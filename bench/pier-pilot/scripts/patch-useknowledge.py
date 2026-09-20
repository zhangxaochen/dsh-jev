# Record which tasks a tagged phase has already run.
#
# The repeat phase re-selects tasks from disk, so without this it would happily re-run the same
# five tasks after any restart. The tag file makes a restart resume instead of repeat.
import pathlib

path = pathlib.Path("D:/code/dsh-jev/tmp/pier-pilot/run-top20.py")
text = path.read_text(encoding="utf-8")

old = """    log(f"finished: {sum(1 for task in ids if is_done(status, task, 'A') and is_done(status, task, 'B'))}/{len(ids)} tasks have both arms")
    return 0"""
new = """    log(
        f"finished: {sum(1 for task in ids if is_done(status, task, 'A') and is_done(status, task, 'B'))}/{len(ids)} tasks have both arms"
    )
    if args.tag:
        rep_file = PILOT / f"done-{args.tag}.json"
        done = set()
        if rep_file.exists():
            try:
                done = set(json.loads(rep_file.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                done = set()
        rep_file.write_text(json.dumps(sorted(done | set(ran))), encoding="utf-8")
        log(f"recorded {len(ran)} task(s) in {rep_file.name}")
    return 0"""
assert old in text, "anchor not found"
text = text.replace(old, new, 1)

# Track what this process launched.
text = text.replace(
    "    pending = pending[: args.max_tasks]" if "    pending = pending[: args.max_tasks]" in text else "    log(f\"starting {len(pending)} task(s)\")",
    "    log(f\"starting {len(pending)} task(s)\")\n    ran = list(pending)",
    1,
)
path.write_text(text, encoding="utf-8")
print("tag recording added")
