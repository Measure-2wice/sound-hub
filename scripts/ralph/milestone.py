"""Milestone-level outer loop for Ralph.

This module is a thin orchestration layer that runs every
execution-eligible ticket in a configured milestone sequentially
by reusing the existing single-ticket ``Orchestrator``.

It is intentionally NOT a state machine.

Responsibilities owned here:

- rediscovering milestone task state between tickets,
- selecting the next expected issue from the execution
  frontier,
- pinning that expected issue into a fresh ``Orchestrator``
  instance,
- classifying the milestone-level outcome from the
  Orchestrator's terminal ``TicketState``,
- applying the no-progress invariant against the EXACT
  expected issue,
- reporting milestone-level status to the operator console.

Responsibilities NOT owned here:

- ticket checkpoint creation, mutation, or clearing,
- implementation, review, QA, persistence, integration,
- branch cleanup,
- GitHub write operations,
- inner ticket selection (the Orchestrator owns that for
  both checkpoint-resume and pinned-identity paths),
- parent-issue filtering (the production
  ``GitHubTaskSource`` already excludes ``parentIssue``).

Those remain owned by the existing components.

Restart model:

- This module introduces NO new durable checkpoint.
- A durable ticket checkpoint already present on disk means
  the previous ticket did not finish successfully.  The
  existing ``Orchestrator`` resumes that exact ticket on
  its own.  ``--milestone`` MUST invoke the Orchestrator
  for the checkpointed issue BEFORE classifying the
  milestone as COMPLETE, NO_ELIGIBLE_WORK, or empty.
- No checkpoint on disk plus a CLOSED previous issue means
  the milestone is between tickets.  ``--milestone``
  rediscovers GitHub, picks the next execution-frontier
  ticket, and pins it into a fresh ``Orchestrator`` so a
  concurrent GitHub change CANNOT silently swap identities.

Termination model:

- ``MilestoneStatus.COMPLETE``: every discovered milestone
  ticket is already CLOSED after a successful iteration
  that PROVED the expected issue itself closed.  Vacuous-
  truth empty discovery does NOT count.  A terminal
  checkpoint MUST take precedence over a COMPLETE
  classification.
- ``MilestoneStatus.STOPPED_FOR_HUMAN``: ``Orchestrator``
  returned ``BLOCKED_FOR_HUMAN``, OR ``Orchestrator``
  returned ``HUMAN_QA_PENDING`` but the just-pinned issue
  is still OPEN or absent (no-progress invariant failure),
  OR an existing terminal ``BLOCKED_FOR_HUMAN`` checkpoint
  was loaded.
- ``MilestoneStatus.INFRA_FAILURE``: ``Orchestrator``
  returned ``INFRA_FAILURE``, ``CheckpointStore`` could
  not load the durable checkpoint, OR an existing
  terminal ``INFRA_FAILURE`` checkpoint was loaded.
- ``MilestoneStatus.AGENT_FAILURE``: ``Orchestrator``
  returned ``AGENT_FAILURE``, OR an existing terminal
  ``AGENT_FAILURE`` checkpoint was loaded.
- ``MilestoneStatus.NO_ELIGIBLE_WORK``: open milestone
  tickets remain but ``execution_frontier`` is empty, OR
  the discovery returned an empty task list with no
  checkpoint on disk (treated as fail-closed).

Terminal checkpoint preservation:

- When an existing ticket checkpoint is already on disk
  AND its ``state`` is ``BLOCKED_FOR_HUMAN``,
  ``INFRA_FAILURE``, or ``AGENT_FAILURE``, the milestone
  runner MUST stop immediately and MUST NOT invoke the
  ``Orchestrator`` again.  The durable on-disk state is
  the authoritative reason Ralph stopped; sending the
  checkpoint back through the single-ticket eligibility
  machinery would risk silent reclassification to a
  different terminal category (e.g. ``INFRA_FAILURE`` ->
  ``BLOCKED_FOR_HUMAN`` via ``ISSUE_NOT_ELIGIBLE`` when
  the issue was closed externally).
- Terminal classification is AUTH-FREE: the runner
  MUST NOT construct ``GitHubAppAuthenticator``,
  ``GitHubTaskSource``, ``Orchestrator``, or
  ``TenkiSandbox`` to reach the terminal mapping.  A
  stale or missing GitHub App config MUST NOT mask the
  authoritative terminal state.
- A non-terminal checkpoint (e.g. ``IMPLEMENTING``,
  ``AUTOMATED_QA``, ``INTEGRATING``) MUST use the normal
  existing Orchestrator recovery path.  Only terminal
  states short-circuit the Orchestrator invocation.
- The terminal checkpoint file MUST remain unmodified by
  the milestone layer.  No save / replace / clear.

Trust boundary:

- ``checkpoint.last_error`` is Ralph-owned control-plane
  data and is set only through the Orchestrator's closed
  ``TerminalReason`` static-message mapping.  The milestone
  layer never writes ``last_error`` directly.
- Orchestration exceptions, CheckpointStore failures, and
  config-load failures are normalized to STATIC
  Ralph-authored console lines.  No exception text, repr,
  model output, API response, or subprocess output reaches
  the operator console from this module.
"""

