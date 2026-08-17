from .states import TicketState


ALLOWED_TICKET_TRANSITIONS: dict[TicketState, set[TicketState]] = {
    TicketState.DISCOVERED: {
        TicketState.READY,
        TicketState.NEEDS_RESHAPING,
        TicketState.BLOCKED_FOR_HUMAN,
    },

    TicketState.READY: {
        TicketState.IMPLEMENTING,
    },

    TicketState.IMPLEMENTING: {
        TicketState.IMPLEMENTING,
        TicketState.REVIEWING,
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
        TicketState.AGENT_FAILURE,
    },

    TicketState.REVIEWING: {
        TicketState.FIXING,
        TicketState.AUTOMATED_QA,
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
        TicketState.AGENT_FAILURE,
    },

    TicketState.FIXING: {
        TicketState.FIXING,
        TicketState.REVIEWING,
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
        TicketState.AGENT_FAILURE,
    },

    TicketState.AUTOMATED_QA: {
        TicketState.INTEGRATING,
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
    },

    TicketState.INTEGRATING: {
        TicketState.INTEGRATED,
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
    },

    TicketState.INTEGRATED: {
        TicketState.HUMAN_QA_PENDING,
    },

    TicketState.HUMAN_QA_PENDING: set(),

    TicketState.NEEDS_RESHAPING: set(),
    TicketState.BLOCKED_FOR_HUMAN: set(),
    TicketState.INFRA_FAILURE: set(),
    TicketState.AGENT_FAILURE: set(),
}


def can_transition(current: TicketState, target: TicketState) -> bool:
    return target in ALLOWED_TICKET_TRANSITIONS[current]


def assert_transition(current: TicketState, target: TicketState) -> None:
    if not can_transition(current, target):
        raise ValueError(
            f"Illegal Ralph ticket transition: {current.value} -> {target.value}"
        )
