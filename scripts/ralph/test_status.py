import unittest

from scripts.ralph.github_source import GitHubTask
from scripts.ralph.status import (
    build_status,
    unresolved_dependencies,
)


def task(
    number,
    state="OPEN",
    dependencies=(),
    labels=(),
):
    return GitHubTask(
        number=number,
        title=f"Issue {number}",
        state=state,
        labels=frozenset(labels),
        dependencies=tuple(dependencies),
    )


class RalphStatusTests(unittest.TestCase):
    def test_builds_ready_and_waiting_frontiers(self):
        tasks = [
            task(15, state="CLOSED"),
            task(
                16,
                dependencies=(15,),
                labels=("ready-for-ralph",),
            ),
            task(
                17,
                dependencies=(16,),
            ),
        ]

        status = build_status(
            tasks,
            required_label="ready-for-ralph",
            skip_labels=("needs-reshaping",),
        )

        self.assertEqual(
            status.closed,
            1,
        )

        self.assertEqual(
            [item.number for item in status.dependency_ready],
            [16],
        )

        self.assertEqual(
            [item.number for item in status.execution_ready],
            [16],
        )

        self.assertEqual(
            [
                (
                    item.number,
                    blockers,
                )
                for item, blockers in status.waiting
            ],
            [
                (17, (16,)),
            ],
        )

    def test_dependency_ready_without_label_is_not_execution_ready(self):
        tasks = [
            task(15, state="CLOSED"),
            task(
                16,
                dependencies=(15,),
            ),
        ]

        status = build_status(
            tasks,
            required_label="ready-for-ralph",
            skip_labels=(),
        )

        self.assertEqual(
            [item.number for item in status.dependency_ready],
            [16],
        )

        self.assertEqual(
            status.execution_ready,
            [],
        )

    def test_missing_dependency_remains_blocked(self):
        candidate = task(
            16,
            dependencies=(99,),
        )

        self.assertEqual(
            unresolved_dependencies(
                candidate,
                [candidate],
            ),
            (99,),
        )


if __name__ == "__main__":
    unittest.main()
