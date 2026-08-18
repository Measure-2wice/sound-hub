from dataclasses import dataclass

from scripts.ralph.states import TicketState


class GitPolicyError(RuntimeError):
    """A requested Git write violates Ralph's branch safety policy."""


@dataclass(frozen=True)
class GitPushPolicy:
    integration_branch: str
    ticket_branch_prefix: str
    protected_branches: tuple[str, ...] = ("main",)

    def ticket_branch(self, issue_number: int) -> str:
        return f"{self.ticket_branch_prefix}{issue_number}"

    def assert_push_allowed(
        self,
        *,
        branch: str,
        state: TicketState,
        issue_number: int,
        force: bool = False,
    ) -> None:
        if force:
            raise GitPolicyError(
                "Ralph force-push is forbidden."
            )

        if branch in self.protected_branches:
            raise GitPolicyError(
                f"Ralph may never push protected branch `{branch}`."
            )

        expected_ticket_branch = self.ticket_branch(
            issue_number
        )

        if branch == expected_ticket_branch:
            if state not in {
                TicketState.IMPLEMENTING,
                TicketState.FIXING,
            }:
                raise GitPolicyError(
                    "Ticket-branch push is only allowed while "
                    f"IMPLEMENTING or FIXING; current state is "
                    f"{state.value}."
                )

            return

        if branch == self.integration_branch:
            if state != TicketState.INTEGRATING:
                raise GitPolicyError(
                    "Integration-branch push is only allowed while "
                    f"INTEGRATING; current state is {state.value}."
                )

            return

        raise GitPolicyError(
            f"Ralph is not permitted to push branch `{branch}`."
        )
