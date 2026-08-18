import unittest

from scripts.ralph.github_source import GitHubTask
from scripts.ralph.refinement import (
    build_refinement_packet,
    eligible_for_refinement,
)


def task(
    number,
    state="OPEN",
    dependencies=(),
    labels=(),
    body="",
):
    return GitHubTask(
        number=number,
        title=f"Issue {number}",
        state=state,
        labels=frozenset(labels),
        dependencies=tuple(dependencies),
        body=body,
    )


class RefinementTests(unittest.TestCase):
    def test_dependency_ready_ticket_is_eligible(self):
        candidate = task(
            16,
            dependencies=(15,),
        )

        self.assertTrue(
            eligible_for_refinement(
                candidate,
                closed_dependencies=(15,),
            )
        )

    def test_blocked_ticket_is_not_eligible(self):
        candidate = task(
            17,
            dependencies=(16,),
        )

        self.assertFalse(
            eligible_for_refinement(
                candidate,
                closed_dependencies=(15,),
            )
        )

    def test_closed_ticket_is_not_refined(self):
        candidate = task(
            15,
            state="CLOSED",
        )

        self.assertFalse(
            eligible_for_refinement(
                candidate,
                closed_dependencies=(),
            )
        )

    def test_packet_contains_authoritative_issue_context(self):
        candidate = task(
            16,
            dependencies=(15,),
            labels=("foo",),
            body="Acceptance criteria here",
        )

        policy = {
            "version": 1,
            "verdicts": ["RALPH_READY"],
        }

        packet = build_refinement_packet(
            candidate,
            policy,
        )

        self.assertEqual(packet.number, 16)
        self.assertEqual(packet.dependencies, [15])
        self.assertEqual(packet.labels, ["foo"])
        self.assertEqual(
            packet.body,
            "Acceptance criteria here",
        )
        self.assertEqual(packet.policy["version"], 1)


if __name__ == "__main__":
    unittest.main()