import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Optional

from scripts.ralph.checkpoint import (
    CheckpointError,
    CheckpointStore,
)
from scripts.ralph.github_app import GitHubAppAuthenticator
from scripts.ralph.github_source import (
    GitHubTask,
    GitHubTaskSource,
    execution_frontier,
)
from scripts.ralph.run import (
    ConductorCallbacks,
    Orchestrator,
    OrchestratorError,
    build_authenticator,
    load_config,
    split_repository,
)
from scripts.ralph.states import TicketState


class MilestoneStatus(Enum):
    """Categorical milestone-level outcomes.

    All values are static Ralph-owned strings; the operator
    console never prints arbitrary text under these names.
    """

    COMPLETE = "COMPLETE"
    STOPPED_FOR_HUMAN = "STOPPED_FOR_HUMAN"
    INFRA_FAILURE = "INFRA_FAILURE"
    AGENT_FAILURE = "AGENT_FAILURE"
    NO_ELIGIBLE_WORK = "NO_ELIGIBLE_WORK"


# Set of terminal single-ticket states that MUST stop the
# milestone loop immediately.  Mirrors the terminal states
# already enforced inside ``Orchestrator``.
_STOP_STATES: frozenset = frozenset(
    {
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
        TicketState.AGENT_FAILURE,
    }
)

# Map a terminal ``TicketState`` to the corresponding
# milestone-level status.  Ralph-owned static mapping.
_TICKET_TO_MILESTONE_STATUS: dict = {
    TicketState.BLOCKED_FOR_HUMAN: (
        MilestoneStatus.STOPPED_FOR_HUMAN
    ),
    TicketState.INFRA_FAILURE: (
        MilestoneStatus.INFRA_FAILURE
    ),
    TicketState.AGENT_FAILURE: (
        MilestoneStatus.AGENT_FAILURE
    ),
}


@dataclass(frozen=True)
class MilestoneResult:
    """Outcome of one ``--milestone`` invocation.

    NOT persisted.  Used only by the CLI to compute the
    process exit code and to print a final summary line.
    """

    status: MilestoneStatus
    completed_tickets: tuple[int, ...]
    current_issue: Optional[int]


@dataclass(frozen=True)
class MilestoneRunnerCallbacks:
    """Injectable factory hooks so unit tests can substitute
    ``Orchestrator``, ``GitHubTaskSource``, and the
    ``GitHubAppAuthenticator`` constructor.

    All fields default to ``None``, meaning the runner falls
    back to the real production wiring.
    """

    make_orchestrator: object = None
    make_task_source: object = None
    build_authenticator: object = None
    conductor_callbacks: Optional[ConductorCallbacks] = None


