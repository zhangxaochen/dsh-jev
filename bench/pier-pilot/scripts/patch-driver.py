# Patch the driver for higher concurrency without breaking it:
#   1. a lock file so the launch spacing holds ACROSS processes (two drivers at once),
#   2. treat a job directory touched in the last couple of hours as busy, so a second
#      driver never picks a task whose first arm is still building its image.
import pathlib

path = pathlib.Path("D:/code/dsh-jev/tmp/pier-pilot/run-top20.py")
text = path.read_text(encoding="utf-8")

# 1. cross-process spacing
old_lock = """    global _last_launch
    async with _launch_lock:
        wait = _last_launch + LAUNCH_GAP_S - time.time()
        if wait > 0:
            await asyncio.sleep(wait)
        _last_launch = time.time()
    return await run_arm(task, arm, log_path)"""
new_lock = """    global _last_launch
    async with _launch_lock:
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
    return await run_arm(task, arm, log_path)"""
assert old_lock in text, "launch lock block not found"
text = text.replace(old_lock, new_lock, 1)

# 2. recent-activity guard
old_recent = """def running_tasks(ids: list[str]) -> set[str]:"""
new_recent = """def recent_tasks(ids: list[str], minutes: int = 120) -> set[str]:
    \"\"\"Tasks with a job directory touched recently: their arms are still building or running.

    A run spends its first minutes building an image, before any container exists, so the live
    container check alone would let a second driver start the same task again.
    \"\"\"
    cutoff = time.time() - minutes * 60
    busy = set()
    if not JOBS.exists():
        return busy
    for directory in JOBS.iterdir():
        if not directory.is_dir() or not directory.name.startswith("2026-"):
            continue
        try:
            if directory.stat().st_mtime < cutoff:
                continue
            children = [child.name for child in directory.iterdir()]
        except OSError:
            continue
        for task in ids:
            if any(child.startswith(task[:28]) for child in children):
                busy.add(task)
    return busy


def running_tasks(ids: list[str]) -> set[str]:"""
assert old_recent in text
text = text.replace(old_recent, new_recent, 1)

text = text.replace(
    "    busy = running_tasks(ids)",
    "    busy = running_tasks(ids) | recent_tasks(ids)",
    1,
)
text = text.replace(
    'LAUNCH_GAP_S = 4.0',
    'LAUNCH_GAP_S = 5.0\nLAUNCH_LOCK = PILOT / ".launch-lock"',
    1,
)
path.write_text(text, encoding="utf-8")
print("driver patched for 4 pairs")
