# Hunt for real efficiency metrics in the two pilot job directories: model token usage,
# cost, turn/tool-call counts and wall clock. Prints what exists, so the report can quote
# measured numbers instead of a log file size.
import json
import pathlib
import re

JOBS = pathlib.Path(r"D:\code\deep-swe\jobs")
ARMS = {"A control": "2026-09-19__21-37-10", "B plugin": "2026-09-19__21-54-57"}
INTERESTING = re.compile(r"token|usage|cost|prompt|cache|turn|step|tool_call", re.I)


def trial_dir(job: str) -> pathlib.Path:
    for child in (JOBS / job).iterdir():
        if child.is_dir() and "__" in child.name:
            return child
    raise SystemExit(f"no trial dir in {job}")


for label, job in ARMS.items():
    trial = trial_dir(job)
    print(f"\n================ {label}  ({job}) ================")

    # 1. Everything pier recorded for the trial.
    result_path = trial / "result.json"
    if result_path.exists():
        data = json.loads(result_path.read_text(encoding="utf-8"))
        print("result.json top-level keys:", ", ".join(sorted(data.keys())))
        for key, value in data.items():
            if isinstance(value, dict):
                inner = [k for k in value if INTERESTING.search(k)]
                if inner:
                    print(f"  {key}: " + ", ".join(f"{k}={value[k]}" for k in sorted(inner)))
            elif INTERESTING.search(key):
                print(f"  {key}={value}")

    # 2. Any dedicated usage/metrics file, and the plugin's own counters.
    for path in sorted(trial.rglob("*")):
        if not path.is_file():
            continue
        name = path.name.lower()
        if INTERESTING.search(name) or "stat" in name:
            size = path.stat().st_size
            print(f"  file: {path.relative_to(trial)}  ({size}B)")

    # 3. What the agent CLI itself printed about usage.
    dsh = trial / "artifacts" / "agent" / "dsh.txt"
    if dsh.exists():
        text = dsh.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        print(f"  dsh.txt lines: {len(lines)}")
        hits = [ln.strip() for ln in lines if INTERESTING.search(ln) and len(ln) < 200]
        print(f"  usage-ish lines in dsh.txt: {len(hits)}")
        for line in hits[:8]:
            print("    " + line)
        # Tool-call style lines: the headless CLI prints the tool name it is invoking.
        calls = [ln for ln in lines if re.match(r"^\s*(?:→|»|\[tool|Tool:|tool_use|\w+ tool\()", ln)]
        print(f"  tool-call-looking lines: {len(calls)}")
