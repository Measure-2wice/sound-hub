import re
from dataclasses import dataclass
from enum import Enum
from typing import Mapping, Optional

from scripts.ralph.sandbox import TenkiSandbox
from scripts.ralph.workspace import TicketWorkspace


class QaError(RuntimeError):
    pass


class QaStatus(str, Enum):
    PASSED = "PASSED"
    CODE_FAILURE = "CODE_FAILURE"
    INFRA_FAILURE = "INFRA_FAILURE"


# Console-output trust boundary
# ---------------------------------------------------------------------------
#
# QA command ``name`` values come from the milestone
# configuration and are intended to be short identifiers
# ("format-check", "ralph-smoke").  They are NOT arbitrary
# subprocess output.  Even so, we constrain the console
# projection to a small safe character set and length so:
#
#   - a misconfigured name cannot inject ANSI escapes or
#     control characters into the operator's terminal,
#   - a future review surface (e.g. an internal Slack
#     bridge) never inherits a longer, attacker-controlled
#     string by accident.
#
# No subprocess stdout, stderr, command text, or
# environment variable is ever projected to the console
# by QaRunner.
_QA_NAME_SAFE_RE = re.compile(r"[^A-Za-z0-9_.\-]")


def _sanitize_qa_name(name: str) -> str:
    """Project a configured QA command name to a
    console-safe identifier.

    - Replaces every disallowed character with ``_``.
    - Truncates to a 32-character cap.
    - Returns ``"<unnamed>"`` for an empty result.
    """
    if not name:
        return "<unnamed>"

    cleaned = _QA_NAME_SAFE_RE.sub("_", name)
    cleaned = cleaned[:32]

    if not cleaned:
        return "<unnamed>"

    return cleaned


# Operator-facing QA status label.
#
# The internal ``QaStatus`` enum keeps the word
# ``PASSED`` for symmetry with the failure names
# (``CODE_FAILURE``, ``INFRA_FAILURE``).  The operator
# console, however, must use the short token ``PASS``
# to match the contract in the Ralph observability
# spec.
#
# This is a presentation-only mapping.  It MUST NOT
# change ``QaStatus`` semantics, the QA evidence
# format, the ``last_error`` text, the checkpoint
# schema, or any state-machine transitions.
_QA_STATUS_LABELS: dict = {
    QaStatus.PASSED: "PASS",
    QaStatus.CODE_FAILURE: "CODE_FAILURE",
    QaStatus.INFRA_FAILURE: "INFRA_FAILURE",
}


def _qa_status_label(status: "QaStatus") -> str:
    """Return the operator-facing console label for a
    ``QaStatus``.  Falls back to the enum value if a
    future status is added before its label is wired
    in, so the console never silently drops a status.
    """
    return _QA_STATUS_LABELS.get(status, status.value)


def _announce_qa_start(name: str) -> None:
    print(
        f"RALPH QA: starting {_sanitize_qa_name(name)}",
        flush=True,
    )


def _announce_qa_result(
    name: str,
    status: "QaStatus",
) -> None:
    print(
        f"RALPH QA: {_sanitize_qa_name(name)} "
        f"-> {_qa_status_label(status)}",
        flush=True,
    )


@dataclass(frozen=True)
class QaCommand:
    name: str
    command: str
    timeout_seconds: int = 900


@dataclass(frozen=True)
class QaCommandResult:
    name: str
    command: str
    exit_code: int
    stdout: str
    stderr: str
    status: QaStatus


@dataclass(frozen=True)
class QaResult:
    status: QaStatus
    commands: tuple[QaCommandResult, ...]

    @property
    def passed(self) -> bool:
        return self.status == QaStatus.PASSED

    def evidence(self) -> str:
        lines = [
            f"QA STATUS: {self.status.value}",
            "",
        ]

        for command in self.commands:
            lines.extend(
                [
                    f"## {command.name}",
                    f"Command: {command.command}",
                    f"Exit code: {command.exit_code}",
                    f"Status: {command.status.value}",
                    "",
                    "STDOUT:",
                    command.stdout.strip() or "(empty)",
                    "",
                    "STDERR:",
                    command.stderr.strip() or "(empty)",
                    "",
                ]
            )

        return "\n".join(lines)


class QaRunner:
    def __init__(
        self,
        sandbox: TenkiSandbox,
        workspace: TicketWorkspace,
    ):
        self.sandbox = sandbox
        self.workspace = workspace

    def run(
        self,
        commands: tuple[QaCommand, ...],
        *,
        env: Optional[Mapping[str, str]] = None,
    ) -> QaResult:
        if not commands:
            raise QaError(
                "QA requires at least one command."
            )

        results = []

        for command in commands:
            _announce_qa_start(command.name)

            result = self._run_command(
                command,
                env=env,
            )

            _announce_qa_result(command.name, result.status)

            results.append(result)

            if result.status != QaStatus.PASSED:
                return QaResult(
                    status=result.status,
                    commands=tuple(results),
                )

        return QaResult(
            status=QaStatus.PASSED,
            commands=tuple(results),
        )

    def _run_command(
        self,
        command: QaCommand,
        *,
        env: Optional[Mapping[str, str]],
    ) -> QaCommandResult:
        result = self.sandbox.exec(
            "bash",
            "-lc",
            command.command,
            cwd=self.workspace.repository_path,
            env=dict(env or {}),
            timeout=command.timeout_seconds,
        )

        if result.exit_code == 0:
            status = QaStatus.PASSED
        else:
            status = self._classify_failure(
                stdout=result.stdout,
                stderr=result.stderr,
            )

        return QaCommandResult(
            name=command.name,
            command=command.command,
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
            status=status,
        )

    @staticmethod
    def _classify_failure(
        *,
        stdout: str,
        stderr: str,
    ) -> QaStatus:
        text = (
            stdout + "\n" + stderr
        ).lower()

        infrastructure_signals = (
            "connection refused",
            "could not connect",
            "connection timed out",
            "network is unreachable",
            "temporary failure in name resolution",
            "no space left on device",
            "cannot connect to the docker daemon",
            "database system is starting up",
            "database is unavailable",
            "econnrefused",
        )

        if any(
            signal in text
            for signal in infrastructure_signals
        ):
            return QaStatus.INFRA_FAILURE

        return QaStatus.CODE_FAILURE