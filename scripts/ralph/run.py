"""Single-ticket Ralph conductor.

This module wires components together and dispatches state
transitions. The actual business logic for each step lives in the
existing component owned for that responsibility.

Restart model:

- Pre-persistence states (IMPLEMENTING, REVIEWING, FIXING,
  AUTOMATED_QA): Ralph builds a fresh sandbox and recomputes from
  the checkpointed ticket baseline. Attempt counters are
  incremented and saved BEFORE the operation runs, so a crash
  cannot erase a consumed attempt. The integration base SHA must
  still match the checkpoint.

- Crash window between persistence side-effects and durable
  checkpoint save: ``recovery.reconcile_persistence`` reads
  durable GitHub state and recovers
  ``persisted_commit_sha`` + ``pull_request_number`` without
  re-running persistence.

- Post-persistence state (INTEGRATING, INTEGRATED): the durable
  commit and PR identity are the source of truth.
  ``IntegrationRunner`` is already idempotent.

- Uncertain state around an irreversible GitHub operation: stop
  rather than guess.

Attempt budget invariant: each runner is invoked only after the
appropriate counter has been incremented AND the checkpoint has
been saved. A crash anywhere in the runner does not lose the
attempt.
"""

import argparse
import json
import os
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Optional

from scripts.ralph.checkpoint import (
    CheckpointError,
    CheckpointStore,
    TicketCheckpoint,
)
from scripts.ralph.cleanup import (
    RemoteBranchCleanupError,
    RemoteBranchCleaner,
)
from scripts.ralph.eligibility import (
    EligibilityConfig,
    issue_still_eligible,
)
from scripts.ralph.github_app import GitHubAppAuthenticator
from scripts.ralph.github_probe import GitHubReadOnlyProbe
from scripts.ralph.github_source import (
    DependencyDeclarationError,
    GitHubTask,
    GitHubTaskSource,
    execution_frontier,
)
from scripts.ralph.git_policy import GitPushPolicy
from scripts.ralph.implementation import (
    CompletionPhase,
    ImplementationError,
    ImplementationFixContext,
    ImplementationRunner,
    completion_result_path,
)
from scripts.ralph.integration import (
    IntegrationError,
    IntegrationRunner,
)
from scripts.ralph.persistence import (
    CommitOnlyContinuationResult,
    PersistenceError,
    PersistenceRunner,
    PersistenceRecoveryDisposition,
)
from scripts.ralph.qa import (
    QaRunner,
    QaStatus,
)
from scripts.ralph.qa_environment import (
    PostgresQaEnvironment,
    QaEnvironmentError,
)
from scripts.ralph.recovery import (
    DurableStateProbe,
    MergedPRVerification,
    RecoveryOutcome,
    RecoveryState,
    reconcile_persistence,
    verify_merged_pull_request,
)
from scripts.ralph.review import (
    ReviewError,
    ReviewRunner,
    ReviewStage,
    ReviewVerdict,
)
from scripts.ralph.sandbox import TenkiSandbox
from scripts.ralph.states import TicketState
from scripts.ralph.transitions import assert_transition
from scripts.ralph.workspace import (
    TicketWorkspace,
    TicketWorkspaceManager,
    WorkspacePreparationError,
)


class OrchestratorError(RuntimeError):
    pass


@dataclass(frozen=True)
class ConductorCallbacks:
    """Injectable factory hooks so unit tests can substitute runners."""

    make_authenticator: object = None
    make_qa_environment: object = None
    make_implementation_runner: object = None
    make_review_runner: object = None
    make_qa_runner: object = None
    make_persistence_runner: object = None
    make_integration_runner: object = None
    make_remote_branch_cleaner: object = None
    make_github_probe: object = None
    mint_github_token: object = None


# ---------------------------------------------------------------------------
# Control-plane trust boundary
# ---------------------------------------------------------------------------
#
# ``checkpoint.last_error`` is Ralph-owned control-plane metadata.
# It MUST NEVER be derived from runtime model output, exception
# strings, subprocess stdout/stderr, API response text, QA command
# output, or any other untrusted source.
#
# The only path into ``checkpoint.last_error`` is
# ``_record_terminal(..., reason=TerminalReason)``, which maps
# the closed categorical reason to a STATIC Ralph-authored
# message.  No caller may provide the final string.
#
# This is the security boundary.  Do not weaken it.
# ---------------------------------------------------------------------------


class TerminalReason(str, Enum):
    """Closed categorical reasons for terminating ticket
    orchestration.  Each reason maps to a single static
    Ralph-authored message in ``TERMINAL_REASON_MESSAGES``.

    Reasons correspond to terminal paths the conductor already
    takes.  No new state is invented; the enum only names what
    the conductor was already doing so the message it persists
    cannot be chosen by an attacker.
    """

    ITERATION_GUARD_EXCEEDED = (
        "ITERATION_GUARD_EXCEEDED"
    )
    IMPLEMENTATION_AGENT_FAILURE = (
        "IMPLEMENTATION_AGENT_FAILURE"
    )
    IMPLEMENTATION_BLOCKED = (
        "IMPLEMENTATION_BLOCKED"
    )
    IMPLEMENTATION_EXHAUSTED_NO_CHANGES = (
        "IMPLEMENTATION_EXHAUSTED_NO_CHANGES"
    )
    IMPLEMENTATION_BUDGET_EXHAUSTED = (
        "IMPLEMENTATION_BUDGET_EXHAUSTED"
    )
    REVIEW_FIX_BUDGET_EXHAUSTED = (
        "REVIEW_FIX_BUDGET_EXHAUSTED"
    )
    REVIEW_CYCLE_BUDGET_EXHAUSTED = (
        "REVIEW_CYCLE_BUDGET_EXHAUSTED"
    )
    REVIEW_AGENT_FAILURE = (
        "REVIEW_AGENT_FAILURE"
    )
    REVIEW_FIX_BEFORE_QA = (
        "REVIEW_FIX_BEFORE_QA"
    )
    REVIEW_BLOCK_PERSISTENCE = (
        "REVIEW_BLOCK_PERSISTENCE"
    )
    QA_CODE_FAILURE = (
        "QA_CODE_FAILURE"
    )
    QA_BUDGET_EXHAUSTED = (
        "QA_BUDGET_EXHAUSTED"
    )
    QA_ENVIRONMENT_FAILURE = (
        "QA_ENVIRONMENT_FAILURE"
    )
    QA_INFRA_FAILURE = (
        "QA_INFRA_FAILURE"
    )
    PERSISTENCE_CONFLICT = (
        "PERSISTENCE_CONFLICT"
    )
    PERSISTENCE_AGENT_FAILURE = (
        "PERSISTENCE_AGENT_FAILURE"
    )
    INTEGRATION_CONFLICT = (
        "INTEGRATION_CONFLICT"
    )
    INTEGRATION_AGENT_FAILURE = (
        "INTEGRATION_AGENT_FAILURE"
    )
    WORKSPACE_UNAVAILABLE = (
        "WORKSPACE_UNAVAILABLE"
    )
    REMOTE_BRANCH_CLEANUP_FAILURE = (
        "REMOTE_BRANCH_CLEANUP_FAILURE"
    )
    ISSUE_NOT_ELIGIBLE = (
        "ISSUE_NOT_ELIGIBLE"
    )
    ISSUE_NO_LONGER_PRESENT = (
        "ISSUE_NO_LONGER_PRESENT"
    )


