import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, List

from .github_source import GitHubTask


@dataclass(frozen=True)
class RefinementPacket:
    number: int
    title: str
    state: str
    labels: List[str]
    dependencies: List[int]
    body: str
    policy: dict


def load_refinement_policy(
    path: str = ".ralph/refinement/policy.json",
) -> dict:
    return json.loads(Path(path).read_text())


def build_refinement_packet(
    task: GitHubTask,
    policy: dict,
) -> RefinementPacket:
    return RefinementPacket(
        number=task.number,
        title=task.title,
        state=task.state,
        labels=sorted(task.labels),
        dependencies=list(task.dependencies),
        body=task.body,
        policy=policy,
    )


def packet_to_json(packet: RefinementPacket) -> str:
    return json.dumps(
        asdict(packet),
        indent=2,
        sort_keys=True,
    )


def eligible_for_refinement(
    task: GitHubTask,
    closed_dependencies: Iterable[int],
) -> bool:
    closed = set(closed_dependencies)

    return (
        not task.is_closed
        and all(
            dependency in closed
            for dependency in task.dependencies
        )
    )
