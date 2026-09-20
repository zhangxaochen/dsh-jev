# Build the A/B comparison table from pier job directories.
# Usage: python compare.py [n]      (n = how many of the newest jobs to show, default 6)
import json
import pathlib
import sys

JOBS = pathlib.Path(r"D:\code\deep-swe\jobs")


def trial_dir(job: pathlib.Path) -> pathlib.Path | None:
    for child in sorted(job.iterdir()):
        if child.is_dir() and "__" in child.name:
            return child
    return None


def load_json(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def describe(job: pathlib.Path) -> dict:
    trial = trial_dir(job)
    out = {"job": job.name, "arm": "?", "reward": None, "f2p": "", "p2p": "",
           "patch": "", "runtime": "", "note": ""}
    if trial is None:
        out["note"] = "no trial dir"
        return out

    reward = load_json(trial / "verifier" / "reward.json")
    if reward:
        out["reward"] = reward.get("reward")
        if reward.get("f2p_total") is not None:
            out["f2p"] = f"{reward.get('f2p_passed')}/{reward.get('f2p_total')}"
            out["p2p"] = f"{reward.get('p2p_passed')}/{reward.get('p2p_total')}"

    patch = trial / "artifacts" / "model.patch"
    out["patch"] = f"{patch.stat().st_size / 1024:.1f}KB" if patch.exists() else "-"

    # The arm is decided by the profile the setup built: headless-jev carried the plugin.
    setup = trial / "artifacts" / "agent" / "setup.txt"
    if setup.exists():
        text = setup.read_text(encoding="utf-8", errors="replace")
        out["arm"] = "B plugin" if "profiles/headless-jev" in text else "A control"

    # Wall clock, wherever pier recorded it.
    result = load_json(trial / "result.json")
    for container in (result, result.get("agent_result") or {}):
        if not isinstance(container, dict):
            continue
        for key in ("runtime", "duration", "wall_time", "elapsed", "runtime_sec"):
            if container.get(key) is not None:
                out["runtime"] = str(container[key])
                break
        if out["runtime"]:
            break
    if not out["runtime"]:
        # pier does not always record wall clock; the trial directory's own span is a
        # faithful enough proxy because the run writes into it from start to finish.
        end = max((p.stat().st_mtime for p in trial.rglob("*") if p.is_file()), default=None)
        if end:
            out["runtime"] = f"~{(end - trial.stat().st_mtime) / 60:.1f}m"

    dsh_log = trial / "artifacts" / "agent" / "dsh.txt"
    if dsh_log.exists():
        text = dsh_log.read_text(encoding="utf-8", errors="replace")
        for marker, label in (
            ("cannot resolve profile bundle", "BUNDLE UNRESOLVED"),
            ("MISSING_CREDENTIAL", "NO CREDENTIAL"),
            ("plugin tree failed to load", "PLUGIN LOAD FAILED"),
        ):
            if marker in text:
                out["note"] = label
                break
    return out


count = int(sys.argv[1]) if len(sys.argv) > 1 else 6
jobs = sorted((p for p in JOBS.iterdir() if p.is_dir()), key=lambda p: p.name, reverse=True)[:count]
rows = [describe(job) for job in jobs]

print("| job | arm | reward | F2P | P2P | patch | runtime | note |")
print("| --- | --- | --- | --- | --- | --- | --- |")
for row in rows:
    print(
        f"| {row['job']} | {row['arm']} | {row['reward']} | {row['f2p']} | "
        f"{row['p2p']} | {row['patch']} | {row['runtime']} | {row['note']} |"
    )
