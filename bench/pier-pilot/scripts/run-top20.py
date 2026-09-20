"""Drive the full top-20 A/B: both arms of one task run concurrently, two pairs in flight.

Why this shape:
  * the two arms of a task start together, so wall-clock is measured under the same host
    load and stays comparable within a pair;
  * two pairs run side by side, so 20 tasks take ~5 hours instead of ~20;
  * every arm's setup.txt is checked for the Command Code route and the exact model, and a
    misrouted wave aborts the whole run instead of burning hours of unusable data;
  * progress lands in top20-status.json, so the driver can be restarted and resumes.

Usage: python tmp/pier-pilot/run-top20.py [--max-tasks N] [--pairs K] [--only id1,id2]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from pathlib import Path

PILOT = Path(r"D:\code\dsh-jev\tmp\pier-pilot")
JOBS = Path(r"D:\code\deep-swe\jobs")
TASKS_DIR = Path(r"D:\code\deep-swe\tasks")
IDS_FILE = PILOT / "top20-ids.txt"
STATUS_FILE = PILOT / "top20-status.json"
LOG_DIR = PILOT / "logs" / "top20"

ARM_FLAG = {"A": "off", "B": "on"}  # A = control (no plugin), B = treatment (plugin)
ROUTE_PROVIDER = "provider: commandcode"
ROUTE_MODEL = "model: deepseek/deepseek-v4.1-flash"


def errored_attempts(task: str, minutes: int = 45) -> int:
    """How many of today's runs for this task ended without a usable reward."""
    prefix = task[:28]
    count = 0
    if not JOBS.exists():
        return count
    now = time.time()
    for directory in JOBS.iterdir():
        if not directory.is_dir() or not directory.name.startswith("2026-"):
            continue
        try:
            children = [child for child in directory.iterdir() if child.is_dir()]
            age = now - directory.stat().st_mtime
        except OSError:
            continue
        for child in children:
            if not child.name.startswith(prefix):
                continue
            reward = None
            reward_file = child / "verifier" / "reward.json"
            if reward_file.exists():
                try:
                    reward = json.loads(reward_file.read_text(encoding="utf-8")).get("reward")
                except (OSError, json.JSONDecodeError):
                    reward = None
            finished = (child / "result.json").exists()
            if reward is not None and reward >= 0:
                continue
            # No reward yet: still running unless the directory is old or already finalised.
            if finished or age > minutes * 60:
                count += 1
    return count