# Static Ralph-authored terminal messages.
#
# These strings are the ONLY strings that may ever appear in
# ``checkpoint.last_error``.  No runtime text is permitted.
#
# Vocabulary is deliberately disjoint from plausible secret
# shapes (API keys, tokens, JSON fragments, base64) so a
# substring scan can prove the absence of a leak without false
# positives.
TERMINAL_REASON_MESSAGES: dict = {
    TerminalReason.ITERATION_GUARD_EXCEEDED:
        "Ralph exceeded its internal iteration guard. "
        "Manual inspection required.",
    TerminalReason.IMPLEMENTATION_AGENT_FAILURE:
        "Implementation agent failed.",
    TerminalReason.IMPLEMENTATION_BLOCKED:
        "Implementation agent reported a blocker.",
    TerminalReason.IMPLEMENTATION_EXHAUSTED_NO_CHANGES:
        "Implementation exhausted its iteration "
        "budget without producing changes.",
    TerminalReason.IMPLEMENTATION_BUDGET_EXHAUSTED:
        "Implementation iteration budget exhausted.",
    TerminalReason.REVIEW_FIX_BUDGET_EXHAUSTED:
        "Fix iteration budget exhausted.",
    TerminalReason.REVIEW_CYCLE_BUDGET_EXHAUSTED:
        "Review cycle budget exhausted.",
    TerminalReason.REVIEW_AGENT_FAILURE:
        "Independent reviewer returned an invalid "
        "response.",
    TerminalReason.REVIEW_FIX_BEFORE_QA:
        "PRE_QA review requested "
        "implementation fixes.",
    TerminalReason.REVIEW_BLOCK_PERSISTENCE:
        "PRE_PERSISTENCE review blocked "
        "persistence.",
    TerminalReason.QA_CODE_FAILURE:
        "Automated QA reported code failure.",
    TerminalReason.QA_BUDGET_EXHAUSTED:
        "Automated QA attempt budget exhausted.",
    TerminalReason.QA_ENVIRONMENT_FAILURE:
        "Automated QA environment could not be "
        "provisioned.",
    TerminalReason.QA_INFRA_FAILURE:
        "Automated QA reported an infrastructure "
        "failure.",
    TerminalReason.PERSISTENCE_CONFLICT:
        "Persistence state could not be safely "
        "reconciled.",
    TerminalReason.PERSISTENCE_AGENT_FAILURE:
        "Persistence agent failed.",
    TerminalReason.INTEGRATION_CONFLICT:
        "Integration state could not be safely "
        "reconciled.",
    TerminalReason.INTEGRATION_AGENT_FAILURE:
        "Integration agent failed.",
    TerminalReason.WORKSPACE_UNAVAILABLE:
        "Workspace preparation failed.",
    TerminalReason.REMOTE_BRANCH_CLEANUP_FAILURE:
        "Remote ticket branch cleanup failed.",
    TerminalReason.ISSUE_NOT_ELIGIBLE:
        "Issue is no longer execution-authorized "
        "in its current GitHub state.",
    TerminalReason.ISSUE_NO_LONGER_PRESENT:
        "Issue is no longer present in the "
        "current milestone task list.",
}


def _terminal_message(reason: TerminalReason) -> str:
    """Resolve a ``TerminalReason`` to its static Ralph-owned
    message.  This is the single source of truth for the content
    of ``checkpoint.last_error``.
    """
    if not isinstance(reason, TerminalReason):
        # Defensive: a non-enum value must never produce a
        # ``last_error`` string.  Raising here converts the
        # caller bug into an immediate, loud failure rather
        # than a silent leak.
        raise TypeError(
            "_record_terminal requires a TerminalReason, "
            f"got {type(reason).__name__}"
        )
    return TERMINAL_REASON_MESSAGES[reason]


# Closed set of approved ``checkpoint.last_error`` values.
#
# Every non-null ``TicketCheckpoint.last_error`` MUST equal an
# exact member of this immutable set.  The set is derived
# directly from ``TERMINAL_REASON_MESSAGES`` so the two sources
# cannot drift.
#
# ``CheckpointStore`` enforces this invariant on both load and
# save.  Any value not in this set is rejected with
# ``CheckpointError`` rather than being silently persisted,
# deserialized, or coerced into a "trusted" value.
APPROVED_LAST_ERROR_MESSAGES: frozenset = frozenset(
    TERMINAL_REASON_MESSAGES.values()
)


@dataclass(frozen=True)
class Budgets:
    max_implementation_iterations: int
    max_review_cycles: int
    max_review_fix_iterations: int
    max_qa_attempts: int


def _load_budgets(config: dict) -> Budgets:
    execution = config.get("execution", {})

    return Budgets(
        max_implementation_iterations=execution.get(
            "maxImplementationIterations", 1
        ),
        max_review_cycles=execution.get(
            "maxReviewCycles", 1
        ),
        max_review_fix_iterations=execution.get(
            "maxReviewFixIterations", 1
        ),
        max_qa_attempts=execution.get(
            "maxQaAttempts", 1
        ),
    )


def _load_eligibility_config(
    config: dict,
) -> EligibilityConfig:
    selection = config.get("selection", {})

    return EligibilityConfig(
        required_label=selection.get(
            "requiredLabel", "ready-for-ralph"
        ),
        skip_labels=frozenset(
            selection.get("skipLabels", [])
        ),
    )


