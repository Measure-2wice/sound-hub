import unittest
from unittest.mock import MagicMock

from scripts.ralph.qa import (
    QaCommand,
    QaError,
    QaRunner,
    QaStatus,
)
from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.workspace import TicketWorkspace


class QaRunnerTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = MagicMock()

        self.workspace = TicketWorkspace(
            repository_path="/tmp/sound-hub",
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
            base_sha="base123",
            ticket_sha="ticket123",
            resumed=False,
        )

        self.runner = QaRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
        )

    def test_all_commands_pass(self):
        self.sandbox.exec.side_effect = [
            SandboxCommandResult(
                exit_code=0,
                stdout="tests passed",
                stderr="",
            ),
            SandboxCommandResult(
                exit_code=0,
                stdout="typecheck passed",
                stderr="",
            ),
        ]

        result = self.runner.run(
            (
                QaCommand(
                    name="tests",
                    command="pnpm test",
                ),
                QaCommand(
                    name="typecheck",
                    command="pnpm type-check",
                ),
            )
        )

        self.assertTrue(result.passed)
        self.assertEqual(
            result.status,
            QaStatus.PASSED,
        )
        self.assertEqual(
            len(result.commands),
            2,
        )

    def test_test_failure_is_code_failure(self):
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=1,
                stdout="AssertionError: expected 4 got 5",
                stderr="",
            )
        )

        result = self.runner.run(
            (
                QaCommand(
                    name="tests",
                    command="pnpm test",
                ),
            )
        )

        self.assertEqual(
            result.status,
            QaStatus.CODE_FAILURE,
        )

    def test_connection_refused_is_infra_failure(self):
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=1,
                stdout="",
                stderr=(
                    "connect ECONNREFUSED "
                    "127.0.0.1:5433"
                ),
            )
        )

        result = self.runner.run(
            (
                QaCommand(
                    name="database tests",
                    command="pnpm test:db",
                ),
            )
        )

        self.assertEqual(
            result.status,
            QaStatus.INFRA_FAILURE,
        )

    def test_stops_after_first_failure(self):
        self.sandbox.exec.side_effect = [
            SandboxCommandResult(
                exit_code=1,
                stdout="test failed",
                stderr="",
            ),
            SandboxCommandResult(
                exit_code=0,
                stdout="should never run",
                stderr="",
            ),
        ]

        result = self.runner.run(
            (
                QaCommand(
                    name="tests",
                    command="pnpm test",
                ),
                QaCommand(
                    name="typecheck",
                    command="pnpm type-check",
                ),
            )
        )

        self.assertEqual(
            len(result.commands),
            1,
        )

        self.assertEqual(
            self.sandbox.exec.call_count,
            1,
        )

    def test_evidence_contains_command_results(self):
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout="42 tests passed",
                stderr="",
            )
        )

        result = self.runner.run(
            (
                QaCommand(
                    name="unit tests",
                    command="pnpm test",
                ),
            )
        )

        evidence = result.evidence()

        self.assertIn(
            "QA STATUS: PASSED",
            evidence,
        )
        self.assertIn(
            "unit tests",
            evidence,
        )
        self.assertIn(
            "42 tests passed",
            evidence,
        )

    def test_empty_plan_fails_closed(self):
        with self.assertRaises(QaError):
            self.runner.run(())


if __name__ == "__main__":
    unittest.main()