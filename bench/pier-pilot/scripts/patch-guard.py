# Tighten the "task is already in flight" guard.
#
# The first version treated any job directory touched in the last two hours as busy, which
# swept in the 25-second image-failure runs from 10:18 and made a second driver think 17 of
# 20 tasks were already running. What actually indicates an in-flight task is either a live
# container, or a job directory that is still young AND has no result.json yet - a real run
# needs 25+ minutes, while a failed one writes result.json within seconds.
import pathlib

path = pathlib.Path("D:/code/dsh-jev/tmp/pier-pilot/run-top20.py")
text = path.read_text(encoding="utf-8")

start = text.index("def recent_tasks(")
end = text.index("def running_tasks(")
replacement = '''def active_tasks(ids: list[str], minutes: int = 20) -> set[str]:
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


'''
text = text[:start] + replacement + text[end:]
text = text.replace("    busy = running_tasks(ids) | recent_tasks(ids)", "    busy = running_tasks(ids) | active_tasks(ids)", 1)
path.write_text(text, encoding="utf-8")
print("guard tightened")
