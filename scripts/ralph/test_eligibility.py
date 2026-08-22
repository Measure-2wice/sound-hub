"""Unit tests for scripts.ralph.eligibility."""

import unittest

from scripts.ralph.eligibility import (
    EligibilityConfig,
    issue_still_eligible,
)
from scripts.ralph.github_source import GitHubTask
from scripts.ralph.states import TicketState


def task(
    number,
    *,
    state="OPEN",
    labels=("ready-for-ralph",),
    dependencies=(),
):
    return GitHubTask(
        number=number,
        title=f"Issue {number}",
        state=state,
        labels=frozenset(labels),
        dependencies=tuple(dependencies),
        body="",
    )


class IssueStillEligibleTests(unittest.TestCase):
    def setUp(self):
        self.cfg = EligibilityConfig(
            required_label="ready-for-ralph",
            skip_labels=frozenset({"needs-reshaping"}),
        )

    def test_open_labeled_unblocked_is_eligible(self):
        t = task(17)
        self.assertTrue(
            issue_still_eligible(
                task=t,
                tasks_by_number={17: t},
                config=self.cfg,
                state=TicketState.IMPLEMENTING,
            )
        )

    def test_closed_issue_not_eligible_pre_recovery(self):
        t = task(17, state="CLOSED")
        self.assertFalse(
            issue_still_eligible(
                task=t,
                tasks_by_number={17: t},
                config=self.cfg,
                state=TicketState.IMPLEMENTING,
            )
        )

    def test_missing_label_not_eligible_pre_recovery(self):
        t = task(17, labels=())
        self.assertFalse(
            issue_still_eligible(
                task=t,
                tasks_by_number={17: t},
                config=self.cfg,
                state=TicketState.IMPLEMENTING,
            )
        )

    def test_skip_label_not_eligible_pre_recovery(self):
        t = task(
            17,
            labels=(
                "ready-for-ralph",
                "needs-reshaping",
            ),
        )
        self.assertFalse(
            issue_still_eligible(
                task=t,
                tasks_by_number={17: t},
                config=self.cfg,
                state=TicketState.IMPLEMENTING,
            )
        )

    def test_open_dependency_blocks_pre_recovery(self):
        dep = task(15, state="OPEN")
        t = task(17, dependencies=(15,))
        self.assertFalse(
            issue_still_eligible(
                task=t,
                tasks_by_number={15: dep, 17: t},
                config=self.cfg,
                state=TicketState.IMPLEMENTING,
            )
        )

    def test_closed_issue_eligible_during_integrating(self):
        """After merge, Ralph itself may have closed the issue.
        Integration restart must not block on the closed state."""
        t = task(17, state="CLOSED")
        self.assertTrue(
            issue_still_eligible(
                task=t,
                tasks_by_number={17: t},
                config=self.cfg,
                state=TicketState.INTEGRATING,
            )
        )

    def test_closed_issue_eligible_during_integrated(self):
        t = task(17, state="CLOSED")
        self.assertTrue(
            issue_still_eligible(
                task=t,
                tasks_by_number={17: t},
                config=self.cfg,
                state=TicketState.INTEGRATED,
            )
        )


if __name__ == "__main__":
    unittest.main()