def arm_reward(base: str):
    """(arm, reward, f2p ratio) from one job directory, or None when unusable."""
    setup = base / "artifacts" / "agent" / "setup.txt"
    reward_file = base / "verifier" / "reward.json"
    if not setup.exists() or not reward_file.exists():
        return None
    try:
        payload = json.loads(reward_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    reward = payload.get("reward")
    total = payload.get("f2p_total") or 0
    passed = payload.get("f2p_passed") or 0
    arm = "B" if "plugin in profile:" in setup.read_text(encoding="utf-8", errors="replace") else "A"
    return arm, reward, (passed / total if total else 0.0)


def unsaturated_tasks(ids: list[str]) -> set[str]:
    """Tasks where at least one arm missed a FAIL_TO_PASS test.

    A pair where both arms scored every F2P test cannot show an effect, so repeating it only
    buys confirmation. These are the tasks whose outcome can actually move. Per arm the best
    ratio seen wins, so an arm that ever scored 100% is not treated as incomplete.
    """
    best: dict = {}
    if not JOBS.exists():
        return set()
    for job in JOBS.iterdir():
        if not job.is_dir() or not job.name.startswith("2026-"):
            continue
        for child in job.iterdir():
            prefix = child.name.split("__")[0]
            task = next((task for task in ids if task.startswith(prefix) or prefix.startswith(task[:28])), None)
            if not task:
                continue
            info = arm_reward(child)
            if not info:
                continue
            arm, reward, ratio = info
            if reward is None or reward < 0:
                continue
            entry = best.setdefault(task, {})
            if arm not in entry or ratio > entry[arm]:
                entry[arm] = ratio
    return {
        task
        for task, arms in best.items()
        if "A" in arms and "B" in arms and (arms["A"] < 1 or arms["B"] < 1)
    }


def skip_list():
    """Task ids in skip.txt, whose trials error repeatedly and cost more than they return."""
    path = PILOT / "skip.txt"
    if not path.exists():
        return set()
    lines = path.read_text(encoding="utf-8").splitlines()
    return {line.strip() for line in lines if line.strip() and not line.startswith("#")}


def is_done(status: dict, task: str, arm: str) -> bool:
    """A task is done for an arm only when that arm produced a real trial (reward >= 0).

    Pier writes -1 for an errored trial; treating that as a result would silently skip a task
    that still needs a re-run.
    """
    reward = status.get(task, {}).get(arm, {}).get("reward")
    return reward is not None and reward >= 0


def active_tasks(ids: list[str], minutes: int = 20) -> set[str]:
    """Tasks whose newest job directory is too young to have finished, so still in flight.

    A live container covers most of a run, but its first minutes are spent building the task
    image with no container yet. A directory created recently and still missing result.json is
    that window; failed runs write result.json within seconds and so are not counted.
    """
    cutoff = time.time() - minutes * 60
    busy: set[str] = set()
    if not JOBS.exists():
        return busy
    for task in ids:
        prefix = task[:28]
        newest: tuple[float, bool] | None = None
        for directory in JOBS.iterdir():
            if not directory.is_dir() or not directory.name.startswith("2026-"):
                continue
            try:
                children = [child for child in directory.iterdir() if child.is_dir()]
                created = directory.stat().st_mtime
            except OSError:
                continue
            for child in children:
                if not child.name.startswith(prefix):
                    continue
                finished = (child / "result.json").exists()
                if newest is None or created > newest[0]:
                    newest = (created, finished)
        if newest and newest[0] >= cutoff and not newest[1]:
            busy.add(task)
    return busy


def running_tasks(ids: list[str]) -> set[str]:
    """Tasks that already have a live container, so a restart must not start them twice."""
    result = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    names = result.stdout.split()
    return {task for task in ids if any(name.startswith(task[:28]) for name in names)}


def load_status() -> dict:
    if STATUS_FILE.exists():
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    return {}


def save_status(status: dict) -> None:
    STATUS_FILE.write_text(json.dumps(status, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def log(message: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {message}"
    print(line, flush=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with (LOG_DIR / "driver.log").open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def task_ids(only: list[str]) -> list[str]:
    ids = [line.strip() for line in IDS_FILE.read_text(encoding="utf-8").splitlines() if line.strip()]
    if only:
        ids = [task for task in ids if task in only]
    return ids


def job_dirs() -> set[str]:
    return {path.name for path in JOBS.iterdir() if path.is_dir()} if JOBS.exists() else set()


def stage_job_dirs(before: set[str], task: str) -> list[str]:
    """Job directories this task created.

    The snapshot must be filtered per task: with two pairs in flight, an unfiltered diff
    hands one task's directories to the other. Pier truncates the task id in the directory
    name (valibot-recursive-schema-composi), so match on a prefix.
    """
    prefix = task[:28]
    found = []
    for name in sorted(job_dirs() - before):
        children = [child.name for child in (JOBS / name).iterdir()]
        if any(child.startswith(prefix) for child in children):
            found.append(name)
    return found


def inspect_job(job: Path) -> dict:
    """Read one job's route line, reward and test counts."""
    record: dict = {"job": job.name}
    arm_dir = next(iter(job.glob("*/artifacts/agent")), None)
    if arm_dir:
        setup = arm_dir / "setup.txt"
        if setup.exists():
            text = setup.read_text(encoding="utf-8", errors="replace")
            record["provider_ok"] = ROUTE_PROVIDER in text
            record["model_ok"] = ROUTE_MODEL in text
            # Identify the arm by whether the plugin sits in the profile, not by the profile
            # name appearing anywhere in the setup log.
            record["arm"] = "B" if "plugin in profile:" in text else "A"
        dsh_log = arm_dir / "dsh.txt"
        if dsh_log.exists():
            tail = dsh_log.read_text(encoding="utf-8", errors="replace")
            record["quota"] = "QUOTA" in tail
    reward_file = next(iter(job.glob("*/verifier/reward.json")), None)
    if reward_file:
        try:
            payload = json.loads(reward_file.read_text(encoding="utf-8"))
            record["reward"] = payload.get("reward")
        except json.JSONDecodeError:
            record["reward"] = None
    result_file = next(iter(job.glob("*/result.json")), None)
    if result_file:
        try:
            payload = json.loads(result_file.read_text(encoding="utf-8"))
            record["f2p"] = len(payload.get("f2p", []) or [])
            record["p2p"] = len(payload.get("p2p", []) or [])
            record["runtime_s"] = payload.get("runtime", payload.get("total_runtime"))
        except json.JSONDecodeError:
            pass
    return record


# 90 s, not 5 s: Pier builds each task image with buildx --pull, and public.ecr.aws fails
# systematically when several builds fetch at once, so launches are spread to space the builds.
LAUNCH_GAP_S = 90.0
LAUNCH_LOCK = PILOT / ".launch-lock"
_launch_lock = asyncio.Lock()
_last_launch = 0.0


async def launch_arm(task: str, arm: str, log_path: Path, attempts: int = 1) -> int:
    """Start one arm, keeping every launch across the driver at least LAUNCH_GAP_S apart.

    Pier names its job directory to the second. Two arms starting in the same second collide
    and the loser dies with FileExistsError, so spacing launches globally - not per task - is
    what actually prevents it.
    """
    global _last_launch
    async with _launch_lock:
        # Free address-pool slots; a dead run leaves its compose network behind.
        await asyncio.create_subprocess_exec(
            "docker",
            "network",
            "prune",
            "-f",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        # The gap must hold across driver processes too: two drivers running at once still
        # collide on Pier's second-resolution job directory if each only spaces its own
        # launches, so the timestamp lives in a file both of them honour.
        while True:
            try:
                last = float(LAUNCH_LOCK.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                last = 0.0
            wait = max(last, _last_launch) + LAUNCH_GAP_S - time.time()
            if wait <= 0:
                break
            await asyncio.sleep(min(wait, 1.0))
        now = time.time()
        _last_launch = now
        try:
            LAUNCH_LOCK.write_text(str(now), encoding="utf-8")
        except OSError:
            pass
    return await run_arm(task, arm, log_path)


def task_image(task: str) -> str | None:
    """The registry image this task builds on, from the top-20 manifest."""
    try:
        manifest = json.loads((TASKS_DIR.parent / "top20_tasks.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    for entry in manifest:
        if entry.get("task_id") == task:
            return entry.get("docker_image")
    return None


async def pull_image(task: str) -> bool:
    """Fetch the task's base image.

    Concurrent runs pull several multi-gigabyte images at once, and public.ecr.aws then drops
    the build with "failed to fetch anonymous token". Pulling that one image serially before
    retrying the task is what gets the trial past it.
    """
    image = task_image(task)
    if not image:
        return False
    log(f"task {task}: pulling {image}")
    process = await asyncio.create_subprocess_exec(
        "docker",
        "pull",
        image,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    ok = process.returncode == 0
    if not ok:
        log(f"task {task}: pull FAILED {stderr.decode('utf-8', 'replace')[-160:]}")
    return ok


async def run_arm(task: str, arm: str, log_path: Path, attempts: int = 1) -> int:
    command = [
        "pwsh",
        "-NoProfile",
        "-File",
        str(PILOT / "run-arm.ps1"),
        "-Jev",
        ARM_FLAG[arm],
        "-TaskId",
        task,
    ]
    if attempts > 1:
        command += ["-Attempts", str(attempts)]
    with log_path.open("w", encoding="utf-8") as handle:
        handle.write(f"$ {' '.join(command)}\n\n")
        handle.flush()
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=handle,
            stderr=asyncio.subprocess.STDOUT,
            # Pier resolves its jobs root against the working directory, so run from the
            # dataset root: results then land beside the tasks, where every later tool looks.
            cwd=str(TASKS_DIR.parent),
        )
        return await process.wait()


async def run_stage(
    task: str, stage: int, status: dict, stop: asyncio.Event, attempt: int = 1, attempts: int = 1
) -> bool:
    """Both arms of one task, concurrently. Returns False when the run must stop."""
    before = job_dirs()
    started = time.time()
    logs = {arm: LOG_DIR / f"{task}.{arm}.log" for arm in ARM_FLAG}

    # Pier names the job directory to the second (jobs/<Y-m-d__H-M-S>), so two arms starting
    # in the same second collide: the loser dies with FileExistsError "cannot be resumed with
    # a different config". Let the control arm claim its directory before starting treatment.
    log(f"task {task}: arm A starting (stage {stage})")
    controls = asyncio.create_task(launch_arm(task, "A", logs["A"], attempts))
    deadline = time.time() + 60
    while time.time() < deadline and not stage_job_dirs(before, task):
        await asyncio.sleep(1)

    claimed = stage_job_dirs(before, task)
    log(f"task {task}: arm B starting (A claimed {claimed or 'nothing'})")
    treatments = asyncio.create_task(launch_arm(task, "B", logs["B"], attempts))
    codes = await asyncio.gather(controls, treatments)

    created = stage_job_dirs(before, task)
    entry: dict = {
        "task": task,
        "stage": stage,
        "elapsed_s": round(time.time() - started, 1),
        "exit": list(codes),
    }
    jobs = [inspect_job(JOBS / name) for name in created]
    for job in jobs:
        arm = job.get("arm")
        if arm:
            entry[arm] = job
    status[task] = entry
    save_status(status)

    summary = " ".join(
        f"{job.get('arm')}={job.get('reward')}" for job in jobs if job.get("arm")
    )
    log(f"task {task}: done in {entry['elapsed_s']}s exit={list(codes)} jobs={created} {summary}")

    # A misrouted arm invalidates a pair, and a misrouted first wave would invalidate the
    # whole run, so stop rather than collect hours of data from the wrong model.
    for job in jobs:
        if job.get("provider_ok") is False or job.get("model_ok") is False:
            log(f"STOP: {job['job']} did not report the Command Code deepseek route ({job})")
            stop.set()
            return False

    for job in jobs:
        if job.get("quota"):
            log(f"STOP: {job['job']} hit a QUOTA error; resume later with the same command")
            stop.set()
            return False

    # A pair that dies in seconds never reached the agent: in practice the task image failed
    # to come down from public.ecr.aws while several runs pulled at once. Pull that one image
    # serially and try the pair once more before giving up on it.
    # A reward of -1 marks a Pier error trial, which is not a result: only >= 0 counts.
    incomplete = [job for job in jobs if job.get("reward") is None or job.get("reward") < 0]
    if (any(code != 0 for code in codes) or not created or incomplete) and attempt < 5:
        log(
            f"task {task}: attempt {attempt} produced no complete pair "
            f"(exit={list(codes)}, jobs={created}, missing={[j['job'] for j in incomplete]}); "
            "pulling the base image and retrying"
        )
        await pull_image(task)
        # The registry refusal is intermittent, so give it a pause before trying again.
        await asyncio.sleep(60)
        return await run_stage(task, stage, status, stop, attempt + 1, attempts)

    # Any arm that failed, or any pair that produced no job, must abort the run: continuing
    # would spawn further pairs while the real problem stays unfixed.
    if any(code != 0 for code in codes) or not created or incomplete:
        # Do not abort the run for one task: the registry refusal is intermittent and the task
        # simply stays unfinished for the next pass. Only invalid data or exhausted quota stops
        # everything, and both are handled above.
        log(
            f"SKIP after {attempt} attempt(s): task {task} produced no complete pair "
            f"(exit={list(codes)}) see {logs['A']} and {logs['B']}"
        )
        return False
    return True


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=int, default=2, help="tasks in flight (each runs 2 arms)")
    parser.add_argument("--max-tasks", type=int, default=0, help="stop after N tasks (0 = all)")
    parser.add_argument("--only", default="", help="comma separated task ids")
    parser.add_argument("--force", action="store_true", help="re-run tasks already in the status file")
    parser.add_argument("--attempts", type=int, default=1, help="Pier attempts per trial (-k)")
    parser.add_argument("--unsaturated", action="store_true", help="only tasks whose arms differ on F2P")
    parser.add_argument("--tag", default="", help="completion file suffix, keeps phases apart")
    args = parser.parse_args()

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    # Disk truth wins: the in-process bookkeeping can mis-attribute directories.
    subprocess.run(["node", str(PILOT / "rebuild-status.mjs")], check=False, capture_output=True)
    status = load_status()
    ids = task_ids([part.strip() for part in args.only.split(",") if part.strip()])
    if args.unsaturated:
        # Repeat phase: pick the tasks that can move, ignoring the normal done-check.
        rep = set()
        if args.tag:
            rep_file = PILOT / f"done-{args.tag}.json"
            if rep_file.exists() and not args.force:
                rep = set(json.loads(rep_file.read_text(encoding="utf-8")))
        pending = [task for task in ids if task not in rep]
        loose = unsaturated_tasks(ids)
        pending = [task for task in pending if task in loose]
    else:
        pending = [
            task
            for task in ids
            if args.force
            or not (
                is_done(status, task, "A")
                and is_done(status, task, "B")
            )
        ]
    busy = running_tasks(ids) | active_tasks(ids)
    if busy:
        log(f"skipping {len(busy)} task(s) that already have live containers: {sorted(busy)}")
        pending = [task for task in pending if task not in busy]
    skip = skip_list()
    broken = [task for task in pending if task in skip]
    if broken:
        log(f"skipping {len(broken)} task(s) from skip.txt: {broken}")
        pending = [task for task in pending if task not in broken]
    if args.max_tasks:
        pending = pending[: args.max_tasks]

    log(f"top20 A/B: {len(pending)} task(s) pending of {len(ids)} | pairs in flight {args.pairs}")
    if not pending:
        log("nothing to do")
        return 0

    # Warm the uv tool env once, so concurrent runs never race on the install.
    subprocess.run(
        ["pwsh", "-NoProfile", "-Command", "uv tool run --from datacurve-pier pier --version"],
        check=False,
        capture_output=True,
    )

    stop = asyncio.Event()
    semaphore = asyncio.Semaphore(args.pairs)

    async def guarded(task: str, stage: int) -> None:
        async with semaphore:
            if stop.is_set():
                return
            await run_stage(task, stage, status, stop, attempts=args.attempts)

    await asyncio.gather(*(guarded(task, index + 1) for index, task in enumerate(pending)))

    done = sum(
        1
        for task in ids
        if is_done(status, task, "A") and is_done(status, task, "B")
    )
    log(f"finished: {done}/{len(ids)} tasks have both arms")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
