import json
import re
import subprocess
from dataclasses import dataclass
from typing import Iterable, List, Optional, Set


DEPENDENCY_SECTION_RE = re.compile(
    r"^## Dependencies\s*$([\s\S]*?)(?=^## |\Z)",
    re.MULTILINE,
)

ISSUE_REFERENCE_RE = re.compile(r"#(\d+)")


@dataclass(frozen=True)
class GitHubTask:
    number: int
    title: str
    state: str
    labels: frozenset[str]
    dependencies: tuple[int, ...]
    body: str = ""

    @property
    def is_closed(self) -> bool:
        return self.state.upper() == "CLOSED"


def parse_dependencies(body: str) -> tuple[int, ...]:
    """
    Parse issue dependencies only from the explicit `## Dependencies` section.

    References elsewhere in the issue body, such as the parent specification,
    must not accidentally become blockers.
    """
    match = DEPENDENCY_SECTION_RE.search(body or "")
    if not match:
        return ()

    section = match.group(1)

    if re.search(r"Blocked by:\s*None\b", section, re.IGNORECASE):
        return ()

    dependencies = {
        int(number)
        for number in ISSUE_REFERENCE_RE.findall(section)
    }

    return tuple(sorted(dependencies))


def _label_names(raw_labels: Iterable[object]) -> frozenset[str]:
    names: Set[str] = set()

    for label in raw_labels:
        if isinstance(label, str):
            names.add(label)
        elif isinstance(label, dict):
            name = label.get("name")
            if isinstance(name, str):
                names.add(name)

    return frozenset(names)


def task_from_gh_json(raw: dict) -> GitHubTask:
    return GitHubTask(
        number=int(raw["number"]),
        title=str(raw["title"]),
        state=str(raw["state"]).upper(),
        labels=_label_names(raw.get("labels") or []),
        dependencies=parse_dependencies(raw.get("body") or ""),
        body=raw.get("body") or "",
    )


class GitHubTaskSource:
    def __init__(
        self,
        repository: str,
        milestone: str,
        parent_issue: Optional[int] = None,
    ):
        self.repository = repository
        self.milestone = milestone
        self.parent_issue = parent_issue

    def list_tasks(self) -> List[GitHubTask]:
        command = [
            "gh",
            "issue",
            "list",
            "--repo",
            self.repository,
            "--milestone",
            self.milestone,
            "--state",
            "all",
            "--limit",
            "200",
            "--json",
            "number,title,state,labels,body",
        ]

        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )

        raw_tasks = json.loads(result.stdout)

        tasks = [
            task_from_gh_json(raw)
            for raw in raw_tasks
        ]

        tasks = exclude_parent_issue(
            tasks,
            self.parent_issue,
        )

        return sorted(
            tasks,
            key=lambda task: task.number,
        )

def exclude_parent_issue(
    tasks: Iterable[GitHubTask],
    parent_issue: Optional[int],
) -> List[GitHubTask]:
    tasks = list(tasks)

    if parent_issue is None:
        return tasks

    return [
        task
        for task in tasks
        if task.number != parent_issue
    ]


def dependency_frontier(tasks: Iterable[GitHubTask]) -> List[GitHubTask]:
    """
    Return open tasks whose declared dependencies are all closed.
    """
    tasks = list(tasks)
    closed = {
        task.number
        for task in tasks
        if task.is_closed
    }

    return [
        task
        for task in tasks
        if not task.is_closed
        and all(dependency in closed for dependency in task.dependencies)
    ]


def execution_frontier(
    tasks: Iterable[GitHubTask],
    required_label: str,
    skip_labels: Optional[Iterable[str]] = None,
) -> List[GitHubTask]:
    """
    Apply Ralph execution policy to the dependency-ready frontier.
    """
    skip = set(skip_labels or [])

    return [
        task
        for task in dependency_frontier(tasks)
        if required_label in task.labels
        and not (task.labels & skip)
    ]
