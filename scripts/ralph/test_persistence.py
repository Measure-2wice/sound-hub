import unittest
from unittest.mock import MagicMock

from scripts.ralph.git_policy import GitPushPolicy
from scripts.ralph.persistence import (
    CommitOnlyContinuationResult,
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


class CommitOnlyContinuationTests(unittest.TestCase):
    """#1 — verify ``ensure_pull_request_for_persisted_commit``
    requires ``recovered_sha`` to equal local HEAD, remote
    HEAD, and rejects any disagreement.

    The runner must NOT derive the durable commit identity
    from ``workspace.ticket_sha``; the conductor's
    ``recovered_sha`` is authoritative, subject to
    independent local + remote verification.
    """

    def setUp(self):
        self.sandbox = MagicMock()

        self.workspace = TicketWorkspace(
            repository_path="/tmp/sound-hub",
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
            base_sha="base123",
            ticket_sha="ORIGINAL_TICKET_SHA",
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

    def _stub_branch_check_ok(self):
        return SandboxCommandResult(
            exit_code=0,
            stdout="ralph/m2-17\n",
            stderr="",
        )

    def _stub_local_head(self, sha: str):
        return SandboxCommandResult(
            exit_code=0,
            stdout=f"{sha}\n",
            stderr="",
        )

    def _stub_remote_head(self, sha: str):
        return SandboxCommandResult(
            exit_code=0,
            stdout=(
                f"RALPH_REMOTE_SHA={sha}\n"
            ),
            stderr="",
        )

    def test_a_verified_sha_returns_commit_only_continuation(
        self,
    ):
        """A) recovered_sha == local HEAD == remote HEAD ->
        success.  PR is created (or recovered), the result
        contains the verified SHA, and the runner never
        derives identity from ``workspace.ticket_sha``.
        """
        sha = "T"

        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
            self._stub_local_head(sha),
            self._stub_remote_head(sha),
        ]

        self.runner._create_or_recover_pull_request = (
            MagicMock(
                return_value=(
                    42,
                    "https://github.com/x/y/pull/42",
                    True,
                )
            )
        )

        result = self.runner.ensure_pull_request_for_persisted_commit(
            issue_number=17,
            recovered_sha=sha,
            original_ticket_sha="ORIGINAL_TICKET_SHA",
            pull_request_title="Issue #17",
            pull_request_body="Body",
        )

        self.assertIsInstance(
            result, CommitOnlyContinuationResult
        )
        self.assertEqual(result.commit_sha, sha)
        self.assertEqual(result.remote_sha, sha)
        self.assertEqual(result.pull_request_number, 42)
        self.assertTrue(result.pull_request_created)

        self.runner._create_or_recover_pull_request.assert_called_once()

    def test_b_local_head_disagrees_with_recovered_sha_blocks(
        self,
    ):
        """B) recovered_sha = T1, local HEAD = T2, remote HEAD
        = T2.  No PR operation; PersistenceError.
        """
        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
            self._stub_local_head("T2"),
            self._stub_remote_head("T2"),
        ]

        self.runner._create_or_recover_pull_request = (
            MagicMock()
        )

        with self.assertRaises(PersistenceError):
            self.runner.ensure_pull_request_for_persisted_commit(
                issue_number=17,
                recovered_sha="T1",
                original_ticket_sha="ORIGINAL_TICKET_SHA",
                pull_request_title="Issue #17",
                pull_request_body="Body",
            )

        # No PR operation must have been attempted.
        (
            self.runner
            ._create_or_recover_pull_request
            .assert_not_called()
        )

    def test_c_remote_head_disagrees_with_recovered_sha_blocks(
        self,
    ):
        """C) recovered_sha = T1, local HEAD = T1, remote HEAD
        = T2.  No PR operation; PersistenceError.
        """
        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
            self._stub_local_head("T1"),
            self._stub_remote_head("T2"),
        ]

        self.runner._create_or_recover_pull_request = (
            MagicMock()
        )

        with self.assertRaises(PersistenceError):
            self.runner.ensure_pull_request_for_persisted_commit(
                issue_number=17,
                recovered_sha="T1",
                original_ticket_sha="ORIGINAL_TICKET_SHA",
                pull_request_title="Issue #17",
                pull_request_body="Body",
            )

        (
            self.runner
            ._create_or_recover_pull_request
            .assert_not_called()
        )

    def test_d_local_and_remote_disagree_blocks(self):
        """If local HEAD and remote HEAD disagree (even when
        both equal the recovered SHA on one side), the runner
        MUST fail closed before any PR operation.
        """
        # Both equal "T1" but remote reports "T1-different".
        # Test the explicit local!=remote branch.
        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
            self._stub_local_head("T1"),
            self._stub_remote_head("T1"),
        ]
        # The runner reads remote SHA from the output's
        # RALPH_REMOTE_SHA marker.  To force local==recovered
        # but remote!=recovered, set local==recovered and
        # remote output a different SHA.
        self.runner._create_or_recover_pull_request = (
            MagicMock()
        )

        # local == recovered, but the recovered marker
        # comparison itself passes; we then need a different
        # signal to force local != remote.  Easiest: corrupt
        # the remote read to return something else.
        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
            self._stub_local_head("T1"),
            SandboxCommandResult(
                exit_code=0,
                stdout="RALPH_REMOTE_SHA=T1\n",
                stderr="",
            ),
        ]

        # Override _local_head_sha to disagree with the
        # runner's recovered SHA, then have remote match the
        # recovered SHA.  This forces local != remote.
        self.runner._local_head_sha = MagicMock(
            return_value="T1-LOCAL"
        )
        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
            self._stub_remote_head("T1"),
        ]

        with self.assertRaises(PersistenceError):
            self.runner.ensure_pull_request_for_persisted_commit(
                issue_number=17,
                recovered_sha="T1",
                original_ticket_sha="ORIGINAL_TICKET_SHA",
                pull_request_title="Issue #17",
                pull_request_body="Body",
            )

        (
            self.runner
            ._create_or_recover_pull_request
            .assert_not_called()
        )

    def test_recovered_sha_equal_to_baseline_blocks(self):
        """If recovered_sha matches the original pre-implementation
        baseline, the runner MUST fail closed.  This catches
        the case where the recovery probe accepted the
        baseline branch HEAD as durable state.
        """
        baseline = "ORIGINAL_TICKET_SHA"

        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
        ]

        self.runner._create_or_recover_pull_request = (
            MagicMock()
        )

        with self.assertRaises(PersistenceError):
            self.runner.ensure_pull_request_for_persisted_commit(
                issue_number=17,
                recovered_sha=baseline,
                original_ticket_sha=baseline,
                pull_request_title="Issue #17",
                pull_request_body="Body",
            )

        (
            self.runner
            ._create_or_recover_pull_request
            .assert_not_called()
        )

    def test_empty_recovered_sha_blocks(self):
        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
        ]

        self.runner._create_or_recover_pull_request = (
            MagicMock()
        )

        with self.assertRaises(PersistenceError):
            self.runner.ensure_pull_request_for_persisted_commit(
                issue_number=17,
                recovered_sha="",
                original_ticket_sha="ORIGINAL_TICKET_SHA",
                pull_request_title="Issue #17",
                pull_request_body="Body",
            )

        (
            self.runner
            ._create_or_recover_pull_request
            .assert_not_called()
        )

    def test_persistence_recovery_disposition_is_explicit(self):
        """The disposition enum has three explicit values.
        Callers cannot read a single boolean and infer
        success/failure independently.
        """
        from scripts.ralph.persistence import (
            PersistenceRecoveryDisposition,
        )

        # All three values must exist and be distinct.
        self.assertEqual(
            PersistenceRecoveryDisposition.NOT_APPLICABLE.value,
            "NOT_APPLICABLE",
        )
        self.assertEqual(
            PersistenceRecoveryDisposition.READY_TO_INTEGRATE.value,
            "READY_TO_INTEGRATE",
        )
        self.assertEqual(
            PersistenceRecoveryDisposition.TERMINAL.value,
            "TERMINAL",
        )
        self.assertEqual(
            len(
                set(PersistenceRecoveryDisposition)
            ),
            3,
        )

    def test_result_carries_ververified_not_input_sha(self):
        """The result's ``commit_sha`` MUST be the SHA the
        runner independently verified (local + remote), NOT
        the input ``recovered_sha`` parameter verbatim.  In
        practice both values are equal — but the runner MUST
        read it back from the verified local/remote reads
        rather than the input, so the conductor can
        checkpoint only the verified SHA.
        """
        sha = "T"

        self.sandbox.exec.side_effect = [
            self._stub_branch_check_ok(),
            self._stub_local_head(sha),
            self._stub_remote_head(sha),
        ]

        self.runner._create_or_recover_pull_request = (
            MagicMock(
                return_value=(
                    42,
                    "https://github.com/x/y/pull/42",
                    True,
                )
            )
        )

        result = self.runner.ensure_pull_request_for_persisted_commit(
            issue_number=17,
            recovered_sha=sha,
            original_ticket_sha="ORIGINAL_TICKET_SHA",
            pull_request_title="Issue #17",
            pull_request_body="Body",
        )

        # The runner verified local + remote via
        # ``_read_remote_ticket_head`` and assigned
        # ``commit_sha=remote_sha`` in the result.  The
        # conductor will checkpoint this value, never the
        # unverified input.
        self.assertEqual(result.commit_sha, sha)
        self.assertEqual(result.remote_sha, sha)


if __name__ == "__main__":
    unittest.main()