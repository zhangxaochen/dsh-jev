# Delete the adapter's duplicate setup builders so pilot_setup.py is the single source,
# then point the adapter at it. Run with: python wire_adapter.py
import pathlib
import re

path = pathlib.Path(r"D:\code\dsh-jev\tmp\pier-pilot\dsh_agent.py")
src = path.read_text(encoding="utf-8")

# 1. Drop the duplicates: everything from `_add_bundle_to_manifest` up to `class DshCli(`.
start = src.index("def _add_bundle_to_manifest(")
end = src.index("class DshCli(")
src = src[:start] + src[end:]

# 2. Import the single source (and keep the names the rest of the file uses).
if "import pilot_setup" not in src:
    src = src.replace(
        "from pier.models.agent.network import NetworkAllowlist\n",
        "from pier.models.agent.network import NetworkAllowlist\n\n"
        "import pilot_setup\n"
        "from pilot_setup import (\n"
        "    DSH_VERSION,\n"
        "    OUTPUT_FILENAME,\n"
        "    PLUGIN_TARBALL,\n"
        "    PROFILE_CONTROL,\n"
        "    PROFILE_TREATMENT,\n"
        ")\n",
        1,
    )

# 3. The constants that lived here are now imported; drop the local duplicates.
src = re.sub(
    r'DSH_VERSION = "0\.1\.5-rc\.2"\nPLUGIN_TARBALL = "[^"]*"\nPROFILE_CONTROL = "[^"]*"\nPROFILE_TREATMENT = "[^"]*"\nOUTPUT_FILENAME = "[^"]*"\n',
    "",
    src,
)

# 4. run() builds the setup through pilot_setup instead of inline strings.
src = re.sub(
    r"setup_script = \(\n(?:.*\n)*?        \)\n",
    "setup_script = pilot_setup.wrapped_setup(profile, self.with_jev)\n",
    src,
    count=1,
)

path.write_text(src, encoding="utf-8")
print("wired; lines:", len(src.splitlines()))
