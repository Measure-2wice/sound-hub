import base64
import json
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from scripts.ralph.sandbox import (
    SandboxCommandResult,
    TenkiSandbox,
)
from scripts.ralph.workspace import TicketWorkspace


class ImplementationError(RuntimeError):
    """A Ralph implementation iteration could not be executed."""


class CompletionStatus(str, Enum):
    COMPLETE = "COMPLETE"
    BLOCKED = "BLOCKED"


@dataclass(frozen=True)
class ImplementationFixContext:
    """Defect material layered on top of the authoritative issue.

    The issue body remains the specification.
    Findings/evidence describe defects to repair within that specification.
    """

    reviewer_findings: Optional[str] = None
    qa_failure_evidence: Optional[str] = None
    pre_persistence_findings: Optional[str] = None

    def has_any(self) -> bool:
        return any(
            value
            for value in (
                self.reviewer_findings,
                self.qa_failure_evidence,
                self.pre_persistence_findings,
            )
        )


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

    completion_status: CompletionStatus
    completion_summary: Optional[str]
    completion_validation: Optional[str]
    completion_blocker: Optional[str]

    @property
    def exhausted(self) -> bool:
        return self.terminal_reason == "max_turns"

    @property
    def is_blocked(self) -> bool:
        return self.completion_status == CompletionStatus.BLOCKED


COMPLETION_RESULT_PATH_TEMPLATE = (
    "/tmp/ralph-implementation-result-{issue}-"
    "{phase}-{attempt}.json"
)


class CompletionPhase(str, Enum):
    IMPLEMENTATION = "implementation"
    FIX = "fix"


def completion_result_path(
    *,
    issue_number: int,
    phase: str,
    attempt: int,
) -> str:
    """Per-attempt, per-phase completion file path.

    Every iteration gets its own file, with the phase included in
    the path, so:

      - initial implementation attempt 1
        -> /tmp/ralph-implementation-result-17-implementation-1.json
      - fix attempt 1
        -> /tmp/ralph-implementation-result-17-fix-1.json

    never collide. The conductor never reads a completion file
    from a phase other than the one currently active.
    """
    return COMPLETION_RESULT_PATH_TEMPLATE.format(
        issue=issue_number,
        phase=phase,
        attempt=attempt,
    )