class MilestoneRunner:
    """Thin outer loop that drives the existing ``Orchestrator``
    across every execution-eligible ticket in a milestone.

    Every iteration uses a FRESH ``Orchestrator`` instance so
    each ticket inherits the existing fresh Tenki sandbox
    lifecycle.  No milestone-level checkpoint is created.

    Identity pinning: when no durable ticket checkpoint
    exists, the runner pins the chosen issue number into
    the new ``Orchestrator`` via ``expected_issue_number``.
    The Orchestrator MUST execute that exact issue or fail
    closed; it MUST NOT silently substitute a different
    eligible ticket.

    Startup ordering:

      1. Config load (static failure normalization).
      2. Checkpoint load (static failure normalization
         on corrupt checkpoint).
      3. Terminal-checkpoint short-circuit.  If the
         checkpoint is already in ``BLOCKED_FOR_HUMAN``,
         ``INFRA_FAILURE``, or ``AGENT_FAILURE``, return
         the mapped milestone status IMMEDIATELY.  This
         step MUST NOT require GitHub authentication.  A
         durable terminal checkpoint is the authoritative
         answer regardless of whether the operator's GitHub
         App config is valid.
      4. Authenticator build.  Only reached when no
         terminal checkpoint short-circuited.
      5. Existing checkpoint recovery (non-terminal) or
         normal discovery.

    Existing checkpoint precedence: when a non-terminal
    ticket checkpoint is already on disk, the milestone
    runner invokes the Orchestrator FIRST for the
    checkpointed issue BEFORE classifying the milestone
    state.  Missing-checkpointed-issue and successful
    resume are handled by the existing Orchestrator
    recovery path.
    """

    def __init__(
        self,
        *,
        config_path: str,
        checkpoint_path: Path,
        callbacks: Optional[
            MilestoneRunnerCallbacks
        ] = None,
    ):
        self.config_path = config_path
        self.checkpoint_path = checkpoint_path
        self.callbacks = (
            callbacks or MilestoneRunnerCallbacks()
        )

    def run(self) -> MilestoneResult:
        # ------------------------------------------------------------------
        # Startup ordering invariant:
        #
        #   1. CONFIG LOAD     (static failure normalization)
        #   2. CHECKPOINT LOAD (static failure normalization)
        #   3. TERMINAL CHECKPOINT SHORT-CIRCUIT (NO GitHub auth)
        #   4. AUTHENTICATOR BUILD
        #   5. NORMAL DISCOVERY / RECOVERY LOOP
        #
        # The terminal-classification step (#3) MUST be reachable
        # even when GitHub authentication would fail.  A durable
        # terminal checkpoint is authoritative on-disk state; if it
        # says Ralph stopped, that is the answer regardless of
        # whether the operator's GitHub App credentials are still
        # valid.  Constructing the authenticator before reading the
        # checkpoint would let a stale or missing auth config
        # mask the authoritative terminal state.
        # ------------------------------------------------------------------

        # 1. CONFIG LOAD.
        config = self._load_config_safely()

        if config is None:
            # Config-load failure already printed a
            # static Ralph-owned line.  INFRA_FAILURE
            # is the closest existing status to a
            # configuration problem.
            return MilestoneResult(
                status=MilestoneStatus.INFRA_FAILURE,
                completed_tickets=(),
                current_issue=None,
            )

        milestone_id = str(
            config.get("id", "")
        )

        # 2. CHECKPOINT LOAD.
        try:
            existing_checkpoint = (
                CheckpointStore(
                    self.checkpoint_path
                ).load()
            )
        except CheckpointError:
            # A corrupt checkpoint is an
            # INFRA_FAILURE-class event at the milestone
            # layer.  Surface a static Ralph-owned line
            # and stop — and crucially, this still
            # happens WITHOUT GitHub authentication.
            print(
                "RALPH MILESTONE: "
                "checkpoint infrastructure failure"
            )
            return MilestoneResult(
                status=MilestoneStatus.INFRA_FAILURE,
                completed_tickets=(),
                current_issue=None,
            )

        # 3. TERMINAL CHECKPOINT SHORT-CIRCUIT.
        #
        # Auth-free classification.  The durable
        # terminal checkpoint is the authoritative
        # reason Ralph stopped.  We map the state and
        # return WITHOUT building the authenticator,
        # WITHOUT instantiating Orchestrator, WITHOUT
        # touching GitHub, WITHOUT mutating the
        # checkpoint file.
        if existing_checkpoint is not None:
            terminal = self._classify_terminal_checkpoint(
                existing_checkpoint
            )
            if terminal is not None:
                return terminal

        # 4. AUTHENTICATOR BUILD.
        authenticator = self._build_authenticator(
            config=config,
        )

        completed: list[int] = []

        print(
            "RALPH MILESTONE: "
            f"starting {milestone_id}"
        )

        # 5. EXISTING CHECKPOINT PRECEDENCE (non-terminal).
        #
        # When a durable ticket checkpoint is already on
        # disk AND it is not already in a terminal
        # state, invoke the Orchestrator FIRST so the
        # checkpointed ticket is resumed / recorded
        # terminal / marked missing.  Do NOT classify
        # empty discovery, COMPLETE, or
        # NO_ELIGIBLE_WORK before resolving the existing
        # checkpoint.
        if existing_checkpoint is not None:
            return self._resume_checked_ticket(
                config=config,
                authenticator=authenticator,
                existing_checkpoint=existing_checkpoint,
                completed=completed,
            )

        # 2. NO CHECKPOINT.  Classify milestone shape
        # before selecting a ticket.
        tasks = self._discover_tasks(
            config=config,
            authenticator=authenticator,
        )

        # An empty task list from a configured milestone
        # is fail-closed.  Empty discovery may signal a
        # misconfigured ``githubMilestone`` or a
        # parent-only milestone; in either case we MUST
        # NOT silently declare success.
        if not tasks:
            print(
                "RALPH MILESTONE: "
                "no milestone tasks discovered"
            )
            return MilestoneResult(
                status=MilestoneStatus.NO_ELIGIBLE_WORK,
                completed_tickets=tuple(completed),
                current_issue=None,
            )

        # Fast-path: every discovered ticket is already
        # CLOSED AND the discovery was non-empty AND no
        # checkpoint exists.  The milestone is complete
        # before the runner ever touches a Tenki sandbox
        # or the ticket checkpoint.
        if self._milestone_is_complete(tasks=tasks):
            print(
                "RALPH MILESTONE: "
                "COMPLETE — 0 tickets completed"
            )
            return MilestoneResult(
                status=MilestoneStatus.COMPLETE,
                completed_tickets=tuple(completed),
                current_issue=None,
            )

        return self._run_milestone_loop(
            config=config,
            authenticator=authenticator,
            initial_tasks=tasks,
            completed=completed,
        )

    # ---------------------------------------------------------------
    # Terminal-checkpoint classification (auth-free path)
    # ---------------------------------------------------------------

    def _classify_terminal_checkpoint(
        self,
        existing_checkpoint,
    ) -> Optional[MilestoneResult]:
        """If the durable checkpoint is in a terminal
        state, return the corresponding
        ``MilestoneResult`` and STOP.

        This helper MUST NOT construct or call:

        - ``Orchestrator``
        - ``GitHubTaskSource``
        - ``GitHubAppAuthenticator``
        - ``TenkiSandbox``

        The durable on-disk terminal state is the
        authoritative reason Ralph stopped; this is the
        auth-free classification path.  It runs BEFORE
        any GitHub authentication is attempted so a
        stale, missing, or revoked GitHub App config
        cannot mask the authoritative terminal state.

        Returns ``None`` when the checkpoint is NOT
        terminal — the caller should then proceed with
        normal discovery / Orchestrator-based
        recovery.
        """
        if existing_checkpoint.state not in _STOP_STATES:
            return None

        milestone_status = _TICKET_TO_MILESTONE_STATUS[
            existing_checkpoint.state
        ]
        self._print_stop(
            issue_number=(
                existing_checkpoint.issue_number
            ),
            final_state=existing_checkpoint.state,
        )
        return MilestoneResult(
            status=milestone_status,
            completed_tickets=(),
            current_issue=(
                existing_checkpoint.issue_number
            ),
        )

    # ---------------------------------------------------------------
    # Resume-checkpoint path (existing-checkpoint precedence)
    # ---------------------------------------------------------------

    def _resume_checked_ticket(
        self,
        *,
        config: dict,
        authenticator: GitHubAppAuthenticator,
        existing_checkpoint,
        completed: list[int],
    ) -> MilestoneResult:
        """Invoke the Orchestrator for the checkpointed
        issue exactly once, then classify the outcome.

        The Orchestrator owns the resolution of the
        existing checkpoint: it may resume the ticket
        (returns ``HUMAN_QA_PENDING`` and clears the
        checkpoint), record ``ISSUE_NO_LONGER_PRESENT``
        if the issue disappeared from discovery, or
        return a terminal state (BLOCKED / INFRA /
        AGENT).  In every case the milestone layer must
        not override the Orchestrator's classification.
        """
        current_issue = existing_checkpoint.issue_number

        print(
            "RALPH MILESTONE: "
            f"resuming issue #{current_issue}"
        )

        # ``pinned=None`` because the existing checkpoint
        # is the authoritative identity; the Orchestrator
        # MUST resume that exact ticket on its own.
        final_state = self._invoke_orchestrator(
            config=config,
            pinned=None,
        )

        if final_state in _STOP_STATES:
            milestone_status = (
                _TICKET_TO_MILESTONE_STATUS[final_state]
            )
            self._print_stop(
                issue_number=current_issue,
                final_state=final_state,
            )
            return MilestoneResult(
                status=milestone_status,
                completed_tickets=tuple(completed),
                current_issue=current_issue,
            )

        if final_state != TicketState.HUMAN_QA_PENDING:
            self._print_stop(
                issue_number=current_issue,
                final_state=final_state,
            )
            return MilestoneResult(
                status=MilestoneStatus.STOPPED_FOR_HUMAN,
                completed_tickets=tuple(completed),
                current_issue=current_issue,
            )

        # The Orchestrator cleared the checkpoint and
        # closed the issue.  Apply the strengthened
        # no-progress invariant and continue into the
        # loop body.
        print(
            "RALPH MILESTONE: rediscovering tasks"
        )

        tasks = self._discover_tasks(
            config=config,
            authenticator=authenticator,
        )

        if self._no_progress_for(
            current_issue=current_issue,
            tasks=tasks,
        ):
            print(
                "RALPH MILESTONE: "
                "no-progress guard tripped — "
                f"issue #{current_issue} "
                "remained open after successful "
                "execution"
            )
            return MilestoneResult(
                status=MilestoneStatus.STOPPED_FOR_HUMAN,
                completed_tickets=tuple(completed),
                current_issue=current_issue,
            )

        completed.append(current_issue)
        current_issue = None

        print(
            "RALPH MILESTONE: "
            f"issue #{completed[-1]} completed"
        )

        # Empty discovery after a successful resume is
        # fail-closed.
        if not tasks:
            print(
                "RALPH MILESTONE: "
                "no milestone tasks discovered"
            )
            return MilestoneResult(
                status=MilestoneStatus.NO_ELIGIBLE_WORK,
                completed_tickets=tuple(completed),
                current_issue=None,
            )

        return self._run_milestone_loop(
            config=config,
            authenticator=authenticator,
            initial_tasks=tasks,
            completed=completed,
        )

    # ---------------------------------------------------------------
    # Main loop body (no existing checkpoint)
    # ---------------------------------------------------------------

    def _run_milestone_loop(
        self,
        *,
        config: dict,
        authenticator: GitHubAppAuthenticator,
        initial_tasks: list[GitHubTask],
        completed: list[int],
    ) -> MilestoneResult:
        tasks = initial_tasks

        while True:
            if self._milestone_is_complete(tasks=tasks):
                break

            chosen_task = self._select_ticket(
                tasks=tasks,
                config=config,
            )

            if chosen_task is None:
                # Execution frontier is empty even though
                # not every milestone ticket is CLOSED.
                # Possible causes: missing required label,
                # skip label, unresolved dependency,
                # supervised-agent, needs-reshaping.  STOP
                # without mutating anything.
                open_count = sum(
                    1
                    for task in tasks
                    if not task.is_closed
                )
                print(
                    "RALPH MILESTONE: "
                    "no eligible execution-frontier "
                    f"tickets; {open_count} open "
                    "milestone tickets remain."
                )
                return MilestoneResult(
                    status=MilestoneStatus.NO_ELIGIBLE_WORK,
                    completed_tickets=tuple(completed),
                    current_issue=None,
                )

            current_issue = chosen_task.number

            print(
                "RALPH MILESTONE: "
                f"executing issue #{current_issue}"
            )

            # Pin the chosen issue into the Orchestrator
            # so a concurrent GitHub change cannot
            # silently substitute a different ticket.
            final_state = self._invoke_orchestrator(
                config=config,
                pinned=current_issue,
            )

            if final_state in _STOP_STATES:
                milestone_status = (
                    _TICKET_TO_MILESTONE_STATUS[
                        final_state
                    ]
                )
                self._print_stop(
                    issue_number=current_issue,
                    final_state=final_state,
                )
                return MilestoneResult(
                    status=milestone_status,
                    completed_tickets=tuple(completed),
                    current_issue=current_issue,
                )

            if final_state != TicketState.HUMAN_QA_PENDING:
                self._print_stop(
                    issue_number=current_issue,
                    final_state=final_state,
                )
                return MilestoneResult(
                    status=MilestoneStatus.STOPPED_FOR_HUMAN,
                    completed_tickets=tuple(completed),
                    current_issue=current_issue,
                )

            # Success path: ``HUMAN_QA_PENDING`` means
            # the ticket checkpoint has been cleared.
            # Apply the strengthened no-progress
            # invariant.
            print(
                "RALPH MILESTONE: rediscovering tasks"
            )

            tasks = self._discover_tasks(
                config=config,
                authenticator=authenticator,
            )

            if self._no_progress_for(
                current_issue=current_issue,
                tasks=tasks,
            ):
                print(
                    "RALPH MILESTONE: "
                    "no-progress guard tripped — "
                    f"issue #{current_issue} "
                    "remained open after successful "
                    "execution"
                )
                return MilestoneResult(
                    status=MilestoneStatus.STOPPED_FOR_HUMAN,
                    completed_tickets=tuple(completed),
                    current_issue=current_issue,
                )

            completed.append(current_issue)
            current_issue = None

            print(
                "RALPH MILESTONE: "
                f"issue #{completed[-1]} completed"
            )

        print(
            "RALPH MILESTONE: "
            f"COMPLETE — {len(completed)} tickets "
            "completed"
        )

        return MilestoneResult(
            status=MilestoneStatus.COMPLETE,
            completed_tickets=tuple(completed),
            current_issue=None,
        )

    # ---------------------------------------------------------------
    # Config load — fail closed with static Ralph-owned message
    # ---------------------------------------------------------------

    def _load_config_safely(self) -> Optional[dict]:
        """Load the milestone config and normalize known
        failure modes into a static ``RALPH MILESTONE``
        console line.

        Returns ``None`` if the config could not be
        loaded.  Only ``OSError`` (missing / unreadable
        file) and ``json.JSONDecodeError`` (malformed
        JSON) are caught.  Programming bugs are NOT
        hidden.
        """
        try:
            return load_config(self.config_path)
        except (OSError, json.JSONDecodeError):
            print(
                "RALPH MILESTONE: "
                "configuration load failure"
            )
            return None

    # ---------------------------------------------------------------
    # Orchestrator invocation — trust boundary
    # ---------------------------------------------------------------

    def _invoke_orchestrator(
        self,
        *,
        config: dict,
        pinned: Optional[int],
    ) -> TicketState:
        """Construct a fresh ``Orchestrator`` and invoke it
        for exactly one ticket.

        ``pinned`` is the issue number the outer runner
        expects the Orchestrator to execute.  ``None`` means
        no pin (used when an existing checkpoint is the
        authoritative identity).

        ``OrchestratorError`` is normalized to a STATIC
        Ralph-owned console line; no exception text reaches
        the operator.  The exception is then re-raised so
        the CLI's exit-code path can map it to a non-zero
        return.
        """
        conductor_callbacks = (
            self.callbacks.conductor_callbacks
        )

        if self.callbacks.make_orchestrator is not None:
            orchestrator = (
                self.callbacks.make_orchestrator(
                    config_path=self.config_path,
                    checkpoint_path=(
                        self.checkpoint_path
                    ),
                    expected_issue_number=pinned,
                    callbacks=conductor_callbacks,
                )
            )
        else:
            orchestrator = Orchestrator(
                config_path=self.config_path,
                checkpoint_path=self.checkpoint_path,
                expected_issue_number=pinned,
                callbacks=conductor_callbacks,
            )

        try:
            return orchestrator.run()
        except OrchestratorError:
            print(
                "RALPH MILESTONE: "
                "ticket orchestration failed"
            )
            raise

    # ---------------------------------------------------------------
    # Discovery
    # ---------------------------------------------------------------

    def _build_authenticator(
        self,
        *,
        config: dict,
    ) -> GitHubAppAuthenticator:
        if (
            self.callbacks.build_authenticator
            is not None
        ):
            return self.callbacks.build_authenticator(
                config
            )

        return build_authenticator(config)

    def _discover_tasks(
        self,
        *,
        config: dict,
        authenticator: GitHubAppAuthenticator,
    ) -> list[GitHubTask]:
        owner, repository = split_repository(
            config["repository"]
        )

        token = authenticator.mint_repository_token(
            owner=owner,
            repository=repository,
        )

        if self.callbacks.make_task_source is not None:
            source = self.callbacks.make_task_source(
                repository=config["repository"],
                milestone=config["githubMilestone"],
                parent_issue=config.get(
                    "parentIssue"
                ),
                github_token=token.token,
            )
        else:
            source = GitHubTaskSource(
                repository=config["repository"],
                milestone=config["githubMilestone"],
                parent_issue=config.get(
                    "parentIssue"
                ),
                github_token=token.token,
            )

        return source.list_tasks()

    def _select_ticket(
        self,
        *,
        tasks: list[GitHubTask],
        config: dict,
    ) -> Optional[GitHubTask]:
        eligible = execution_frontier(
            tasks,
            required_label=config["selection"][
                "requiredLabel"
            ],
            skip_labels=config["selection"][
                "skipLabels"
            ],
        )

        if not eligible:
            return None

        return eligible[0]

    # ---------------------------------------------------------------
    # No-progress invariant
    # ---------------------------------------------------------------

    def _no_progress_for(
        self,
        *,
        current_issue: int,
        tasks: list[GitHubTask],
    ) -> bool:
        """Return True if the just-executed pinned issue
        is NOT present in the post-discovery task list
        OR is still OPEN.

        Closing some other issue never satisfies
        progress for ``current_issue``.
        """
        post_by_number = {
            task.number: task for task in tasks
        }
        executed = post_by_number.get(current_issue)
        return (
            executed is None
            or not executed.is_closed
        )

    # ---------------------------------------------------------------
    # Completion predicate
    #
    # The production ``GitHubTaskSource.list_tasks()`` already
    # excludes ``config["parentIssue"]`` from the returned task
    # set, so this predicate operates on the production-shaped
    # child-only list.  It is only consulted AFTER the caller
    # has verified that ``tasks`` is non-empty AND no durable
    # ticket checkpoint is present.
    # ---------------------------------------------------------------

    def _milestone_is_complete(
        self,
        *,
        tasks: list[GitHubTask],
    ) -> bool:
        """Return True only when every discovered task is
        already CLOSED.

        Vacuous-truth empty discovery is rejected by the
        caller; this predicate is only consulted when
        ``tasks`` is non-empty AND no checkpoint is on
        disk.
        """
        return all(task.is_closed for task in tasks)

    # ---------------------------------------------------------------
    # Observability
    # ---------------------------------------------------------------

    def _print_stop(
        self,
        *,
        issue_number: Optional[int],
        final_state: TicketState,
    ) -> None:
        if issue_number is not None:
            print(
                "RALPH MILESTONE: "
                f"stopped on issue #{issue_number} — "
                f"{final_state.value}"
            )
        else:
            print(
                "RALPH MILESTONE: "
                f"stopped — {final_state.value}"
            )


def build_cli_callbacks() -> MilestoneRunnerCallbacks:
    """Build a ``MilestoneRunnerCallbacks`` whose only override
    is the real production ``Orchestrator`` factory.  Kept as
    a stable import target for the CLI; the milestone runner
    uses the production ``Orchestrator`` by default.
    """
    return MilestoneRunnerCallbacks()