class Orchestrator:
    def __init__(
        self,
        *,
        config_path: str,
        checkpoint_path: Path,
        callbacks: Optional[ConductorCallbacks] = None,
    ):
        self.config_path = config_path
        self.checkpoint_path = checkpoint_path
        self.callbacks = callbacks or ConductorCallbacks()

    def run(self) -> TicketState:
        config = load_config(self.config_path)

        store = CheckpointStore(self.checkpoint_path)

        try:
            existing = store.load()
        except CheckpointError as error:
            raise OrchestratorError(
                f"Ralph checkpoint is corrupt: {error}"
            ) from error

        authenticator = (
            self.callbacks.make_authenticator(config)
            if self.callbacks.make_authenticator is not None
            else build_authenticator(config)
        )

        tasks = self._discover_tasks(
            config=config,
            authenticator=authenticator,
        )

        tasks_by_number = {
            task.number: task
            for task in tasks
        }

        checkpoint, task = self._resolve_ticket(
            existing=existing,
            tasks=tasks,
            tasks_by_number=tasks_by_number,
            config=config,
            store=store,
        )

        if task is None:
            print(
                f"RALPH: stopping with state "
                f"{checkpoint.state.value}."
            )
            return checkpoint.state

        eligibility_cfg = _load_eligibility_config(config)

        if not issue_still_eligible(
            task=task,
            tasks_by_number=tasks_by_number,
            config=eligibility_cfg,
            state=checkpoint.state,
        ):
            checkpoint = self._record_failure(
                checkpoint=checkpoint,
                store=store,
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason.ISSUE_NOT_ELIGIBLE
                ),
            )
            return checkpoint.state

        print(
            f"RALPH: executing ticket #{task.number} "
            f"({task.title!r}) from "
            f"{checkpoint.state.value}."
        )

        with TenkiSandbox(
            name=f"ralph-{checkpoint.issue_number}",
        ) as sandbox:
            qa_environment = (
                self.callbacks.make_qa_environment(sandbox)
                if self.callbacks.make_qa_environment is not None
                else PostgresQaEnvironment(sandbox=sandbox)
            )

            try:
                conductor = Conductor(
                    sandbox=sandbox,
                    checkpoint=checkpoint,
                    task=task,
                    tasks=tuple(tasks),
                    config=config,
                    store=store,
                    authenticator=authenticator,
                    qa_environment=qa_environment,
                    callbacks=self.callbacks,
                )

                return conductor.run()
            finally:
                try:
                    qa_environment.stop()
                except QaEnvironmentError:
                    pass

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

        source = GitHubTaskSource(
            repository=config["repository"],
            milestone=config["githubMilestone"],
            parent_issue=config.get("parentIssue"),
            github_token=token.token,
        )

        return source.list_tasks()

    def _resolve_ticket(
        self,
        *,
        existing: Optional[TicketCheckpoint],
        tasks: list[GitHubTask],
        tasks_by_number: dict[int, GitHubTask],
        config: dict,
        store: CheckpointStore,
    ) -> tuple[
        TicketCheckpoint,
        Optional[GitHubTask],
    ]:
        integration = config["integration"]

        if existing is not None:
            task = tasks_by_number.get(
                existing.issue_number
            )

            if task is None:
                checkpoint = replace(
                    existing,
                    state=TicketState.BLOCKED_FOR_HUMAN,
                    last_error=_terminal_message(
                        TerminalReason
                        .ISSUE_NO_LONGER_PRESENT
                    ),
                )
                store.save(checkpoint)
                return checkpoint, None

            return existing, task

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
            return (
                TicketCheckpoint(
                    milestone_id=config["id"],
                    issue_number=0,
                    state=TicketState.HUMAN_QA_PENDING,
                    integration_branch=integration[
                        "branch"
                    ],
                    ticket_branch="",
                ),
                None,
            )

        chosen = eligible[0]

        checkpoint = TicketCheckpoint(
            milestone_id=config["id"],
            issue_number=chosen.number,
            state=TicketState.READY,
            integration_branch=integration["branch"],
            ticket_branch=(
                f"{integration['ticketBranchPrefix']}"
                f"{chosen.number}"
            ),
        )

        store.save(checkpoint)

        return checkpoint, chosen

    def _record_failure(
        self,
        *,
        checkpoint: TicketCheckpoint,
        store: CheckpointStore,
        state: TicketState,
        reason: TerminalReason,
    ) -> TicketCheckpoint:
        # ``last_error`` is Ralph-owned control-plane data.
        # Only ``_terminal_message(reason)`` produces the
        # persisted string.  No caller may supply an arbitrary
        # message.  This is the security boundary.
        message = _terminal_message(reason)

        updated = replace(
            checkpoint,
            state=state,
            last_error=message,
        )

        store.save(updated)

        return updated


def _consume_attempt(
    *,
    checkpoint: TicketCheckpoint,
    store: CheckpointStore,
    field: str,
    limit: int,
    budget_reason: TerminalReason,
) -> TicketCheckpoint:
    """Increment an attempt counter, save the checkpoint, then
    enforce the limit.

    The counter is incremented and saved BEFORE the operation runs,
    so a crash anywhere in the operation cannot lose the attempt.
    If the new counter equals or exceeds the configured limit,
    Ralph transitions to ``BLOCKED_FOR_HUMAN`` BEFORE the runner
    is invoked.
    """
    current = getattr(checkpoint, field)
    updated = replace(
        checkpoint,
        **{
            field: current + 1,
        },
    )
    store.save(updated)

    if current + 1 > limit:
        # ``last_error`` is Ralph-owned control-plane data;
        # only static ``TerminalReason`` messages are allowed.
        blocked = replace(
            updated,
            state=TicketState.BLOCKED_FOR_HUMAN,
            last_error=_terminal_message(budget_reason),
        )
        store.save(blocked)
        raise _BudgetExhausted(blocked)

    return updated


class _BudgetExhausted(Exception):
    def __init__(self, checkpoint: TicketCheckpoint):
        self.checkpoint = checkpoint


TERMINAL_STATES = frozenset(
    {
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.HUMAN_QA_PENDING,
        TicketState.INFRA_FAILURE,
        TicketState.AGENT_FAILURE,
    }
)


