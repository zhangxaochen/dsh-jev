# Add the repeat phase: --attempts N (Pier's -k) and --unsaturated (only tasks whose arms
# differ, i.e. the only ones whose outcome can move).
#
# Also adds --tag so the repeat phase keeps its own completion file: those tasks are already
# "done" by reward, and the normal resume rule would skip exactly the ones we want to repeat.
import pathlib

path = pathlib.Path("D:/code/dsh-jev/tmp/pier-pilot/run-top20.py")
text = path.read_text(encoding="utf-8")

# 1. run_arm gains an attempts argument
text = text.replace(
    "async def run_arm(task: str, arm: str, log_path: Path) -> int:\n    command = [",
    "async def run_arm(task: str, arm: str, log_path: Path, attempts: int = 1) -> int:\n    command = [",
    1,
)
text = text.replace(
    """        "-TaskId",
        task,
    ]""",
    """        "-TaskId",
        task,
    ]
    if attempts > 1:
        command += ["-Attempts", str(attempts)]""",
    1,
)
text = text.replace(
    "    return await run_arm(task, arm, log_path)\n\n\nasync def run_arm",
    "    return await run_arm(task, arm, log_path, attempts)\n\n\nasync def run_arm",
    1,
)
text = text.replace(
    "async def launch_arm(task: str, arm: str, log_path: Path) -> int:",
    "async def launch_arm(task: str, arm: str, log_path: Path, attempts: int = 1) -> int:",
    1,
)

# 2. run_stage / main thread the value through
text = text.replace(
    "async def run_stage(task: str, stage: int, status: dict, stop: asyncio.Event, attempt: int = 1) -> bool:",
    "async def run_stage(\n    task: str, stage: int, status: dict, stop: asyncio.Event, attempt: int = 1, attempts: int = 1\n) -> bool:",
    1,
)
text = text.replace(
    'controls = asyncio.create_task(launch_arm(task, "A", logs["A"]))',
    'controls = asyncio.create_task(launch_arm(task, "A", logs["A"], attempts))',
    1,
)
text = text.replace(
    'treatments = asyncio.create_task(launch_arm(task, "B", logs["B"]))',
    'treatments = asyncio.create_task(launch_arm(task, "B", logs["B"], attempts))',
    1,
)
text = text.replace(
    "        return await run_stage(task, stage, status, stop, attempt + 1)",
    "        return await run_stage(task, stage, status, stop, attempt + 1, attempts)",
    1,
)
text = text.replace(
    "            await run_stage(task, stage, status, stop)",
    "            await run_stage(task, stage, status, stop, attempts=args.attempts)",
    1,
)

# 3. unsaturated detector
helper = '''def arm_reward(base: str):
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


'''
text = text.replace("def skip_list():", helper + "def skip_list():", 1)

# 4. arguments and the completion file per tag
text = text.replace(
    '    parser.add_argument("--force", action="store_true", help="re-run tasks already in the status file")',
    '    parser.add_argument("--force", action="store_true", help="re-run tasks already in the status file")\n'
    '    parser.add_argument("--attempts", type=int, default=1, help="Pier attempts per trial (-k)")\n'
    '    parser.add_argument("--unsaturated", action="store_true", help="only tasks whose arms differ on F2P")\n'
    '    parser.add_argument("--tag", default="", help="completion file suffix, keeps phases apart")',
    1,
)

old_pending = """    pending = [
        task
        for task in ids
        if args.force
        or not (
            is_done(status, task, "A")
            and is_done(status, task, "B")
        )
    ]"""
new_pending = """    if args.unsaturated:
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
        ]"""
assert old_pending in text
text = text.replace(old_pending, new_pending, 1)

path.write_text(text, encoding="utf-8")
print("repeat phase wired")
