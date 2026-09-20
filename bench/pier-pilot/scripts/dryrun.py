# Full end-to-end dry run of the container setup with the real credentials:
#   1. install the published dsh globally
#   2. run the generated setup (profile + Command Code provider + dsh-jev + model route)
#   3. boot the profile and confirm a real answer through Command Code
# Secrets travel as environment values only, so nothing lands in a log.
import base64
import os
import pathlib
import subprocess
import sys

PILOT = pathlib.Path(r"D:\code\dsh-jev\tmp\pier-pilot")
sys.path.insert(0, str(PILOT))
import pilot_setup  # noqa: E402

script = pilot_setup.wrapped_setup(pilot_setup.PROFILE_TREATMENT, True)
(PILOT / "setup-script.sh").write_bytes(script.encode("utf-8"))

dsh_home = pathlib.Path(os.environ["DSH_HOME"])
credentials = (dsh_home / ".credentials.yaml").read_bytes()
typesafe = ""
env_file = dsh_home / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("TYPESAFE_API_KEY="):
            typesafe = line.split("=", 1)[1].strip()

inner = (
    "npm i -g --no-audit --no-fund --loglevel=error @deepseek-ai/dsh@"
    + pilot_setup.DSH_VERSION
    + " >/tmp/npm.log 2>&1; "
    "echo \"dsh: $(dsh --version 2>&1 | head -1)\"; "
    "sh /mnt/pilot/setup-script.sh; "
    "echo '=== boot through Command Code ==='; "
    "timeout 300 dsh --profile " + pilot_setup.PROFILE_TREATMENT + " 'Reply with exactly: ok' 2>&1 | tail -14; "
    "echo '=== plugin counters ==='; "
    "head -14 ~/.dsh/jev-stats.json 2>/dev/null"
)

completed = subprocess.run(
    [
        "docker", "run", "--rm",
        "-v", f"{PILOT}:/mnt/pilot",
        "-v", f"{PILOT / 'logs'}:/logs",
        "-e", f"DSH_CREDENTIALS_YAML_B64={base64.b64encode(credentials).decode()}",
        "-e", f"TYPESAFE_API_KEY={typesafe}",
        "node:22", "sh", "-c", inner,
    ],
    capture_output=True,
    text=True,
)
print(completed.stdout[-4000:])
if completed.stderr.strip():
    print("--- stderr ---")
    print(completed.stderr[-1200:])
