import unittest
from unittest.mock import MagicMock

from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.workspace import (
    TicketWorkspaceManager,
    WorkspacePreparationError,
)


class TicketWorkspaceManagerTests(unittest.TestCase):
    def test_prepares_new_ticket_branch(self):
        sandbox = MagicMock()

        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                "RALPH_BASE_SHA=abc123\n"
                "RALPH_TICKET_SHA=abc123\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
                "RALPH_WORKSPACE_MODE=CREATED\n"
            ),
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url=(
                "https://github.com/"
                "Measure-2wice/sound-hub.git"
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
            workspace.ticket_sha,
            "abc123",
        )
        self.assertEqual(
            workspace.ticket_branch,
            "ralph/m2-16",
        )
        self.assertFalse(workspace.resumed)

    def test_resumes_existing_ticket_branch(self):
        sandbox = MagicMock()

        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                "RALPH_BASE_SHA=base123\n"
                "RALPH_TICKET_SHA=ticket456\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
                "RALPH_WORKSPACE_MODE=RESUMED\n"
            ),
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url=(
                "https://github.com/"
                "Measure-2wice/sound-hub.git"
            ),
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        workspace = manager.prepare(
            issue_number=16,
        )

        self.assertEqual(
            workspace.base_sha,
            "base123",
        )
        self.assertEqual(
            workspace.ticket_sha,
            "ticket456",
        )
        self.assertEqual(
            workspace.ticket_branch,
            "ralph/m2-16",
        )
        self.assertTrue(workspace.resumed)

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
            stdout=(
                "RALPH_BASE_SHA=abc123\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
            ),
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

    def test_resume_configures_ticket_as_remote_branch(self):
        sandbox = MagicMock()

        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                "RALPH_BASE_SHA=base123\n"
                "RALPH_TICKET_SHA=ticket456\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
                "RALPH_WORKSPACE_MODE=RESUMED\n"
            ),
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url="repo",
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        manager.prepare(16)

        script = sandbox.exec.call_args.args[2]

        normalized_script = " ".join(script.split())

        self.assertIn(
            'git remote set-branches --add origin "ralph/m2-16"',
            normalized_script,
        )

    def test_prepare_passes_token_to_sandbox_not_command(self):
        """The installation token must be delivered via env (askpass
        mechanism) and must NOT appear in the executed command text."""
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                "RALPH_BASE_SHA=abc123\n"
                "RALPH_TICKET_SHA=abc123\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
                "RALPH_WORKSPACE_MODE=CREATED\n"
            ),
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url="repo",
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        manager.prepare(
            16,
            github_token="ghs_super_secret",
        )

        # Token is delivered through env, not as a CLI arg.
        kwargs = sandbox.exec.call_args.kwargs
        self.assertEqual(
            kwargs["env"]["RALPH_GITHUB_TOKEN"],
            "ghs_super_secret",
        )

        # Token never appears in the command text.
        for arg in sandbox.exec.call_args.args:
            self.assertNotIn(
                "ghs_super_secret",
                str(arg),
            )

    def test_prepare_disables_terminal_prompt(self):
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                "RALPH_BASE_SHA=abc123\n"
                "RALPH_TICKET_SHA=abc123\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
                "RALPH_WORKSPACE_MODE=CREATED\n"
            ),
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url="repo",
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        manager.prepare(16, github_token="t")

        env = sandbox.exec.call_args.kwargs["env"]
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(env["GIT_ASKPASS"], "/tmp/ralph-git-askpass")

    def test_prepare_script_uses_ephemeral_askpass_helper(self):
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                "RALPH_BASE_SHA=abc123\n"
                "RALPH_TICKET_SHA=abc123\n"
                "RALPH_TICKET_BRANCH=ralph/m2-16\n"
                "RALPH_WORKSPACE_MODE=CREATED\n"
            ),
            stderr="",
        )

        manager = TicketWorkspaceManager(
            sandbox=sandbox,
            repository_url="repo",
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        manager.prepare(16, github_token="ghs_t")

        script = sandbox.exec.call_args.args[2]

        self.assertIn(
            "/tmp/ralph-git-askpass",
            script,
        )
        self.assertIn("trap cleanup EXIT", script)
        self.assertIn("rm -f /tmp/ralph-git-askpass", script)
        self.assertIn(
            "core.askPass=/tmp/ralph-git-askpass",
            script,
        )

if __name__ == "__main__":
    unittest.main()