"""
Pier agent adapter: drive DSH headless inside the task container, with or without the
dsh-jev plugin loaded.

Arm A (control):  --agent-import-path dsh_agent:DshCli --agent-kwarg with_jev=false
Arm B (treatment): the same with with_jev=true, which installs dsh-jev into a copied
headless profile and adds it to that profile's bundle list - exactly what `pnpm run sync`
does on the host.

Notes that matter for reading the results:
- The published runtime is @deepseek-ai/dsh 0.1.5-rc.2; the local deployment runs 0.2.0,
  which is not on npm. In 0.1.5 the `tools.guard()` API is absent, so the plugin's
  deterministic hard-deny layer does not register there (safety-guard skips it when
  `typeof tools.guard !== 'function'`). The semantic layer, pruner, router, shaper and
  loop guard all hook events that do exist in 0.1.5.
- Both arms get the same runtime, model, network allowlist and commit step; the only
  difference is whether the plugin is installed in the profile.
"""

import os
import shlex
from pathlib import Path

from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist

import pilot_setup
from pilot_setup import (
    DSH_VERSION,
    OUTPUT_FILENAME,
    PLUGIN_TARBALL,
    PROFILE_CONTROL,
    PROFILE_TREATMENT,
)



class DshCli(BaseInstalledAgent):
    """DeepSeek Harness (dsh) running one headless task inside the container."""

    SUPPORTS_ATIF: bool = False

    def __init__(self, *args, with_jev: object = False, **kwargs):
        self.with_jev = str(with_jev).strip().lower() in {"1", "true", "yes", "on"}
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "dsh"

    def get_version_command(self) -> str | None:
        return "dsh --version"

    def network_allowlist(self) -> NetworkAllowlist:
        return allowlist_from_urls(
            [],
            default_domains=[
                "registry.npmjs.org",
                "nodejs.org",
                "deb.debian.org",
                "security.debian.org",
                "api.deepseek.com",
                "api.typesafe.ai",
                # The Command Code provider plugin declares these two as its own needs.
                # Routing the model through Command Code is what unblocks the DeepSeek
                # balance, and both arms use it so the comparison stays matched.
                "api.commandcode.ai",
                "commandcode.ai",
            ],
        )

    def install_spec(self) -> AgentInstallSpec:
        # The SWE-bench style task images keep apt in a held/broken state, so installing
        # nodejs/npm through apt fails with exit 100. A TypeScript task image already
        # ships node; the fallback fetches the official Linux build instead of touching apt.
        node_step = (
            "set -euo pipefail; "
            "if ! command -v node >/dev/null 2>&1; then "
            "  if ! command -v curl >/dev/null 2>&1; then "
            "    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; "
            "  fi; "
            "  curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node.tar.xz; "
            "  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; "
            "fi; "
            "node --version && npm --version"
        )
        # Only the global runtime is installed at build time. Profiles are built at run
        # time: the plugin tarball arrives with the bind mount, and the profile has to
        # belong to the user that will run dsh.
        steps = [
            InstallStep(user="root", env={"DEBIAN_FRONTEND": "noninteractive"}, run=node_step),
            InstallStep(
                user="root",
                run=(
                    f"npm i -g --no-audit --no-fund @deepseek-ai/dsh@{DSH_VERSION} "
                    "&& dsh --version"
                ),
            ),
        ]
        return AgentInstallSpec(
            agent_name=self.name(),
            version=DSH_VERSION,
            steps=steps,
            verification_command=self.get_version_command(),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        profile = PROFILE_TREATMENT if self.with_jev else PROFILE_CONTROL
        deepseek_key = os.environ.get("DEEPSEEK_API_KEY", "")
        typesafe_key = os.environ.get("TYPESAFE_API_KEY", "")
        credentials_b64 = os.environ.get("DSH_CREDENTIALS_YAML_B64", "")

        # Secrets travel as environment values, never inside a logged command line: Pier
        # echoes every command it runs, which is how the first two runs put the TypeSafe
        # key into trial.log.
        child_env = {
            "DEEPSEEK_API_KEY": deepseek_key,
            "TYPESAFE_API_KEY": typesafe_key,
            "DSH_CREDENTIALS_YAML_B64": credentials_b64,
            "HEADLESS": "true",
            "CI": "true",
        }
        setup_script = pilot_setup.wrapped_setup(profile, self.with_jev)
        await self.exec_as_agent(environment, command=setup_script, env=child_env)

        run_command = (
            "cd /app && "
            f"dsh --profile {profile} {shlex.quote(instruction)} "
            f"2>&1 </dev/null | tee /logs/agent/{OUTPUT_FILENAME}; "
            # Keep what Pier actually archives: the agent output and the plugin's counters.
            f"cp /logs/agent/{OUTPUT_FILENAME} /logs/artifacts/{OUTPUT_FILENAME} 2>/dev/null || true; "
            "cp ~/.dsh/jev-stats.json /logs/agent/jev-stats.json 2>/dev/null || true; "
            "cp ~/.dsh/jev-decisions.jsonl /logs/agent/jev-decisions.jsonl 2>/dev/null || true; "
            # The session transcript is the only place the real per-request model usage
            # exists (the CLI prints no summary), and pier's token fields stay empty
            # unless the agent reports them. Archive it so tokens/steps/tool calls can be
            # counted offline; it is a few hundred KB of zstd.
            "mkdir -p /logs/agent/sessions 2>/dev/null || true; "
            "find ~/.dsh/sessions -name 'session.v3.jsonl.zstd' -exec cp {} /logs/agent/sessions/ \\; 2>/dev/null || true; "
            "git config --global user.name 'dsh' 2>/dev/null || true; "
            "git config --global user.email 'dsh@deepseek.ai' 2>/dev/null || true; "
            "git add -A 2>/dev/null || true; "
            "git commit -m 'dsh solution' 2>/dev/null || true; "
            "LATEST_BRANCH=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/ | head -n 1); "
            'if [ -n "$LATEST_BRANCH" ]; then git checkout "$LATEST_BRANCH" 2>/dev/null || true; fi'
        )

        try:
            await self.exec_as_agent(environment, command=run_command, env=child_env)
        except Exception as error:  # keep the log; Pier grades the workspace, not the exit code
            self.logger.warning(f"Error executing dsh: {error}")

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / OUTPUT_FILENAME
        if not output_path.exists():
            return
        text = output_path.read_text(encoding="utf-8", errors="ignore")
        context.n_input_tokens = len(text.split())
        context.n_output_tokens = len(text.split())