class Conductor:
    def __init__(
        self,
        *,
        sandbox: TenkiSandbox,
        checkpoint: TicketCheckpoint,
        task: GitHubTask,
        tasks: tuple[GitHubTask, ...],
        config: dict,
        store: CheckpointStore,
        authenticator: GitHubAppAuthenticator,
        qa_environment: PostgresQaEnvironment,
        callbacks: ConductorCallbacks,
    ):
        self.sandbox = sandbox
        self.checkpoint = checkpoint
        self.task = task
        self.tasks = tasks
        self.config = config
        self.store = store
        self.authenticator = authenticator
        self.qa_environment = qa_environment
        self.callbacks = callbacks

        self._workspace: Optional[TicketWorkspace] = None
        self._workspace_unavailable = False

        integration = config["integration"]
        self._policy = GitPushPolicy(
            integration_branch=integration["branch"],
            ticket_branch_prefix=integration[
                "ticketBranchPrefix"
            ],
        )

        self._budgets = _load_budgets(config)

    def run(self) -> TicketState:
        guard = 0
        max_guard = 100

        while True:
            guard += 1

            if guard > max_guard:
                self._record_terminal(
                    state=TicketState.BLOCKED_FOR_HUMAN,
                    reason=(
                        TerminalReason
                        .ITERATION_GUARD_EXCEEDED
                    ),
                )
                return self.checkpoint.state

            state = self.checkpoint.state

            if state == TicketState.READY:
                self._transition(TicketState.IMPLEMENTING)
                continue

            if state == TicketState.IMPLEMENTING:
                self._run_implementation(fix_context=None)
                continue

            if state == TicketState.FIXING:
                self._run_implementation(
                    fix_context=self._load_fix_context(),
                )
                continue

            if state == TicketState.REVIEWING:
                self._run_review()
                continue

            if state == TicketState.AUTOMATED_QA:
                self._run_qa_phase()
                continue

            if state == TicketState.INTEGRATING:
                self._run_integration()
                continue

            if state == TicketState.INTEGRATED:
                return self._run_post_integration()

            return state

    def _record_terminal(
        self,
        *,
        state: TicketState,
        reason: TerminalReason,
    ) -> None:
        # ``last_error`` is Ralph-owned control-plane data.
        # Only ``_terminal_message(reason)`` produces the
        # persisted string.  No caller may supply an arbitrary
        # message.  This is the security boundary.
        message = _terminal_message(reason)

        self.checkpoint = replace(
            self.checkpoint,
            state=state,
            last_error=message,
        )
        self.store.save(self.checkpoint)

    def _transition(
        self,
        target: TicketState,
    ) -> None:
        assert_transition(
            self.checkpoint.state,
            target,
        )
        self.checkpoint = replace(
            self.checkpoint,
            state=target,
        )
        self.store.save(self.checkpoint)

    def _run_implementation(
        self,
        *,
        fix_context: Optional[ImplementationFixContext],
    ) -> None:
        is_fix = fix_context is not None

        limit = (
            self._budgets.max_review_fix_iterations
            if is_fix
            else self._budgets.max_implementation_iterations
        )

        field = (
            "fix_attempts"
            if is_fix
            else "implementation_attempts"
        )

        try:
            self.checkpoint = _consume_attempt(
                checkpoint=self.checkpoint,
                store=self.store,
                field=field,
                limit=limit,
                budget_reason=(
                    TerminalReason.REVIEW_FIX_BUDGET_EXHAUSTED
                    if is_fix
                    else (
                        TerminalReason
                        .IMPLEMENTATION_BUDGET_EXHAUSTED
                    )
                ),
            )
        except _BudgetExhausted as error:
            self.checkpoint = error.checkpoint
            return

        try:
            workspace = self._ensure_workspace()
        except WorkspaceUnavailable:
            return

        attempt = self._current_attempt_counter()

        # The completion file path is phase-qualified so the
        # initial implementation attempt 1 and the fix attempt 1
        # never collide, and Ralph never reads a completion file
        # from a previous phase.
        phase = (
            CompletionPhase.FIX
            if is_fix
            else CompletionPhase.IMPLEMENTATION
        )

        runner = self._make_implementation_runner(
            workspace=workspace,
            attempt=attempt,
            phase=phase,
        )

        completion_path = completion_result_path(
            issue_number=self.checkpoint.issue_number,
            phase=phase.value,
            attempt=attempt,
        )

        try:
            result = runner.run(
                issue_number=self.checkpoint.issue_number,
                issue_title=self.task.title,
                issue_body=self.task.body,
                minimax_api_key=os.environ[
                    "MINIMAX_API_KEY"
                ],
                fix_context=fix_context,
            )
        except ImplementationError:
            # ``ImplementationError`` text is untrusted and
            # MUST NOT reach ``checkpoint.last_error``.  Map
            # the failure to a static categorical reason.
            self._record_terminal(
                state=TicketState.AGENT_FAILURE,
                reason=(
                    TerminalReason
                    .IMPLEMENTATION_AGENT_FAILURE
                ),
            )
            return

        if result.is_blocked:
            # ``result.completion_blocker`` is model-authored
            # text and MUST NOT reach ``checkpoint.last_error``.
            # Map the BLOCKED verdict to a static categorical
            # reason.  The blocker string continues to live
            # on the ImplementationResult / completion file
            # as untrusted evidence if needed elsewhere.
            self._record_terminal(
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason
                    .IMPLEMENTATION_BLOCKED
                ),
            )
            return

        if not result.changed_files and result.exhausted:
            self._record_terminal(
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason
                    .IMPLEMENTATION_EXHAUSTED_NO_CHANGES
                ),
            )
            return

        if is_fix:
            self.checkpoint = replace(
                self.checkpoint,
                pre_qa_findings=None,
                qa_failure_evidence=None,
                pre_persistence_findings=None,
            )

        self.checkpoint = replace(
            self.checkpoint,
            state=TicketState.REVIEWING,
            review_stage=ReviewStage.PRE_QA,
            review_attempts=(
                self.checkpoint.review_attempts + 1
            ),
            review_cycles_consumed=(
                self.checkpoint.review_cycles_consumed + 1
            ),
            implementation_session_id=(
                result.session_id
            ),
            last_error=None,
        )
        self.store.save(self.checkpoint)

    def _current_attempt_counter(self) -> int:
        # Implementation attempt path uses the implementation counter
        # so that if the previous attempt crashed mid-run, the new
        # attempt always writes a fresh completion file with a
        # higher number.
        if self.checkpoint.state == TicketState.FIXING:
            return (
                self.checkpoint.fix_attempts
                if self.checkpoint.fix_attempts > 0
                else 1
            )

        return (
            self.checkpoint.implementation_attempts
            if self.checkpoint.implementation_attempts > 0
            else 1
        )

    def _load_fix_context(
        self,
    ) -> ImplementationFixContext:
        return ImplementationFixContext(
            reviewer_findings=(
                self.checkpoint.pre_qa_findings
            ),
            qa_failure_evidence=(
                self.checkpoint.qa_failure_evidence
            ),
            pre_persistence_findings=(
                self.checkpoint.pre_persistence_findings
            ),
        )

    def _run_review(self) -> None:
        # Review is part of a cycle: PRE_QA -> QA -> PRE_PERSISTENCE
        # -> persistence -> integration. The cycle is bounded by
        # ``maxReviewCycles``.
        #
        # ``review_cycles_consumed`` counts PRE_QA entries. PRE_
        # PERSISTENCE inside an already-consumed cycle MUST NOT
        # consume a second cycle. With max=2: cycle 1 must run,
        # cycle 2 must run, attempt to begin cycle 3 must block.
        #
        # The counter is incremented and saved in
        # ``_run_implementation`` (the conductor's only PRE_QA
        # entry point), so by the time we land here the counter
        # already reflects this cycle's consumption. If the
        # current cycle exceeded the budget, block unconditionally
        # BEFORE invoking the reviewer.

        if self.checkpoint.review_stage == ReviewStage.PRE_QA:
            if (
                self.checkpoint.review_cycles_consumed
                > self._budgets.max_review_cycles
            ):
                self._record_terminal(
                    state=TicketState.BLOCKED_FOR_HUMAN,
                    reason=(
                        TerminalReason
                        .REVIEW_CYCLE_BUDGET_EXHAUSTED
                    ),
                )
                return

        try:
            workspace = self._ensure_workspace()
        except WorkspaceUnavailable:
            return

        runner = self._make_review_runner(workspace=workspace)

        try:
            result = runner.review(
                issue_number=self.checkpoint.issue_number,
                issue_context=self.task.body,
                stage=self.checkpoint.review_stage,
                previous_findings=(
                    self.checkpoint.last_error
                    if (
                        self.checkpoint.review_stage
                        == ReviewStage.PRE_QA
                    )
                    else None
                ),
                qa_evidence=self.checkpoint.qa_evidence,
            )
        except ReviewError:
            # ``ReviewError`` text is untrusted (it embeds
            # subprocess exit codes only, never model content,
            # but we still treat it as untrusted).  Map the
            # failure to a static categorical reason.
            self._record_terminal(
                state=TicketState.AGENT_FAILURE,
                reason=(
                    TerminalReason
                    .REVIEW_AGENT_FAILURE
                ),
            )
            return

        if (
            self.checkpoint.review_stage
            == ReviewStage.PRE_QA
        ):
            if (
                result.verdict
                == ReviewVerdict.FIX_BEFORE_QA
            ):
                # checkpoint.last_error is Ralph
                # control-plane state.  The model-
                # authored ReviewResult.summary is
                # untrusted content and MUST NOT be
                # persisted there.  Structured
                # reviewer findings remain in the
                # dedicated ``pre_qa_findings``
                # field so the fix-context mechanism
                # can still consume them.  The
                # ``last_error`` string is resolved
                # through the closed ``TerminalReason``
                # trust boundary.
                self.checkpoint = replace(
                    self.checkpoint,
                    state=TicketState.FIXING,
                    pre_qa_findings=format_findings(
                        result.findings,
                        result.summary,
                    ),
                    pre_persistence_findings=None,
                    qa_failure_evidence=None,
                    last_error=_terminal_message(
                        TerminalReason
                        .REVIEW_FIX_BEFORE_QA
                    ),
                )
                self.store.save(self.checkpoint)
                return

            self.checkpoint = replace(
                self.checkpoint,
                state=TicketState.AUTOMATED_QA,
                review_stage=ReviewStage.PRE_QA,
                qa_evidence=None,
                pre_qa_findings=None,
                pre_persistence_findings=None,
                qa_failure_evidence=None,
                last_error=None,
            )
            self.store.save(self.checkpoint)
            return

        if (
            result.verdict
            == ReviewVerdict.BLOCK_PERSISTENCE
        ):
            # checkpoint.last_error is Ralph
            # control-plane state.  The model-
            # authored ReviewResult.summary is
            # untrusted content and MUST NOT be
            # persisted there.  Structured
            # reviewer findings remain in the
            # dedicated ``pre_persistence_findings``
            # field so the fix-context mechanism
            # can still consume them.  The
            # ``last_error`` string is resolved
            # through the closed ``TerminalReason``
            # trust boundary.
            self.checkpoint = replace(
                self.checkpoint,
                state=TicketState.FIXING,
                pre_persistence_findings=format_findings(
                    result.findings,
                    result.summary,
                ),
                pre_qa_findings=None,
                qa_failure_evidence=None,
                last_error=_terminal_message(
                    TerminalReason
                    .REVIEW_BLOCK_PERSISTENCE
                ),
            )
            self.store.save(self.checkpoint)
            return

        self._run_persistence()

    def _run_qa_phase(self) -> None:
        # Crash-window check: a durable commit exists in the
        # checkpoint but no PR.  We must still verify the
        # probe agrees before assuming COMMIT_ONLY.  A probe
        # that says "branch absent" while the checkpoint
        # believes a commit exists is AMBIGUOUS, not
        # COMMIT_ONLY.  Defer to recovery so the boundary
        # semantics are honored.
        if (
            self.checkpoint.persisted_commit_sha is not None
            and self.checkpoint.pull_request_number is None
        ):
            disposition = self._maybe_recover_persistence()

            if (
                disposition
                == PersistenceRecoveryDisposition.TERMINAL
            ):
                # Recovery or the COMMIT_ONLY continuation
                # detected an unsafe condition and already
                # recorded BLOCKED_FOR_HUMAN.  Stop.  Do NOT
                # attempt to transition to INTEGRATING.
                return

            if (
                disposition
                == PersistenceRecoveryDisposition.READY_TO_INTEGRATE
            ):
                self._transition(TicketState.INTEGRATING)
                return

            # ``NOT_APPLICABLE``: trust the checkpoint's
            # persisted_commit_sha (it survived a previous
            # crash) and continue with the missing PR.
            result = self._continue_commit_only_persistence(
                recovered_sha=(
                    self.checkpoint.persisted_commit_sha
                ),
            )

            if result is None:
                # Continuation already recorded
                # BLOCKED_FOR_HUMAN.  Stop — no
                # INTEGRATING transition.
                return

            self._transition(TicketState.INTEGRATING)
            return

        # If persistence already happened in a previous run,
        # reconcile any partial durable state, then move on.
        if self.checkpoint.persisted_commit_sha is None:
            disposition = self._maybe_recover_persistence()

            if (
                disposition
                == PersistenceRecoveryDisposition.TERMINAL
            ):
                # Recovery recorded BLOCKED_FOR_HUMAN.  Stop.
                return

            if (
                disposition
                == PersistenceRecoveryDisposition.READY_TO_INTEGRATE
            ):
                self._transition(TicketState.INTEGRATING)
                return

            # ``NOT_APPLICABLE``: continue to normal QA.

        # Persisted already, nothing more to QA.
        if self.checkpoint.persisted_commit_sha is not None:
            self._transition(TicketState.INTEGRATING)
            return

        # Count and gate the QA attempt against the explicit
        # ``maxQaAttempts`` budget. qa_attempts is incremented and
        # saved BEFORE QaRunner runs, so a crash mid-run cannot
        # lose the attempt.
        try:
            self.checkpoint = _consume_attempt(
                checkpoint=self.checkpoint,
                store=self.store,
                field="qa_attempts",
                limit=self._budgets.max_qa_attempts,
                budget_reason=(
                    TerminalReason.QA_BUDGET_EXHAUSTED
                ),
            )
        except _BudgetExhausted as error:
            self.checkpoint = error.checkpoint
            return

        try:
            workspace = self._ensure_workspace()
        except WorkspaceUnavailable:
            return

        try:
            environment = self.qa_environment.start()
        except QaEnvironmentError:
            # ``QaEnvironmentError`` text is untrusted and
            # MUST NOT reach ``checkpoint.last_error``.  Map
            # the failure to a static categorical reason.
            self._record_terminal(
                state=TicketState.INFRA_FAILURE,
                reason=(
                    TerminalReason.QA_ENVIRONMENT_FAILURE
                ),
            )
            return

        try:
            qa_runner = self._make_qa_runner(
                workspace=workspace,
            )

            commands = build_qa_commands(self.config)

            qa_result = qa_runner.run(
                commands,
                env=environment.env,
            )
        finally:
            self.qa_environment.stop()

        if (
            qa_result.status
            == QaStatus.INFRA_FAILURE
        ):
            self._record_terminal(
                state=TicketState.INFRA_FAILURE,
                reason=(
                    TerminalReason.QA_INFRA_FAILURE
                ),
            )
            return

        if (
            qa_result.status
            == QaStatus.CODE_FAILURE
        ):
            evidence = qa_result.evidence()

            self.checkpoint = replace(
                self.checkpoint,
                state=TicketState.FIXING,
                qa_failure_evidence=evidence,
                pre_qa_findings=None,
                pre_persistence_findings=None,
                last_error=_terminal_message(
                    TerminalReason.QA_CODE_FAILURE
                ),
            )
            self.store.save(self.checkpoint)
            return

        self.checkpoint = replace(
            self.checkpoint,
            review_stage=ReviewStage.PRE_PERSISTENCE,
            qa_evidence=qa_result.evidence(),
            last_error=None,
        )
        self.store.save(self.checkpoint)

        self._run_review()

    def _recovery_is_meaningful(self) -> bool:
        """Return True if recovery should probe GitHub state.

        Recovery is meaningful only when the conductor has
        reached or passed the persistence decision boundary:

          - the checkpoint already has partial persisted evidence
            (commit_sha and/or pull_request_number), OR
          - the conductor is in INTEGRATING / INTEGRATED
            (post-merge restart where the durable PR must be
            reconciled), OR
          - the conductor is at the AUTOMATED_QA gate with no
            checkpoint persistence values yet — this is exactly
            the crash window between persistence side effects
            and the checkpoint save.

        For a fresh ticket earlier in the pipeline (READY,
        IMPLEMENTING, REVIEWING, FIXING) recovery is NOT
        meaningful: there are no durable side effects to
        reconcile, and probing on a MagicMock / non-GitHub
        sandbox would only generate malformed responses.
        """
        if (
            self.checkpoint.persisted_commit_sha is not None
            or self.checkpoint.pull_request_number is not None
        ):
            return True

        if self.checkpoint.state in (
            TicketState.INTEGRATING,
            TicketState.INTEGRATED,
            TicketState.AUTOMATED_QA,
        ):
            return True

        return False

    def _maybe_recover_persistence(
        self,
    ) -> PersistenceRecoveryDisposition:
        """Reconcile durable GitHub state with the in-memory
        checkpoint and return an explicit disposition.

        Disposition values:

          - ``NOT_APPLICABLE``: no recovery was required (probe
            not invoked, or ``NOTHING_DURABLE`` outcome).
            Caller may proceed through normal persistence
            logic.

          - ``READY_TO_INTEGRATE``: recovery + COMMIT_ONLY
            continuation succeeded (if applicable) and the
            verified persisted commit + PR are checkpointed.
            Caller may transition to INTEGRATING.

          - ``TERMINAL``: recovery or the COMMIT_ONLY
            continuation detected an unsafe/ambiguous
            condition.  A ``BLOCKED_FOR_HUMAN`` checkpoint has
            already been saved.  Caller MUST return
            immediately — no persistence retry, no INTEGRATING
            transition, no IntegrationRunner invocation.

        Recovery is meaningful only when there is reason to
        suspect partial persistence:

          - the checkpoint already carries some persisted
            values, OR
          - the conductor is at the AUTOMATED_QA gate with no
            checkpoint persistence values yet — this is
            exactly the crash window between persistence side
            effects and the checkpoint save, OR
          - the ticket is in INTEGRATING / INTEGRATED
            (post-merge restart where the durable PR must be
            reconciled).
        """
        if not self._recovery_is_meaningful():
            return PersistenceRecoveryDisposition.NOT_APPLICABLE

        try:
            workspace = self._ensure_workspace()
        except WorkspaceUnavailable:
            # Workspace prep already recorded BLOCKED_FOR_HUMAN.
            return PersistenceRecoveryDisposition.TERMINAL

        owner, repository = split_repository(
            self.config["repository"]
        )

        token = self._mint_github_token()

        if self.callbacks.make_github_probe is not None:
            probe = self.callbacks.make_github_probe(
                sandbox=self.sandbox,
                github_token=token.token,
                owner=owner,
                repository=repository,
            )
        else:
            probe = GitHubReadOnlyProbe(
                sandbox=self.sandbox,
                github_token=token.token,
                owner=owner,
                repository=repository,
            )

        outcome = reconcile_persistence(
            checkpoint=self.checkpoint,
            policy=self._policy,
            probe=probe,
            owner=owner,
            repository=repository,
        )

        if outcome.outcome == RecoveryOutcome.AMBIGUOUS:
            self._record_terminal(
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason.PERSISTENCE_CONFLICT
                ),
            )
            return PersistenceRecoveryDisposition.TERMINAL

        if (
            outcome.outcome
            == RecoveryOutcome.NOTHING_DURABLE
        ):
            return PersistenceRecoveryDisposition.NOT_APPLICABLE

        self.checkpoint = replace(
            self.checkpoint,
            persisted_commit_sha=outcome.commit_sha,
            pull_request_number=(
                outcome.pull_request_number
            ),
            last_error=None,
        )
        self.store.save(self.checkpoint)

        if outcome.outcome == RecoveryOutcome.COMMIT_ONLY:
            # Branch exists with durable commit but no PR.
            # Run the dedicated continuation, which performs
            # NO new commit, NO SHA-changing push, NO force
            # push, and creates (or reuses) exactly one PR.
            result = self._continue_commit_only_persistence(
                recovered_sha=outcome.commit_sha,
            )

            if result is None:
                # Continuation detected a terminal failure
                # (PersistenceError, workspace unavailable,
                # etc.) and already recorded BLOCKED_FOR_HUMAN.
                # Propagate TERMINAL so callers MUST stop —
                # do NOT fall through to INTEGRATING.
                return (
                    PersistenceRecoveryDisposition.TERMINAL
                )

            return (
                PersistenceRecoveryDisposition.READY_TO_INTEGRATE
            )

        return (
            PersistenceRecoveryDisposition.READY_TO_INTEGRATE
        )

    def _continue_commit_only_persistence(
        self,
        *,
        recovered_sha: Optional[str],
    ) -> Optional[CommitOnlyContinuationResult]:
        """Run the COMMIT_ONLY continuation: recover only the
        missing PR for an already-durable commit.

        Contract:

          - returns ``CommitOnlyContinuationResult`` only when
            the runner successfully verified local HEAD ==
            remote HEAD == ``recovered_sha`` and either reused
            or created exactly one PR.  The checkpoint has
            already been updated to the verified SHA from the
            result (NOT from the unverified input).

          - returns ``None`` when this method has already
            recorded a terminal ``BLOCKED_FOR_HUMAN`` state
            (or earlier recovery transitioned to a terminal
            state).  Callers MUST stop on ``None`` — do not
            transition toward INTEGRATING, do not invoke
            IntegrationRunner.
        """
        try:
            workspace = self._ensure_workspace()
        except WorkspaceUnavailable:
            # Workspace prep already recorded the terminal
            # failure via _record_terminal(BLOCKED_FOR_HUMAN).
            return None

        # Re-check the conductor state after the side effect
        # above: if workspace prep left it terminal, stop.
        if self.checkpoint.state in TERMINAL_STATES:
            return None

        runner = self._make_persistence_runner(
            workspace=workspace,
        )

        try:
            result = runner.ensure_pull_request_for_persisted_commit(
                issue_number=self.checkpoint.issue_number,
                recovered_sha=recovered_sha or "",
                original_ticket_sha=(
                    self.checkpoint.ticket_sha
                ),
                pull_request_title=(
                    f"Issue #{self.checkpoint.issue_number}: "
                    f"{self.task.title}"
                ),
                pull_request_body=(
                    f"Automated Ralph implementation of "
                    f"#{self.checkpoint.issue_number}."
                ),
            )
        except PersistenceError:
            # ``PersistenceError`` text is untrusted and MUST
            # NOT reach ``checkpoint.last_error``.  Map the
            # failure to a static categorical reason.
            self._record_terminal(
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason
                    .PERSISTENCE_AGENT_FAILURE
                ),
            )
            return None

        # The runner independently verified the SHA.  The
        # checkpoint MUST use the SHA from the result, never
        # the unverified input.  This is the single source of
        # truth for the durable commit identity.
        self.checkpoint = replace(
            self.checkpoint,
            persisted_commit_sha=result.commit_sha,
            pull_request_number=(
                result.pull_request_number
            ),
            last_error=None,
        )
        self.store.save(self.checkpoint)

        return result

    def _run_persistence(self) -> None:
        # COMMIT_ONLY continuation: durable commit, missing PR.
        # This must run BEFORE the persisted_commit_sha short
        # circuit below, because that short circuit assumed the
        # checkpoint already has BOTH a commit and a PR.
        if (
            self.checkpoint.persisted_commit_sha is not None
            and self.checkpoint.pull_request_number is None
        ):
            result = self._continue_commit_only_persistence(
                recovered_sha=(
                    self.checkpoint.persisted_commit_sha
                ),
            )

            # The continuation either succeeded (and
            # checkpointed the verified SHA) or already
            # transitioned to BLOCKED_FOR_HUMAN.  Either way,
            # do NOT unconditionally transition to INTEGRATING.
            if result is None:
                return

            self._transition(TicketState.INTEGRATING)
            return

        if self.checkpoint.persisted_commit_sha is not None:
            self._transition(TicketState.INTEGRATING)
            return

        disposition = self._maybe_recover_persistence()

        if (
            disposition
            == PersistenceRecoveryDisposition.TERMINAL
        ):
            # Recovery recorded BLOCKED_FOR_HUMAN.  Stop —
            # do NOT recreate persistence side effects.
            return

        if (
            disposition
            == PersistenceRecoveryDisposition.READY_TO_INTEGRATE
        ):
            self._transition(TicketState.INTEGRATING)
            return

        # Recovery may have transitioned to a terminal state
        # (AMBIGUOUS -> BLOCKED_FOR_HUMAN).  Do not proceed to
        # recreate persistence side effects.
        if self.checkpoint.state in TERMINAL_STATES:
            return

        try:
            workspace = self._ensure_workspace()
        except WorkspaceUnavailable:
            return

        runner = self._make_persistence_runner(
            workspace=workspace,
        )

        try:
            result = runner.persist(
                issue_number=self.checkpoint.issue_number,
                state=TicketState.AUTOMATED_QA,
                commit_message=(
                    f"feat(m2): issue #{self.checkpoint.issue_number}"
                ),
                pull_request_title=(
                    f"Issue #{self.checkpoint.issue_number}: "
                    f"{self.task.title}"
                ),
                pull_request_body=(
                    f"Automated Ralph implementation of "
                    f"#{self.checkpoint.issue_number}."
                ),
            )
        except PersistenceError:
            # ``PersistenceError`` text is untrusted and MUST
            # NOT reach ``checkpoint.last_error``.  Map the
            # failure to a static categorical reason.
            self._record_terminal(
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason
                    .PERSISTENCE_AGENT_FAILURE
                ),
            )
            return

        self.checkpoint = replace(
            self.checkpoint,
            persisted_commit_sha=result.commit_sha,
            pull_request_number=(
                result.pull_request_number
            ),
            last_error=None,
        )
        self.store.save(self.checkpoint)

        self._transition(TicketState.INTEGRATING)

    def _run_integration(self) -> None:
        if (
            self.checkpoint.persisted_commit_sha is None
            or self.checkpoint.pull_request_number is None
        ):
            disposition = self._maybe_recover_persistence()

            if (
                disposition
                == PersistenceRecoveryDisposition.TERMINAL
            ):
                # Recovery recorded BLOCKED_FOR_HUMAN.  Stop.
                return

            if (
                disposition
                == PersistenceRecoveryDisposition.NOT_APPLICABLE
            ):
                self._record_terminal(
                    state=TicketState.BLOCKED_FOR_HUMAN,
                    reason=(
                        TerminalReason
                        .PERSISTENCE_CONFLICT
                    ),
                )
                return

            # ``READY_TO_INTEGRATE``: recovery reconciled
            # values; the checkpoint now has both a commit
            # and a PR.  Fall through to integration.

        try:
            workspace = self._ensure_workspace()
        except WorkspaceUnavailable:
            return

        runner = self._make_integration_runner(
            workspace=workspace,
        )

        try:
            integration_result = runner.integrate(
                issue_number=self.checkpoint.issue_number,
                state=TicketState.INTEGRATING,
                pull_request_number=(
                    self.checkpoint.pull_request_number
                ),
                expected_head_sha=(
                    self.checkpoint.persisted_commit_sha
                ),
            )
        except IntegrationError:
            # ``IntegrationError`` text is untrusted and MUST
            # NOT reach ``checkpoint.last_error``.  Map the
            # failure to a static categorical reason.
            self._record_terminal(
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason
                    .INTEGRATION_AGENT_FAILURE
                ),
            )
            return

        self.checkpoint = replace(
            self.checkpoint,
            state=TicketState.INTEGRATED,
            last_error=None,
        )
        self.store.save(self.checkpoint)

        del integration_result

    def _run_post_integration(
        self,
    ) -> TicketState:
        integration_cfg = self.config["integration"]

        if integration_cfg.get(
            "deleteRemoteTicketBranchAfterIntegration"
        ):
            try:
                self._cleanup_remote_branch()
            except RemoteBranchCleanupError:
                # ``RemoteBranchCleanupError`` text is
                # untrusted and MUST NOT reach
                # ``checkpoint.last_error``.  Map the failure
                # to a static categorical reason.
                self._record_terminal(
                    state=TicketState.BLOCKED_FOR_HUMAN,
                    reason=(
                        TerminalReason
                        .REMOTE_BRANCH_CLEANUP_FAILURE
                    ),
                )
                return self.checkpoint.state

        self._transition(TicketState.HUMAN_QA_PENDING)

        self.store.clear()

        return self.checkpoint.state

    def _cleanup_remote_branch(self) -> None:
        owner, repository = split_repository(
            self.config["repository"]
        )

        token = self._mint_github_token()

        cleaner = self._make_remote_branch_cleaner(
            github_token=token.token,
            owner=owner,
            repository=repository,
        )

        cleaner.cleanup_ticket_branch(
            ticket_branch=self.checkpoint.ticket_branch,
            expected_branch=self._policy.ticket_branch(
                self.checkpoint.issue_number
            ),
            expected_head_sha=(
                self.checkpoint.persisted_commit_sha
                or ""
            ),
            protected_branches=(
                self.checkpoint.integration_branch,
                "main",
            ),
        )

    def _ensure_workspace(
        self,
    ) -> TicketWorkspace:
        if self._workspace_unavailable:
            raise WorkspaceUnavailable(
                "Workspace is unavailable; see checkpoint "
                "last_error."
            )

        if self._workspace is not None:
            return self._workspace

        owner, repository = split_repository(
            self.config["repository"]
        )

        token = self._mint_github_token()

        manager = TicketWorkspaceManager(
            sandbox=self.sandbox,
            repository_url=(
                f"https://github.com/{owner}/{repository}.git"
            ),
            integration_branch=self.checkpoint.integration_branch,
            ticket_branch_prefix=(
                self.config["integration"][
                    "ticketBranchPrefix"
                ]
            ),
        )

        # State-aware base guard. By default the integration
        # branch MUST still equal checkpoint.base_sha. The
        # exception is INTEGRATING/INTEGRATED restart where the
        # expected PR is already merged: in that case the
        # integration branch has advanced beyond base_sha, which
        # is expected and must not block recovery. We prove that
        # the PR is already merged via the read-only probe
        # BEFORE relaxing the base requirement.
        expected_base_sha = self.checkpoint.base_sha

        if (
            self.checkpoint.state
            in (
                TicketState.INTEGRATING,
                TicketState.INTEGRATED,
            )
            and self.checkpoint.pull_request_number is not None
            and self.checkpoint.persisted_commit_sha is not None
        ):
            if self._probe_pr_already_merged(
                owner=owner,
                repository=repository,
                token=token.token,
            ):
                expected_base_sha = None

        try:
            workspace = manager.prepare(
                issue_number=self.checkpoint.issue_number,
                expected_base_sha=expected_base_sha,
                github_token=token.token,
            )
        except WorkspacePreparationError:
            # ``WorkspacePreparationError`` text is untrusted
            # and MUST NOT reach ``checkpoint.last_error``.
            # Map the failure to a static categorical reason.
            self._workspace_unavailable = True

            self._record_terminal(
                state=TicketState.BLOCKED_FOR_HUMAN,
                reason=(
                    TerminalReason
                    .WORKSPACE_UNAVAILABLE
                ),
            )
            raise WorkspaceUnavailable(
                "Workspace preparation failed."
            )

        # The original ticket_sha is the durable pre-implementation
        # baseline. On a fresh sandbox we receive the current HEAD
        # of the ticket branch, which after a remote crash may be
        # the implementation commit. We deliberately do NOT
        # overwrite the original baseline here — recovery is the
        # only place that owns the durable commit.
        if (
            self.checkpoint.base_sha is None
            or self.checkpoint.ticket_sha is None
        ):
            self.checkpoint = replace(
                self.checkpoint,
                base_sha=workspace.base_sha,
                ticket_sha=workspace.ticket_sha,
            )
            self.store.save(self.checkpoint)

        self._workspace = workspace
        return workspace

    def _probe_pr_already_merged(
        self,
        *,
        owner: str,
        repository: str,
        token: str,
    ) -> bool:
        """Return True ONLY when the read-only probe proves
        that the EXACT expected persisted PR is the one GitHub
        shows as merged.

        Strict identity is required for ALL of:

          - PR number == checkpoint.pull_request_number
          - base repository == expected SoundHub repository
          - head repository == expected repository
          - base ref == expected integration branch
          - head ref == expected ticket branch
          - head SHA == checkpoint.persisted_commit_sha
          - ``merged`` is exactly the boolean ``True`` (NOT a
            truthy value like ``"false"`` or ``"true"``)

        Any other outcome — VERIFIED_NOT_MERGED, AMBIGUOUS,
        malformed response, wrong identity, missing fields,
        non-boolean ``merged``, exception — returns False.
        The caller treats False as "do not relax the base
        guard".

        Note: this is an additional proof for workspace
        preparation only.  ``IntegrationRunner`` STILL owns
        its own final validation before any GitHub writes.
        """
        try:
            if self.callbacks.make_github_probe is not None:
                probe = self.callbacks.make_github_probe(
                    sandbox=self.sandbox,
                    github_token=token,
                    owner=owner,
                    repository=repository,
                )
            else:
                probe = GitHubReadOnlyProbe(
                    sandbox=self.sandbox,
                    github_token=token,
                    owner=owner,
                    repository=repository,
                )

            proof = verify_merged_pull_request(
                probe=probe,
                expected_repository=(
                    f"{owner}/{repository}"
                ),
                expected_base=(
                    self.checkpoint.integration_branch
                ),
                expected_head_ref=(
                    self._policy.ticket_branch(
                        self.checkpoint.issue_number
                    )
                ),
                expected_head_sha=(
                    self.checkpoint.persisted_commit_sha or ""
                ),
                expected_pull_request_number=(
                    self.checkpoint.pull_request_number or 0
                ),
            )

            return (
                proof.outcome
                == MergedPRVerification.VERIFIED_MERGED
            )
        except Exception:
            return False

    def _mint_github_token(self):
        if self.callbacks.mint_github_token is not None:
            return self.callbacks.mint_github_token(
                self.authenticator,
                self.config,
            )

        owner, repository = split_repository(
            self.config["repository"]
        )

        return self.authenticator.mint_repository_token(
            owner=owner,
            repository=repository,
        )

    def _make_implementation_runner(
        self,
        *,
        workspace: TicketWorkspace,
        attempt: int,
        phase: CompletionPhase,
    ) -> ImplementationRunner:
        if (
            self.callbacks.make_implementation_runner
            is not None
        ):
            return (
                self.callbacks
                .make_implementation_runner(
                    sandbox=self.sandbox,
                    workspace=workspace,
                    attempt=attempt,
                    phase=phase,
                )
            )

        return ImplementationRunner(
            sandbox=self.sandbox,
            workspace=workspace,
            attempt=attempt,
            phase=phase,
        )

    def _make_review_runner(
        self,
        *,
        workspace: TicketWorkspace,
    ) -> ReviewRunner:
        if self.callbacks.make_review_runner is not None:
            return (
                self.callbacks
                .make_review_runner(
                    sandbox=self.sandbox,
                    workspace=workspace,
                )
            )

        return ReviewRunner(
            sandbox=self.sandbox,
            workspace=workspace,
            model="moonshotai/Kimi-K2.7-Code",
            api_key=os.environ["NEBIUS_API_KEY"],
        )

    def _make_qa_runner(
        self,
        *,
        workspace: TicketWorkspace,
    ) -> QaRunner:
        if self.callbacks.make_qa_runner is not None:
            return self.callbacks.make_qa_runner(
                sandbox=self.sandbox,
                workspace=workspace,
            )

        return QaRunner(
            sandbox=self.sandbox,
            workspace=workspace,
        )

    def _make_persistence_runner(
        self,
        *,
        workspace: TicketWorkspace,
    ) -> PersistenceRunner:
        if (
            self.callbacks.make_persistence_runner
            is not None
        ):
            return (
                self.callbacks
                .make_persistence_runner(
                    sandbox=self.sandbox,
                    workspace=workspace,
                    git_policy=self._policy,
                )
            )

        owner, repository = split_repository(
            self.config["repository"]
        )

        token = self._mint_github_token()

        return PersistenceRunner(
            sandbox=self.sandbox,
            workspace=workspace,
            git_policy=self._policy,
            github_token=token.token,
            owner=owner,
            repository=repository,
        )

    def _make_integration_runner(
        self,
        *,
        workspace: TicketWorkspace,
    ) -> IntegrationRunner:
        if (
            self.callbacks.make_integration_runner
            is not None
        ):
            return (
                self.callbacks
                .make_integration_runner(
                    sandbox=self.sandbox,
                    workspace=workspace,
                    git_policy=self._policy,
                )
            )

        owner, repository = split_repository(
            self.config["repository"]
        )

        token = self._mint_github_token()

        return IntegrationRunner(
            sandbox=self.sandbox,
            workspace=workspace,
            git_policy=self._policy,
            github_token=token.token,
            owner=owner,
            repository=repository,
        )

    def _make_remote_branch_cleaner(
        self,
        *,
        github_token: str,
        owner: str,
        repository: str,
    ) -> RemoteBranchCleaner:
        if (
            self.callbacks.make_remote_branch_cleaner
            is not None
        ):
            return (
                self.callbacks
                .make_remote_branch_cleaner(
                    sandbox=self.sandbox,
                    github_token=github_token,
                    owner=owner,
                    repository=repository,
                )
            )

        return RemoteBranchCleaner(
            sandbox=self.sandbox,
            github_token=github_token,
            owner=owner,
            repository=repository,
        )


