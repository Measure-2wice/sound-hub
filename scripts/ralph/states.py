from enum import Enum


class StrEnum(str, Enum):
    """Python 3.9-compatible string enum."""

    def __str__(self) -> str:
        return self.value


class MilestoneState(StrEnum):
    READY = "READY"
    RUNNING = "RUNNING"
    BLOCKED = "BLOCKED"
    QA_READY = "QA_READY"
    COMPLETE = "COMPLETE"


class TicketState(StrEnum):
    DISCOVERED = "DISCOVERED"
    READY = "READY"

    IMPLEMENTING = "IMPLEMENTING"
    REVIEWING = "REVIEWING"
    FIXING = "FIXING"
    AUTOMATED_QA = "AUTOMATED_QA"

    INTEGRATING = "INTEGRATING"
    INTEGRATED = "INTEGRATED"
    HUMAN_QA_PENDING = "HUMAN_QA_PENDING"

    NEEDS_RESHAPING = "NEEDS_RESHAPING"
    BLOCKED_FOR_HUMAN = "BLOCKED_FOR_HUMAN"
    INFRA_FAILURE = "INFRA_FAILURE"
    AGENT_FAILURE = "AGENT_FAILURE"
