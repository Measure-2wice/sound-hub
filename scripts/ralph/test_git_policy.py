import unittest

from scripts.ralph.git_policy import (
    GitPolicyError,
    GitPushPolicy,
)
from scripts.ralph.states import TicketState


class GitPushPolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

    def test_ticket_branch_allowed_during_implementation(self):
        self.policy.assert_push_allowed(
            branch="ralph/m2-16",
            state=TicketState.IMPLEMENTING,
            issue_number=16,
        )

    def test_ticket_branch_allowed_during_fixing(self):
        self.policy.assert_push_allowed(
            branch="ralph/m2-16",
            state=TicketState.FIXING,
            issue_number=16,
        )

    def test_wrong_ticket_branch_is_denied(self):
        with self.assertRaises(GitPolicyError):
            self.policy.assert_push_allowed(
                branch="ralph/m2-17",
                state=TicketState.IMPLEMENTING,
                issue_number=16,
            )

    def test_ticket_push_during_review_is_denied(self):
        with self.assertRaises(GitPolicyError):
            self.policy.assert_push_allowed(
                branch="ralph/m2-16",
                state=TicketState.REVIEWING,
                issue_number=16,
            )

    def test_integration_branch_allowed_only_while_integrating(self):
        self.policy.assert_push_allowed(
            branch="ralph/m2",
            state=TicketState.INTEGRATING,
            issue_number=16,
        )

    def test_integration_branch_during_implementation_is_denied(self):
        with self.assertRaises(GitPolicyError):
            self.policy.assert_push_allowed(
                branch="ralph/m2",
                state=TicketState.IMPLEMENTING,
                issue_number=16,
            )

    def test_main_is_always_denied(self):
        with self.assertRaises(GitPolicyError):
            self.policy.assert_push_allowed(
                branch="main",
                state=TicketState.INTEGRATING,
                issue_number=16,
            )

    def test_force_push_is_always_denied(self):
        with self.assertRaises(GitPolicyError):
            self.policy.assert_push_allowed(
                branch="ralph/m2-16",
                state=TicketState.IMPLEMENTING,
                issue_number=16,
                force=True,
            )

    def test_unknown_branch_is_denied(self):
        with self.assertRaises(GitPolicyError):
            self.policy.assert_push_allowed(
                branch="feature/random",
                state=TicketState.IMPLEMENTING,
                issue_number=16,
            )


if __name__ == "__main__":
    unittest.main()
