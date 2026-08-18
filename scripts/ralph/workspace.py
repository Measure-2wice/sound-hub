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


class WorkspacePreparationError(RuntimeError):
    pass


class TicketWorkspaceManager:
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

        branch = self._extract_value(
            result,
            "RALPH_TICKET_BRANCH",
        )

        if branch != ticket_branch:
            raise WorkspacePreparationError(
                "Prepared branch does not match "
                f"expected ticket branch: {branch}"
            )

        return TicketWorkspace(
            repository_path=self.repository_path,
            integration_branch=self.integration_branch,
            ticket_branch=ticket_branch,
            base_sha=base_sha,
        )

    def _prepare_script(
        self,
        ticket_branch: str,
        expected_base_sha: Optional[str],
    ) -> str:
        expected = expected_base_sha or ""

        return f"""
set -euo pipefail

rm -rf {self.repository_path}

git clone \
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

git switch -c {ticket_branch}

corepack enable
pnpm install --frozen-lockfile

test "$(git branch --show-current)" = "{ticket_branch}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Workspace is dirty after bootstrap:" >&2
  git status --short >&2
  exit 43
fi

echo "RALPH_BASE_SHA=$base_sha"
echo "RALPH_TICKET_BRANCH=$(git branch --show-current)"
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
