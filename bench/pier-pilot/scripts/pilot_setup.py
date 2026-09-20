"""
Pure string builders for the container-side setup, kept free of any pier import so the
exact script can be printed and dry-run inside a throwaway container in a minute, instead
of being validated only by a four-minute pier round.
"""

DSH_VERSION = "0.1.6-alpha.2"
PLUGIN_TARBALL = "/mnt/pilot/dsh-jev-0.2.0.tgz"
PROVIDER_PACKAGE = "@mars-sea/dsh-commandcode-provider"
PROVIDER_SPEC = "@mars-sea/dsh-commandcode-provider@0.11.6"
PROVIDER_MODEL = "deepseek/deepseek-v4.1-flash"
PROFILE_CONTROL = "headless"
PROFILE_TREATMENT = "headless-jev"
OUTPUT_FILENAME = "dsh.txt"

# The model route lives in settings.yaml, and it is what sends the agent's calls through
# Command Code instead of DeepSeek - whose balance ran out mid-pair and aborted an arm.
# Both arms use it, so the comparison stays matched.
SETTINGS_YAML = (
    "agent-default-model:\n"
    "  provider: commandcode\n"
    f"  model: {PROVIDER_MODEL}\n"
    "  reasoningEffort: high\n"
    # Without this cap the route uses the catalog window, DSH never compacts, and every
    # step reasons over ~180K tokens (measured: 24m59s vs 11m35s on the DeepSeek route).
    "llm-commandcode:\n"
    "  contextWindowOverrides:\n"
    f"    {PROVIDER_MODEL}: 368000\n"
)


def profile_setup(profile: str, with_plugin: bool) -> str:
    """Build a headless profile the way the shipped template does, then add the plugin.

    The profile is created at run time in the container rather than through
    `--from-default-profile` (a desktop-app facility that the npm CLI does not have), and
    the plugin is installed into the profile directory, which is one of the two places
    dsh resolves a bundle from.
    """
    bundles = f'["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","{PROVIDER_PACKAGE}"'
    if with_plugin:
        bundles += ',"dsh-jev"'
    bundles += ']'
    manifest = (
        '{"name":"dsh-profile-' + profile + '","private":true,"dependencies":{},'
        '"dsh":{"profile":{"bundles":' + bundles + ',"patchReload":"startup"}}}'
    )
    # The bundles resolve from the global installation (installing `@deepseek-ai/dsh-base`
    # into the profile 404s on unpublished peers), but the loader imports each bundle
    # *from the profile directory*, so every bundle that is not part of the global install
    # has to live in the profile's node_modules. Both facts come from the loader's errors.
    install = (
        f"npm i --no-audit --no-fund {PROVIDER_SPEC}"
        ' && echo "provider in profile: $(ls -d "$(pwd)/node_modules/@mars-sea/dsh-commandcode-provider" 2>&1)"'
    )
    if with_plugin:
        install += (
            f" && npm i --no-audit --no-fund {PLUGIN_TARBALL}"
            f' && echo "plugin in profile: $(ls -d "$(pwd)/node_modules/dsh-jev" 2>&1)"'
        )
    verify = 'test -d node_modules/dsh-jev && ' if with_plugin else ""
    return (
        f'mkdir -p "$HOME/.dsh/profiles/{profile}" && '
        f'cd "$HOME/.dsh/profiles/{profile}" && '
        f"printf '%s\\n' '{manifest}' > package.json && "
        "printf '[]\\n' > cordis.patch.yml && "
        f"{install} && "
        f"{verify}"
        f"echo 'profile {profile} ready'"
    )


def setup_script(profile: str, with_plugin: bool) -> str:
    """The full container setup: mount check, profile, plugin, credentials, model route."""
    return (
        'echo "--- mount check:"; ls -la /mnt 2>&1 | head -8; '
        f'if [ -f {PLUGIN_TARBALL} ]; then echo "TARBALL_OK"; else echo "TARBALL_MISSING"; fi\n'
        + profile_setup(profile, with_plugin)
        + "\n"
        + 'if [ -n "$DSH_CREDENTIALS_YAML_B64" ]; then '
        'printf "%s" "$DSH_CREDENTIALS_YAML_B64" | base64 -d > ~/.dsh/.credentials.yaml; '
        "chmod 600 ~/.dsh/.credentials.yaml; fi\n"
        + 'if [ -n "$TYPESAFE_API_KEY" ]; then '
        "printf 'TYPESAFE_API_KEY=%s\\n' \"$TYPESAFE_API_KEY\" > ~/.dsh/.env; fi\n"
        # Route the agent's model calls through Command Code for both arms; DeepSeek's
        # balance ran out mid-pair and aborted a run with QUOTA: Insufficient Balance.
        # printf interprets \n in its format string, so no heredoc or sed is needed.
        + "printf '" + SETTINGS_YAML.replace("\n", "\\n") + "' > ~/.dsh/settings.yaml\n"
        + 'mkdir -p ~/.dsh/patches && cp /mnt/pilot/commandcode-context-cap.mjs ~/.dsh/patches/ && '
        "sed -i \"s/const PROFILES = \\[[^]]*\\]/const PROFILES = ['desktop','tui','web','acp','headless','" + profile + "']/\" ~/.dsh/patches/commandcode-context-cap.mjs && "
        + 'node ~/.dsh/patches/commandcode-context-cap.mjs 2>&1 | tail -3; '
        + 'echo "--- context cap check (exit 0 = in effect):"; node ~/.dsh/patches/commandcode-context-cap.mjs --check 2>&1 | tail -4; echo "check exit=$?"; '
        + 'echo "--- model route:"; grep -A2 agent-default-model ~/.dsh/settings.yaml 2>&1; '
        + 'echo "--- bundle dir:"; ls -d "$(pwd)/node_modules/dsh-jev" 2>&1; '
        + 'echo "--- setup done"; '
        + "echo '--- setup.txt tail:'; tail -4 /logs/agent/setup.txt"
    )


def wrapped_setup(profile: str, with_plugin: bool) -> str:
    """Setup with its output redirected to the archived log.

    The directory is created first: in POSIX sh a failed `exec >` aborts the entire script,
    which silently skipped the profile, plugin and credentials in every earlier attempt.
    """
    return (
        "mkdir -p ~/.dsh /logs/agent /logs/artifacts\n"
        "exec > /logs/agent/setup.txt 2>&1\n"
        + setup_script(profile, with_plugin)
    )