class ImplementationRunner:
    def __init__(
        self,
        *,
        sandbox: TenkiSandbox,
        workspace: TicketWorkspace,
        model: str = "MiniMax-M2.7",
        max_turns: int = 60,
        attempt: int = 1,
        phase: CompletionPhase = (
            CompletionPhase.IMPLEMENTATION
        ),
    ):
        self.sandbox = sandbox
        self.workspace = workspace
        self.model = model
        self.max_turns = max_turns
        self.attempt = attempt
        self.phase = phase

    def run(
        self,
        *,
        issue_number: int,
        issue_title: str,
        issue_body: str,
        minimax_api_key: str,
        fix_context: Optional[ImplementationFixContext] = None,
    ) -> ImplementationResult:
        self._ensure_claude_code()

        packet_path = self._write_ticket_packet(
            issue_number=issue_number,
            issue_title=issue_title,
            issue_body=issue_body,
            fix_context=fix_context,
        )

        completion_path = completion_result_path(
            issue_number=issue_number,
            phase=self.phase.value,
            attempt=self.attempt,
        )

        prompt = self._build_prompt(
            issue_number=issue_number,
            packet_path=packet_path,
            completion_path=completion_path,
            fix_context=fix_context,
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

        base = self._parse_result(
            command_result,
            changed_files=changed_files,
        )

        completion = self._read_completion(
            completion_path=completion_path,
            issue_number=issue_number,
        )

        return ImplementationResult(
            exit_code=base.exit_code,
            session_id=base.session_id,
            num_turns=base.num_turns,
            terminal_reason=base.terminal_reason,
            stop_reason=base.stop_reason,
            is_error=base.is_error,
            result_text=base.result_text,
            changed_files=base.changed_files,
            completion_status=completion.status,
            completion_summary=completion.summary,
            completion_validation=completion.validation,
            completion_blocker=completion.blocker,
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
        fix_context: Optional[ImplementationFixContext],
    ) -> str:
        packet_path = (
            f"/tmp/ralph-issue-{issue_number}.md"
        )

        sections = [
            f"# GitHub Issue #{issue_number}",
            "",
            "## Title",
            "",
            issue_title,
            "",
            "## Current authoritative issue body",
            "",
            issue_body,
        ]

        if (
            fix_context is not None
            and fix_context.has_any()
        ):
            sections.extend(
                self._fix_context_sections(fix_context)
            )

        packet = "\n".join(sections) + "\n"

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

    @staticmethod
    def _fix_context_sections(
        fix_context: ImplementationFixContext,
    ) -> list[str]:
        sections = [
            "",
            "## Defects to repair",
            "",
            (
                "These defects describe the repair scope "
                "for THIS iteration only."
            ),
            (
                "The authoritative issue above remains the "
                "specification."
            ),
            (
                "Do NOT expand scope beyond the original "
                "issue to address defects."
            ),
            "",
        ]

        if fix_context.reviewer_findings:
            sections.extend(
                [
                    "### PRE_QA reviewer findings",
                    "",
                    fix_context.reviewer_findings,
                    "",
                ]
            )

        if fix_context.qa_failure_evidence:
            sections.extend(
                [
                    "### Automated QA failure evidence",
                    "",
                    fix_context.qa_failure_evidence,
                    "",
                ]
            )

        if fix_context.pre_persistence_findings:
            sections.extend(
                [
                    "### PRE_PERSISTENCE reviewer findings",
                    "",
                    fix_context.pre_persistence_findings,
                    "",
                ]
            )

        return sections

    def _build_prompt(
        self,
        *,
        issue_number: int,
        packet_path: str,
        completion_path: str,
        fix_context: Optional[ImplementationFixContext],
    ) -> str:
        iteration_label = (
            "fix iteration"
            if (
                fix_context is not None
                and fix_context.has_any()
            )
            else "initial implementation"
        )

        completion_instructions = f"""
Before finishing you MUST write a single machine-readable JSON file at:

    {completion_path}

The JSON object MUST have exactly this shape:

    {{
      "status": "COMPLETE" | "BLOCKED",
      "summary": "one-paragraph description of work done",
      "validation": "what you ran / observed to validate",
      "blocker": null | "explicit unresolved decision"
    }}

All FOUR keys MUST be present. No extra keys.

Rules:

- status "COMPLETE" means the implementation satisfies the
  authoritative issue body. Use it only when validation passes.
  "summary" and "validation" MUST be non-empty strings.
  "blocker" MUST be present and strictly null. If you write a
  string into "blocker", Ralph will fail closed.
- status "BLOCKED" means an unresolved decision blocks progress.
  "blocker" MUST be a non-empty string explaining the decision.
  "summary" and "validation" MUST be non-empty strings too.
- "validation" describes focused validation actually performed
  (commands run, observations made). Do not fabricate validation.
- The object MUST contain EXACTLY the four keys above. Extra keys
  or missing keys are an error and Ralph will fail closed.
- Writing the file is REQUIRED. Ralph will fail closed if the file
  is missing, malformed, contains an unknown status, contains an
  empty required string, contains extra or missing keys, or has
  the wrong type for any field.
""".strip()

        rules_block = """
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
""".strip()

        before_finishing = """
Before finishing:
1. inspect git diff,
2. inspect git status,
3. run the focused validation appropriate to the ticket,
4. write the machine-readable completion JSON file described above.
""".strip()

        prompt_lines = [
            f"You are the Ralph implementation agent for SoundHub issue #{issue_number}.",
            "",
            f"This is a {iteration_label}.",
            "",
            "The repository and correct ticket branch are already prepared for you.",
            "",
            f"Read {packet_path} first. It contains the CURRENT authoritative GitHub issue",
            "and, if present, the specific defects to repair in this iteration.",
            "",
            "Then inspect only the durable repository context necessary to implement that",
            "ticket, including AGENTS.md, CLAUDE.md, specifications, ADRs, tests, and",
            "existing implementation where relevant.",
            "",
            rules_block,
            "",
            before_finishing,
            "",
            completion_instructions,
        ]

        return "\n".join(prompt_lines)

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

    def _read_completion(
        self,
        *,
        completion_path: str,
        issue_number: int,
    ) -> "_Completion":
        result = self.sandbox.exec(
            "bash",
            "-lc",
            (
                "if [ -f \"$RALPH_COMPLETION_PATH\" ]; then\n"
                "  cat \"$RALPH_COMPLETION_PATH\"\n"
                "else\n"
                "  echo \"__RALPH_COMPLETION_MISSING__\"\n"
                "fi\n"
            ),
            env={
                "RALPH_COMPLETION_PATH": completion_path,
            },
        )

        if result.exit_code != 0:
            return _Completion(
                status=CompletionStatus.BLOCKED,
                summary=None,
                validation=None,
                blocker=(
                    f"Unable to read completion file for "
                    f"issue #{issue_number}."
                ),
            )

        raw = result.stdout.strip()

        if raw == "__RALPH_COMPLETION_MISSING__":
            return _Completion(
                status=CompletionStatus.BLOCKED,
                summary=None,
                validation=None,
                blocker=(
                    f"Implementation agent did not write "
                    f"{completion_path} for issue "
                    f"#{issue_number}."
                ),
            )

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return _Completion(
                status=CompletionStatus.BLOCKED,
                summary=None,
                validation=None,
                blocker=(
                    "Implementation completion file was "
                    "malformed JSON."
                ),
            )

        return parse_completion(
            payload=payload,
            issue_number=issue_number,
            completion_path=completion_path,
        )

    @staticmethod
    def _parse_result(
        result: SandboxCommandResult,
        *,
        changed_files: tuple[str, ...],
    ) -> "ImplementationResult":
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
            completion_status=CompletionStatus.BLOCKED,
            completion_summary=None,
            completion_validation=None,
            completion_blocker=(
                "Completion file not yet parsed."
            ),
        )


