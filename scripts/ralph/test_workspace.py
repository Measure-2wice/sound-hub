import unittest
from unittest.mock import MagicMock

from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.workspace import (
    TicketWorkspaceManager,
    WorkspacePreparationError,
)


class TicketWorkspaceManagerTests(unittest.TestCase):
    def test_prepares_ticket_branch(self):
        sandbox = MagicMock()

        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                "RALPH_BASE_SHA=abc123\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
            ),
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url=(
                "https://github.com/Measure-2wice/"
                "sound-hub.git"
            ),
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        workspace = manager.prepare(
            issue_number=16,
            expected_base_sha="abc123",
        )

        self.assertEqual(
            workspace.base_sha,
            "abc123",
        )
        self.assertEqual(
            workspace.ticket_branch,
            "ralph/m2-16",
        )

    def test_failed_bootstrap_raises(self):
        sandbox = MagicMock()

        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=42,
            stdout="",
            stderr="base SHA mismatch",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url="repo",
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        with self.assertRaises(
            WorkspacePreparationError
        ):
            manager.prepare(
                issue_number=16,
                expected_base_sha="expected",
            )

    def test_missing_result_marker_raises(self):
        sandbox = MagicMock()

        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="some unrelated output\n",
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url="repo",
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        with self.assertRaises(
            WorkspacePreparationError
        ):
            manager.prepare(16)


if __name__ == "__main__":
    unittest.main()
