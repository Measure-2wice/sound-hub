"""State-aware ticket eligibility / recovery policy.

Before integration, a ticket must still be open and label-clean.

During ``INTEGRATING`` or ``INTEGRATED`` recovery, Ralph itself may
have closed the issue while completing the previous run, so the
issue is allowed to be closed; identity is re-verified through the
durable PR + persisted commit instead.

The rules live here, not in ``run.py``, so the orchestrator can
keep wiring components and not duplicate policy logic.
"""

from dataclasses import dataclass
from typing import Iterable

from scripts.ralph.github_source import GitHubTask
from scripts.ralph.states import TicketState


RECOVERY_STATES: frozenset[TicketState] = frozenset(
    {
        TicketState.INTEGRATING,
        TicketState.INTEGRATED,
    }
)


@dataclass(frozen=True)
class EligibilityConfig:
    required_label: str
    skip_labels: frozenset[str]


def issue_still_eligible(
    *,
    task: GitHubTask,
    tasks_by_number: dict[int, GitHubTask],
    config: EligibilityConfig,
    state: TicketState,
) -> bool:
    """Return True if the checkpoint's ticket may still execute.

    During recovery states, the issue may already be closed by
    Ralph itself; durability is enforced separately.
    """

    if state not in RECOVERY_STATES:
        if task.is_closed:
            return False

        if config.required_label not in task.labels:
            return False

        if task.labels & config.skip_labels:
            return False

        for dep in task.dependencies:
            dependency = tasks_by_number.get(dep)

            if (
                dependency is None
                or not dependency.is_closed
            ):
                return False

    return True