@dataclass(frozen=True)
class _Completion:
    status: CompletionStatus
    summary: Optional[str]
    validation: Optional[str]
    blocker: Optional[str]


_ALLOWED_KEYS = {"status", "summary", "validation", "blocker"}
_REQUIRED_KEYS = _ALLOWED_KEYS


def _coerce_string(
    value,
    *,
    field: str,
) -> Optional[str]:
    """Strictly coerce a JSON field to a string.

    Returns the string itself for any string value (including
    empty), ``None`` for explicit JSON null, and raises
    ``ValueError`` for any other type so the strict schema rejects
    wrong-type payloads.

    An empty string is preserved (NOT collapsed to None) because
    the schema explicitly distinguishes "empty string" from
    "missing key" — completeness is decided by presence, not by
    truthiness.
    """
    if value is None:
        return None

    if isinstance(value, str):
        return value

    raise ValueError(
        f"field {field!r}: expected string or null, "
        f"got {type(value).__name__}"
    )


def parse_completion(
    *,
    payload,
    issue_number: int,
    completion_path: str,
) -> _Completion:
    """Strictly parse the agent's completion file.

    Schema is exactly four keys:

        { "status", "summary", "validation", "blocker" }

    Reject:
      - unknown status
      - extra unexpected keys
      - missing required fields (every key MUST be present)
      - wrong types (every value MUST be string or null)
      - empty required strings
      - COMPLETE with non-null ``blocker``
    """

    if not isinstance(payload, dict):
        return _Completion(
            status=CompletionStatus.BLOCKED,
            summary=None,
            validation=None,
            blocker=(
                "Implementation completion file was not "
                "a JSON object."
            ),
        )

    keys = set(payload.keys())

    if keys != _REQUIRED_KEYS:
        missing = _REQUIRED_KEYS - keys
        extra = keys - _REQUIRED_KEYS

        problems = []

        if missing:
            problems.append(
                f"missing keys: {sorted(missing)}"
            )
        if extra:
            problems.append(
                f"unexpected keys: {sorted(extra)}"
            )

        return _Completion(
            status=CompletionStatus.BLOCKED,
            summary=None,
            validation=None,
            blocker=(
                "Implementation completion file did not "
                "match the strict four-key schema "
                f"({'; '.join(problems)}); expected exactly "
                f"{sorted(_REQUIRED_KEYS)}."
            ),
        )

    raw_status = payload.get("status")

    try:
        status = CompletionStatus(raw_status)
    except (ValueError, TypeError):
        return _Completion(
            status=CompletionStatus.BLOCKED,
            summary=None,
            validation=None,
            blocker=(
                f"Implementation completion file had "
                f"unknown status: {raw_status!r}."
            ),
        )

    try:
        summary = _coerce_string(
            payload.get("summary"),
            field="summary",
        )
        validation = _coerce_string(
            payload.get("validation"),
            field="validation",
        )
        blocker = _coerce_string(
            payload.get("blocker"),
            field="blocker",
        )
    except ValueError as error:
        return _Completion(
            status=CompletionStatus.BLOCKED,
            summary=None,
            validation=None,
            blocker=(
                f"Implementation completion file had "
                f"wrong field type: {error}."
            ),
        )

    if status == CompletionStatus.COMPLETE:
        # COMPLETE: blocker MUST be present and exactly null.
        if blocker is not None:
            return _Completion(
                status=CompletionStatus.BLOCKED,
                summary=summary,
                validation=validation,
                blocker=(
                    "Implementation completion file with "
                    "status COMPLETE must have blocker "
                    "strictly equal to null."
                ),
            )

        missing_strings = []

        if not summary or not summary.strip():
            missing_strings.append("summary")
        if not validation or not validation.strip():
            missing_strings.append("validation")

        if missing_strings:
            return _Completion(
                status=CompletionStatus.BLOCKED,
                summary=summary,
                validation=validation,
                blocker=(
                    "Implementation completion file with "
                    "status COMPLETE was missing or empty "
                    f"required fields: "
                    f"{sorted(missing_strings)}."
                ),
            )

    elif status == CompletionStatus.BLOCKED:
        missing_strings = []

        if not summary or not summary.strip():
            missing_strings.append("summary")
        if not validation or not validation.strip():
            missing_strings.append("validation")
        if not blocker or not blocker.strip():
            missing_strings.append("blocker")

        if missing_strings:
            return _Completion(
                status=CompletionStatus.BLOCKED,
                summary=summary,
                validation=validation,
                blocker=(
                    "Implementation completion file with "
                    "status BLOCKED was missing or empty "
                    f"required fields: "
                    f"{sorted(missing_strings)}."
                ),
            )

    return _Completion(
        status=status,
        summary=summary,
        validation=validation,
        blocker=blocker,
    )
