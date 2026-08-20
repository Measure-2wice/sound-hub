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
            result = self._run_command(
                command,
                env=env,
            )

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