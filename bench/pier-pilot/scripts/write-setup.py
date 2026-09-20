# Emit the container setup script with LF endings and no BOM, so dash parses it.
import sys

sys.path.insert(0, r"D:\code\dsh-jev\tmp\pier-pilot")
import pilot_setup  # noqa: E402

script = pilot_setup.wrapped_setup(pilot_setup.PROFILE_TREATMENT, True)
with open(r"D:\code\dsh-jev\tmp\pier-pilot\setup-script.sh", "wb") as handle:
    handle.write(script.encode("utf-8"))
print("bytes:", len(script), "has_cr:", "\r" in script)
