# Make the driver robust to flaky image fetches.
#
# Evidence: Pier builds its task image with buildx --pull, so it re-fetches the manifest even
# when the base image is already local. public.ecr.aws answers "failed to fetch anonymous
# token" / "401 Unauthorized" intermittently, and the pre-pull therefore does not prevent the
# failure. Two consequences:
#   1. retry a task a few times with a pause, instead of once;
#   2. a single task failing must not abort the whole run - only invalid data (wrong model
#      route) or exhausted quota should stop it. The failing task stays unfinished and is
#      picked up again by the next run.
# Also fix the arm marker in the driver's own logs: both arms install the provider, so only
# the treatment profile carries the plugin line.
import pathlib

path = pathlib.Path("D:/code/dsh-jev/tmp/pier-pilot/run-top20.py")
text = path.read_text(encoding="utf-8")

# 1. arm marker
old_marker = '''            record["arm"] = "B" if "/node_modules/dsh-jev" in text else "A"'''
new_marker = '''            record["arm"] = "B" if "plugin in profile:" in text else "A"'''
assert old_marker in text
text = text.replace(old_marker, new_marker, 1)

# 2. more attempts, with a pause
old_retry = "    if (any(code != 0 for code in codes) or not created or incomplete) and attempt < 2:"
new_retry = "    if (any(code != 0 for code in codes) or not created or incomplete) and attempt < 3:"
assert old_retry in text
text = text.replace(old_retry, new_retry, 1)

old_pull = '''        await pull_image(task)
        return await run_stage(task, stage, status, stop, attempt + 1)'''
new_pull = '''        await pull_image(task)
        # The registry refusal is intermittent, so give it a pause before trying again.
        await asyncio.sleep(30)
        return await run_stage(task, stage, status, stop, attempt + 1)'''
assert old_pull in text
text = text.replace(old_pull, new_pull, 1)

# 3. one task failing no longer aborts the run
old_stop = '''    if any(code != 0 for code in codes) or not created or incomplete:
        log(f"STOP: task {task} failed (exit={list(codes)}, jobs={created}); see {logs['A']} and {logs['B']}")
        stop.set()
        return False
    return True'''
new_stop = '''    if any(code != 0 for code in codes) or not created or incomplete:
        # Do not abort the run for one task: the registry refusal is intermittent and the task
        # simply stays unfinished for the next pass. Only invalid data or exhausted quota stops
        # everything, and both are handled above.
        log(
            f"SKIP after {attempt} attempt(s): task {task} produced no complete pair "
            f"(exit={list(codes)}) see {logs['A']} and {logs['B']}"
        )
        return False
    return True'''
assert old_stop in text
text = text.replace(old_stop, new_stop, 1)

path.write_text(text, encoding="utf-8")
print("driver made resilient")
