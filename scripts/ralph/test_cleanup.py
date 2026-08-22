import unittest
from unittest.mock import MagicMock

from scripts.ralph.cleanup import (
    RemoteBranchCleanupError,
    RemoteBranchCleaner,
)
from scripts.ralph.sandbox import SandboxCommandResult


class RemoteBranchCleanerTests(unittest.TestCase):
    EXPECTED = "ralph/m2-17"

    def setUp(self):
        self.sandbox = MagicMock()
        self.cleaner = RemoteBranchCleaner(
            sandbox=self.sandbox,
            github_token="ghs_test",
            owner="Measure-2wice",
            repository="sound-hub",
        )

    def _exec_returns(self, *results):
        self.sandbox.exec.side_effect = list(results)

    def test_cleanup_deletes_when_sha_matches(self):
        self._exec_returns(
            SandboxCommandResult(
                exit_code=0,
                stdout=(
                    '{"object": {"sha": "abc123"}}'
                ),
                stderr="",
            ),
            SandboxCommandResult(
                exit_code=0,
                stdout="",
                stderr="",
            ),
        )

        result = self.cleaner.cleanup_ticket_branch(
            ticket_branch=self.EXPECTED,
            expected_branch=self.EXPECTED,
            expected_head_sha="abc123",
        )

        self.assertTrue(result.deleted)
        self.assertFalse(result.already_absent)
        self.assertEqual(result.branch, self.EXPECTED)

    def test_cleanup_treats_empty_204_as_success(self):
        # GitHub ref deletion returns 204 No Content with an empty
        # body. The cleaner must accept this without raising.
        self._exec_returns(
            SandboxCommandResult(
                exit_code=0,
                stdout=(
                    '{"object": {"sha": "abc123"}}'
                ),
                stderr="",
            ),
            SandboxCommandResult(
                exit_code=0,
                stdout="",
                stderr="",
            ),
        )

        result = self.cleaner.cleanup_ticket_branch(
            ticket_branch=self.EXPECTED,
            expected_branch=self.EXPECTED,
            expected_head_sha="abc123",
        )

        self.assertTrue(result.deleted)

    def test_cleanup_idempotent_when_branch_missing(self):
        self._exec_returns(
            SandboxCommandResult(
                exit_code=0,
                stdout="null",
                stderr="",
            ),
        )

        result = self.cleaner.cleanup_ticket_branch(
            ticket_branch=self.EXPECTED,
            expected_branch=self.EXPECTED,
            expected_head_sha="abc123",
        )

        self.assertFalse(result.deleted)
        self.assertTrue(result.already_absent)

    def test_cleanup_refuses_main(self):
        with self.assertRaises(
            RemoteBranchCleanupError
        ):
            self.cleaner.cleanup_ticket_branch(
                ticket_branch="main",
                expected_branch="main",
                expected_head_sha="abc123",
            )

    def test_cleanup_refuses_integration_branch(self):
        with self.assertRaises(
            RemoteBranchCleanupError
        ):
            self.cleaner.cleanup_ticket_branch(
                ticket_branch="ralph/m2",
                expected_branch="ralph/m2",
                expected_head_sha="abc123",
                protected_branches=("ralph/m2", "main"),
            )

    def test_cleanup_refuses_unrelated_non_protected_branch(self):
        # An unrelated non-protected branch with the same SHA must
        # NOT be deleted.
        with self.assertRaises(
            RemoteBranchCleanupError
        ):
            self.cleaner.cleanup_ticket_branch(
                ticket_branch="ralph/m2-other",
                expected_branch=self.EXPECTED,
                expected_head_sha="abc123",
            )

    def test_cleanup_refuses_sha_mismatch(self):
        self._exec_returns(
            SandboxCommandResult(
                exit_code=0,
                stdout=(
                    '{"object": {"sha": "different"}}'
                ),
                stderr="",
            ),
        )

        with self.assertRaises(
            RemoteBranchCleanupError
        ):
            self.cleaner.cleanup_ticket_branch(
                ticket_branch=self.EXPECTED,
                expected_branch=self.EXPECTED,
                expected_head_sha="abc123",
            )

    def test_cleanup_refuses_empty_expected_sha(self):
        # Without a known SHA we cannot prove the remote branch is
        # the Ralph ticket branch we created.
        with self.assertRaises(
            RemoteBranchCleanupError
        ):
            self.cleaner.cleanup_ticket_branch(
                ticket_branch=self.EXPECTED,
                expected_branch=self.EXPECTED,
                expected_head_sha="",
            )


if __name__ == "__main__":
    unittest.main()
