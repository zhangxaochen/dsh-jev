# Stop burning 40-minute attempts on a task whose trials keep erroring.
#
# A Pier error trial writes reward -1, and an aborted or unverifiable run leaves a directory
# with no reward. Two such attempts mean the task is more likely broken in this dataset than
# unlucky, so it is skipped and reported rather than retried forever.
import pathlib

path = pathlib.Path("D:/code/dsh-jev/tmp/pier-pilot/run-top20.py")
text = path.read_text(encoding="utf-8")

helper = '''def errored_attempts(task: str, minutes: int = 45) -> int:
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


'''
text = text.replace("def is_done(status: dict, task: str, arm: str) -> bool:", helper + "def is_done(status: dict, task: str, arm: str) -> bool:", 1)

old = '''    if args.max_tasks:
        pending = pending[: args.max_tasks]'''
new = '''    broken = [task for task in pending if errored_attempts(task) >= 2]
    if broken:
        log(f"skipping {len(broken)} task(s) with two errored trials: {broken}")
        pending = [task for task in pending if task not in broken]
    if args.max_tasks:
        pending = pending[: args.max_tasks]'''
assert old in text
text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("error cap added")
