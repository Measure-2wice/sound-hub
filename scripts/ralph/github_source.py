import json
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Iterable, List, Optional, Set


DEPENDENCY_SECTION_RE = re.compile(
    r"^## Dependencies\s*$([\s\S]*?)(?=^## |\Z)",
    re.MULTILINE,
)

ISSUE_REFERENCE_RE = re.compile(r"#(\d+)")

class DependencyDeclarationError(ValueError):
    """The GitHub issue does not contain a valid Ralph dependency declaration."""


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
    Parse dependencies from the required `## Dependencies` section.

    Ralph fails closed when the dependency declaration is missing or malformed.
    """
    match = DEPENDENCY_SECTION_RE.search(body or "")

    if not match:
        raise DependencyDeclarationError(
            "missing required `## Dependencies` section"
        )

    section = match.group(1)

    if not re.search(r"\bBlocked by\s*:", section, re.IGNORECASE):
        raise DependencyDeclarationError(
            "missing required `Blocked by:` declaration"
        )

    if re.search(
        r"Blocked by\s*:\s*None\b",
        section,
        re.IGNORECASE,
    ):
        return ()

    dependencies = {
        int(number)
        for number in ISSUE_REFERENCE_RE.findall(section)
    }

    if not dependencies:
        raise DependencyDeclarationError(
            "`Blocked by:` must declare `None` or at least one #issue"
        )

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
    try:
        dependencies = parse_dependencies(
            raw.get("body") or ""
        )
    except DependencyDeclarationError as error:
        raise DependencyDeclarationError(
            f"Issue #{raw.get('number', '?')}: {error}"
        ) from error

    return GitHubTask(
        number=int(raw["number"]),
        title=str(raw["title"]),
        state=str(raw["state"]).upper(),
        labels=_label_names(raw.get("labels") or []),
        dependencies=dependencies,
        body=raw.get("body") or "",
    )


class GitHubTaskSource:
    def __init__(
        self,
        repository: str,
        milestone: str,
        parent_issue: Optional[int] = None,
        github_token: Optional[str] = None,
    ):
        self.repository = repository
        self.milestone = milestone
        self.parent_issue = parent_issue
        self.github_token = github_token

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

        # Overlay the inherited environment so PATH and other
        # ambient variables (locale, etc.) remain available to the
        # ``gh`` binary. The token is added on top — never the only
        # key, since that would lose PATH.
        env = os.environ.copy()

        if self.github_token is not None:
            env["GH_TOKEN"] = self.github_token

        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )

        raw_tasks = json.loads(result.stdout)

        if self.parent_issue is not None:
            raw_tasks = [
                raw
                for raw in raw_tasks
                if int(raw["number"]) != self.parent_issue
            ]

        tasks = [
            task_from_gh_json(raw)
            for raw in raw_tasks
        ]

        return sorted(
            tasks,
            key=lambda task: task.number,
        )


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
