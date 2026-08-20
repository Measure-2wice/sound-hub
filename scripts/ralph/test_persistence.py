import unittest
from unittest.mock import MagicMock

from scripts.ralph.git_policy import GitPushPolicy
from scripts.ralph.persistence import (
    PersistenceError,
    PersistenceRunner,
)
from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.states import TicketState
from scripts.ralph.workspace import TicketWorkspace


class PersistenceRunnerTests(unittest.TestCase):
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

        self.policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        self.runner = PersistenceRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
            git_policy=self.policy,
            github_token="secret",
            owner="Measure-2wice",
            repository="sound-hub",
        )

    def test_wrong_branch_fails_closed(self):
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout="main\n",
                stderr="",
            )
        )

        with self.assertRaises(
            PersistenceError
        ):
            self.runner._assert_ticket_branch()

    def test_commit_extracts_commit_sha(self):
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout=(
                    "RALPH_COMMIT_MODE=CREATED\n"
                    "RALPH_COMMIT_SHA=abc123\n"
                ),
                stderr="",
            )
        )

        sha = self.runner._commit_or_resume(
            commit_message="feat(m2): test (#17)",
        )

        self.assertEqual(
            sha,
            "abc123",
        )

    def test_commit_can_resume_existing_commit(self):
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout=(
                    "RALPH_COMMIT_MODE=RESUMED\n"
                    "RALPH_COMMIT_SHA=existing123\n"
                ),
                stderr="",
            )
        )

        sha = self.runner._commit_or_resume(
            commit_message="feat(m2): test (#17)",
        )

        self.assertEqual(
            sha,
            "existing123",
        )

    def test_push_extracts_remote_sha(self):
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout=(
                    "RALPH_REMOTE_SHA=abc123\n"
                ),
                stderr="",
            )
        )

        sha = self.runner._push_ticket_branch(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        self.assertEqual(
            sha,
            "abc123",
        )

    def test_existing_pull_request_is_reused(self):
        self.runner._github_request = MagicMock(
            return_value=[
                {
                    "number": 42,
                    "html_url":
                        "https://github.com/x/y/pull/42",
                }
            ]
        )

        (
            number,
            url,
            created,
        ) = self.runner._create_or_recover_pull_request(
            title="Issue #17",
            body="Body",
        )

        self.assertEqual(number, 42)
        self.assertFalse(created)
        self.assertIn(
            "/pull/42",
            url,
        )

    def test_missing_pull_request_is_created(self):
        self.runner._find_existing_pull_request = (
            MagicMock(
                return_value=None
            )
        )

        self.runner._github_request = MagicMock(
            return_value={
                "number": 43,
                "html_url":
                    "https://github.com/x/y/pull/43",
            }
        )

        (
            number,
            url,
            created,
        ) = self.runner._create_or_recover_pull_request(
            title="Issue #17",
            body="Body",
        )

        self.assertEqual(number, 43)
        self.assertTrue(created)
        self.assertIn(
            "/pull/43",
            url,
        )

    def test_remote_sha_must_match_commit(self):
        self.runner._assert_ticket_branch = MagicMock()
        self.runner._commit_or_resume = MagicMock(
            return_value="local123"
        )
        self.runner._push_ticket_branch = MagicMock(
            return_value="remote456"
        )

        with self.assertRaises(
            PersistenceError
        ):
            self.runner.persist(
                issue_number=17,
                state=TicketState.AUTOMATED_QA,
                commit_message="feat(m2): test (#17)",
                pull_request_title="Issue #17",
                pull_request_body="Body",
            )


if __name__ == "__main__":
    unittest.main()