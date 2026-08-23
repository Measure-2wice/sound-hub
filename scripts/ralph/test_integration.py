import unittest
from unittest.mock import MagicMock

from scripts.ralph.git_policy import (
    GitPushPolicy,
)
from scripts.ralph.integration import (
    IntegrationError,
    IntegrationRunner,
)
from scripts.ralph.sandbox import (
    SandboxCommandResult,
)
from scripts.ralph.states import TicketState
from scripts.ralph.workspace import (
    TicketWorkspace,
)


class IntegrationRunnerTests(
    unittest.TestCase
):
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

        self.runner = IntegrationRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
            git_policy=self.policy,
            github_token="secret",
            owner="Measure-2wice",
            repository="sound-hub",
        )

    def _pull_request(
        self,
        *,
        state="open",
        merged=False,
        draft=False,
        base_ref="ralph/m2",
        head_ref="ralph/m2-17",
        head_sha="persisted123",
        merge_sha=None,
    ):
        return {
            "number": 40,
            "state": state,
            "merged": merged,
            "draft": draft,
            "merge_commit_sha":
                merge_sha,
            "base": {
                "ref": base_ref,
                "repo": {
                    "full_name":
                        "Measure-2wice/"
                        "sound-hub",
                },
            },
            "head": {
                "ref": head_ref,
                "sha": head_sha,
                "repo": {
                    "full_name":
                        "Measure-2wice/"
                        "sound-hub",
                },
            },
        }

    def test_open_pull_request_integrates(
        self,
    ):
        self.runner._get_pull_request = (
            MagicMock(
                return_value=
                    self._pull_request()
            )
        )

        self.runner._assert_fresh_integration_base = (
            MagicMock()
        )

        self.runner._merge_pull_request = (
            MagicMock(
                return_value="merge123"
            )
        )

        self.runner._assert_merge_reachable = (
            MagicMock()
        )

        self.runner._close_issue = MagicMock(
            return_value=True
        )

        result = self.runner.integrate(
            issue_number=17,
            state=TicketState.INTEGRATING,
            pull_request_number=40,
            expected_head_sha=
                "persisted123",
        )

        self.assertEqual(
            result.merge_sha,
            "merge123",
        )

        self.assertTrue(
            result.merge_created
        )

        self.assertTrue(
            result.issue_closed_now
        )

    def test_merged_pull_request_resumes(
        self,
    ):
        self.runner._get_pull_request = (
            MagicMock(
                return_value=
                    self._pull_request(
                        state="closed",
                        merged=True,
                        merge_sha="merge123",
                    )
            )
        )

        self.runner._merge_pull_request = (
            MagicMock()
        )

        self.runner._assert_fresh_integration_base = (
            MagicMock()
        )

        self.runner._assert_merge_reachable = (
            MagicMock()
        )

        self.runner._close_issue = MagicMock(
            return_value=False
        )

        result = self.runner.integrate(
            issue_number=17,
            state=TicketState.INTEGRATING,
            pull_request_number=40,
            expected_head_sha=
                "persisted123",
        )

        self.assertEqual(
            result.merge_sha,
            "merge123",
        )

        self.assertFalse(
            result.merge_created
        )

        self.runner._merge_pull_request\
            .assert_not_called()

        self.runner\
            ._assert_fresh_integration_base\
            .assert_not_called()

    def test_wrong_base_branch_fails_closed(
        self,
    ):
        pull_request = self._pull_request(
            base_ref="main"
        )

        with self.assertRaises(
            IntegrationError
        ):
            self.runner\
                ._assert_pull_request_identity(
                    pull_request=
                        pull_request,
                    pull_request_number=40,
                    expected_head_sha=
                        "persisted123",
                )

    def test_wrong_ticket_branch_fails_closed(
        self,
    ):
        pull_request = self._pull_request(
            head_ref="ralph/m2-999"
        )

        with self.assertRaises(
            IntegrationError
        ):
            self.runner\
                ._assert_pull_request_identity(
                    pull_request=
                        pull_request,
                    pull_request_number=40,
                    expected_head_sha=
                        "persisted123",
                )

    def test_changed_head_sha_fails_closed(
        self,
    ):
        pull_request = self._pull_request(
            head_sha="unexpected456"
        )

        with self.assertRaises(
            IntegrationError
        ):
            self.runner\
                ._assert_pull_request_identity(
                    pull_request=
                        pull_request,
                    pull_request_number=40,
                    expected_head_sha=
                        "persisted123",
                )

    def test_stale_integration_base_fails_closed(
        self,
    ):
        self.runner._get_ref_sha = MagicMock(
            return_value="newbase456"
        )

        with self.assertRaises(
            IntegrationError
        ):
            self.runner\
                ._assert_fresh_integration_base()

    def test_merge_reachable_accepts_ahead(
        self,
    ):
        self.runner._github_request = MagicMock(
            return_value={
                "status": "ahead",
            }
        )

        self.runner._assert_merge_reachable(
            "merge123"
        )

    def test_merge_reachable_accepts_identical(
        self,
    ):
        self.runner._github_request = MagicMock(
            return_value={
                "status": "identical",
            }
        )

        self.runner._assert_merge_reachable(
            "merge123"
        )

    def test_merge_reachable_rejects_diverged(
        self,
    ):
        self.runner._github_request = MagicMock(
            return_value={
                "status": "diverged",
            }
        )

        with self.assertRaises(
            IntegrationError
        ):
            self.runner._assert_merge_reachable(
                "merge123"
            )

    def test_close_issue_is_idempotent(
        self,
    ):
        self.runner._github_request = MagicMock(
            return_value={
                "state": "closed",
            }
        )

        changed = self.runner._close_issue(
            17
        )

        self.assertFalse(changed)

        self.assertEqual(
            self.runner._github_request.call_count,
            1,
        )

    def test_close_open_issue(
        self,
    ):
        self.runner._github_request = MagicMock(
            side_effect=[
                {
                    "state": "open",
                },
                {
                    "state": "closed",
                },
            ]
        )

        changed = self.runner._close_issue(
            17
        )

        self.assertTrue(changed)

        self.assertEqual(
            self.runner._github_request.call_count,
            2,
        )


if __name__ == "__main__":
    unittest.main()