class WorkspaceUnavailable(RuntimeError):
    pass


def build_authenticator(
    config: dict,
) -> GitHubAppAuthenticator:
    app_cfg = config["githubApp"]

    app_id = os.environ[app_cfg["idEnv"]]
    key_path = os.environ[app_cfg["privateKeyPathEnv"]]

    return GitHubAppAuthenticator(
        app_id=app_id,
        private_key_path=key_path,
    )


def build_qa_commands(
    config: dict,
) -> tuple:
    from scripts.ralph.qa import QaCommand

    raw = config.get("qa", {}).get("commands", [])

    return tuple(
        QaCommand(
            name=entry["name"],
            command=entry["command"],
            timeout_seconds=entry.get(
                "timeoutSeconds", 900
            ),
        )
        for entry in raw
    )


def format_findings(
    findings,
    summary: str,
) -> str:
    parts = []

    if summary:
        parts.append(summary.strip())
        parts.append("")

    for index, finding in enumerate(findings, start=1):
        parts.append(
            f"{index}. [{finding.severity}] "
            f"{finding.title}"
        )
        parts.append(finding.details.strip())
        parts.append("")

    return "\n".join(parts).strip()


def split_repository(
    repository: str,
) -> tuple[str, str]:
    if "/" not in repository:
        raise OrchestratorError(
            f"Invalid repository in config: {repository!r}"
        )

    owner, name = repository.split("/", 1)

    return owner, name


def load_config(path: str) -> dict:
    return json.loads(Path(path).read_text())


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="scripts.ralph.run",
        description=(
            "Ralph single-ticket conductor."
        ),
    )

    parser.add_argument(
        "--next",
        action="store_true",
        help=(
            "Execute exactly one execution-frontier "
            "ticket through the full Ralph state machine."
        ),
    )

    parser.add_argument(
        "--config",
        default=".ralph/config/m2.json",
        help="Path to the Ralph milestone config.",
    )

    parser.add_argument(
        "--checkpoint",
        default=".ralph/checkpoint.json",
        help="Path to the durable ticket checkpoint.",
    )

    args = parser.parse_args(argv)

    if not args.next:
        parser.print_help()
        return 0

    orchestrator = Orchestrator(
        config_path=args.config,
        checkpoint_path=Path(args.checkpoint),
    )

    try:
        final_state = orchestrator.run()
    except OrchestratorError as error:
        print(f"RALPH: {error}")
        return 1

    print(
        f"RALPH: final state = "
        f"{final_state.value}"
    )

    if final_state in {
        TicketState.HUMAN_QA_PENDING,
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
        TicketState.AGENT_FAILURE,
    }:
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
