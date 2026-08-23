import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Tuple

from scripts.ralph.github_source import (
    DependencyDeclarationError,
    GitHubTask,
    GitHubTaskSource,
    dependency_frontier,
    execution_frontier,
)


@dataclass(frozen=True)
class RalphStatus:
    closed: int
    dependency_ready: List[GitHubTask]
    execution_ready: List[GitHubTask]
    waiting: List[Tuple[GitHubTask, Tuple[int, ...]]]


def unresolved_dependencies(
    task: GitHubTask,
    tasks: Iterable[GitHubTask],
) -> Tuple[int, ...]:
    by_number = {
        item.number: item
        for item in tasks
    }

    return tuple(
        dependency
        for dependency in task.dependencies
        if (
            dependency not in by_number
            or not by_number[dependency].is_closed
        )
    )


def build_status(
    tasks: Iterable[GitHubTask],
    required_label: str,
    skip_labels: Iterable[str],
) -> RalphStatus:
    tasks = list(tasks)

    dependency_ready = dependency_frontier(tasks)

    execution_ready = execution_frontier(
        tasks,
        required_label=required_label,
        skip_labels=skip_labels,
    )

    waiting = []

    for task in tasks:
        if task.is_closed:
            continue

        unresolved = unresolved_dependencies(
            task,
            tasks,
        )

        if unresolved:
            waiting.append(
                (task, unresolved)
            )

    return RalphStatus(
        closed=sum(
            1
            for task in tasks
            if task.is_closed
        ),
        dependency_ready=dependency_ready,
        execution_ready=execution_ready,
        waiting=waiting,
    )


def print_tasks(
    heading: str,
    tasks: Iterable[GitHubTask],
) -> None:
    print(heading)

    tasks = list(tasks)

    if not tasks:
        print("  NONE")
        return

    for task in tasks:
        print(
            f"  #{task.number} {task.title}"
        )


def print_status(
    milestone_id: str,
    status: RalphStatus,
) -> None:
    print(
        f"RALPH {milestone_id.upper()}"
    )
    print()

    print_tasks(
        "Dependency frontier",
        status.dependency_ready,
    )

    print()
    print_tasks(
        "Execution frontier",
        status.execution_ready,
    )

    print()
    print("Waiting")

    if not status.waiting:
        print("  NONE")
    else:
        for task, blockers in status.waiting:
            blocker_text = ", ".join(
                f"#{number}"
                for number in blockers
            )

            print(
                f"  #{task.number} waiting on {blocker_text}"
            )

    print()
    print("Summary")
    print(
        f"  closed:           {status.closed}"
    )
    print(
        f"  dependency-ready: {len(status.dependency_ready)}"
    )
    print(
        f"  execution-ready:  {len(status.execution_ready)}"
    )
    print(
        f"  waiting:          {len(status.waiting)}"
    )


def load_config(path: str) -> dict:
    return json.loads(
        Path(path).read_text()
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Show Ralph milestone execution status."
    )

    parser.add_argument(
        "--config",
        default=".ralph/config/m2.json",
        help="Path to Ralph milestone config.",
    )

    args = parser.parse_args()

    try:
        config = load_config(args.config)

        source = GitHubTaskSource(
            repository=config["repository"],
            milestone=config["githubMilestone"],
            parent_issue=config["parentIssue"],
        )

        tasks = source.list_tasks()

        status = build_status(
            tasks,
            required_label=config["selection"]["requiredLabel"],
            skip_labels=config["selection"]["skipLabels"],
        )

    except DependencyDeclarationError as error:
        print("RALPH STATUS BLOCKED")
        print()
        print(f"Dependency contract error: {error}")
        return 2

    except subprocess.CalledProcessError as error:
        print("RALPH STATUS BLOCKED")
        print()
        print(
            f"GitHub command failed with exit code "
            f"{error.returncode}."
        )
        return 2

    print_status(
        config["id"],
        status,
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
