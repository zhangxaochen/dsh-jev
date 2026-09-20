# Prune stale Docker networks before every launch.
#
# Root cause of a long stretch of 25-second failures: every Pier trial creates its own compose
# network (plus an egress proxy), and when a run dies badly the network is left behind. Docker
# Desktop's default address pool is small, so after a day of runs the pool is exhausted and new
# trials die with "all predefined address pools have been fully subnetted" before the agent
# starts. Pruning unused networks before each launch keeps slots free; running containers keep
# theirs, so nothing in flight is disturbed.
import pathlib

path = pathlib.Path("D:/code/dsh-jev/tmp/pier-pilot/run-top20.py")
text = path.read_text(encoding="utf-8")

old = """    global _last_launch
    async with _launch_lock:"""
new = """    global _last_launch
    async with _launch_lock:
        # Free address-pool slots; a dead run leaves its compose network behind.
        await asyncio.create_subprocess_exec(
            "docker",
            "network",
            "prune",
            "-f",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )"""
assert old in text
text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("network prune wired into launches")
