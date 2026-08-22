from dataclasses import dataclass
from typing import Optional

from scripts.ralph.sandbox import (
    SandboxCommandResult,
    TenkiSandbox,
)


@dataclass(frozen=True)
class TicketWorkspace:
    repository_path: str
    integration_branch: str
    ticket_branch: str
    base_sha: str
    ticket_sha: str
    resumed: bool


class WorkspacePreparationError(RuntimeError):
    pass


class TicketWorkspaceManager:
    """Prepare a fresh Ralph ticket workspace inside a Tenki sandbox.

    Authentication invariant:

    - The git remote is private and must be cloned/fetched using the
      GitHub App installation token minted at the boundary, never
      via the human's ambient credentials.
    - The token never appears in command text or in any logged
      ``env`` payload — it is delivered through an ephemeral
      ``GIT_ASKPASS`` helper that the script writes and removes
      inside the sandbox.
    - ``GIT_TERMINAL_PROMPT=0`` is set so git never falls back to
      interactive prompts.
    """

    def __init__(
        self,
        sandbox: TenkiSandbox,
        repository_url: str,
        integration_branch: str,
        ticket_branch_prefix: str,
        repository_path: str = "/tmp/sound-hub",
    ):
        self.sandbox = sandbox
        self.repository_url = repository_url
        self.integration_branch = integration_branch
        self.ticket_branch_prefix = ticket_branch_prefix
        self.repository_path = repository_path

    def prepare(
        self,
        issue_number: int,
        expected_base_sha: Optional[str] = None,
        *,
        github_token: Optional[str] = None,
    ) -> TicketWorkspace:
        ticket_branch = (
            f"{self.ticket_branch_prefix}{issue_number}"
        )

        result = self.sandbox.exec(
            "bash",
            "-lc",
            self._prepare_script(
                ticket_branch=ticket_branch,
                expected_base_sha=expected_base_sha,
            ),
            env=self._auth_env(github_token=github_token),
        )

        if result.exit_code != 0:
            raise WorkspacePreparationError(
                "Failed to prepare Ralph ticket workspace.\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        base_sha = self._extract_value(
            result,
            "RALPH_BASE_SHA",
        )

        ticket_sha = self._extract_value(
            result,
            "RALPH_TICKET_SHA",
        )

        branch = self._extract_value(
            result,
            "RALPH_TICKET_BRANCH",
        )

        mode = self._extract_value(
            result,
            "RALPH_WORKSPACE_MODE",
        )

        if branch != ticket_branch:
            raise WorkspacePreparationError(
                "Prepared branch does not match "
                f"expected ticket branch: {branch}"
            )

        if mode not in {"CREATED", "RESUMED"}:
            raise WorkspacePreparationError(
                f"Unknown Ralph workspace mode: {mode}"
            )

        return TicketWorkspace(
            repository_path=self.repository_path,
            integration_branch=self.integration_branch,
            ticket_branch=ticket_branch,
            base_sha=base_sha,
            ticket_sha=ticket_sha,
            resumed=(mode == "RESUMED"),
        )

    def _auth_env(
        self,
        *,
        github_token: Optional[str],
    ) -> dict[str, str]:
        """Environment for the prepare script.

        The token is delivered through an ephemeral askpass helper.
        ``GIT_TERMINAL_PROMPT=0`` blocks interactive fallback so
        a wrong/missing token fails closed rather than hanging.
        """
        env = {
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "/tmp/ralph-git-askpass",
        }

        if github_token:
            env["RALPH_GITHUB_TOKEN"] = github_token

        return env

    def _prepare_script(
        self,
        ticket_branch: str,
        expected_base_sha: Optional[str],
    ) -> str:
        expected = expected_base_sha or ""

        return f"""
set -euo pipefail

# --- Ephemeral git credential helper -------------------------------
# Writes a per-invocation askpass that returns the installation token
# when git asks for it. Removed on exit so the token is never left
# behind in the sandbox filesystem.

cat > /tmp/ralph-git-askpass <<'EOF'
#!/bin/sh
case "$1" in
    *Username*)
        printf '%s\n' "x-access-token"
        ;;
    *Password*)
        if [ -n "${{RALPH_GITHUB_TOKEN:-}}" ]; then
            printf '%s\n' "$RALPH_GITHUB_TOKEN"
        else
            exit 1
        fi
        ;;
    *)
        exit 1
        ;;
esac
EOF

chmod 700 /tmp/ralph-git-askpass

cleanup() {{
    rm -f /tmp/ralph-git-askpass
}}

trap cleanup EXIT

# -------------------------------------------------------------------

rm -rf {self.repository_path}

git -c credential.helper= \
    -c core.askPass=/tmp/ralph-git-askpass \
    clone \
      --branch {self.integration_branch} \
      --single-branch \
      {self.repository_url} \
      {self.repository_path}

cd {self.repository_path}

base_sha="$(git rev-parse HEAD)"

if [ -n "{expected}" ] && [ "$base_sha" != "{expected}" ]; then
  echo "Expected base SHA: {expected}" >&2
  echo "Actual base SHA:   $base_sha" >&2
  exit 42
fi

if git ls-remote \
  --exit-code \
  --heads \
  origin \
  "refs/heads/{ticket_branch}" \
  >/dev/null 2>&1
then
  git remote set-branches \
    --add \
    origin \
    "{ticket_branch}"

  git -c credential.helper= \
      -c core.askPass=/tmp/ralph-git-askpass \
      fetch \
      origin \
      "{ticket_branch}"

  git switch \
    --track \
    -c "{ticket_branch}" \
    "origin/{ticket_branch}"

  workspace_mode="RESUMED"
else
  git switch -c "{ticket_branch}"
  workspace_mode="CREATED"
fi

corepack enable
pnpm install --frozen-lockfile

test "$(git branch --show-current)" = "{ticket_branch}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Workspace is dirty after bootstrap:" >&2
  git status --short >&2
  exit 43
fi

ticket_sha="$(git rev-parse HEAD)"

echo "RALPH_BASE_SHA=$base_sha"
echo "RALPH_TICKET_SHA=$ticket_sha"
echo "RALPH_TICKET_BRANCH=$(git branch --show-current)"
echo "RALPH_WORKSPACE_MODE=$workspace_mode"
"""

    @staticmethod
    def _extract_value(
        result: SandboxCommandResult,
        key: str,
    ) -> str:
        prefix = f"{key}="

        for line in result.stdout.splitlines():
            if line.startswith(prefix):
                return line[len(prefix):].strip()

        raise WorkspacePreparationError(
            f"Missing {key} in workspace preparation output."
        )
