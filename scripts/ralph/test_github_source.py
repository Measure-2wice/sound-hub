import unittest

from unittest.mock import patch

from scripts.ralph.github_source import (
    DependencyDeclarationError,
    GitHubTask,
    GitHubTaskSource,
    dependency_frontier,
    execution_frontier,
    parse_dependencies,
    task_from_gh_json,
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


class DependencyParsingTests(unittest.TestCase):
    def test_parses_blocked_by_issue(self):
        body = """
## Parent specification

#12

## Dependencies

Blocked by:

- #15 — Foundation

## Scope guard

Something else.
"""
        self.assertEqual(parse_dependencies(body), (15,))

    def test_parses_multiple_dependencies(self):
        body = """
## Dependencies

Blocked by:

- #20 — Sessions
- #22 — Membership
- #26 — Offerings

## Scope guard
"""
        self.assertEqual(
            parse_dependencies(body),
            (20, 22, 26),
        )

    def test_none_means_no_dependencies(self):
        body = """
## Dependencies

Blocked by: None — initial ready-for-agent frontier.

## Scope guard
"""
        self.assertEqual(parse_dependencies(body), ())

    def test_parent_spec_reference_is_not_dependency(self):
        body = """
## Parent specification

#12

## Dependencies

Blocked by:

- #15 — Foundation
"""
        self.assertEqual(parse_dependencies(body), (15,))

    def test_missing_dependency_section_fails_closed(self):
        body = """
        ## Parent specification

        #12

        ## What to build

        Something.
        """

        with self.assertRaises(DependencyDeclarationError):
            parse_dependencies(body)


    def test_malformed_dependency_declaration_fails_closed(self):
        body = """
    ## Dependencies

    Blocked by:

    TBD
    """

        with self.assertRaises(DependencyDeclarationError):
            parse_dependencies(body)


    def test_error_identifies_issue_number(self):
        raw = {
            "number": 23,
            "title": "Broken issue",
            "state": "OPEN",
            "labels": [],
            "body": "No dependency contract here.",
        }

        with self.assertRaisesRegex(
            DependencyDeclarationError,
            r"Issue #23",
        ):
            task_from_gh_json(raw)


class FrontierTests(unittest.TestCase):
    def test_closed_dependency_unlocks_next_ticket(self):
        tasks = [
            task(15, state="CLOSED"),
            task(16, dependencies=(15,)),
            task(17, dependencies=(16,)),
        ]

        self.assertEqual(
            [item.number for item in dependency_frontier(tasks)],
            [16],
        )

    def test_open_dependency_blocks_ticket(self):
        tasks = [
            task(15),
            task(16, dependencies=(15,)),
        ]

        self.assertEqual(
            [item.number for item in dependency_frontier(tasks)],
            [15],
        )

    def test_dependency_ready_is_not_execution_ready_without_label(self):
        tasks = [
            task(15, state="CLOSED"),
            task(16, dependencies=(15,)),
        ]

        self.assertEqual(
            execution_frontier(
                tasks,
                required_label="ready-for-ralph",
            ),
            [],
        )

    def test_ready_label_allows_execution(self):
        tasks = [
            task(15, state="CLOSED"),
            task(
                16,
                dependencies=(15,),
                labels=("ready-for-ralph",),
            ),
        ]

        self.assertEqual(
            [
                item.number
                for item in execution_frontier(
                    tasks,
                    required_label="ready-for-ralph",
                )
            ],
            [16],
        )

    def test_skip_label_overrides_ready_label(self):
        tasks = [
            task(
                16,
                labels=(
                    "ready-for-ralph",
                    "needs-reshaping",
                ),
            ),
        ]

        self.assertEqual(
            execution_frontier(
                tasks,
                required_label="ready-for-ralph",
                skip_labels=("needs-reshaping",),
            ),
            [],
        )

class GitHubTaskSourceTests(unittest.TestCase):
    @patch("scripts.ralph.github_source.subprocess.run")
    def test_parent_issue_is_skipped_before_dependency_parsing(
        self,
        run,
    ):
        run.return_value.stdout = """
[
  {
    "number": 12,
    "title": "Parent specification",
    "state": "OPEN",
    "labels": [],
    "body": "No dependency section because this is the parent spec."
  },
  {
    "number": 15,
    "title": "First implementation ticket",
    "state": "CLOSED",
    "labels": [],
    "body": "## Dependencies\\n\\nBlocked by: None"
  }
]
"""

        source = GitHubTaskSource(
            repository="Measure-2wice/sound-hub",
            milestone="M2",
            parent_issue=12,
        )

        tasks = source.list_tasks()

        self.assertEqual(
            [task.number for task in tasks],
            [15],
        )

if __name__ == "__main__":
    unittest.main()
