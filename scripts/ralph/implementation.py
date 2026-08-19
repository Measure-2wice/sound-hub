import base64
import json
from dataclasses import dataclass
from typing import Optional

from scripts.ralph.sandbox import (
    SandboxCommandResult,
    TenkiSandbox,
)
from scripts.ralph.workspace import TicketWorkspace


class ImplementationError(RuntimeError):
    """A Ralph implementation iteration could not be executed."""


@dataclass(frozen=True)
class ImplementationResult:
    exit_code: int
    session_id: Optional[str]
    num_turns: Optional[int]
    terminal_reason: Optional[str]
    stop_reason: Optional[str]
    is_error: bool
    result_text: str
    changed_files: tuple[str, ...]

    @property
    def exhausted(self) -> bool:
        return self.terminal_reason == "max_turns"


class ImplementationRunner:
    def __init__(
        self,
        *,
        sandbox: TenkiSandbox,
        workspace: TicketWorkspace,
        model: str = "MiniMax-M2.7",
        max_turns: int = 60,
    ):
        self.sandbox = sandbox
        self.workspace = workspace
        self.model = model
        self.max_turns = max_turns

    def run(
        self,
        *,
        issue_number: int,
        issue_title: str,
        issue_body: str,
        minimax_api_key: str,
    ) -> ImplementationResult:
        self._ensure_claude_code()

        packet_path = self._write_ticket_packet(
            issue_number=issue_number,
            issue_title=issue_title,
            issue_body=issue_body,
        )

        prompt = self._build_prompt(
            issue_number=issue_number,
            packet_path=packet_path,
        )

        command_result = self.sandbox.exec(
            "claude",
            "-p",
            prompt,
            "--output-format",
            "json",
            "--max-turns",
            str(self.max_turns),
            "--model",
            self.model,
            "--dangerously-skip-permissions",
            cwd=self.workspace.repository_path,
            env={
                "ANTHROPIC_BASE_URL": (
                    "https://api.minimax.io/anthropic"
                ),
                "ANTHROPIC_AUTH_TOKEN": minimax_api_key,
                "ANTHROPIC_MODEL": self.model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": self.model,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": self.model,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": self.model,
                "API_TIMEOUT_MS": "3000000",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            },
        )

        changed_files = self._changed_files()

        return self._parse_result(
            command_result,
            changed_files=changed_files,
        )

    def _ensure_claude_code(self) -> None:
        result = self.sandbox.exec(
            "bash",
            "-lc",
            """
set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code
fi

claude --version
""",
        )

        if result.exit_code != 0:
            raise ImplementationError(
                "Unable to install or locate Claude Code.\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

    def _write_ticket_packet(
        self,
        *,
        issue_number: int,
        issue_title: str,
        issue_body: str,
    ) -> str:
        packet_path = (
            f"/tmp/ralph-issue-{issue_number}.md"
        )

        packet = (
            f"# GitHub Issue #{issue_number}\n\n"
            f"## Title\n\n{issue_title}\n\n"
            f"## Current authoritative issue body\n\n"
            f"{issue_body}\n"
        )

        encoded = base64.b64encode(
            packet.encode("utf-8")
        ).decode("ascii")

        result = self.sandbox.exec(
            "python3",
            "-c",
            (
                "import base64, os; "
                f"open({packet_path!r}, 'wb').write("
                "base64.b64decode("
                "os.environ['RALPH_PACKET_B64']))"
            ),
            env={
                "RALPH_PACKET_B64": encoded,
            },
        )

        if result.exit_code != 0:
            raise ImplementationError(
                "Unable to write Ralph ticket packet."
            )

        return packet_path

    def _build_prompt(
        self,
        *,
        issue_number: int,
        packet_path: str,
    ) -> str:
        return f"""
You are the Ralph implementation agent for SoundHub issue #{issue_number}.

The repository and correct ticket branch are already prepared for you.

Read {packet_path} first. It contains the CURRENT authoritative GitHub issue.

Then inspect only the durable repository context necessary to implement that
ticket, including AGENTS.md, CLAUDE.md, specifications, ADRs, tests, and
existing implementation where relevant.

Rules:

- Implement only the current ticket boundary.
- Preserve already-correct work on this branch.
- Do not redesign unrelated architecture.
- Do not expand scope beyond the current issue or accepted architecture.
- Do not push, merge, rebase, reset, switch branches, or close GitHub issues.
- Do not create pull requests.
- Do not modify GitHub configuration or credentials.
- Run focused validation for the implementation.
- Leave all implementation changes in the working tree.
- Do not create a git commit. The Ralph controller owns persistence.
- If durable repository evidence shows the ticket is already satisfied,
  make no speculative changes.
- If implementation is blocked by an unresolved decision, stop rather than
  inventing one.

Before finishing:
1. inspect git diff,
2. inspect git status,
3. run the focused validation appropriate to the ticket.

Your final response must concisely state:
- what you changed,
- validation performed,
- any blocker,
- whether the implementation is complete.
""".strip()

    def _changed_files(self) -> tuple[str, ...]:
        result = self.sandbox.exec(
            "git",
            "status",
            "--porcelain",
            cwd=self.workspace.repository_path,
        )

        if result.exit_code != 0:
            raise ImplementationError(
                "Unable to inspect implementation working tree."
            )

        files = []

        for line in result.stdout.splitlines():
            if len(line) < 4:
                continue

            path = line[3:].strip()

            if path:
                files.append(path)

        return tuple(files)

    @staticmethod
    def _parse_result(
        result: SandboxCommandResult,
        *,
        changed_files: tuple[str, ...],
    ) -> ImplementationResult:
        payload = {}

        if result.stdout.strip():
            try:
                payload = json.loads(result.stdout)
            except json.JSONDecodeError:
                payload = {}

        return ImplementationResult(
            exit_code=result.exit_code,
            session_id=payload.get("session_id"),
            num_turns=payload.get("num_turns"),
            terminal_reason=payload.get(
                "terminal_reason"
            ),
            stop_reason=payload.get("stop_reason"),
            is_error=bool(
                payload.get("is_error")
                or result.exit_code != 0
            ),
            result_text=str(
                payload.get("result")
                or result.stdout
                or ""
            ),
            changed_files=changed_files,
        )
