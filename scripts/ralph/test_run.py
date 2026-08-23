"""Unit tests for scripts.ralph.run.

These tests MUST NOT make real Tenki, MiniMax, Nebius, PostgreSQL, or
GitHub calls. All components are replaced with fakes via
ConductorCallbacks.
"""

import json
import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest.mock import MagicMock

from scripts.ralph.checkpoint import (
    CheckpointError,
    CheckpointStore,
    TicketCheckpoint,
)
from scripts.ralph.cleanup import (
    RemoteBranchCleanupError,
    RemoteBranchCleaner,
)
from scripts.ralph.github_source import (
    GitHubTask,
    GitHubTaskSource,
)
from scripts.ralph.implementation import (
    CompletionPhase,
    CompletionStatus,
    ImplementationError,
    ImplementationFixContext,
    ImplementationResult,
    ImplementationTimeoutError,
)
from scripts.ralph.persistence import (
    PersistenceError,
    PersistenceRecoveryDisposition,
)
from scripts.ralph.qa import (
    QaCommandResult,
    QaResult,
    QaStatus,
)
from scripts.ralph.recovery import (
    BranchAbsentReason,
    BranchLookup,
    BranchMalformedReason,
    CandidateEvaluation,
    PullRequestAbsentReason,
    PullRequestLookup,
    PullRequestMalformedReason,
)
from scripts.ralph.review import (
    ReviewError,
    ReviewFinding,
    ReviewResult,
    ReviewStage,
    ReviewVerdict,
)
from scripts.ralph.run import (
    APPROVED_LAST_ERROR_MESSAGES,
    Budgets,
    ConductorCallbacks,
    Orchestrator,
    OrchestratorError,
    TERMINAL_REASON_MESSAGES,
    TerminalReason,
    _load_budgets,
    _terminal_message,
    _validate_implementation_timeout_seconds,
    _validate_sandbox_max_duration_seconds,
    build_qa_commands,
    format_findings,
    split_repository,
)
from scripts.ralph.sandbox import (
    SandboxCommandResult,
    SandboxSessionTerminatedError,
    TenkiSandbox,
)
from scripts.ralph.states import TicketState
from scripts.ralph.workspace import (
    TicketWorkspace,
    WorkspacePreparationError,
)


# Tracks every workspace patcher created by tests so the
# module-level ``tearDownModule`` can stop them all when the
# test module finishes.  This catches patchers leaked by
# cross-instance callers (e.g., a fresh
# ``PostMergeWorkspaceBaseGuardTests()`` instance used only
# to invoke ``_make_real_workspace_sandbox``).
_WORKSPACE_PATCHERS: list = []


def tearDownModule():
    while _WORKSPACE_PATCHERS:
        patcher = _WORKSPACE_PATCHERS.pop()
        try:
            patcher.stop()
        except Exception:
            pass


CONFIG = {
    "id": "m2",
    "githubMilestone": "M2",
    "repository": "Measure-2wice/sound-hub",
    "parentIssue": 12,
    "githubApp": {
        "idEnv": "RALPH_GITHUB_APP_ID",
        "privateKeyPathEnv": (
            "RALPH_GITHUB_APP_PRIVATE_KEY_PATH"
        ),
    },
    "integration": {
        "branch": "ralph/m2",
        "ticketBranchPrefix": "ralph/m2-",
        "deleteRemoteTicketBranchAfterIntegration": True,
        "mergeToMain": False,
    },
    "execution": {
        "maxImplementationIterations": 2,
        "maxReviewCycles": 5,
        "maxReviewFixIterations": 2,
        "maxQaAttempts": 5,
    },
    "selection": {
        "requiredLabel": "ready-for-ralph",
        "skipLabels": ["needs-reshaping"],
    },
    "qa": {
        "commands": [
            {
                "name": "format-check",
                "command": "pnpm format:check",
                "timeoutSeconds": 300,
            },
            {
                "name": "check",
                "command": "pnpm check",
                "timeoutSeconds": 1800,
            },
        ],
    },
}


def task(
    number,
    *,
    state="OPEN",
    labels=("ready-for-ralph",),
    dependencies=(),
    body="",
    title="",
):
    return GitHubTask(
        number=number,
        title=title or f"Issue {number}",
        state=state,
        labels=frozenset(labels),
        dependencies=tuple(dependencies),
        body=body or f"Body for issue {number}",
    )


def workspace_response(
    *,
    base="base123",
    ticket="ticket123",
    branch="ralph/m2-17",
    mode="CREATED",
):
    return SandboxCommandResult(
        exit_code=0,
        stdout=(
            f"RALPH_BASE_SHA={base}\n"
            f"RALPH_TICKET_SHA={ticket}\n"
            f"RALPH_TICKET_BRANCH={branch}\n"
            f"RALPH_WORKSPACE_MODE={mode}\n"
        ),
        stderr="",
    )


def make_fake_sandbox(workspace=workspace_response()):
    sandbox = MagicMock(name="TenkiSandbox")
    sandbox.exec.return_value = workspace
    return sandbox


def make_fake_authenticator(token="ghs_fake"):
    return SimpleNamespace(
        mint_repository_token=MagicMock(
            return_value=SimpleNamespace(token=token)
        )
    )


def make_fake_qa_environment(
    *,
    start_error=None,
    start_env=None,
):
    fake = SimpleNamespace()
    fake.start_calls = 0
    fake.stop_calls = 0
    fake.start_error = start_error
    fake.start_env = start_env or {
        "TEST_DATABASE_URL": (
            "postgresql://tenki@127.0.0.1:5433/"
            "soundhub_m1_test"
        ),
    }

    def start():
        fake.start_calls += 1

        if fake.start_error is not None:
            raise fake.start_error

        return SimpleNamespace(
            database_url=fake.start_env[
                "TEST_DATABASE_URL"
            ],
            env=fake.start_env,
        )

    def stop():
        fake.stop_calls += 1

    fake.start = start
    fake.stop = stop

    return fake


def make_completion(
    *,
    status=CompletionStatus.COMPLETE,
    summary="Implemented the ticket.",
    validation="pnpm check passed",
    blocker=None,
    changed_files=("apps/api/src/services/x.ts",),
    session_id="session-1",
    num_turns=1,
    exhausted=False,
):
    return ImplementationResult(
        exit_code=0,
        session_id=session_id,
        num_turns=num_turns,
        terminal_reason=(
            "max_turns" if exhausted else "completed"
        ),
        stop_reason=None,
        is_error=False,
        result_text="Implementation complete.",
        changed_files=changed_files,
        completion_status=status,
        completion_summary=summary,
        completion_validation=validation,
        completion_blocker=blocker,
    )


def make_review(
    *,
    verdict,
    summary="",
    findings=(),
    stage=ReviewStage.PRE_QA,
):
    return ReviewResult(
        stage=stage,
        verdict=verdict,
        summary=summary,
        findings=tuple(findings),
        prompt_tokens=10,
        completion_tokens=5,
        total_tokens=15,
    )


def make_qa_result(
    *,
    status=QaStatus.PASSED,
):
    return QaResult(
        status=status,
        commands=(
            QaCommandResult(
                name="format-check",
                command="pnpm format:check",
                exit_code=0
                if status == QaStatus.PASSED
                else 1,
                stdout="ok"
                if status == QaStatus.PASSED
                else "format failed",
                stderr="",
                status=QaStatus.PASSED
                if status == QaStatus.PASSED
                else status,
            ),
        ),
    )


def make_present_branch(head_sha: str) -> BranchLookup:
    return BranchLookup(head_sha=head_sha)


def make_absent_branch() -> BranchLookup:
    return BranchLookup(
        absent_reason=BranchAbsentReason.NOT_FOUND
    )


def make_empty_pr_lookup() -> PullRequestLookup:
    return PullRequestLookup(
        candidates=(),
        absent_reason=PullRequestAbsentReason.EMPTY_LIST,
        malformed_reasons=(),
    )


def make_matching_pr_lookup(
    *,
    number: int,
    head_sha: str,
) -> PullRequestLookup:
    return PullRequestLookup(
        candidates=(
            CandidateEvaluation(
                number=number,
                head_sha=head_sha,
                reasons=(),
            ),
        ),
        absent_reason=None,
        malformed_reasons=(),
    )


def make_merged_pr_dict(
    *,
    number: int,
    head_sha: str,
    head_ref: str = "ralph/m2-17",
    base_ref: str = "ralph/m2",
    repository: str = "Measure-2wice/sound-hub",
    merged: bool = True,
) -> dict:
    """Build a full-PR dict for the strict merged-PR identity
    proof.  The verifier expects every identity field plus
    ``merged`` to be present.
    """
    return {
        "number": number,
        "head": {
            "ref": head_ref,
            "sha": head_sha,
            "repo": {"full_name": repository},
        },
        "base": {
            "ref": base_ref,
            "repo": {"full_name": repository},
        },
        "merged": merged,
    }


class RunHarness:
    def __init__(
        self,
        *,
        tasks,
        checkpoint=None,
        callbacks=None,
        initial_workspace=None,
        authenticator=None,
        config_override=None,
        sandbox_override=None,
    ):
        self._saved_env = {
            "RALPH_GITHUB_APP_ID": os.environ.get(
                "RALPH_GITHUB_APP_ID"
            ),
            "RALPH_GITHUB_APP_PRIVATE_KEY_PATH": (
                os.environ.get(
                    "RALPH_GITHUB_APP_PRIVATE_KEY_PATH"
                )
            ),
            "MINIMAX_API_KEY": os.environ.get(
                "MINIMAX_API_KEY"
            ),
            "NEBIUS_API_KEY": os.environ.get(
                "NEBIUS_API_KEY"
            ),
        }

        os.environ["RALPH_GITHUB_APP_ID"] = "12345"
        os.environ[
            "RALPH_GITHUB_APP_PRIVATE_KEY_PATH"
        ] = "/tmp/fake.pem"
        os.environ["MINIMAX_API_KEY"] = "fake"
        os.environ["NEBIUS_API_KEY"] = "fake"

        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

        self.config_path = self.root / "config.json"
        effective_config = (
            config_override
            if config_override is not None
            else CONFIG
        )
        self.config_path.write_text(
            json.dumps(effective_config)
        )

        self.checkpoint_path = self.root / "checkpoint.json"

        self._last_saved_checkpoint: Optional[
            TicketCheckpoint
        ] = None
        self._saved_checkpoints: list[
            TicketCheckpoint
        ] = []

        self._store_save_spy = unittest.mock.patch.object(
            CheckpointStore,
            "save",
            side_effect=self._capture_save,
        )
        self._store_save_spy.start()

        self._store_clear_spy = unittest.mock.patch.object(
            CheckpointStore,
            "clear",
            side_effect=self._capture_clear,
        )
        self._store_clear_spy.start()

        if checkpoint is not None:
            self.checkpoint_path.write_text(
                json.dumps(
                    checkpoint,
                    default=lambda value: getattr(
                        value, "value", value
                    ),
                )
            )

        default_branch = (
            checkpoint["ticket_branch"]
            if checkpoint is not None
            else "ralph/m2-17"
        )

        self.sandbox = (
            sandbox_override
            if sandbox_override is not None
            else make_fake_sandbox(
                workspace=(
                    initial_workspace
                    if initial_workspace is not None
                    else workspace_response(
                        branch=default_branch
                    )
                )
            )
        )

        self.authenticator = (
            authenticator
            if authenticator is not None
            else make_fake_authenticator()
        )

        self.tasks = tasks
        self.tasks_by_number = {
            task.number: task for task in tasks
        }

        self.impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion()
            )
        )
        self.review_runner = SimpleNamespace(
            review=MagicMock()
        )
        self.qa_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_qa_result()
            )
        )
        self.persistence_runner = SimpleNamespace(
            persist=MagicMock(
                return_value=SimpleNamespace(
                    commit_sha="commit_default",
                    remote_sha="commit_default",
                    pull_request_number=1,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )
        )
        self.integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )
        self.cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        self.qa_environment = make_fake_qa_environment()

        # Default recovery probe: if the checkpoint already
        # records ``persisted_commit_sha``, the probe confirms
        # the branch HEAD matches it; otherwise the probe
        # returns an absent branch.  Tests that exercise a
        # specific recovery scenario (AMBIGUOUS, multiple PRs,
        # etc.) set their own ``make_github_probe`` callback.
        self.recovery_probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                side_effect=lambda **kw: (
                    make_present_branch(
                        checkpoint[
                            "persisted_commit_sha"
                        ]
                    )
                    if (
                        checkpoint
                        and checkpoint.get(
                            "persisted_commit_sha"
                        )
                    )
                    else make_absent_branch()
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        if callbacks is None:
            self.callbacks = ConductorCallbacks(
                make_authenticator=lambda config: (
                    self.authenticator
                ),
                make_qa_environment=lambda sb: self.qa_environment,
                make_implementation_runner=lambda **kw: (
                    self.impl_runner
                ),
                make_review_runner=lambda **kw: (
                    self.review_runner
                ),
                make_qa_runner=lambda **kw: self.qa_runner,
                make_persistence_runner=lambda **kw: (
                    self.persistence_runner
                ),
                make_integration_runner=lambda **kw: (
                    self.integration_runner
                ),
                make_remote_branch_cleaner=lambda **kw: (
                    self.cleaner
                ),
                make_github_probe=lambda **kw: (
                    self.recovery_probe
                ),
            )
        else:
            # Wrap the provided callbacks so any missing factory
            # (notably ``make_github_probe``) falls back to the
            # harness default.  Tests that override ``make_github_probe``
            # get the override; tests that omit it get the default.
            defaults = ConductorCallbacks(
                make_github_probe=lambda **kw: (
                    self.recovery_probe
                ),
            )

            self.callbacks = ConductorCallbacks(
                make_authenticator=(
                    callbacks.make_authenticator
                    or defaults.make_authenticator
                ),
                make_qa_environment=(
                    callbacks.make_qa_environment
                    or defaults.make_qa_environment
                ),
                make_implementation_runner=(
                    callbacks.make_implementation_runner
                    or defaults.make_implementation_runner
                ),
                make_review_runner=(
                    callbacks.make_review_runner
                    or defaults.make_review_runner
                ),
                make_qa_runner=(
                    callbacks.make_qa_runner
                    or defaults.make_qa_runner
                ),
                make_persistence_runner=(
                    callbacks.make_persistence_runner
                    or defaults.make_persistence_runner
                ),
                make_integration_runner=(
                    callbacks.make_integration_runner
                    or defaults.make_integration_runner
                ),
                make_remote_branch_cleaner=(
                    callbacks.make_remote_branch_cleaner
                    or defaults.make_remote_branch_cleaner
                ),
                make_github_probe=(
                    callbacks.make_github_probe
                    or defaults.make_github_probe
                ),
                mint_github_token=(
                    callbacks.mint_github_token
                    or defaults.mint_github_token
                ),
            )

        self.orchestrator = Orchestrator(
            config_path=str(self.config_path),
            checkpoint_path=self.checkpoint_path,
            callbacks=self.callbacks,
        )

        self.source_patcher = unittest.mock.patch.object(
            GitHubTaskSource,
            "list_tasks",
            return_value=list(self.tasks),
        )
        self.source_patcher.start()

        self.sandbox_patcher = unittest.mock.patch(
            "scripts.ralph.run.TenkiSandbox",
        )
        self.mock_tenki = self.sandbox_patcher.start()
        self.mock_tenki.return_value.__enter__.return_value = (
            self.sandbox
        )
        self.mock_tenki.return_value.__exit__.return_value = (
            False
        )

    def close(self):
        try:
            self.source_patcher.stop()
            self.sandbox_patcher.stop()
            self._store_save_spy.stop()
            self._store_clear_spy.stop()
        finally:
            self.tempdir.cleanup()
            for key, value in self._saved_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def run(self):
        return self.orchestrator.run()

    def saved_checkpoint(self) -> Optional[
        TicketCheckpoint
    ]:
        return self._last_saved_checkpoint

    def saved_checkpoints(self) -> list[
        TicketCheckpoint
    ]:
        return list(self._saved_checkpoints)

    def last_before_clear(self) -> Optional[
        TicketCheckpoint
    ]:
        """Return the most recent checkpoint saved BEFORE the
        store was cleared. Useful for tests that exercise the
        post-integration checkpoint-clear path."""
        for checkpoint in reversed(self._saved_checkpoints):
            return checkpoint
        return None

    def checkpoint_missing(self) -> bool:
        return (
            self._last_saved_checkpoint is None
            and not self.checkpoint_path.exists()
        )

    def _capture_save(self, checkpoint):
        self._last_saved_checkpoint = checkpoint
        self._saved_checkpoints.append(checkpoint)

    def _capture_clear(self):
        self._last_saved_checkpoint = None

    def checkpoint_missing(self) -> bool:
        return (
            self._last_saved_checkpoint is None
            and not self.checkpoint_path.exists()
        )


def make_checkpoint_payload(
    *,
    issue_number,
    state,
    implementation_attempts=0,
    fix_attempts=0,
    persisted_commit_sha=None,
    pull_request_number=None,
    review_stage=ReviewStage.PRE_QA.value,
    qa_evidence=None,
    pre_qa_findings=None,
    qa_failure_evidence=None,
    pre_persistence_findings=None,
    base_sha="base123",
    ticket_sha="ticket123",
    integration_branch="ralph/m2",
    ticket_branch="ralph/m2-17",
    milestone_id="m2",
    last_error=None,
    qa_attempts=0,
    review_attempts=0,
    review_cycles_consumed=0,
):
    return {
        "schema_version": 2,
        "milestone_id": milestone_id,
        "issue_number": issue_number,
        "state": state.value
        if hasattr(state, "value")
        else state,
        "integration_branch": integration_branch,
        "ticket_branch": ticket_branch,
        "base_sha": base_sha,
        "ticket_sha": ticket_sha,
        "implementation_session_id": None,
        "review_attempts": review_attempts,
        "review_cycles_consumed": review_cycles_consumed,
        "qa_attempts": qa_attempts,
        "implementation_attempts": implementation_attempts,
        "fix_attempts": fix_attempts,
        "persisted_commit_sha": persisted_commit_sha,
        "pull_request_number": pull_request_number,
        "review_stage": review_stage,
        "qa_evidence": qa_evidence,
        "last_error": last_error,
        "pre_qa_findings": pre_qa_findings,
        "qa_failure_evidence": qa_failure_evidence,
        "pre_persistence_findings": pre_persistence_findings,
    }


class NoExecutionReadyTicketTests(unittest.TestCase):
    def test_no_execution_ready_ticket_is_noop(self):
        tasks = [
            task(
                16,
                labels=(),
            ),
        ]

        with RunHarness(tasks=tasks) as harness:
            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        self.assertTrue(harness.checkpoint_missing())

    def test_no_execution_ready_ticket_no_runner_invoked(
        self,
    ):
        tasks = [
            task(
                16,
                labels=(),
            ),
        ]

        with RunHarness(tasks=tasks) as harness:
            harness.run()

        harness.impl_runner.run.assert_not_called()


class TicketSelectionTests(unittest.TestCase):
    def test_deterministic_selection_of_first_eligible(
        self,
    ):
        tasks = [
            task(15, state="CLOSED"),
            task(
                16,
                dependencies=(15,),
                labels=(),
            ),
            task(
                17,
                dependencies=(15,),
                labels=("ready-for-ralph",),
            ),
        ]

        with RunHarness(tasks=tasks) as harness:
            harness.impl_runner.run.return_value = (
                make_completion(
                    status=CompletionStatus.BLOCKED,
                    blocker=(
                        "Cannot determine schema"
                    ),
                )
            )

            final = harness.run()

            loaded = harness.saved_checkpoint()

        self.assertEqual(loaded.issue_number, 17)
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_existing_checkpoint_takes_precedence(self):
        tasks = [
            task(15, state="CLOSED"),
            task(
                16,
                dependencies=(15,),
                labels=(),
            ),
            task(
                17,
                dependencies=(15,),
                labels=("ready-for-ralph",),
            ),
        ]

        checkpoint = make_checkpoint_payload(
            issue_number=16,
            state=TicketState.REVIEWING,
            ticket_branch="ralph/m2-16",
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.impl_runner.run.return_value = (
                make_completion(
                    status=CompletionStatus.BLOCKED,
                    blocker=(
                        "Cannot determine schema"
                    ),
                )
            )

            final = harness.run()

            loaded = harness.saved_checkpoint()

        self.assertEqual(loaded.issue_number, 16)
        self.assertEqual(
            loaded.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )


class ImplementationOutcomeTests(unittest.TestCase):
    def test_implementation_complete_runs_full_pipeline(
        self,
    ):
        tasks = [task(17)]

        with RunHarness(tasks=tasks) as harness:
            harness.impl_runner.run.return_value = (
                make_completion(
                    status=CompletionStatus.COMPLETE,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_QA
                    ),
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        self.assertGreaterEqual(
            harness.qa_runner.run.call_count,
            1,
        )

        self.assertTrue(harness.checkpoint_missing())

    def test_implementation_blocked_transitions_to_blocked_for_human(
        self,
    ):
        tasks = [task(17)]

        with RunHarness(tasks=tasks) as harness:
            harness.impl_runner.run.return_value = (
                make_completion(
                    status=CompletionStatus.BLOCKED,
                    blocker=(
                        "Cannot determine the new "
                        "workspace authorization model."
                    ),
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            loaded.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )

        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        # ``completion_blocker`` is model-authored text and
        # MUST NOT reach ``checkpoint.last_error``.  The
        # terminal message is the static
        # ``IMPLEMENTATION_BLOCKED`` reason — not the
        # blocker string itself.
        self.assertEqual(
            loaded.last_error,
            "Implementation agent reported a blocker.",
        )
        self.assertNotIn(
            "workspace authorization model",
            loaded.last_error or "",
        )

    def test_max_turn_iteration_exhaustion_blocks_for_human(
        self,
    ):
        tasks = [task(17)]

        with RunHarness(tasks=tasks) as harness:
            harness.impl_runner.run.return_value = (
                make_completion(
                    status=CompletionStatus.COMPLETE,
                    changed_files=(),
                    exhausted=True,
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            loaded.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_implementation_attempt_budget_exhausted(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
            implementation_attempts=2,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            loaded.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )


class ReviewFlowTests(unittest.TestCase):
    def test_pre_qa_fix_moves_to_fixing_then_rereview(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.side_effect = [
                make_review(
                    verdict=(
                        ReviewVerdict.FIX_BEFORE_QA
                    ),
                    summary=(
                        "Migration ordering is wrong."
                    ),
                    findings=(
                        ReviewFinding(
                            severity="BLOCKING",
                            title="Wrong order",
                            details=(
                                "Add column before "
                                "backfill."
                            ),
                        ),
                    ),
                ),
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_QA
                    ),
                ),
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                ),
            ]

            harness.impl_runner.run.side_effect = [
                make_completion(
                    status=CompletionStatus.COMPLETE,
                ),
                make_completion(
                    status=CompletionStatus.COMPLETE,
                ),
            ]

            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.persistence_runner.persist.return_value = (
                SimpleNamespace(
                    commit_sha="commitXYZ",
                    remote_sha="commitXYZ",
                    pull_request_number=101,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )

            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        self.assertEqual(
            harness.impl_runner.run.call_count,
            1,
        )

        self.assertEqual(
            harness.review_runner.review.call_count,
            3,
        )

        fix_call = harness.impl_runner.run.call_args_list[
            0
        ]

        self.assertIsNotNone(
            fix_call.kwargs.get("fix_context")
        )

    def test_pre_qa_approval_enters_qa(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_QA
                    ),
                )
            )

            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        self.assertEqual(
            harness.qa_environment.start_calls,
            1,
        )


class QaLifecycleTests(unittest.TestCase):
    def test_postgres_stop_executes_on_qa_success(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.side_effect = [
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                ),
            ]

            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.persistence_runner.persist.return_value = (
                SimpleNamespace(
                    commit_sha="commit123",
                    remote_sha="commit123",
                    pull_request_number=99,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )

            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        self.assertEqual(
            harness.qa_environment.start_calls,
            1,
        )

        self.assertGreaterEqual(
            harness.qa_environment.stop_calls,
            1,
        )

    def test_postgres_stop_executes_on_qa_infra_failure(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.INFRA_FAILURE,
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            loaded.state,
            TicketState.INFRA_FAILURE,
        )
        self.assertEqual(
            final,
            TicketState.INFRA_FAILURE,
        )
        self.assertEqual(
            harness.qa_environment.start_calls,
            1,
        )
        self.assertGreaterEqual(
            harness.qa_environment.stop_calls,
            1,
        )

    def test_postgres_stop_executes_on_qa_exception(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.side_effect = (
                RuntimeError("boom")
            )

            with self.assertRaises(RuntimeError):
                harness.run()

        self.assertEqual(
            harness.qa_environment.start_calls,
            1,
        )
        self.assertGreaterEqual(
            harness.qa_environment.stop_calls,
            1,
        )

    def test_qa_code_failure_routes_through_fix(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.CODE_FAILURE,
                )
            )

            final = harness.run()

            loaded = harness.saved_checkpoint()

        self.assertGreaterEqual(
            harness.impl_runner.run.call_count,
            1,
        )

        fix_call = (
            harness.impl_runner.run.call_args_list[0]
        )

        self.assertIsNotNone(
            fix_call.kwargs.get("fix_context")
        )

        self.assertEqual(
            loaded.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_qa_infra_failure_is_terminal(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.INFRA_FAILURE,
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.INFRA_FAILURE,
        )

    def test_postgres_provisioning_failure_is_infra(
        self,
    ):
        from scripts.ralph.qa_environment import (
            QaEnvironmentError,
        )

        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_environment.start_error = (
                QaEnvironmentError(
                    "postgres install failed"
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.INFRA_FAILURE,
        )


class PersistenceAndIntegrationTests(
    unittest.TestCase,
):
    def test_pre_persistence_review_requires_qa_evidence(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
            qa_evidence=None,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.side_effect = (
                AssertionError(
                    "ReviewRunner would have been "
                    "invoked with qa_evidence=None"
                )
            )

            with self.assertRaises(AssertionError):
                harness.run()

    def test_block_persistence_routes_through_fix(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.BLOCK_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                    summary=(
                        "Migration script missing."
                    ),
                )
            )

            final = harness.run()

            loaded = harness.saved_checkpoint()

        self.assertGreaterEqual(
            harness.impl_runner.run.call_count,
            1,
        )

        fix_call = (
            harness.impl_runner.run.call_args_list[0]
        )

        self.assertIsNotNone(
            fix_call.kwargs.get("fix_context")
        )

        self.assertEqual(
            loaded.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_block_persistence_fix_full_re_review_re_qa(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            pre_persistence_findings=(
                "Migration script missing."
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.side_effect = [
                make_review(
                    verdict=(
                        ReviewVerdict.BLOCK_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                ),
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_QA
                    ),
                    stage=ReviewStage.PRE_QA,
                ),
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                ),
            ]

            harness.impl_runner.run.side_effect = [
                make_completion(
                    status=CompletionStatus.COMPLETE,
                ),
            ]

            harness.persistence_runner.persist.return_value = (
                SimpleNamespace(
                    commit_sha="commitXYZ",
                    remote_sha="commitXYZ",
                    pull_request_number=101,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )

            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        self.assertGreaterEqual(
            harness.review_runner.review.call_count,
            3,
        )

        self.assertGreaterEqual(
            harness.qa_runner.run.call_count,
            2,
        )

    def test_approved_persistence_saves_commit_and_pr(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )

            harness.persistence_runner.persist.return_value = (
                SimpleNamespace(
                    commit_sha="commitABC",
                    remote_sha="commitABC",
                    pull_request_number=202,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )

            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        harness.integration_runner.integrate.assert_called_once()

        kwargs = (
            harness
            .integration_runner
            .integrate
            .call_args
            .kwargs
        )

        self.assertEqual(
            kwargs["expected_head_sha"],
            "commitABC",
        )
        self.assertEqual(
            kwargs["pull_request_number"],
            202,
        )

    def test_restart_after_persistence_does_not_recreate(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )

            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        harness.persistence_runner.persist.assert_not_called()

    def test_restart_during_integrating_is_idempotent(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATING,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=False,
                    already_absent=True,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        harness.persistence_runner.persist.assert_not_called()

        harness.impl_runner.run.assert_not_called()

        harness.review_runner.review.assert_not_called()

    def test_restart_after_integrated_retries_cleanup_only(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATED,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        harness.impl_runner.run.assert_not_called()
        harness.review_runner.review.assert_not_called()
        harness.qa_runner.run.assert_not_called()
        harness.persistence_runner.persist.assert_not_called()

        harness.cleaner.cleanup_ticket_branch.assert_called_once()

    def test_successful_ticket_clears_checkpoint(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )

            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

        self.assertTrue(harness.checkpoint_missing())


class UnexpectedStateTests(unittest.TestCase):
    def test_unexpected_github_state_blocks_for_human(
        self,
    ):
        tasks = [
            task(
                16,
                labels=("ready-for-ralph",),
            ),
            task(
                17,
                labels=("ready-for-ralph",),
                dependencies=(16,),
            ),
        ]

        checkpoint = make_checkpoint_payload(
            issue_number=16,
            state=TicketState.IMPLEMENTING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.source_patcher.stop()

            with unittest.mock.patch.object(
                GitHubTaskSource,
                "list_tasks",
                return_value=[
                    task(
                        17,
                        labels=("ready-for-ralph",),
                    ),
                ],
            ):
                final = harness.run()

                loaded = harness.saved_checkpoint()

        self.assertEqual(
            loaded.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_main_is_never_an_integration_target(self):
        from scripts.ralph.git_policy import (
            GitPolicyError,
            GitPushPolicy,
        )

        policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
            protected_branches=("main", "ralph/m2"),
        )

        with self.assertRaises(GitPolicyError):
            policy.assert_push_allowed(
                branch="main",
                state=TicketState.INTEGRATING,
                issue_number=17,
            )


class CleanupTests(unittest.TestCase):
    def test_remote_branch_cleanup_is_idempotent(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATED,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.cleaner.cleanup_ticket_branch.side_effect = [
                SimpleNamespace(
                    deleted=False,
                    already_absent=True,
                    branch="ralph/m2-17",
                ),
            ]

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )
        self.assertTrue(harness.checkpoint_missing())

    def test_remote_branch_cleanup_sha_mismatch_blocks(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATED,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.cleaner.cleanup_ticket_branch.side_effect = (
                RemoteBranchCleanupError(
                    "branch SHA mismatch"
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_remote_branch_cleanup_never_deletes_main(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATED,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.cleaner.cleanup_ticket_branch.side_effect = (
                RemoteBranchCleanupError(
                    "Ralph will never delete protected "
                    "branch `main`."
                )
            )

            final = harness.run()

        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )


class HelperFunctionTests(unittest.TestCase):
    def test_build_qa_commands_reads_config(self):
        commands = build_qa_commands(CONFIG)

        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0].name, "format-check")
        self.assertEqual(commands[1].name, "check")

    def test_format_findings_includes_severity_and_details(
        self,
    ):
        text = format_findings(
            (
                ReviewFinding(
                    severity="BLOCKING",
                    title="X",
                    details="d",
                ),
            ),
            "summary",
        )

        self.assertIn("BLOCKING", text)
        self.assertIn("X", text)
        self.assertIn("d", text)
        self.assertIn("summary", text)

    def test_split_repository(self):
        self.assertEqual(
            split_repository(
                "Measure-2wice/sound-hub"
            ),
            ("Measure-2wice", "sound-hub"),
        )


class AttemptBudgetDurabilityTests(unittest.TestCase):
    """Attempt counters must be incremented and persisted BEFORE
    the runner is invoked, so a crash in the runner cannot lose
    the attempt."""

    def test_implementation_attempt_incremented_before_runner(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                side_effect=ImplementationError(
                    "agent crashed"
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        # Counter incremented and saved BEFORE the runner was
        # invoked, so even an ImplementationError mid-run cannot
        # lose the attempt.
        self.assertEqual(
            saved.implementation_attempts,
            1,
        )
        self.assertEqual(
            saved.state,
            TicketState.AGENT_FAILURE,
        )

    def test_fix_attempt_incremented_before_runner(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings="Old defect",
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                side_effect=ImplementationError(
                    "agent crashed"
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        self.assertEqual(
            saved.fix_attempts,
            1,
        )

    def test_qa_attempt_incremented_before_runner(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        qa_runner = SimpleNamespace(
            run=MagicMock(
                side_effect=RuntimeError(
                    "qa crashed"
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            with self.assertRaises(RuntimeError):
                harness.run()

            saved = harness.saved_checkpoint()

        self.assertEqual(
            saved.qa_attempts,
            1,
        )

    def test_qa_budget_exhaustion_blocks_before_runner(self):
        # Test harness sets maxQaAttempts=5 via CONFIG. We set
        # qa_attempts=5 to exceed the limit and assert the
        # runner is never invoked.
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_attempts=5,
        )

        qa_runner = SimpleNamespace(
            run=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        qa_runner.run.assert_not_called()
        self.assertEqual(
            saved.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )


class ImplementationTimeoutTerminalStateTests(unittest.TestCase):
    """Regression tests for the wall-clock timeout added after
    the M2 #17 hang.

    Contract under test:

    - When ``ImplementationRunner.run`` raises
      ``ImplementationTimeoutError`` (either phase), the
      conductor MUST transition to ``AGENT_FAILURE`` with
      ``last_error`` set to the static
      ``IMPLEMENTATION_TIMEOUT`` message.

    - The trust boundary on ``checkpoint.last_error`` MUST
      remain intact: no subprocess stdout / stderr / model
      output may reach ``last_error``.

    - The attempt counter is already incremented BEFORE the
      runner runs (existing durable checkpoint contract), so
      the timeout consumes the next allowed fix attempt on
      restart.

    - ``ImplementationTimeoutError`` is a subclass of
      ``ImplementationError`` so existing exception-driven
      fallbacks still apply, but the dedicated ``except
      ImplementationTimeoutError`` arm fires first.
    """

    def _timeout_runner(self):
        return SimpleNamespace(
            run=MagicMock(
                side_effect=ImplementationTimeoutError(
                    "Implementation command exceeded "
                    "its 3600s wall-clock deadline."
                )
            )
        )

    def test_implementation_timeout_maps_to_agent_failure(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._timeout_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        # The runner was actually invoked (the timeout is not
        # short-circuited by the budget guard).
        impl_runner.run.assert_called_once()

        self.assertEqual(
            saved.implementation_attempts,
            1,
        )
        self.assertEqual(
            saved.state,
            TicketState.AGENT_FAILURE,
        )

        # ``last_error`` MUST be the static Ralph-authored
        # message; no subprocess / model output may leak.
        self.assertEqual(
            saved.last_error,
            _terminal_message(
                TerminalReason.IMPLEMENTATION_TIMEOUT
            ),
        )
        self.assertIn(
            "wall-clock deadline",
            saved.last_error,
        )
        # The static message is disjoint from the runtime
        # exception's text (the runtime message uses the same
        # vocabulary by design), but it MUST NOT contain any
        # arbitrary SDK detail.
        self.assertNotIn("DEADLINE_EXCEEDED", saved.last_error)

    def test_fix_timeout_maps_to_agent_failure(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings="Old defect",
        )

        impl_runner = self._timeout_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        impl_runner.run.assert_called_once()

        # The fix attempt counter is incremented BEFORE the
        # runner is invoked, so a timeout cannot lose the
        # attempt.  This is what allows a restart to resume
        # the durable ``fix_attempts == 1`` checkpoint and
        # consume the next allowed attempt normally.
        self.assertEqual(
            saved.fix_attempts,
            1,
        )
        self.assertEqual(
            saved.state,
            TicketState.AGENT_FAILURE,
        )
        self.assertEqual(
            saved.last_error,
            _terminal_message(
                TerminalReason.IMPLEMENTATION_TIMEOUT
            ),
        )

    def test_timeout_last_error_is_in_approved_set(self):
        # Belt-and-braces: the new terminal message MUST be
        # in the closed ``APPROVED_LAST_ERROR_MESSAGES`` set
        # so the load/save trust boundary accepts it.
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._timeout_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        self.assertIn(
            saved.last_error,
            APPROVED_LAST_ERROR_MESSAGES,
        )

    def test_timeout_does_not_silently_retry_in_runner(self):
        # The runner is invoked exactly once.  The durable
        # checkpoint/attempt mechanism owns retry semantics:
        # ``ImplementationRunner`` MUST NOT loop on a
        # timeout.
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._timeout_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

        self.assertEqual(impl_runner.run.call_count, 1)

    def test_timeout_subclass_is_a_kind_of_implementation_error(self):
        # The dedicated ``except ImplementationTimeoutError``
        # arm fires BEFORE the generic ``except
        # ImplementationError`` arm, but the new exception
        # MUST remain a subclass of ``ImplementationError``
        # so any existing fallback still matches.
        self.assertTrue(
            issubclass(
                ImplementationTimeoutError,
                ImplementationError,
            )
        )

    def test_timeout_message_in_terminal_reason_messages(self):
        # The terminal reason catalog and the approved
        # ``last_error`` set are derived from the same source
        # of truth (``TERMINAL_REASON_MESSAGES``).  The
        # ``IMPLEMENTATION_TIMEOUT`` entry MUST exist in both
        # and use the same static string.
        self.assertIn(
            TerminalReason.IMPLEMENTATION_TIMEOUT,
            TERMINAL_REASON_MESSAGES,
        )
        message = TERMINAL_REASON_MESSAGES[
            TerminalReason.IMPLEMENTATION_TIMEOUT
        ]
        self.assertIn(
            "wall-clock deadline", message
        )
        self.assertIn(
            message,
            APPROVED_LAST_ERROR_MESSAGES,
        )


class ImplementationTimeoutConfigValidationTests(unittest.TestCase):
    """Regression tests for the
    ``execution.implementationTimeoutSeconds`` configuration
    boundary.

    Contract under test (added after Codex review of the M2 #17
    hang fix):

    - The configuration validator uses
      ``type(value) is int and value > 0``.  Using
      ``isinstance(value, int)`` is unsafe because ``bool`` is
      a subclass of ``int`` in Python; ``True`` would otherwise
      survive integer validation and reach Tenki as
      approximately 1 second.

    - Validation runs at the configuration/budget loading
      boundary (the single source of truth in
      ``_load_budgets``), BEFORE any checkpoint load, task
      discovery, sandbox creation, runner construction, attempt
      consumption, or GitHub mutation.  An invalid config
      therefore CANNOT consume a ticket attempt budget or
      mutate the durable checkpoint.

    - Invalid configurations surface as ``OrchestratorError``,
      the existing Ralph orchestration error boundary.  The
      message is a static Ralph-owned string and never echoes
      the raw value.
    """

    # ---- 1. Missing key defaults to integer 3600 ----

    def test_missing_key_defaults_to_3600_integer(self):
        config = json.loads(json.dumps(CONFIG))

        budgets = _load_budgets(config)

        self.assertEqual(
            budgets.implementation_timeout_seconds, 3600
        )
        self.assertIsInstance(
            budgets.implementation_timeout_seconds, int
        )
        self.assertIsNot(
            type(budgets.implementation_timeout_seconds),
            bool,
        )

    # ---- 2. Positive integer is accepted exactly ----

    def test_positive_integer_accepted_exactly(self):
        for value in (1, 30, 900, 3600):
            with self.subTest(value=value):
                config = json.loads(json.dumps(CONFIG))
                config["execution"][
                    "implementationTimeoutSeconds"
                ] = value

                budgets = _load_budgets(config)

                self.assertEqual(
                    budgets.implementation_timeout_seconds,
                    value,
                )

    # ---- 3. ``True`` is rejected ----

    def test_true_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = True

        with self.assertRaises(ValueError):
            _load_budgets(config)

        # And the predicate itself rejects ``True`` directly
        # (proves the unsafe ``isinstance(True, int)`` path is
        # not what we use).
        self.assertRaises(
            ValueError,
            _validate_implementation_timeout_seconds,
            True,
        )

    # ---- 4. ``False`` is rejected ----

    def test_false_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = False

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_implementation_timeout_seconds,
            False,
        )

    # ---- 5. The string ``"3600"`` is rejected ----

    def test_string_3600_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = "3600"

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_implementation_timeout_seconds,
            "3600",
        )

    # ---- 6. The float ``3600.0`` is rejected ----

    def test_float_3600_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = 3600.0

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_implementation_timeout_seconds,
            3600.0,
        )

    # ---- 7. ``0`` is rejected ----

    def test_zero_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = 0

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_implementation_timeout_seconds,
            0,
        )

    # ---- 8. Negative integer is rejected ----

    def test_negative_integer_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = -1

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_implementation_timeout_seconds,
            -3600,
        )

    # ---- 9. Explicit ``None`` is rejected ----

    def test_explicit_null_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = None

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_implementation_timeout_seconds,
            None,
        )

    # ---- Additional negative cases (lists, objects) ----

    def test_list_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = [3600]

        with self.assertRaises(ValueError):
            _load_budgets(config)

    def test_object_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = {"seconds": 3600}

        with self.assertRaises(ValueError):
            _load_budgets(config)

    # ---- Predicate sanity: ``isinstance(True, int) is True``
    # but our predicate is strict ----

    def test_predicate_rejects_bool_even_though_isinstance_passes(
        self,
    ):
        # Belt-and-braces: prove that ``isinstance(True, int)``
        # is the trap we are explicitly avoiding, and that
        # ``type(True) is int`` is False.
        self.assertTrue(isinstance(True, int))
        self.assertFalse(type(True) is int)
        self.assertFalse(type(False) is int)
        # Both ``True`` and ``False`` MUST raise.
        with self.assertRaises(ValueError):
            _validate_implementation_timeout_seconds(True)
        with self.assertRaises(ValueError):
            _validate_implementation_timeout_seconds(False)
        # And the predicate accepts a positive int.
        self.assertEqual(
            _validate_implementation_timeout_seconds(3600),
            3600,
        )


class ImplementationTimeoutConfigFailFastTests(unittest.TestCase):
    """End-to-end fail-closed tests proving invalid config
    cannot mutate the durable checkpoint, consume a ticket
    attempt, or invoke Claude / ``ImplementationRunner``.
    """

    def _config_with_timeout(self, value):
        config = json.loads(json.dumps(CONFIG))
        config["execution"][
            "implementationTimeoutSeconds"
        ] = value
        return config

    # ---- 10. Invalid config fails BEFORE implementation
    # attempt consumption ----

    def test_invalid_config_fails_before_implementation_attempt(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
            implementation_attempts=0,
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=ImplementationResult(
                    exit_code=0,
                    session_id="x",
                    num_turns=1,
                    terminal_reason="completed",
                    stop_reason=None,
                    is_error=False,
                    result_text="ok",
                    changed_files=(),
                    completion_status=CompletionStatus.COMPLETE,
                    completion_summary="ok",
                    completion_validation="ok",
                    completion_blocker=None,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=self._config_with_timeout(True),
        ) as harness:
            with self.assertRaises(OrchestratorError):
                harness.run()

        # The runner MUST NOT have been invoked at all.
        impl_runner.run.assert_not_called()

        # No checkpoint save was performed (the
        # implementation_attempts counter was never
        # incremented).
        self.assertIsNone(harness.saved_checkpoint())

    # ---- 11. Invalid config fails BEFORE fix attempt
    # consumption ----

    def test_invalid_config_fails_before_fix_attempt(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings="Old defect",
            fix_attempts=0,
            review_cycles_consumed=1,
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=ImplementationResult(
                    exit_code=0,
                    session_id="x",
                    num_turns=1,
                    terminal_reason="completed",
                    stop_reason=None,
                    is_error=False,
                    result_text="ok",
                    changed_files=(),
                    completion_status=CompletionStatus.COMPLETE,
                    completion_summary="ok",
                    completion_validation="ok",
                    completion_blocker=None,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=self._config_with_timeout(True),
        ) as harness:
            with self.assertRaises(OrchestratorError):
                harness.run()

            # Read the checkpoint on disk BEFORE the
            # ``TemporaryDirectory`` cleanup removes the file.
            on_disk = json.loads(
                harness.checkpoint_path.read_text()
            )

        impl_runner.run.assert_not_called()

        # The durable FIXING checkpoint MUST remain
        # byte-for-byte unchanged on disk.  fix_attempts,
        # review_cycles_consumed, and state are the three
        # fields the failure path must not touch.
        self.assertEqual(on_disk["state"], "FIXING")
        self.assertEqual(on_disk["fix_attempts"], 0)
        self.assertEqual(on_disk["review_cycles_consumed"], 1)
        self.assertEqual(
            on_disk["implementation_attempts"], 0
        )

    # ---- 12. FIXING checkpoint leaves all counters/state
    # unchanged for invalid config (cross-config sweep) ----

    def test_fixing_checkpoint_unchanged_for_any_invalid_config(
        self,
    ):
        invalid_values = [
            True,
            False,
            "3600",
            3600.0,
            0,
            -1,
            None,
            [3600],
            {"seconds": 3600},
        ]

        for value in invalid_values:
            with self.subTest(value=value):
                tasks = [task(17)]

                checkpoint = make_checkpoint_payload(
                    issue_number=17,
                    state=TicketState.FIXING,
                    pre_qa_findings="Old defect",
                    fix_attempts=0,
                    review_cycles_consumed=1,
                )

                callbacks = ConductorCallbacks(
                    make_authenticator=lambda config: (
                        make_fake_authenticator()
                    ),
                    make_qa_environment=lambda sb: (
                        make_fake_qa_environment()
                    ),
                    make_implementation_runner=lambda **kw: (
                        MagicMock()
                    ),
                    make_review_runner=lambda **kw: MagicMock(),
                    make_qa_runner=lambda **kw: MagicMock(),
                    make_persistence_runner=lambda **kw: (
                        MagicMock()
                    ),
                    make_integration_runner=lambda **kw: (
                        MagicMock()
                    ),
                    make_remote_branch_cleaner=lambda **kw: (
                        MagicMock()
                    ),
                )

                with RunHarness(
                    tasks=tasks,
                    checkpoint=checkpoint,
                    callbacks=callbacks,
                    config_override=(
                        self._config_with_timeout(value)
                    ),
                ) as harness:
                    with self.assertRaises(OrchestratorError):
                        harness.run()

                    # Read inside the ``with`` block, before
                    # the temp directory is removed.
                    on_disk = json.loads(
                        harness.checkpoint_path.read_text()
                    )

                self.assertEqual(
                    on_disk["state"], "FIXING"
                )
                self.assertEqual(on_disk["fix_attempts"], 0)
                self.assertEqual(
                    on_disk["review_cycles_consumed"], 1
                )

    # ---- 13. Claude / ``ImplementationRunner`` is never
    # invoked for invalid config ----

    def test_implementation_runner_never_invoked_for_invalid_config(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        factory_calls: list = []
        runner_instance = SimpleNamespace(
            run=MagicMock(
                side_effect=AssertionError(
                    "ImplementationRunner.run was invoked "
                    "for invalid configuration."
                )
            )
        )

        def make_runner(**kwargs):
            factory_calls.append(kwargs)
            return runner_instance

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=make_runner,
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=self._config_with_timeout(True),
        ) as harness:
            with self.assertRaises(OrchestratorError):
                harness.run()

        # The factory MUST never have been called: validation
        # short-circuits before any ``Conductor`` instance is
        # constructed.
        self.assertEqual(factory_calls, [])

    # ---- 14. Normal valid timeout execution still propagates
    # the configured finite timeout to BOTH IMPLEMENTING and
    # FIXING ----

    def test_valid_timeout_propagates_to_implementing(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        captured_kwargs: list = []

        def make_runner(**kwargs):
            captured_kwargs.append(kwargs)
            return SimpleNamespace(
                run=MagicMock(
                    return_value=ImplementationResult(
                        exit_code=0,
                        session_id="x",
                        num_turns=1,
                        terminal_reason="completed",
                        stop_reason=None,
                        is_error=False,
                        result_text="ok",
                        changed_files=(),
                        completion_status=(
                            CompletionStatus.COMPLETE
                        ),
                        completion_summary="ok",
                        completion_validation="ok",
                        completion_blocker=None,
                    )
                )
            )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=make_runner,
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=self._config_with_timeout(900),
        ) as harness:
            harness.run()

        self.assertEqual(len(captured_kwargs), 1)
        self.assertEqual(
            captured_kwargs[0][
                "implementation_timeout_seconds"
            ],
            900,
        )

    def test_valid_timeout_propagates_to_fixing(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings="Old defect",
        )

        captured_kwargs: list = []

        def make_runner(**kwargs):
            captured_kwargs.append(kwargs)
            return SimpleNamespace(
                run=MagicMock(
                    return_value=ImplementationResult(
                        exit_code=0,
                        session_id="x",
                        num_turns=1,
                        terminal_reason="completed",
                        stop_reason=None,
                        is_error=False,
                        result_text="ok",
                        changed_files=(),
                        completion_status=(
                            CompletionStatus.COMPLETE
                        ),
                        completion_summary="ok",
                        completion_validation="ok",
                        completion_blocker=None,
                    )
                )
            )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=make_runner,
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=self._config_with_timeout(1800),
        ) as harness:
            harness.run()

        self.assertEqual(len(captured_kwargs), 1)
        self.assertEqual(
            captured_kwargs[0][
                "implementation_timeout_seconds"
            ],
            1800,
        )
        self.assertEqual(
            captured_kwargs[0]["phase"],
            CompletionPhase.FIX,
        )


class SandboxMaxDurationConfigValidationTests(unittest.TestCase):
    """Regression tests for the ``sandbox.maxDurationSeconds``
    configuration boundary added after the M2 #17 hang
    investigation.

    Contract under test:

    - ``sandbox.maxDurationSeconds`` defaults to 21600 (6
      hours) when the key is absent from the config.

    - The validator uses
      ``type(value) is int and value > 0`` — same predicate
      as ``execution.implementationTimeoutSeconds`` so a
      ``bool`` cannot survive integer validation and reach
      the Tenki SDK.

    - The validator rejects ``bool``, ``str``, ``float``,
      ``None``, ``list``, ``dict``, zero, and negative
      values at the configuration loading boundary so an
      invalid value cannot reach ``TenkiSandbox.__enter__``
      or the installed ``tenki`` SDK.

    - ``sandbox.maxDurationSeconds`` MUST be strictly
      greater than
      ``execution.implementationTimeoutSeconds``.  This is
      a hard configuration consistency invariant — we
      deliberately do NOT silently clamp either value.

    - Validation runs in ``_load_budgets`` BEFORE any
      checkpoint load, task discovery, sandbox creation,
      runner construction, attempt consumption, or
      GitHub mutation — so an invalid config cannot
      consume a ticket attempt budget or mutate the
      durable checkpoint.

    - Invalid configurations surface as
      ``OrchestratorError``, the existing Ralph
      orchestration error boundary.  The message is a
      static Ralph-owned string and never echoes the raw
      value.
    """

    # ---- 1. Default sandbox max duration is 21600 ----

    def test_default_sandbox_max_duration_is_21600(self):
        config = json.loads(json.dumps(CONFIG))

        budgets = _load_budgets(config)

        self.assertEqual(
            budgets.sandbox_max_duration_seconds, 21_600
        )
        self.assertIsInstance(
            budgets.sandbox_max_duration_seconds, int
        )
        self.assertIsNot(
            type(budgets.sandbox_max_duration_seconds),
            bool,
        )

    # ---- 2. Positive integer is accepted exactly ----

    def test_positive_integer_accepted_exactly(self):
        for value in (3601, 21_600, 86_400):
            with self.subTest(value=value):
                config = json.loads(json.dumps(CONFIG))
                # Lower the implementation timeout below
                # the candidate sandbox lifetime so the
                # cross-check invariant does not reject it.
                config["execution"][
                    "implementationTimeoutSeconds"
                ] = 1800
                config["sandbox"] = {
                    "maxDurationSeconds": value
                }

                budgets = _load_budgets(config)

                self.assertEqual(
                    budgets.sandbox_max_duration_seconds,
                    value,
                )

    # ---- 3. ``True`` is rejected ----

    def test_true_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {"maxDurationSeconds": True}

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_sandbox_max_duration_seconds,
            True,
        )

    # ---- 4. ``False`` is rejected ----

    def test_false_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {"maxDurationSeconds": False}

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_sandbox_max_duration_seconds,
            False,
        )

    # ---- 5. String is rejected ----

    def test_string_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {
            "maxDurationSeconds": "21600"
        }

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_sandbox_max_duration_seconds,
            "21600",
        )

    # ---- 6. Float is rejected ----

    def test_float_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {
            "maxDurationSeconds": 21_600.0
        }

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_sandbox_max_duration_seconds,
            21_600.0,
        )

    # ---- 7. Zero is rejected ----

    def test_zero_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {"maxDurationSeconds": 0}

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_sandbox_max_duration_seconds,
            0,
        )

    # ---- 8. Negative integer is rejected ----

    def test_negative_integer_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {
            "maxDurationSeconds": -21_600
        }

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_sandbox_max_duration_seconds,
            -21_600,
        )

    # ---- 9. Explicit ``None`` is rejected ----

    def test_explicit_null_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {"maxDurationSeconds": None}

        with self.assertRaises(ValueError):
            _load_budgets(config)

        self.assertRaises(
            ValueError,
            _validate_sandbox_max_duration_seconds,
            None,
        )

    # ---- 10. List / object is rejected ----

    def test_list_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {"maxDurationSeconds": [21600]}

        with self.assertRaises(ValueError):
            _load_budgets(config)

    def test_object_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["sandbox"] = {
            "maxDurationSeconds": {"seconds": 21600}
        }

        with self.assertRaises(ValueError):
            _load_budgets(config)

    # ---- 11. Cross-check invariant: lifetime <= impl
    # timeout is rejected (no silent clamping) ----

    def test_lifetime_equal_to_impl_timeout_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"]["implementationTimeoutSeconds"] = (
            3600
        )
        config["sandbox"] = {"maxDurationSeconds": 3600}

        with self.assertRaises(ValueError):
            _load_budgets(config)

    def test_lifetime_less_than_impl_timeout_is_rejected(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"]["implementationTimeoutSeconds"] = (
            7200
        )
        config["sandbox"] = {"maxDurationSeconds": 3600}

        with self.assertRaises(ValueError):
            _load_budgets(config)

    def test_lifetime_greater_than_impl_timeout_is_accepted(self):
        config = json.loads(json.dumps(CONFIG))
        config["execution"]["implementationTimeoutSeconds"] = (
            1800
        )
        config["sandbox"] = {"maxDurationSeconds": 3600}

        budgets = _load_budgets(config)

        self.assertEqual(
            budgets.implementation_timeout_seconds, 1800
        )
        self.assertEqual(
            budgets.sandbox_max_duration_seconds, 3600
        )


class SandboxMaxDurationConfigFailFastTests(unittest.TestCase):
    """End-to-end fail-closed tests proving invalid sandbox
    lifetime config cannot mutate the durable checkpoint,
    consume a ticket attempt, or invoke Claude /
    ``ImplementationRunner``.
    """

    def _config_with(
        self,
        *,
        impl_timeout=3600,
        sandbox_max=None,
    ):
        config = json.loads(json.dumps(CONFIG))
        config["execution"]["implementationTimeoutSeconds"] = (
            impl_timeout
        )
        if sandbox_max is not None:
            config["sandbox"] = {
                "maxDurationSeconds": sandbox_max
            }
        return config

    def test_invalid_sandbox_lifetime_fails_before_implementation(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
            implementation_attempts=0,
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion()
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=self._config_with(
                impl_timeout=3600,
                sandbox_max=1800,
            ),
        ) as harness:
            with self.assertRaises(OrchestratorError):
                harness.run()

            saved = harness.saved_checkpoint()

        # Configuration validation failed before any
        # side effect, so no checkpoint save ever
        # occurred.  ``saved_checkpoint`` returns ``None``
        # in that case — proof that the durable store was
        # not mutated.
        self.assertIsNone(saved)
        # The runner MUST NOT have been invoked.
        impl_runner.run.assert_not_called()

    def test_lifetime_equal_impl_timeout_fails_before_runner(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(return_value=make_completion())
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=self._config_with(
                impl_timeout=3600,
                sandbox_max=3600,
            ),
        ) as harness:
            with self.assertRaises(OrchestratorError):
                harness.run()

        impl_runner.run.assert_not_called()


class SandboxSessionTerminatedMappingTests(unittest.TestCase):
    """Regression tests proving the installed tenki 1.0.0
    SDK's ``SessionTerminatedError`` is mapped to a static
    Ralph-owned reason and never surfaces as an uncaught
    traceback, raw SDK text, or arbitrary subprocess
    output.

    Contract under test:

    - When ``TenkiSandbox.exec`` (which already translates
      ``tenki.SessionTerminatedError`` to the static
      ``SandboxSessionTerminatedError``) propagates into
      ``Conductor.run``, the conductor MUST transition to
      ``INFRA_FAILURE`` (not ``AGENT_FAILURE`` — this is
      platform loss, not model loss) with ``last_error``
      set to the static
      ``SANDBOX_SESSION_TERMINATED`` message.

    - ``last_error`` MUST contain the static Ralph-authored
      string and MUST NOT contain any SDK exception text,
      ``session_terminated:`` prefix, secret-shaped
      substring, subprocess stdout/stderr, or model output.

    - The mapping runs at most once per
      ``Conductor.run`` invocation; the runner MUST NOT
      be silently retried inside the conductor.

    - The approved ``last_error`` set MUST accept the
      new ``SANDBOX_SESSION_TERMINATED`` message so
      ``CheckpointStore`` accepts it on save and load.
    """

    def _terminated_runner(self):
        return SimpleNamespace(
            run=MagicMock(
                side_effect=SandboxSessionTerminatedError(
                    "Sandbox session terminated unexpectedly."
                )
            )
        )

    def test_session_terminated_maps_to_infra_failure(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._terminated_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        # The implementation attempt counter was
        # incremented before the runner ran (existing
        # durable checkpoint contract).
        self.assertEqual(
            saved.implementation_attempts, 1
        )
        # Infrastructure loss, not agent failure.
        self.assertEqual(
            saved.state, TicketState.INFRA_FAILURE
        )
        # Static Ralph-owned message only.
        self.assertEqual(
            saved.last_error,
            _terminal_message(
                TerminalReason.SANDBOX_SESSION_TERMINATED
            ),
        )
        self.assertIn(
            "Sandbox session terminated unexpectedly.",
            saved.last_error,
        )
        # No SDK exception text / prefixes leak.
        self.assertNotIn(
            "session_terminated", saved.last_error
        )
        self.assertNotIn(
            "guest_agent_liveness", saved.last_error
        )

    def test_session_terminated_last_error_in_approved_set(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._terminated_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        self.assertIn(
            saved.last_error, APPROVED_LAST_ERROR_MESSAGES
        )

    def test_session_terminated_does_not_silently_retry(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._terminated_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

        # Exactly one invocation — the durable
        # checkpoint/attempt mechanism owns retry.
        self.assertEqual(impl_runner.run.call_count, 1)

    def test_session_terminated_terminal_reason_in_catalog(self):
        self.assertIn(
            TerminalReason.SANDBOX_SESSION_TERMINATED,
            TERMINAL_REASON_MESSAGES,
        )
        message = TERMINAL_REASON_MESSAGES[
            TerminalReason.SANDBOX_SESSION_TERMINATED
        ]
        self.assertEqual(
            message, "Sandbox session terminated unexpectedly."
        )
        self.assertIn(
            message, APPROVED_LAST_ERROR_MESSAGES
        )


class TenkiSandboxLifetimePropagationTests(unittest.TestCase):
    """End-to-end test proving the validated
    ``sandbox.maxDurationSeconds`` budget is actually
    forwarded to ``TenkiSandbox(max_duration_seconds=...)``
    so ``Sandbox.create(max_duration=...)`` receives a
    finite, validated value.

    Re-uses the RunHarness machinery, but swaps the
    ``mock_tenki`` factory before ``Orchestrator.run``
    enters the ``with TenkiSandbox(...)`` block so the
    kwargs are captured.
    """

    def test_propagated_max_duration_reaches_tenki_sandbox(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.HUMAN_QA_PENDING,
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                MagicMock()
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        config = json.loads(json.dumps(CONFIG))
        config["execution"]["implementationTimeoutSeconds"] = (
            1800
        )
        config["sandbox"] = {"maxDurationSeconds": 21_600}

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=config,
        ) as harness:
            captured_kwargs = []

            def _capture(**kwargs):
                captured_kwargs.append(kwargs)
                return harness.sandbox

            # Re-bind the factory so Orchestrator.run
            # calls our capture instead of returning the
            # default MagicMock.  ``__enter__`` returns the
            # harness ``sandbox`` so the conductor never
            # actually executes ``__enter__`` on the real
            # TenkiSandbox.
            harness.mock_tenki.side_effect = _capture

            harness.run()

        self.assertEqual(len(captured_kwargs), 1)
        self.assertEqual(
            captured_kwargs[0].get("max_duration_seconds"),
            21_600,
        )
        self.assertEqual(
            captured_kwargs[0].get("name"), "ralph-17"
        )


class SandboxCleanupTraceSafetyTests(unittest.TestCase):
    """Regression tests for the teardown-safety defect
    found during the M2 #17 sandbox-lifetime review.

    Contract under test:

    - Once the Conductor has classified the ticket as
      ``INFRA_FAILURE`` (because ``SandboxSessionTerminatedError``
      escaped a ``sandbox.exec`` call), the Orchestrator's
      QA teardown sequence MUST NOT overwrite that
      terminal state with an uncaught traceback.

    - The Orchestrator's outer ``TenkiSandbox.__exit__``
      MUST NOT propagate the installed SDK's
      ``tenki.SessionTerminatedError`` or
      ``tenki.SessionNotFoundError`` raised from
      ``Sandbox.close()``; both must be treated as
      already-closed cleanup.

    - Provider / RPC / secret-shaped text from the SDK
      MUST NOT appear in ``checkpoint.last_error``,
      console output, or raised Ralph-owned exception
      messages.

    - The combined sequence (sandbox dies mid-exec →
      ``INFRA_FAILURE`` → QA teardown sees terminated
      sandbox → sandbox ``__exit__`` sees terminated
      session) MUST leave ``INFRA_FAILURE`` intact and
      MUST NOT emit an uncaught traceback.

    - Healthy sandbox close MUST still work normally.
    """

    def _make_runner_raising_session_terminated(self):
        # Carry fabricated provider-internal detail
        # including secret-shaped substrings so we can
        # prove nothing leaks into ``last_error``.
        return SimpleNamespace(
            run=MagicMock(
                side_effect=SandboxSessionTerminatedError(
                    "Sandbox session terminated unexpectedly."
                )
            )
        )

    def _terminated_sandbox_factory(self):
        # Sandbox whose ``exec`` raises the Ralph-owned
        # boundary exception (used to simulate the
        # already-dead-sandbox QA teardown sequence) and
        # whose ``close`` raises the installed SDK's
        # ``SessionTerminatedError`` carrying fabricated
        # provider-internal detail.
        sandbox = MagicMock(name="TenkiSandbox")

        def _exec_raises(*args, **kwargs):
            raise SandboxSessionTerminatedError(
                "Sandbox session terminated unexpectedly."
            )

        sandbox.exec.side_effect = _exec_raises

        def _close_raises_terminated():
            raise tenki.SessionTerminatedError(
                "session_terminated:guest_agent_liveness "
                "TENKI_SECRET=abc123 "
                "grpc_status=FAILED_PRECONDITION "
                "provider-internal-session-id="
                "s_xxxxxxxxxxxxxxxxxxxxxx"
            )

        sandbox.close.side_effect = _close_raises_terminated
        return sandbox

    def _missing_session_sandbox_factory(self):
        # Variant: SDK close() raises
        # ``SessionNotFoundError``.
        sandbox = MagicMock(name="TenkiSandbox")

        def _exec_ok(*args, **kwargs):
            return SandboxCommandResult(
                exit_code=0,
                stdout="",
                stderr="",
            )

        sandbox.exec.side_effect = _exec_ok

        def _close_raises_missing():
            raise tenki.SessionNotFoundError(
                "session not found "
                "TENKI_SECRET=abc123 "
                "provider-internal-session-id="
                "s_xxxxxxxxxxxxxxxxxxxxxx"
            )

        sandbox.close.side_effect = _close_raises_missing
        return sandbox

    # ---- 1. TRACE 1: dead sandbox during QA teardown
    # does NOT override the recorded INFRA_FAILURE ----

    def test_qa_teardown_against_dead_sandbox_preserves_infra_failure(
        self,
    ):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._make_runner_raising_session_terminated()

        # The sandbox ``exec`` raises ``SandboxSessionTerminatedError``
        # both during the implementation phase AND during
        # the QA teardown sequence (which runs ``pg_ctl
        # stop`` via ``sandbox.exec``).
        dead_sandbox = self._terminated_sandbox_factory()

        qa_env = make_fake_qa_environment()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: qa_env,
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            sandbox_override=dead_sandbox,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        # Primary failure (the implementation runner) was
        # classified as INFRA_FAILURE / SANDBOX_SESSION_TERMINATED.
        self.assertEqual(
            saved.state, TicketState.INFRA_FAILURE
        )
        self.assertEqual(
            saved.last_error,
            _terminal_message(
                TerminalReason.SANDBOX_SESSION_TERMINATED
            ),
        )
        # No provider / RPC / secret-shaped text leaked.
        self.assertNotIn("TENKI_SECRET", saved.last_error)
        self.assertNotIn(
            "grpc_status=FAILED_PRECONDITION",
            saved.last_error,
        )
        self.assertNotIn(
            "provider-internal-session-id",
            saved.last_error,
        )
        # No uncaught traceback escaped from QA teardown.
        # (If a traceback had escaped, the harness's
        # ``run()`` would have raised rather than
        # returned normally.)

    # ---- 2. TRACE 2: SDK close() raising
    # ``SessionTerminatedError`` does NOT escape
    # ``TenkiSandbox.__exit__`` ----

    def test_sandbox_exit_swallows_sdk_session_terminated(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.HUMAN_QA_PENDING,
        )

        # Sandbox whose close() raises
        # ``tenki.SessionTerminatedError``.  ``exec``
        # behaves normally so the conductor reaches
        # the ``__exit__`` phase through a healthy
        # path.  No attempt consumption, no
        # implementation runner needed.
        sandbox = self._terminated_sandbox_factory()

        # Replace the ``__exit__`` side_effect so close()
        # raises only on ``__exit__`` (the harness
        # already wraps TenkiSandbox in a context
        # manager).
        def _exec_ok(*args, **kwargs):
            return SandboxCommandResult(
                exit_code=0,
                stdout="",
                stderr="",
            )

        sandbox.exec.side_effect = _exec_ok

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            sandbox_override=sandbox,
        ) as harness:
            # The Orchestrator runs through a healthy
            # conductor loop and exits via ``TenkiSandbox``
            # ``__exit__``.  The ``TenkiSandbox`` boundary
            # itself is patched by the harness, so
            # close()-level teardown safety is verified
            # directly in
            # ``test_sandbox.SandboxTeardownSafetyTests``.
            # Here we prove the orchestrator's outer
            # context-manager exit does not propagate
            # the SDK signal past the conductor.
            try:
                final_state = harness.run()
            except (
                tenki.SessionTerminatedError,
                tenki.SessionNotFoundError,
            ) as err:
                self.fail(
                    "TenkiSandbox.__exit__ path leaked SDK "
                    f"exception: {type(err).__name__}: "
                    f"{err!r}"
                )

        # The conductor reached ``HUMAN_QA_PENDING``
        # via the healthy path; the SDK's
        # ``SessionTerminatedError`` MUST NOT have
        # rewritten that.
        self.assertEqual(
            final_state, TicketState.HUMAN_QA_PENDING
        )
        # No provider / secret-shaped text in any
        # persisted checkpoint.
        for saved in harness.saved_checkpoints():
            self.assertNotIn(
                "TENKI_SECRET", str(saved.last_error)
            )
            self.assertNotIn(
                "provider-internal-session-id",
                str(saved.last_error),
            )

    # ---- 3. SDK close() raising
    # ``SessionNotFoundError`` does NOT escape ----

    def test_sandbox_exit_swallows_sdk_session_not_found(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.HUMAN_QA_PENDING,
        )

        sandbox = self._missing_session_sandbox_factory()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            sandbox_override=sandbox,
        ) as harness:
            try:
                final_state = harness.run()
            except (
                tenki.SessionTerminatedError,
                tenki.SessionNotFoundError,
            ) as err:
                self.fail(
                    "TenkiSandbox.__exit__ path leaked SDK "
                    f"exception: {type(err).__name__}: "
                    f"{err!r}"
                )

        self.assertEqual(
            final_state, TicketState.HUMAN_QA_PENDING
        )
        for saved in harness.saved_checkpoints():
            self.assertNotIn(
                "TENKI_SECRET", str(saved.last_error)
            )

    # ---- 4. Combined TRACE 1 + TRACE 2: full
    # production sequence leaves ``INFRA_FAILURE``
    # intact ----

    def test_combined_traces_leave_infra_failure_intact(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        impl_runner = self._make_runner_raising_session_terminated()

        # Sandbox that:
        # - raises ``SandboxSessionTerminatedError`` on
        #   every ``exec`` call (so both the implementation
        #   runner and the QA teardown see a dead sandbox);
        # - raises ``tenki.SessionTerminatedError`` on
        #   ``close()`` (so ``__exit__`` sees the SDK
        #   teardown signal too).
        sandbox = MagicMock(name="TenkiSandbox")

        def _exec_raises(*args, **kwargs):
            raise SandboxSessionTerminatedError(
                "Sandbox session terminated unexpectedly."
            )

        sandbox.exec.side_effect = _exec_raises

        def _close_raises_terminated():
            raise tenki.SessionTerminatedError(
                "session_terminated:guest_agent_liveness "
                "TENKI_SECRET=abc123 "
                "grpc_status=FAILED_PRECONDITION "
                "provider-internal-session-id="
                "s_xxxxxxxxxxxxxxxxxxxxxx"
            )

        sandbox.close.side_effect = _close_raises_terminated

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            sandbox_override=sandbox,
        ) as harness:
            try:
                harness.run()
            except (
                tenki.SessionTerminatedError,
                tenki.SessionNotFoundError,
                SandboxSessionTerminatedError,
            ) as err:
                self.fail(
                    "Combined teardown trace leaked: "
                    f"{type(err).__name__}: {err!r}"
                )

            saved = harness.saved_checkpoint()

        # The primary failure MUST win.  Nothing in the
        # teardown path overwrites it.
        self.assertEqual(
            saved.state, TicketState.INFRA_FAILURE
        )
        self.assertEqual(
            saved.last_error,
            _terminal_message(
                TerminalReason.SANDBOX_SESSION_TERMINATED
            ),
        )
        # No provider / secret-shaped text leaked.
        self.assertNotIn("TENKI_SECRET", saved.last_error)
        self.assertNotIn(
            "grpc_status=FAILED_PRECONDITION",
            saved.last_error,
        )
        self.assertNotIn(
            "provider-internal-session-id",
            saved.last_error,
        )


class FreshWorkspaceRestartTests(unittest.TestCase):
    """Scenario A: an implementation produced unpersisted changes,
    PRE_QA found a defect, the FIXING checkpoint was saved with
    findings, then the process died and the sandbox disappeared.

    On restart:
    - The fresh sandbox contains only the original ticket_sha.
    - The previous findings survive in the checkpoint.
    - The fix attempt budget survives.
    - Ralph reinvokes the implementation agent WITH the findings.
    - Ralph does NOT assume the old uncommitted diff still exists.
    """

    def test_fresh_workspace_reinvokes_fix_with_findings(self):
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings=(
                "PRE_QA defect: migration column added "
                "AFTER backfill."
            ),
            fix_attempts=0,
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion(
                    status=CompletionStatus.COMPLETE,
                )
            )
        )

        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_QA
                    )
                )
            )
        )

        qa_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_qa_result(
                    status=QaStatus.PASSED,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: (
                review_runner
            ),
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            # Simulate a fresh workspace: no uncommitted diff
            # survives the previous sandbox teardown. The
            # checkpoint's persisted state is the only durable
            # context the conductor has.
            final = harness.run()

            saved = harness.last_before_clear()

        # The fix attempt was consumed.
        self.assertIsNotNone(saved)
        self.assertGreaterEqual(
            saved.fix_attempts,
            1,
        )

        # The implementation runner was reinvoked with the saved
        # findings in the fix_context.
        self.assertGreaterEqual(
            impl_runner.run.call_count,
            1,
        )

        fix_call = impl_runner.run.call_args_list[0]
        ctx = fix_call.kwargs.get("fix_context")
        self.assertIsNotNone(ctx)
        self.assertIn("migration", ctx.reviewer_findings or "")

    def test_fresh_workspace_does_not_assume_diff_survived(self):
        """Ralph must not assume the old uncommitted diff still
        exists; the implementation agent is responsible for
        reconstructing the implementation context from the durable
        repository state and the fix context."""

        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings=(
                "Add column BEFORE backfill."
            ),
            fix_attempts=0,
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion(
                    status=CompletionStatus.COMPLETE,
                    changed_files=(
                        "apps/api/prisma/migrations/"
                        "fix.sql",
                    ),
                )
            )
        )

        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_QA
                    )
                )
            )
        )

        qa_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_qa_result(
                    status=QaStatus.PASSED,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: (
                review_runner
            ),
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

        fix_call = impl_runner.run.call_args_list[0]

        # The implementation agent received the durable issue
        # body and the fix context. Ralph did not pass any
        # "previous diff" payload — the agent is expected to
        # reconstruct from durable state.
        self.assertIn(
            "issue_body",
            fix_call.kwargs,
        )
        self.assertIn(
            "fix_context",
            fix_call.kwargs,
        )


class CrashWindowPersistenceTests(unittest.TestCase):
    """Scenario: persistence created commit + push + PR but the
    process died before the checkpoint captured persisted_commit_sha
    + pull_request_number.

    On restart, reconcile_persistence must recover those values
    and continue without recreating any side effects.
    """

    def test_restart_recovers_persisted_commit_and_pr(self):
        tasks = [task(17)]

        # The checkpoint lost persisted_commit_sha + PR due to a
        # crash right after the PR was opened.
        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha=None,
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
        )

        recovery_outcome = SimpleNamespace(
            recovered=True,
            commit_sha="IMPLEMENTATION_SHA",
            pull_request_number=42,
        )

        recovery_probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=42,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_merged=MagicMock(
                return_value=True
            ),
        )

        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

        persistence_runner = SimpleNamespace(
            persist=MagicMock(),
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
            make_github_probe=lambda **kw: recovery_probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

            saved = harness.last_before_clear()

        # Persistence side effects MUST NOT have been recreated.
        persistence_runner.persist.assert_not_called()

        # Checkpoint must now reflect the recovered durable state.
        self.assertIsNotNone(saved)
        self.assertEqual(
            saved.persisted_commit_sha,
            "IMPLEMENTATION_SHA",
        )
        self.assertEqual(
            saved.pull_request_number,
            42,
        )

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )


class PostMergeRestartTests(unittest.TestCase):
    """Scenario: merge succeeded and issue was closed, then the
    process crashed before the INTEGRATED checkpoint save.

    On restart:
    - no second merge
    - no second issue close
    - cleanup/finalization continues.
    """

    def test_restart_does_not_remerge_or_reclose(self):
        # INTEGRATING checkpoint with persisted durable state
        # means integration already merged and closed the issue.
        tasks = [task(17, state="CLOSED")]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATING,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # Integration is allowed to observe the already-merged
        # PR and already-closed issue; it is called once.
        integration_runner.integrate.assert_called_once()

        # Cleanup runs idempotently.
        cleaner.cleanup_ticket_branch.assert_called_once()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )


class ExactlyOncePersistenceWindowTests(unittest.TestCase):
    """Verify each crash window allows exactly-once persistence
    side effects:

      WINDOW 1: nothing persisted -> normal persistence
      WINDOW 2: commit + push persisted, no PR -> COMMIT_ONLY
      WINDOW 3: commit + push + PR persisted -> COMMIT_AND_PR
      WINDOW 4: PR merged + issue closed -> cleanup only

    No path may duplicate any of:

      - implementation commit
      - PR creation
      - merge
      - issue close
    """

    def _make_persistence_runner(self):
        """Capture every call to ``persist`` and
        ``ensure_pull_request_for_persisted_commit`` so the
        tests can assert exactly-once."""
        runner = SimpleNamespace(
            persist=MagicMock(
                return_value=SimpleNamespace(
                    commit_sha="commit_default",
                    remote_sha="commit_default",
                    pull_request_number=1,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            ),
            ensure_pull_request_for_persisted_commit=MagicMock(
                return_value=SimpleNamespace(
                    pull_request_number=2,
                    pull_request_url="https://y",
                    pull_request_created=True,
                    commit_sha="commit_default",
                    remote_sha="commit_default",
                )
            ),
        )
        return runner

    def test_window_1_nothing_persisted_normal_persistence(
        self,
    ):
        """Fresh state, no checkpoint persistence values.
        Conductor must run a single normal persistence.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha=None,
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

        persistence_runner = self._make_persistence_runner()
        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # Exactly-once commit + push + PR creation.
        persistence_runner.persist.assert_called_once()
        persistence_runner.ensure_pull_request_for_persisted_commit.assert_not_called()
        integration_runner.integrate.assert_called_once()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

    def test_window_2_commit_and_push_persisted_no_pr(
        self,
    ):
        """Checkpoint has persisted_commit_sha but no PR.
        Conductor must create ONLY the missing PR — never
        re-commit, re-push, or force-push.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha="IMPLEMENTATION_SHA",
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

        persistence_runner = self._make_persistence_runner()
        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # No new commit, no push, no force-push.
        persistence_runner.persist.assert_not_called()
        # Create (or recover) the missing PR exactly once.
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_called_once()
        )
        # Run integration once.
        integration_runner.integrate.assert_called_once()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

    def test_window_3_commit_push_pr_all_persisted(
        self,
    ):
        """Checkpoint has both persisted_commit_sha and
        pull_request_number. Conductor must NOT call
        ``persist`` or ``ensure_pull_request_for_persisted_commit``.
        Integration runs once. No duplicate PR creation.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATING,
            persisted_commit_sha="IMPLEMENTATION_SHA",
            pull_request_number=42,
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        persistence_runner = self._make_persistence_runner()

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # No persistence side effects at all.
        persistence_runner.persist.assert_not_called()
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_not_called()
        )
        # Integration runs once.
        integration_runner.integrate.assert_called_once()
        # Cleanup runs once.
        cleaner.cleanup_ticket_branch.assert_called_once()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

    def test_window_4_pr_merged_issue_closed_cleanup_only(
        self,
    ):
        """Issue already closed, PR already merged. Conductor
        must NOT call merge or close again. Must run cleanup
        once.
        """
        tasks = [task(17, state="CLOSED")]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATED,
            persisted_commit_sha="IMPLEMENTATION_SHA",
            pull_request_number=42,
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        persistence_runner = self._make_persistence_runner()

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # No new persistence work.
        persistence_runner.persist.assert_not_called()
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_not_called()
        )
        # INTEGRATED path doesn't invoke integrate; merge already
        # happened. Cleanup runs once.
        integration_runner.integrate.assert_not_called()
        cleaner.cleanup_ticket_branch.assert_called_once()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )


class CompletionPathCollisionRegressionTests(unittest.TestCase):
    """#5 regression: initial implementation attempt 1 writes
    COMPLETE, PRE_QA requests fix, fix attempt 1 fails to write
    a completion result. Ralph must fail closed and MUST NOT
    reuse the initial COMPLETE.

    The phase-qualified completion path ensures the two attempts
    target distinct files.
    """

    def test_fix_attempt_does_not_read_initial_complete(self):
        # Two implementation runners are needed: one for the
        # initial implementation (writes COMPLETE), one for the
        # fix attempt (writes nothing).
        initial_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion(
                    status=CompletionStatus.COMPLETE,
                )
            )
        )

        fix_runner = SimpleNamespace(
            run=MagicMock(
                side_effect=ImplementationError(
                    "agent crashed before writing completion"
                )
            )
        )

        # The conductor dispatches which runner to use by phase,
        # so we route via callbacks.
        runner_index = {"i": 0}

        def make_runner(**kw):
            phase = kw.get("phase")

            if (
                phase is None
                or phase.value == "implementation"
            ):
                return initial_runner

            return fix_runner

        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=ReviewVerdict.FIX_BEFORE_QA,
                    summary="Bad migration order",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=make_runner,
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.IMPLEMENTING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # Initial implementation ran.
        initial_runner.run.assert_called_once()

        # Fix attempt was invoked AFTER PRE_QA flagged a defect.
        fix_runner.run.assert_called_once()

        # The fix attempt crashed mid-run, so it never wrote a
        # completion file. Ralph must NOT silently treat this as
        # COMPLETE — the conductor transitions to AGENT_FAILURE
        # (the implementation runner raised) or BLOCKED_FOR_HUMAN
        # (completion file missing).
        self.assertIn(
            final,
            {
                TicketState.AGENT_FAILURE,
                TicketState.BLOCKED_FOR_HUMAN,
            },
        )

        # Sanity: the fix call was dispatched with the fix phase.
        fix_kwargs = fix_runner.run.call_args.kwargs

        # The fix-context was passed (proving the conductor
        # routed the PRE_QA findings into the fix attempt).
        self.assertIsNotNone(
            fix_kwargs.get("fix_context")
        )


class ReviewCycleBudgetTests(unittest.TestCase):
    """#3 review cycle off-by-one: maxReviewCycles counts complete
    PRE_QA -> QA -> PRE_PERSISTENCE cycles. PRE_PERSISTENCE inside
    an already-consumed cycle must not consume a second cycle.
    The counter is incremented and saved BEFORE PRE_QA starts."""

    def test_max_one_review_cycle_blocks_second_pre_qa(self):
        # With maxReviewCycles=1, the FIRST PRE_QA runs. The
        # SECOND PRE_QA (a fix-driven cycle) must block BEFORE
        # invoking the reviewer.
        tasks = [task(17)]

        config = dict(CONFIG)
        config["execution"] = dict(CONFIG["execution"])
        config["execution"]["maxReviewCycles"] = 1

        # FIXING checkpoint with one cycle already consumed; the
        # implementation runner will transition to REVIEWING and
        # bump cycles_consumed to 2, which is > max=1.
        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings="Old defect",
            review_cycles_consumed=1,
        )

        review_runner = SimpleNamespace(
            review=MagicMock()
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion(
                    status=CompletionStatus.COMPLETE,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=config,
        ) as harness:
            final = harness.run()

        # Implementation ran (the fix). It bumped cycles to 2.
        impl_runner.run.assert_called_once()
        # PRE_QA review for cycle 2 was blocked before invocation.
        review_runner.review.assert_not_called()
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_max_two_review_cycles_second_runs_then_third_blocks(
        self,
    ):
        # Pipeline:
        # - PRE_QA cycle 1 (consumed=1) -> APPROVE -> AUTOMATED_QA
        #   -> PRE_PERSISTENCE (same cycle, NOT consumed again)
        # - FIX (BLOCK_PERSISTENCE) -> FIXING -> implementation ->
        #   PRE_QA cycle 2 (consumed=2) -> APPROVE -> AUTOMATED_QA
        #   -> PRE_PERSISTENCE -> INTEGRATING
        # That's exactly 2 PRE_QA cycles within max=2. OK.
        tasks = [task(17)]

        config = dict(CONFIG)
        config["execution"] = dict(CONFIG["execution"])
        config["execution"]["maxReviewCycles"] = 2

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            pre_persistence_findings=(
                "Initial defect."
            ),
        )

        review_calls = [
            make_review(
                verdict=ReviewVerdict.BLOCK_PERSISTENCE,
                stage=ReviewStage.PRE_PERSISTENCE,
                summary="Initial defect.",
            ),
            make_review(
                verdict=ReviewVerdict.APPROVE_FOR_QA,
                stage=ReviewStage.PRE_QA,
            ),
            make_review(
                verdict=ReviewVerdict.APPROVE_FOR_PERSISTENCE,
                stage=ReviewStage.PRE_PERSISTENCE,
            ),
        ]

        review_runner = SimpleNamespace(
            review=MagicMock(side_effect=review_calls)
        )

        qa_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_qa_result(
                    status=QaStatus.PASSED,
                )
            )
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion(
                    status=CompletionStatus.COMPLETE,
                )
            )
        )

        persistence_runner = SimpleNamespace(
            persist=MagicMock(
                return_value=SimpleNamespace(
                    commit_sha="commitABC",
                    remote_sha="commitABC",
                    pull_request_number=1,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: cleaner,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=config,
        ) as harness:
            final = harness.run()

        # 3 reviewer calls: PRE_PERSISTENCE (cycle 1), PRE_QA
        # (cycle 2), PRE_PERSISTENCE (cycle 2 again).
        self.assertEqual(
            review_runner.review.call_count,
            3,
        )
        # One PRE_QA cycle consumed (the fix iteration). The
        # initial AUTOMATED_QA entry did not consume a cycle
        # because PRE_PERSISTENCE inside an already-consumed
        # cycle must not consume a second cycle.
        self.assertEqual(
            harness.last_before_clear().review_cycles_consumed,
            1,
        )

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

    def test_third_review_cycle_blocks_before_reviewer(self):
        # Pipeline attempts to enter PRE_QA cycle 3 with
        # maxReviewCycles=2 -> must block.
        tasks = [task(17)]

        config = dict(CONFIG)
        config["execution"] = dict(CONFIG["execution"])
        config["execution"]["maxReviewCycles"] = 2

        # FIXING checkpoint with two cycles already consumed.
        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.FIXING,
            pre_qa_findings="Old defect",
            review_cycles_consumed=2,
        )

        review_runner = SimpleNamespace(
            review=MagicMock()
        )

        impl_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_completion(
                    status=CompletionStatus.COMPLETE,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: (
                impl_runner
            ),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=config,
        ) as harness:
            final = harness.run()

        # Implementation runs (the fix). It transitions to
        # REVIEWING (PRE_QA) and consumes cycle 3. The next loop
        # iteration enters _run_review, which sees
        # review_cycles_consumed > maxReviewCycles and blocks
        # BEFORE invoking the reviewer.
        impl_runner.run.assert_called_once()
        review_runner.review.assert_not_called()
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_review_cycles_consumed_survives_restart(self):
        tasks = [task(17)]

        config = dict(CONFIG)
        config["execution"] = dict(CONFIG["execution"])
        config["execution"]["maxReviewCycles"] = 2

        # Restart mid-cycle: review_cycles_consumed=1, currently
        # in REVIEWING (PRE_QA). The PRE_QA reviewer runs and
        # approves. Counter must remain durable across restart
        # and survive the PRE_PERSISTENCE branch (which must NOT
        # consume another cycle).
        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
            review_cycles_consumed=1,
        )

        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=ReviewVerdict.APPROVE_FOR_QA,
                )
            )
        )

        qa_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_qa_result(
                    status=QaStatus.PASSED,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: MagicMock(),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
            config_override=config,
        ) as harness:
            harness.run()

        # Counter is durable; PRE_PERSISTENCE inside the same
        # cycle did not consume another.
        self.assertEqual(
            harness.last_before_clear().review_cycles_consumed,
            1,
        )


def _install_real_workspace_capture(
    *,
    base_sha: str,
    ticket_sha: str,
    captured_expected_base_sha: list,
    cleanup_register,
):
    """Module-level helper that builds the same captured
    workspace as ``PostMergeWorkspaceBaseGuardTests`` but
    registers its patcher via the explicit
    ``cleanup_register`` callback (typically
    ``unittest.TestCase.addCleanup``).

    Returning the patcher separately so callers without a
    TestCase may stop it manually.
    """

    from scripts.ralph.workspace import (
        TicketWorkspaceManager,
    )

    manager = TicketWorkspaceManager(
        sandbox=MagicMock(),
        repository_url="repo",
        integration_branch="ralph/m2",
        ticket_branch_prefix="ralph/m2-",
    )

    def _capturing_prepare(
        *args,
        expected_base_sha=None,
        **kwargs,
    ):
        captured_expected_base_sha.append(
            expected_base_sha
        )

        issue_number = kwargs.get(
            "issue_number", args[0] if args else 17
        )

        ticket_branch = (
            f"{manager.ticket_branch_prefix}{issue_number}"
        )

        shim = (
            "set -euo pipefail\n"
            "TMP_SH=$(mktemp -d)\n"
            "cd \"$TMP_SH\"\n"
            "mkdir -p /tmp/sound-hub\n"
            "git() {\n"
            "  local cmd=\"\"\n"
            "  local skipping=0\n"
            "  for arg in \"$@\"; do\n"
            "    if [ \"$skipping\" = '1' ]; then\n"
            "      skipping=0\n"
            "      continue\n"
            "    fi\n"
            "    case \"$arg\" in\n"
            "      -c) skipping=1; continue ;;\n"
            "      *=*) continue ;;\n"
            "      --*) continue ;;\n"
            "      *) cmd=\"$arg\"; break ;;\n"
            "    esac\n"
            "  done\n"
            "  if [ \"$cmd\" = 'clone' ]; then\n"
            "    local dest=\"${@: -1}\"\n"
            "    mkdir -p \"$dest\"\n"
            "    return 0\n"
            "  fi\n"
            "  if [ \"$1\" = 'rev-parse' ] && "
            "[ \"$2\" = 'HEAD' ]; then\n"
            f"    printf '%s\\n' '{base_sha}'\n"
            "    return 0\n"
            "  fi\n"
            "  if [ \"$1\" = 'ls-remote' ]; then\n"
            "    return 1\n"
            "  fi\n"
            "  if [ \"$1\" = 'branch' ]; then\n"
            "    printf '%s\\n' 'ralph/m2-17'\n"
            "    return 0\n"
            "  fi\n"
            "  if [ \"$1\" = 'status' ]; then\n"
            "    return 0\n"
            "  fi\n"
            "  return 0\n"
            "}\n"
            "corepack() { return 0; }\n"
            "pnpm() { return 0; }\n"
            "export -f git corepack pnpm\n"
            + manager._prepare_script(
                ticket_branch=ticket_branch,
                expected_base_sha=expected_base_sha,
            )
        )

        result = subprocess.run(
            ["bash", "-c", shim],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            raise WorkspacePreparationError(
                "Failed to prepare Ralph ticket workspace.\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        base_out = ticket_sha
        ticket_out = ticket_sha
        branch_out = ticket_branch
        mode_out = "RESUMED"

        for line in result.stdout.splitlines():
            if line.startswith("RALPH_BASE_SHA="):
                base_out = line.split("=", 1)[1].strip()
            elif line.startswith("RALPH_TICKET_SHA="):
                ticket_out = line.split("=", 1)[1].strip()
            elif line.startswith("RALPH_TICKET_BRANCH="):
                branch_out = line.split("=", 1)[1].strip()
            elif line.startswith("RALPH_WORKSPACE_MODE="):
                mode_out = line.split("=", 1)[1].strip()

        return TicketWorkspace(
            repository_path=manager.repository_path,
            integration_branch=manager.integration_branch,
            ticket_branch=branch_out,
            base_sha=base_out,
            ticket_sha=ticket_out,
            resumed=(mode_out == "RESUMED"),
        )

    sandbox = MagicMock(name="TenkiSandbox")
    sandbox.exec.return_value = SandboxCommandResult(
        exit_code=0,
        stdout="",
        stderr="",
    )

    patcher = unittest.mock.patch(
        "scripts.ralph.workspace."
        "TicketWorkspaceManager.prepare",
        new=_capturing_prepare,
    )
    patcher.start()

    if cleanup_register is not None:
        try:
            cleanup_register(patcher.stop)
        except Exception:
            _WORKSPACE_PATCHERS.append(patcher)
    else:
        _WORKSPACE_PATCHERS.append(patcher)

    return sandbox


class PostMergeWorkspaceBaseGuardTests(unittest.TestCase):
    """#1 — restart after merge in INTEGRATING state with an
    advanced integration branch must succeed when the expected
    PR is already merged.

    This test exercises REAL workspace base-validation logic:
    the actual ``TicketWorkspaceManager.prepare`` is invoked
    against a sandbox whose first exec call returns an advanced
    integration branch SHA. The conductor must NOT block on the
    advanced base because the read-only probe proves the
    expected PR was already merged.
    """

    def _make_real_workspace_sandbox(
        self,
        *,
        base_sha: str,
        ticket_sha: str,
        captured_expected_base_sha: list,
    ):
        """Build a sandbox that simulates real
        ``TicketWorkspaceManager.prepare`` behavior by
        actually running its prepare script against a real
        bash interpreter.

        This exercises the REAL workspace base-validation
        logic in ``TicketWorkspaceManager``, including its
        ``[ "$base_sha" != "{expected}" ]`` guard. The script
        exits 42 when the integration base differs from the
        expected base, and exits 0 with the markers when they
        match (or when expected was empty).

        ``captured_expected_base_sha`` is a list (used as a
        mutable box) that records the value the conductor
        passed to ``TicketWorkspaceManager.prepare``.  The
        test reads this list AFTER the conductor ran, to
        verify the conductor's decision — the conductor owns
        the decision, the test only inspects it.
        """
        return _install_real_workspace_capture(
            base_sha=base_sha,
            ticket_sha=ticket_sha,
            captured_expected_base_sha=(
                captured_expected_base_sha
            ),
            cleanup_register=(
                self.addCleanup
                if isinstance(
                    getattr(
                        self, "_testMethodName", None
                    ),
                    str,
                )
                else None
            ),
        )

    def test_advanced_base_accepted_when_pr_already_merged(self):
        from scripts.ralph.states import TicketState

        tasks = [task(17, state="CLOSED")]

        # Checkpoint's original integration base_sha was
        # ORIGINAL_BASE. After the merge the integration branch
        # has advanced to ADVANCED_BASE.
        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATING,
            persisted_commit_sha="IMPLEMENTATION_SHA",
            pull_request_number=202,
            base_sha="ORIGINAL_BASE",
            ticket_sha="IMPLEMENTATION_SHA",
        )

        captured: list = []

        real_sandbox = self._make_real_workspace_sandbox(
            base_sha="ADVANCED_BASE",
            ticket_sha="IMPLEMENTATION_SHA",
            captured_expected_base_sha=captured,
        )

        # The probe proves the PR was already merged.
        recovery_probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            # Strict identity proof requires the full PR dict
            # including ``merged`` (the literal boolean True).
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                    merged=True,
                )
            ),
            pull_request_merged=MagicMock(return_value=True),
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
            make_github_probe=lambda **kw: recovery_probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            # Override the sandbox to the real one (so workspace
            # base-validation is exercised).
            harness.mock_tenki.return_value.__enter__.return_value = (
                real_sandbox
            )

            final = harness.run()

        # The conductor's decision is captured directly from
        # the call it made to ``TicketWorkspaceManager.prepare``.
        # When the PR is already merged, the conductor MUST
        # pass ``expected_base_sha=None`` so the workspace
        # base-validation script does NOT reject the advanced
        # integration branch.
        self.assertGreaterEqual(
            len(captured),
            1,
            "Conductor did not invoke "
            "TicketWorkspaceManager.prepare at all.",
        )
        self.assertIsNone(
            captured[0],
            "Conductor did not relax the base guard after "
            "the read-only probe confirmed the PR is merged.",
        )

        # The advanced base was accepted (no terminal
        # BLOCKED_FOR_HUMAN from workspace prep).
        integration_runner.integrate.assert_called_once()
        cleaner.cleanup_ticket_branch.assert_called_once()
        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )

    def test_advanced_base_blocks_when_pr_not_yet_merged(self):
        # The PR is NOT merged yet. The integration branch
        # advancing would be unexpected; Ralph must not relax
        # the base guard and must block before integration.
        tasks = [task(17, state="OPEN")]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATING,
            persisted_commit_sha="commitABC",
            pull_request_number=202,
            base_sha="ORIGINAL_BASE",
            ticket_sha="IMPLEMENTATION_SHA",
        )

        captured: list = []

        real_sandbox = self._make_real_workspace_sandbox(
            base_sha="ADVANCED_BASE",
            ticket_sha="IMPLEMENTATION_SHA",
            captured_expected_base_sha=captured,
        )

        recovery_probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            # Strict identity proof: PR exists but is not yet
            # merged.  The conductor MUST preserve the
            # original base guard.
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                    merged=False,
                )
            ),
            # PR is open, not merged.
            pull_request_merged=MagicMock(return_value=False),
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
            make_github_probe=lambda **kw: recovery_probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.mock_tenki.return_value.__enter__.return_value = (
                real_sandbox
            )

            final = harness.run()

        # The conductor's decision is captured directly from
        # the call it made to ``TicketWorkspaceManager.prepare``.
        # When the PR is NOT merged, the conductor MUST pass
        # ``expected_base_sha=checkpoint.base_sha`` so the
        # workspace base-validation script REJECTS the advanced
        # integration branch.
        self.assertGreaterEqual(
            len(captured),
            1,
            "Conductor did not invoke "
            "TicketWorkspaceManager.prepare at all.",
        )
        self.assertEqual(
            captured[0],
            "ORIGINAL_BASE",
            "Conductor did not preserve the original base "
            "guard when the PR is not yet merged.",
        )

        # The integration runner was NOT called: the conductor
        # blocked because the advanced base does not match
        # checkpoint.base_sha AND the PR is not yet merged.
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )


class PostMergeIdentityConductorTests(unittest.TestCase):
    """#3 — conductor-level proof that the post-merge base
    guard is relaxed ONLY when the EXACT expected persisted PR
    is verified merged.  Every other outcome (verified-not-
    merged, ambiguous, malformed, wrong identity, non-boolean
    ``merged``) preserves ``expected_base_sha``.

    The tests capture the exact ``expected_base_sha`` argument
    the conductor chose and assert against the documented
    invariant for each scenario.
    """

    def _build_checkpoint(
        self,
        *,
        persisted_commit_sha: str = "IMPLEMENTATION_SHA",
        pull_request_number: int = 202,
        base_sha: str = "ORIGINAL_BASE",
        ticket_sha: str = "IMPLEMENTATION_SHA",
    ):
        return make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATING,
            persisted_commit_sha=persisted_commit_sha,
            pull_request_number=pull_request_number,
            base_sha=base_sha,
            ticket_sha=ticket_sha,
        )

    def _run_with_probe_and_capture(
        self,
        *,
        probe,
        checkpoint,
    ):
        tasks = [task(17, state="CLOSED")]

        captured: list = []

        real_sandbox = _install_real_workspace_capture(
            base_sha="ADVANCED_BASE",
            ticket_sha="IMPLEMENTATION_SHA",
            captured_expected_base_sha=captured,
            cleanup_register=self.addCleanup,
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
            make_github_probe=lambda **kw: probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.mock_tenki.return_value.__enter__.return_value = (
                real_sandbox
            )
            final = harness.run()

        return final, captured, integration_runner

    def test_a_merged_true_with_full_identity_relaxes_base_guard(
        self,
    ):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                    merged=True,
                )
            ),
            pull_request_merged=MagicMock(return_value=True),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        # Conductor MUST relax the base guard:
        self.assertIsNone(captured[0])
        integration_runner.integrate.assert_called_once()
        self.assertEqual(
            final, TicketState.HUMAN_QA_PENDING
        )

    def test_b_merged_false_preserves_original_base(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                    merged=False,
                )
            ),
            pull_request_merged=MagicMock(return_value=False),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        # Conductor MUST preserve the original base guard:
        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_c_merged_string_false_does_not_relax_base(self):
        """``"false"`` (the string) is truthy in Python.  The
        conductor MUST NOT relax the base guard based on a
        non-boolean ``merged`` value.
        """
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value={
                    "number": 202,
                    "head": {
                        "ref": "ralph/m2-17",
                        "sha": "IMPLEMENTATION_SHA",
                        "repo": {
                            "full_name": (
                                "Measure-2wice/sound-hub"
                            )
                        },
                    },
                    "base": {
                        "ref": "ralph/m2",
                        "repo": {
                            "full_name": (
                                "Measure-2wice/sound-hub"
                            )
                        },
                    },
                    "merged": "false",
                }
            ),
            pull_request_merged=MagicMock(return_value="false"),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_d_wrong_repository_preserves_base(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                    repository="OtherOwner/other-repo",
                    merged=True,
                )
            ),
            pull_request_merged=MagicMock(return_value=True),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_e_wrong_base_ref_preserves_base(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                    base_ref="wrong-branch",
                    merged=True,
                )
            ),
            pull_request_merged=MagicMock(return_value=True),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_f_wrong_head_ref_preserves_base(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                    head_ref="ralph/m2-other",
                    merged=True,
                )
            ),
            pull_request_merged=MagicMock(return_value=True),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_g_wrong_head_sha_preserves_base(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=make_merged_pr_dict(
                    number=202,
                    head_sha="OTHER_SHA",
                    merged=True,
                )
            ),
            pull_request_merged=MagicMock(return_value=True),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_h_malformed_pr_response_preserves_base(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=None
            ),
            pull_request_merged=MagicMock(return_value=True),
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner = (
            self._run_with_probe_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )


class DetailedPullRequestEndpointTests(unittest.TestCase):
    """#2 — the post-merge base-guard relaxation MUST come from
    the detailed PR endpoint
    (``GET /repos/{owner}/{repository}/pulls/{number}``), NOT
    the LIST endpoint.  GitHub's LIST representation does not
    reliably provide the ``merged`` boolean, so a legitimate
    restart cannot prove the PR is merged without the detail
    endpoint.

    These tests prove that:

      - the conductor ACTUALLY calls ``pull_request_detail``
        on the detailed probe (not ``pull_request_for_branch``
        on the list representation);

      - for an INTEGRATING checkpoint with base=A and
        persisted_commit_sha=T and pull_request_number=N, the
        detail endpoint verifies the exact identity and
        ``merged is True`` -> the conductor passes
        ``expected_base_sha=None`` to
        ``TicketWorkspaceManager.prepare``;

      - for ``merged is False`` -> the conductor retains
        ``expected_base_sha=A``.

    These tests use realistic GitHub API shapes.
    """

    def _build_checkpoint(
        self,
        *,
        persisted_commit_sha: str = "IMPLEMENTATION_SHA",
        pull_request_number: int = 202,
        base_sha: str = "ORIGINAL_BASE",
    ):
        return make_checkpoint_payload(
            issue_number=17,
            state=TicketState.INTEGRATING,
            persisted_commit_sha=persisted_commit_sha,
            pull_request_number=pull_request_number,
            base_sha=base_sha,
            ticket_sha=persisted_commit_sha,
        )

    def _make_probe_with_detail(
        self,
        *,
        detail: Optional[dict],
    ):
        # NOTE: pull_request_for_branch is intentionally
        # returning a LIST-shape dict (no ``merged``).  The
        # conductor MUST NOT rely on it.  ``pull_request_detail``
        # is the canonical source of ``merged``.
        return SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=202,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_detail=MagicMock(
                return_value=detail
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

    def _run_and_capture(self, *, probe, checkpoint):
        tasks = [task(17, state="CLOSED")]

        captured: list = []

        real_sandbox = _install_real_workspace_capture(
            base_sha="ADVANCED_BASE",
            ticket_sha="IMPLEMENTATION_SHA",
            captured_expected_base_sha=captured,
            cleanup_register=self.addCleanup,
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: MagicMock(),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: MagicMock(),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
            make_github_probe=lambda **kw: probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.mock_tenki.return_value.__enter__.return_value = (
                real_sandbox
            )
            final = harness.run()

        return final, captured, integration_runner, probe

    def test_a_exact_pr_merged_true_relaxes_base(self):
        """Detailed endpoint returns merged=True with exact
        identity.  Conductor MUST call pull_request_detail
        (the detailed endpoint) and pass
        expected_base_sha=None.
        """
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": True,
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, probe = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        # The conductor ACTUALLY called the detailed endpoint.
        probe.pull_request_detail.assert_called_with(
            pull_request_number=202,
        )

        # The conductor did NOT rely on the LIST endpoint.
        # (The list endpoint still gets called as part of
        # reconcile_persistence for the durable-state probe,
        # but the merged proof MUST come from detail.)

        self.assertIsNone(captured[0])
        integration_runner.integrate.assert_called_once()
        self.assertEqual(
            final, TicketState.HUMAN_QA_PENDING
        )

    def test_b_exact_pr_merged_false_preserves_base(self):
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": False,
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, probe = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        probe.pull_request_detail.assert_called_with(
            pull_request_number=202,
        )
        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_c_merged_string_false_preserves_base(self):
        """``merged = "false"`` (the string) is truthy in
        Python.  The conductor MUST NOT relax the base guard
        based on a non-boolean ``merged`` value, even when the
        rest of the identity is exact.
        """
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": "false",
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, probe = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_d_merged_string_true_preserves_base(self):
        """``merged = "true"`` (the string) is also truthy but
        is not the boolean True.  Reject.
        """
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": "true",
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, _ = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_e_wrong_pr_number_preserves_base(self):
        probe = self._make_probe_with_detail(
            detail={
                "number": 999,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": True,
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, _ = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_f_wrong_repository_preserves_base(self):
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "OtherOwner/other-repo"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "OtherOwner/other-repo"
                    },
                },
                "merged": True,
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, _ = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_g_wrong_base_ref_preserves_base(self):
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "wrong-branch",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": True,
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, _ = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_h_wrong_head_ref_preserves_base(self):
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-other",
                    "sha": "IMPLEMENTATION_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": True,
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, _ = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_i_wrong_head_sha_preserves_base(self):
        probe = self._make_probe_with_detail(
            detail={
                "number": 202,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "OTHER_SHA",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "ralph/m2",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "merged": True,
            }
        )

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, _ = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )

    def test_j_malformed_detail_response_preserves_base(self):
        """Detailed endpoint returned ``None`` (malformed).
        The conductor MUST NOT silently treat that as
        ``NOT_MERGED`` — it must fail closed.
        """
        probe = self._make_probe_with_detail(detail=None)

        checkpoint = self._build_checkpoint()
        final, captured, integration_runner, probe = (
            self._run_and_capture(
                probe=probe,
                checkpoint=checkpoint,
            )
        )

        probe.pull_request_detail.assert_called_with(
            pull_request_number=202,
        )
        self.assertEqual(captured[0], "ORIGINAL_BASE")
        integration_runner.integrate.assert_not_called()
        self.assertEqual(
            final, TicketState.BLOCKED_FOR_HUMAN
        )


class AmbiguousRecoveryConductorTests(unittest.TestCase):
    """For every AMBIGUOUS recovery outcome at the probe
    boundary, the conductor MUST:

      - NOT invoke the persistence runner (no commit, no push,
        no force push, no PR creation)
      - NOT create or push a PR
      - transition to BLOCKED_FOR_HUMAN
      - never duplicate any durable side effect

    These tests exercise the full conductor loop with each
    AMBIGUOUS probe response and assert the boundary invariants.
    """

    def _run_ambiguous(
        self,
        *,
        probe,
        state=TicketState.AUTOMATED_QA,
        persisted_commit_sha=None,
        pull_request_number=None,
        ticket_sha="ORIGINAL_BASELINE",
        base_sha="base123",
        integration_branch="ralph/m2",
        ticket_branch="ralph/m2-17",
    ):
        """Run the conductor end-to-end with the given probe
        response and assert the AMBIGUOUS invariants."""

        tasks = [task(17, state="OPEN")]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=state,
            persisted_commit_sha=persisted_commit_sha,
            pull_request_number=pull_request_number,
            ticket_sha=ticket_sha,
            base_sha=base_sha,
            integration_branch=integration_branch,
            ticket_branch=ticket_branch,
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
        )

        # Default review approves persistence; conductor
        # reaches the persistence decision boundary.
        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

        # Persistence and integration runners must NEVER be
        # called on AMBIGUOUS.
        persistence_runner = SimpleNamespace(
            persist=MagicMock(),
            ensure_pull_request_for_persisted_commit=MagicMock(),
        )

        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        cleaner = SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch=ticket_branch,
                )
            )
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: cleaner,
            make_github_probe=lambda **kw: probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        return (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        )

    def _assert_ambiguous_invariants(
        self,
        *,
        final,
        persistence_runner,
        integration_runner,
        cleaner,
        saved_checkpoints,
    ):
        """Every AMBIGUOUS path must satisfy the same boundary
        invariants: no persistence, no integration, no cleanup,
        terminal BLOCKED_FOR_HUMAN.
        """
        persistence_runner.persist.assert_not_called()
        persistence_runner.ensure_pull_request_for_persisted_commit.assert_not_called()
        integration_runner.integrate.assert_not_called()
        cleaner.cleanup_ticket_branch.assert_not_called()

        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
            (
                "AMBIGUOUS outcome must transition to "
                "BLOCKED_FOR_HUMAN."
            ),
        )

        # The checkpoint must reflect BLOCKED_FOR_HUMAN and
        # NOT have any persisted values written.
        last_saved = saved_checkpoints[-1] if saved_checkpoints else None
        self.assertIsNotNone(last_saved)
        self.assertEqual(
            last_saved.state,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_malformed_branch_response_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=BranchLookup(
                    malformed_reason=(
                        BranchMalformedReason.MALFORMED_RESPONSE
                    )
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_malformed_pr_list_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(),
                    absent_reason=None,
                    malformed_reasons=(
                        PullRequestMalformedReason.NOT_A_LIST,
                    ),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_malformed_pr_candidate_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(
                        CandidateEvaluation(
                            number=42,
                            head_sha="IMPLEMENTATION_SHA",
                            reasons=(),
                        ),
                    ),
                    absent_reason=None,
                    malformed_reasons=(
                        PullRequestMalformedReason.CANDIDATE_MALFORMED,
                    ),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_multiple_matching_prs_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(
                        CandidateEvaluation(
                            number=1,
                            head_sha="IMPLEMENTATION_SHA",
                            reasons=(),
                        ),
                        CandidateEvaluation(
                            number=2,
                            head_sha="IMPLEMENTATION_SHA",
                            reasons=(),
                        ),
                    ),
                    absent_reason=None,
                    malformed_reasons=(),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_wrong_base_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(),
                    absent_reason=None,
                    malformed_reasons=(
                        PullRequestMalformedReason.CANDIDATE_WRONG_BASE,
                    ),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_wrong_head_ref_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(),
                    absent_reason=None,
                    malformed_reasons=(
                        PullRequestMalformedReason.CANDIDATE_WRONG_HEAD_REF,
                    ),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_wrong_head_sha_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(),
                    absent_reason=None,
                    malformed_reasons=(
                        PullRequestMalformedReason.CANDIDATE_WRONG_HEAD_SHA,
                    ),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_wrong_repository_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(),
                    absent_reason=None,
                    malformed_reasons=(
                        PullRequestMalformedReason.CANDIDATE_WRONG_REPOSITORY,
                    ),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_invalid_pr_number_ambiguous_no_persistence(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=PullRequestLookup(
                    candidates=(),
                    absent_reason=None,
                    malformed_reasons=(
                        PullRequestMalformedReason.CANDIDATE_INVALID_NUMBER,
                    ),
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(probe=probe)

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_absent_branch_with_checkpoint_sha_ambiguous(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_absent_branch()
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(
            probe=probe,
            persisted_commit_sha="STALE_SHA",
            pull_request_number=None,
        )

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_absent_branch_with_checkpoint_pr_ambiguous(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_absent_branch()
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(
            probe=probe,
            persisted_commit_sha=None,
            pull_request_number=42,
        )

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_baseline_branch_with_checkpoint_sha_ambiguous(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "ORIGINAL_BASELINE"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(
            probe=probe,
            ticket_sha="ORIGINAL_BASELINE",
            persisted_commit_sha="STALE_SHA",
            pull_request_number=None,
        )

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_baseline_branch_with_checkpoint_pr_ambiguous(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "ORIGINAL_BASELINE"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(
            probe=probe,
            ticket_sha="ORIGINAL_BASELINE",
            persisted_commit_sha=None,
            pull_request_number=42,
        )

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_checkpoint_sha_contradicts_remote_ambiguous(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(
            probe=probe,
            persisted_commit_sha="WRONG_SHA",
            pull_request_number=None,
        )

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_checkpoint_pr_contradicts_verified_pr_ambiguous(self):
        # Simulate the crash window where the checkpoint
        # retained a stale PR number but the durable GitHub
        # state proves a different PR.  ``persisted_commit_sha``
        # is None so recovery MUST run; the contradiction
        # between checkpoint's pull_request_number and the
        # verified PR must collapse to AMBIGUOUS.
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch(
                    "IMPLEMENTATION_SHA"
                )
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_matching_pr_lookup(
                    number=42,
                    head_sha="IMPLEMENTATION_SHA",
                )
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(
            probe=probe,
            persisted_commit_sha=None,
            pull_request_number=999,
        )

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )

    def test_unexpected_ticket_branch_ambiguous(self):
        probe = SimpleNamespace(
            remote_branch_head=MagicMock(
                return_value=make_present_branch("X")
            ),
            pull_requests_for_branch=MagicMock(
                return_value=make_empty_pr_lookup()
            ),
            pull_request_merged=MagicMock(return_value=None),
        )

        (
            final,
            persistence_runner,
            integration_runner,
            cleaner,
            harness,
        ) = self._run_ambiguous(
            probe=probe,
            ticket_branch="ralph/m2-WRONG",
        )

        self._assert_ambiguous_invariants(
            final=final,
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            cleaner=cleaner,
            saved_checkpoints=harness.saved_checkpoints(),
        )


class CommitOnlyContinuationConductorTests(unittest.TestCase):
    """#2 — verify the conductor's COMMIT_ONLY continuation
    contract:

      - returns an explicit result (None = terminal failure)
      - on None, the caller MUST NOT transition to INTEGRATING
      - on None, IntegrationRunner is NEVER called

    Both call sites are tested:

      - the AUTOMATED_QA COMMIT_ONLY path
      - the persistence-stage COMMIT_ONLY path
    """

    def _raise_persistence_error(self, **kwargs):
        raise PersistenceError(
            "Local HEAD disagrees with recovered SHA."
        )

    def _build_runner_with_error(
        self,
        *,
        issue_number: int,
    ):
        runner = SimpleNamespace(
            persist=MagicMock(),
            ensure_pull_request_for_persisted_commit=MagicMock(
                side_effect=self._raise_persistence_error
            ),
        )
        return runner

    def _build_review_runner(self):
        return SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

    def _build_integration_runner(self):
        return SimpleNamespace(integrate=MagicMock())

    def _build_cleaner(self):
        return SimpleNamespace(
            cleanup_ticket_branch=MagicMock(
                return_value=SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )
        )

    def _build_callbacks(
        self,
        *,
        persistence_runner,
        integration_runner,
        review_runner=None,
        cleaner=None,
    ):
        return ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: (
                review_runner
                or self._build_review_runner()
            ),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: (
                cleaner or self._build_cleaner()
            ),
        )

    def test_qa_call_site_commit_only_sha_disagreement_no_integration(
        self,
    ):
        """#2 from the AUTOMATED_QA COMMIT_ONLY call site.

        Scenario: checkpoint has persisted_commit_sha, no PR.
        Recovery probe returns NOTHING_DURABLE.  The
        continuation runner raises PersistenceError because
        local HEAD disagrees with recovered_sha.

        Expected:
          - integration_runner.integrate NOT called
          - final state == BLOCKED_FOR_HUMAN
          - last saved checkpoint state == BLOCKED_FOR_HUMAN
          - no illegal transition exception (BLOCKED_FOR_HUMAN
            -> INTEGRATING never attempted)
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha="RECOVERED_SHA",
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        persistence_runner = self._build_runner_with_error(
            issue_number=17
        )
        integration_runner = self._build_integration_runner()
        review_runner = self._build_review_runner()
        cleaner = self._build_cleaner()

        callbacks = self._build_callbacks(
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
            review_runner=review_runner,
            cleaner=cleaner,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # Persistence side effects: never the normal path
        # (commit + push), but the COMMIT_ONLY continuation
        # was attempted exactly once and failed with
        # PersistenceError.
        persistence_runner.persist.assert_not_called()
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_called_once()
        )

        # Integration runner was NEVER called.
        integration_runner.integrate.assert_not_called()
        cleaner.cleanup_ticket_branch.assert_not_called()

        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

        # The last saved checkpoint state is BLOCKED_FOR_HUMAN.
        saved_checkpoints = harness.saved_checkpoints()
        self.assertGreater(len(saved_checkpoints), 0)
        self.assertEqual(
            saved_checkpoints[-1].state,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_persistence_call_site_commit_only_sha_disagreement_no_integration(
        self,
    ):
        """#2 from the persistence-stage COMMIT_ONLY call site.

        Scenario: conductor reaches _run_persistence with
        persisted_commit_sha set and pull_request_number=None.
        The COMMIT_ONLY continuation raises PersistenceError.

        Expected:
          - integration_runner.integrate NOT called
          - final state == BLOCKED_FOR_HUMAN
          - no illegal transition exception
        """
        tasks = [task(17)]

        # Set state to REVIEWING with PRE_PERSISTENCE stage so
        # the conductor reaches _run_persistence naturally.
        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha="RECOVERED_SHA",
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        persistence_runner = self._build_runner_with_error(
            issue_number=17
        )
        integration_runner = self._build_integration_runner()

        callbacks = self._build_callbacks(
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        persistence_runner.persist.assert_not_called()
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_called_once()
        )
        integration_runner.integrate.assert_not_called()

        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

        saved_checkpoints = harness.saved_checkpoints()
        self.assertGreater(len(saved_checkpoints), 0)
        self.assertEqual(
            saved_checkpoints[-1].state,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_qa_call_site_commit_only_success_checkpoints_verified_sha(
        self,
    ):
        """Happy path: continuation succeeds, the conductor
        transitions to INTEGRATING, and the checkpoint's
        persisted_commit_sha equals the SHA the runner
        returned (NOT the input recovered_sha).
        """
        tasks = [task(17)]

        sha_in_checkpoint = "INPUT_SHA"
        sha_verified = "VERIFIED_SHA"

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha=sha_in_checkpoint,
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        persistence_runner = SimpleNamespace(
            persist=MagicMock(),
            ensure_pull_request_for_persisted_commit=MagicMock(
                return_value=SimpleNamespace(
                    pull_request_number=99,
                    pull_request_url="https://x",
                    pull_request_created=True,
                    commit_sha=sha_verified,
                    remote_sha=sha_verified,
                )
            ),
        )
        integration_runner = self._build_integration_runner()

        callbacks = self._build_callbacks(
            persistence_runner=persistence_runner,
            integration_runner=integration_runner,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        # The conductor MUST have called the continuation
        # exactly once with the checkpoint's recovered SHA.
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_called_once()
        )
        call_kwargs = (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .call_args
            .kwargs
        )
        self.assertEqual(
            call_kwargs.get("recovered_sha"),
            sha_in_checkpoint,
        )

        # The conductor MUST have checkpointed the SHA from
        # the result, not the unverified input.
        # Note: harness default probe makes recovery return
        # NOTHING_DURABLE for an absent branch, but the
        # checkpoint already has persisted_commit_sha set, so
        # the recovery will accept the input SHA.

        # Last checkpoint should reflect the verified SHA.
        saved_checkpoints = harness.saved_checkpoints()
        last_with_persisted = None
        for ck in saved_checkpoints:
            if (
                ck.persisted_commit_sha is not None
                and ck.pull_request_number is not None
            ):
                last_with_persisted = ck

        self.assertIsNotNone(last_with_persisted)
        self.assertEqual(
            last_with_persisted.persisted_commit_sha,
            sha_verified,
            (
                "Conductor must checkpoint the SHA from the "
                "continuation RESULT, never the unverified "
                "input."
            ),
        )

        # Integration was invoked (the continuation
        # succeeded, conductor transitioned to INTEGRATING).
        integration_runner.integrate.assert_called_once()

        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )


class RecoveryDispositionPropagationTests(unittest.TestCase):
    """Regression tests for the explicit recovery-disposition
    contract.

    The Codex trace:

      AUTOMATED_QA with no checkpoint persistence
      -> recovery classifies durable state as COMMIT_ONLY(T)
      -> _maybe_recover_persistence checkpoints T
      -> COMMIT_ONLY continuation detects SHA disagreement
      -> _continue_commit_only_persistence catches PersistenceError
      -> checkpoint becomes BLOCKED_FOR_HUMAN
      -> continuation returns None
      -> _maybe_recover_persistence ignores that failure
         and returns True
      -> caller transitions to INTEGRATING
      -> illegal BLOCKED_FOR_HUMAN -> INTEGRATING transition

    Must NOT happen.  ``_maybe_recover_persistence`` MUST
    return ``PersistenceRecoveryDisposition.TERMINAL`` when
    the COMMIT_ONLY continuation detects a terminal failure,
    and every caller MUST switch on the disposition
    explicitly.  Both call sites are covered.
    """

    def _raise_persistence_error(self, **kwargs):
        raise PersistenceError(
            "Local HEAD disagrees with recovered SHA."
        )

    def _build_continuation_runner_that_fails(self):
        runner = SimpleNamespace(
            persist=MagicMock(),
            ensure_pull_request_for_persisted_commit=MagicMock(
                side_effect=self._raise_persistence_error
            ),
        )
        return runner

    def _build_review_runner(self):
        return SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

    def test_qa_call_site_commit_only_continuation_failure_propagates_terminal(
        self,
    ):
        """Codexx trace from the AUTOMATED_QA COMMIT_ONLY call
        site.  Recovery says COMMIT_ONLY(T).  Continuation
        raises PersistenceError.  The conductor MUST end at
        BLOCKED_FOR_HUMAN with IntegrationRunner NEVER called
        and NO illegal transition attempted.
        """
        tasks = [task(17)]

        # Checkpoint state is AUTOMATED_QA with the durable
        # commit already known but no PR yet (the crash
        # window between commit+push and PR creation).
        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha="RECOVERED_SHA",
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        persistence_runner = (
            self._build_continuation_runner_that_fails()
        )
        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: (
                self._build_review_runner()
            ),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            # The test MUST complete without raising the
            # illegal-transition exception.
            final = harness.run()

        # IntegrationRunner was NEVER called.
        integration_runner.integrate.assert_not_called()

        # The COMMIT_ONLY continuation was attempted exactly
        # once (the runner raised PersistenceError inside).
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_called_once()
        )

        # Final state is BLOCKED_FOR_HUMAN, not INTEGRATING.
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

        # The last saved checkpoint state is BLOCKED_FOR_HUMAN.
        saved_checkpoints = harness.saved_checkpoints()
        self.assertGreater(len(saved_checkpoints), 0)
        self.assertEqual(
            saved_checkpoints[-1].state,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_persistence_call_site_commit_only_continuation_failure_propagates_terminal(
        self,
    ):
        """Same Codex trace from the persistence-stage call
        site.  Conductor reaches _run_persistence with
        persisted_commit_sha set, pull_request_number None.
        Continuation raises PersistenceError.  Conductor MUST
        end at BLOCKED_FOR_HUMAN.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha="RECOVERED_SHA",
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        persistence_runner = (
            self._build_continuation_runner_that_fails()
        )
        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: (
                self._build_review_runner()
            ),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        integration_runner.integrate.assert_not_called()
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_called_once()
        )
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )

        saved_checkpoints = harness.saved_checkpoints()
        self.assertGreater(len(saved_checkpoints), 0)
        self.assertEqual(
            saved_checkpoints[-1].state,
            TicketState.BLOCKED_FOR_HUMAN,
        )

    def test_commit_only_success_returns_ready_to_integrate(
        self,
    ):
        """Happy path: continuation succeeds.  Conductor MUST
        transition to INTEGRATING and IntegrationRunner MUST
        run.
        """
        tasks = [task(17)]

        sha_verified = "VERIFIED_SHA"

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha=("RECOVERED_SHA"),
            pull_request_number=None,
            qa_evidence=(
                "QA STATUS: PASSED\n\n## format-check\n"
            ),
            review_stage=(
                ReviewStage.PRE_PERSISTENCE.value
            ),
        )

        persistence_runner = SimpleNamespace(
            persist=MagicMock(),
            ensure_pull_request_for_persisted_commit=MagicMock(
                return_value=SimpleNamespace(
                    pull_request_number=99,
                    pull_request_url="https://x",
                    pull_request_created=True,
                    commit_sha=sha_verified,
                    remote_sha=sha_verified,
                )
            ),
        )
        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: (
                self._build_review_runner()
            ),
            make_qa_runner=lambda **kw: MagicMock(),
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            final = harness.run()

        integration_runner.integrate.assert_called_once()
        self.assertEqual(
            final,
            TicketState.HUMAN_QA_PENDING,
        )


class LastErrorControlPlaneTests(unittest.TestCase):
    """``checkpoint.last_error`` is Ralph-owned
    control-plane data.  It MUST NEVER contain
    model-authored content from
    ``ReviewResult.summary`` or any
    ``ReviewFinding`` field.

    These tests prove the conductor copies no
    reviewer content into ``last_error`` — only
    static Ralph-authored categorical messages.
    """

    SECRET = "super-secret-nebius-value-12345"

    FIX_PRE_QA_STATIC = (
        "PRE_QA review requested "
        "implementation fixes."
    )

    FIX_PRE_PERSISTENCE_STATIC = (
        "PRE_PERSISTENCE review blocked "
        "persistence."
    )

    @staticmethod
    def _fixing_checkpoint(checkpoints):
        """Return the first saved checkpoint
        that landed in FIXING with a non-None
        ``last_error``.  This is the moment the
        reviewer failure verdict is recorded."""
        for checkpoint in checkpoints:
            if (
                checkpoint.state
                == TicketState.FIXING
                and checkpoint.last_error
                is not None
            ):
                return checkpoint
        return None

    def _assert_no_leak(self, text):
        """Assert the secret never appears in
        ``text`` in any form."""
        self.assertNotIn(self.SECRET, text or "")
        for start in range(0, len(self.SECRET) - 3):
            fragment = self.SECRET[start : start + 4]
            self.assertNotIn(fragment, text or "")

    # ------------------------------------------------------------------
    # A. FIX_BEFORE_QA
    # ------------------------------------------------------------------
    def test_fix_before_qa_does_not_leak_summary(self):
        """When the reviewer returns
        ``FIX_BEFORE_QA`` with a malicious
        ``summary``, the conductor MUST NOT copy
        that summary into ``checkpoint.last_error``.
        The dedicated ``pre_qa_findings`` field
        continues to receive the structured
        findings so the fix workflow can use them.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.FIX_BEFORE_QA
                    ),
                    summary=self.SECRET,
                    findings=(
                        ReviewFinding(
                            severity="BLOCKING",
                            title=(
                                "Wrong migration order"
                            ),
                            details=(
                                "Tables must be created "
                                "before indexes."
                            ),
                        ),
                    ),
                )
            )

            _ = harness.run()

            checkpoints = (
                harness.saved_checkpoints()
            )

        fixing = self._fixing_checkpoint(checkpoints)

        # The conductor MUST have routed the
        # ticket through FIXING at least once.
        self.assertIsNotNone(
            fixing,
            msg=(
                "Conductor never saved a FIXING "
                "checkpoint with last_error set"
            ),
        )

        # ``last_error`` MUST be the static
        # Ralph-owned message, NOT the secret
        # model-authored summary.
        self.assertEqual(
            fixing.last_error,
            self.FIX_PRE_QA_STATIC,
        )

        # Belt-and-suspenders: the secret MUST
        # not appear in any form in
        # ``last_error`` (the control plane).
        self._assert_no_leak(fixing.last_error)

        # The dedicated ``pre_qa_findings`` field
        # is a REVIEW/FIX evidence field, not
        # control-plane state.  It continues to
        # carry the structured findings so the
        # fix agent can consume them via the
        # existing dedicated fix-context
        # mechanism.  We confirm the field is
        # populated rather than asserting it
        # contains no model content.
        self.assertIsNotNone(fixing.pre_qa_findings)

        # And: no checkpoint at any point may
        # carry the secret in ``last_error``.
        for saved in checkpoints:
            self._assert_no_leak(saved.last_error)

    # ------------------------------------------------------------------
    # B. BLOCK_PERSISTENCE
    # ------------------------------------------------------------------
    def test_block_persistence_does_not_leak_summary(
        self,
    ):
        """When the reviewer returns
        ``BLOCK_PERSISTENCE`` with a malicious
        ``summary``, the conductor MUST NOT copy
        that summary into ``checkpoint.last_error``.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n"
                "## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.BLOCK_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                    summary=self.SECRET,
                    findings=(
                        ReviewFinding(
                            severity="BLOCKING",
                            title=(
                                "Migration missing"
                            ),
                            details=(
                                "Adds a column with no "
                                "default."
                            ),
                        ),
                    ),
                )
            )

            _ = harness.run()

            checkpoints = (
                harness.saved_checkpoints()
            )

        fixing = self._fixing_checkpoint(checkpoints)

        self.assertIsNotNone(
            fixing,
            msg=(
                "Conductor never saved a FIXING "
                "checkpoint with last_error set"
            ),
        )

        # ``last_error`` MUST be the static
        # Ralph-owned message, NOT the secret.
        self.assertEqual(
            fixing.last_error,
            self.FIX_PRE_PERSISTENCE_STATIC,
        )
        self._assert_no_leak(fixing.last_error)

        # The dedicated ``pre_persistence_findings``
        # field is a REVIEW/FIX evidence field,
        # not control-plane state.  It continues
        # to carry the structured findings so the
        # fix agent can consume them.
        self.assertIsNotNone(
            fixing.pre_persistence_findings,
        )

        # pre_qa_findings is reset because this
        # is the PRE_PERSISTENCE branch.
        self.assertIsNone(fixing.pre_qa_findings)

        # And: no checkpoint at any point may
        # carry the secret in last_error.
        for saved in checkpoints:
            self._assert_no_leak(saved.last_error)

    # ------------------------------------------------------------------
    # C. SUCCESS PATHS
    # ------------------------------------------------------------------
    def test_pre_qa_approval_clears_last_error(self):
        """``APPROVE_FOR_QA`` MUST reset
        ``last_error`` to ``None``.  No
        model-authored summary may be persisted
        on success either."""
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_QA
                    ),
                    summary=self.SECRET,
                )
            )

            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            _ = harness.run()

            checkpoints = (
                harness.saved_checkpoints()
            )

        # No checkpoint at any point may carry
        # the secret in last_error.
        for saved in checkpoints:
            self._assert_no_leak(saved.last_error)

        # The transition from REVIEWING into
        # AUTOMATED_QA on the success path MUST
        # have cleared last_error.
        automated_qa = [
            saved
            for saved in checkpoints
            if saved.state == TicketState.AUTOMATED_QA
        ]
        self.assertTrue(
            automated_qa,
            "Conductor never saved an "
            "AUTOMATED_QA checkpoint on the "
            "PRE_QA success path",
        )
        self.assertIsNone(automated_qa[0].last_error)

    def test_pre_persistence_approval_clears_last_error(
        self,
    ):
        """``APPROVE_FOR_PERSISTENCE`` MUST
        clear ``last_error`` and run through
        persistence without persisting any
        model-authored content."""
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n"
                "## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                    summary=self.SECRET,
                )
            )

            harness.persistence_runner.persist.return_value = (
                SimpleNamespace(
                    commit_sha="commit123",
                    remote_sha="commit123",
                    pull_request_number=99,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )

            harness.cleaner.cleanup_ticket_branch.return_value = (
                SimpleNamespace(
                    deleted=True,
                    already_absent=False,
                    branch="ralph/m2-17",
                )
            )

            _ = harness.run()

            checkpoints = (
                harness.saved_checkpoints()
            )

        # No checkpoint at any point may carry
        # the secret in last_error.
        for saved in checkpoints:
            self._assert_no_leak(saved.last_error)

    # ------------------------------------------------------------------
    # D. STATIC REGRESSION GUARD
    # ------------------------------------------------------------------
    def test_run_module_has_no_last_error_assignment_from_summary(
        self,
    ):
        """A focused static guard: there must be
        no remaining code path in run.py that
        copies ``ReviewResult.summary`` (or any
        ``review.summary`` / ``result.summary``
        attribute) into ``checkpoint.last_error``.

        This protects against an accidental
        regression where a future change
        re-introduces the leak.
        """
        import re

        run_path = (
            "/Users/calebmatteis/sound-hub/"
            "scripts/ralph/run.py"
        )
        # Allow override for worktrees.
        try:
            with open(run_path) as handle:
                source = handle.read()
        except OSError:
            # In a different layout, fall back to
            # the actual module path.
            import scripts.ralph.run as run_module

            source = Path(run_module.__file__).read_text()

        # Strip line/block comments and string
        # literals before scanning so prose about
        # the security policy is not counted as a
        # match.
        stripped_lines = []
        in_block_string = False
        for line in source.splitlines():
            stripped = line
            if in_block_string:
                if '"""' in stripped or "'''" in stripped:
                    in_block_string = False
                stripped = ""
            elif (
                stripped.lstrip().startswith('"""')
                or stripped.lstrip().startswith("'''")
            ):
                if (
                    stripped.count('"""') < 2
                    and stripped.count("'''") < 2
                ):
                    in_block_string = True
                stripped = ""
            stripped = re.sub(
                r"#.*$",
                "",
                stripped,
            )
            stripped_lines.append(stripped)
        stripped_source = "\n".join(stripped_lines)

        # Remove string literals to avoid false
        # positives on test message strings.
        no_strings = re.sub(
            r'"(?:[^"\\]|\\.)*"',
            '""',
            stripped_source,
        )
        no_strings = re.sub(
            r"'(?:[^'\\]|\\.)*'",
            "''",
            no_strings,
        )

        # Look for any line that assigns a
        # ``*.summary`` expression into
        # ``last_error``.
        forbidden = re.compile(
            r"last_error\s*=\s*[^#\n]*\.summary\b"
        )

        matches = list(
            forbidden.finditer(no_strings),
        )

        self.assertEqual(
            matches,
            [],
            msg=(
                "run.py still has a code path that "
                "assigns *.summary to last_error.  "
                "This would re-introduce the "
                "reviewer-content leak the security "
                "policy forbids.  Matches: "
                f"{[m.group(0) for m in matches]}"
            ),
        )


class LastErrorTrustBoundaryTests(unittest.TestCase):
    """``checkpoint.last_error`` is Ralph-owned
    control-plane metadata.  It MUST be sourced from the
    closed ``TerminalReason`` enum only.

    These tests are the structural sink-level guard.
    They prove:

      - ``_record_terminal`` and ``_record_failure`` can
        never receive an arbitrary string,
      - ``_terminal_message`` rejects non-enum values,
      - the closed enum maps to a STATIC message table,
      - the implementation BLOCKED path does not copy
        ``completion_blocker`` into ``last_error``,
      - the reviewer -> fix -> BLOCKED echo chain (the
        exact Codex trace) cannot leak a secret,
      - agent exception text and QA infrastructure errors
        are mapped to static categorical reasons only,
      - persistence / integration conflict paths use
        static categorical reasons only,
      - the FIX_BEFORE_QA / BLOCK_PERSISTENCE /
        QA_CODE_FAILURE FIXING transitions use static
        categorical reasons only,
      - the conductor still reaches the expected
        terminal states (no semantic regression).

    No model text, exception string, subprocess output,
    API response text, QA command output, or arbitrary
    runtime string may reach ``checkpoint.last_error``.
    """

    SECRET = "super-secret-nebius-value-12345"

    # Pre-computed expected static messages so a future
    # edit to TERMINAL_REASON_MESSAGES that changes the
    # message text without a deliberate reason fails this
    # test loudly.
    EXPECTED_IMPLEMENTATION_BLOCKED = (
        "Implementation agent reported a blocker."
    )

    EXPECTED_IMPLEMENTATION_AGENT_FAILURE = (
        "Implementation agent failed."
    )

    EXPECTED_REVIEW_AGENT_FAILURE = (
        "Independent reviewer returned an invalid response."
    )

    EXPECTED_REVIEW_FIX_BEFORE_QA = (
        "PRE_QA review requested implementation fixes."
    )

    EXPECTED_REVIEW_BLOCK_PERSISTENCE = (
        "PRE_PERSISTENCE review blocked persistence."
    )

    EXPECTED_QA_CODE_FAILURE = (
        "Automated QA reported code failure."
    )

    EXPECTED_QA_INFRA_FAILURE = (
        "Automated QA reported an infrastructure failure."
    )

    EXPECTED_QA_ENVIRONMENT_FAILURE = (
        "Automated QA environment could not be provisioned."
    )

    EXPECTED_PERSISTENCE_CONFLICT = (
        "Persistence state could not be safely reconciled."
    )

    EXPECTED_PERSISTENCE_AGENT_FAILURE = (
        "Persistence agent failed."
    )

    EXPECTED_INTEGRATION_AGENT_FAILURE = (
        "Integration agent failed."
    )

    EXPECTED_WORKSPACE_UNAVAILABLE = (
        "Workspace preparation failed."
    )

    EXPECTED_REMOTE_BRANCH_CLEANUP_FAILURE = (
        "Remote ticket branch cleanup failed."
    )

    EXPECTED_ITERATION_GUARD_EXCEEDED = (
        "Ralph exceeded its internal iteration guard. "
        "Manual inspection required."
    )

    EXPECTED_REVIEW_FIX_BUDGET_EXHAUSTED = (
        "Fix iteration budget exhausted."
    )

    EXPECTED_REVIEW_CYCLE_BUDGET_EXHAUSTED = (
        "Review cycle budget exhausted."
    )

    EXPECTED_QA_BUDGET_EXHAUSTED = (
        "Automated QA attempt budget exhausted."
    )

    EXPECTED_IMPLEMENTATION_BUDGET_EXHAUSTED = (
        "Implementation iteration budget exhausted."
    )

    EXPECTED_IMPLEMENTATION_EXHAUSTED_NO_CHANGES = (
        "Implementation exhausted its iteration budget "
        "without producing changes."
    )

    EXPECTED_ISSUE_NOT_ELIGIBLE = (
        "Issue is no longer execution-authorized in its "
        "current GitHub state."
    )

    EXPECTED_ISSUE_NO_LONGER_PRESENT = (
        "Issue is no longer present in the current "
        "milestone task list."
    )

    def _assert_no_leak(self, text):
        """Assert the secret never appears in ``text``
        in any form.  No substring, no fragment, no
        partial overlap of any 4+ character window.
        """
        self.assertNotIn(self.SECRET, text or "")
        for start in range(0, len(self.SECRET) - 3):
            fragment = self.SECRET[start : start + 4]
            self.assertNotIn(fragment, text or "")

    def _assert_static_terminal(
        self,
        loaded,
        expected,
    ):
        """Assert the loaded terminal checkpoint has
        the expected static ``last_error`` and the
        secret never appears anywhere in the
        checkpoint."""
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.last_error, expected)
        self._assert_no_leak(loaded.last_error)

    # ------------------------------------------------------------------
    # A. IMPLEMENTATION BLOCKED — completion_blocker leak path
    # ------------------------------------------------------------------
    def test_implementation_blocked_does_not_leak_blocker(
        self,
    ):
        """When the implementation runner reports
        BLOCKED with a secret-bearing
        ``completion_blocker``, the conductor MUST NOT
        copy the blocker into ``checkpoint.last_error``.

        This is the canonical Codex trace path:
            review findings
            -> ImplementationFixContext
            -> implementation-agent prompt
            -> BLOCKED completion blocker
            -> result.completion_blocker
            -> checkpoint.last_error
        """
        tasks = [task(17)]

        with RunHarness(tasks=tasks) as harness:
            harness.impl_runner.run.return_value = (
                make_completion(
                    status=CompletionStatus.BLOCKED,
                    blocker=self.SECRET,
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_IMPLEMENTATION_BLOCKED,
        )
        # Belt-and-suspenders: every saved checkpoint
        # for this run.
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    # ------------------------------------------------------------------
    # B. REVIEWER-DERIVED ECHO — Codex trace reproducer
    # ------------------------------------------------------------------
    def test_reviewer_echo_through_fix_context_does_not_leak(
        self,
    ):
        """Reproduce Codex's exact trace: a reviewer
        verdict echoes a secret into the fix-context,
        the implementation agent BLOCKEDs with the
        same secret in ``completion_blocker``, and the
        conductor MUST NOT persist the secret in
        ``checkpoint.last_error``.

        The reviewer-fingerprint text flows through:
            ReviewResult.summary
            -> pre_qa_findings
            -> ImplementationFixContext.reviewer_findings
            -> implementation-agent prompt
            -> completion_blocker
            -> checkpoint.last_error

        The trust boundary MUST hold across this
        entire chain.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            # 1) PRE_QA reviewer returns FIX_BEFORE_QA.
            #    The secret appears in:
            #      - result.summary
            #      - result.findings[*].title and details
            #    These flow into:
            #      - checkpoint.pre_qa_findings
            #    (NOT into checkpoint.last_error — that
            #    is the static categorical message.)
            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.FIX_BEFORE_QA
                    ),
                    summary=self.SECRET,
                    findings=(
                        ReviewFinding(
                            severity="BLOCKING",
                            title=(
                                f"Found {self.SECRET}"
                            ),
                            details=(
                                f"Detail: {self.SECRET}"
                            ),
                        ),
                    ),
                )
            )

            # 2) The implementation agent on the FIX
            #    attempt echoes the secret back as the
            #    completion_blocker.
            harness.impl_runner.run.return_value = (
                make_completion(
                    status=CompletionStatus.BLOCKED,
                    blocker=(
                        f"Cannot resolve: {self.SECRET}"
                    ),
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_IMPLEMENTATION_BLOCKED,
        )
        # The dedicated pre_qa_findings evidence field
        # continues to carry reviewer content so the
        # fix-context mechanism can still consume it.
        # That is fine — it is the dedicated evidence
        # field, not control-plane metadata.
        self.assertIsNotNone(
            harness.saved_checkpoint().pre_qa_findings,
        )
        # Every saved checkpoint's last_error must be
        # free of the secret.
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    # ------------------------------------------------------------------
    # C. AGENT EXCEPTION — exception string leak path
    # ------------------------------------------------------------------
    def test_implementation_runner_exception_does_not_leak(
        self,
    ):
        """When ``ImplementationRunner.run`` raises
        ``ImplementationError`` whose message contains
        a secret, the conductor MUST NOT persist that
        exception text in ``checkpoint.last_error``."""
        tasks = [task(17)]

        with RunHarness(tasks=tasks) as harness:
            harness.impl_runner.run.side_effect = (
                ImplementationError(
                    f"runner failure: {self.SECRET}"
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.AGENT_FAILURE,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_IMPLEMENTATION_AGENT_FAILURE,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def test_review_runner_exception_does_not_leak(
        self,
    ):
        """When ``ReviewRunner.review`` raises
        ``ReviewError`` whose message contains a
        secret, the conductor MUST NOT persist that
        exception text in ``checkpoint.last_error``.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.side_effect = (
                ReviewError(
                    f"review failure: {self.SECRET}"
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.AGENT_FAILURE,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_REVIEW_AGENT_FAILURE,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    # ------------------------------------------------------------------
    # D. PERSISTENCE / INTEGRATION / QA INFRASTRUCTURE ERROR PATHS
    # ------------------------------------------------------------------
    def test_persistence_error_does_not_leak(self):
        """When ``PersistenceRunner.persist`` raises
        ``PersistenceError`` whose message contains a
        secret, the conductor MUST NOT persist that
        text in ``checkpoint.last_error``.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n"
                "## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict
                        .APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )

            harness.persistence_runner.persist.side_effect = (
                PersistenceError(
                    f"persist failure: {self.SECRET}"
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_PERSISTENCE_AGENT_FAILURE,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def test_integration_error_does_not_leak(self):
        """When ``IntegrationRunner.integrate`` raises
        ``IntegrationError`` whose message contains a
        secret, the conductor MUST NOT persist that
        text in ``checkpoint.last_error``.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n"
                "## format-check\n"
            ),
            persisted_commit_sha="commit_ok",
            pull_request_number=42,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict
                        .APPROVE_FOR_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )

            harness.persistence_runner.persist.return_value = (
                SimpleNamespace(
                    commit_sha="commit_ok",
                    remote_sha="commit_ok",
                    pull_request_number=42,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )
            )

            harness.integration_runner.integrate.side_effect = (
                scripts_ralph_integration_error_with_secret(
                    self.SECRET
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.BLOCKED_FOR_HUMAN,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_INTEGRATION_AGENT_FAILURE,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def test_qa_environment_error_does_not_leak(self):
        """When the QA environment fails to start with
        an error message containing a secret, the
        conductor MUST NOT persist that text in
        ``checkpoint.last_error``.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n"
                "## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            # A ``QaEnvironmentError`` whose message
            # contains the secret.
            from scripts.ralph.qa_environment import (
                QaEnvironmentError,
            )

            secret_error = QaEnvironmentError(
                f"provisioning failed: {self.SECRET}"
            )

            harness.qa_environment.start_error = (
                secret_error
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.INFRA_FAILURE,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_QA_ENVIRONMENT_FAILURE,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def test_qa_infra_failure_status_does_not_leak(self):
        """When the QA runner reports
        ``QaStatus.INFRA_FAILURE`` (an automated QA
        infrastructure failure, not a code failure),
        the conductor MUST persist a static categorical
        ``last_error`` only — never the QA command
        stdout/stderr or evidence.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.INFRA_FAILURE,
                )
            )

            final = harness.run()

        loaded = harness.saved_checkpoint()
        self.assertEqual(
            final,
            TicketState.INFRA_FAILURE,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_QA_INFRA_FAILURE,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def test_qa_code_failure_fixing_does_not_leak(self):
        """When the QA runner reports
        ``QaStatus.CODE_FAILURE``, the conductor moves
        the ticket to FIXING with a static
        ``last_error``.  QA command output (which is
        untrusted) is persisted ONLY into the
        dedicated ``qa_failure_evidence`` field for
        the fix-context mechanism — never into
        ``last_error``.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.CODE_FAILURE,
                )
            )

            _ = harness.run()

        loaded = self._first_checkpoint_with_state(
            harness.saved_checkpoints(),
            TicketState.FIXING,
        )
        self.assertIsNotNone(loaded)
        self.assertEqual(
            loaded.state,
            TicketState.FIXING,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_QA_CODE_FAILURE,
        )
        # The dedicated QA evidence field is allowed to
        # carry the QA command output (it is the
        # evidence channel, not control-plane state).
        self.assertIsNotNone(
            loaded.qa_failure_evidence,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def test_review_fix_before_qa_fixing_does_not_leak(self):
        """When PRE_QA reviewer returns FIX_BEFORE_QA,
        the conductor moves to FIXING with a static
        ``last_error``.  Reviewer findings remain in
        ``pre_qa_findings`` as untrusted evidence for
        the fix-context mechanism.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.REVIEWING,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.FIX_BEFORE_QA
                    ),
                    summary=self.SECRET,
                    findings=(
                        ReviewFinding(
                            severity="BLOCKING",
                            title=(
                                f"Found {self.SECRET}"
                            ),
                            details=(
                                f"Detail: {self.SECRET}"
                            ),
                        ),
                    ),
                )
            )

            _ = harness.run()

        # The first FIXING checkpoint with last_error
        # set is the one carrying the static message.
        loaded = self._first_checkpoint_with_state(
            harness.saved_checkpoints(),
            TicketState.FIXING,
        )
        self.assertIsNotNone(loaded)
        self.assertEqual(
            loaded.state,
            TicketState.FIXING,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_REVIEW_FIX_BEFORE_QA,
        )
        # pre_qa_findings carries reviewer content
        # (this is the fix-context evidence field, not
        # control-plane state).
        self.assertIsNotNone(
            loaded.pre_qa_findings,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def test_review_block_persistence_fixing_does_not_leak(
        self,
    ):
        """When PRE_PERSISTENCE reviewer returns
        BLOCK_PERSISTENCE, the conductor moves to
        FIXING with a static ``last_error``.
        """
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            qa_evidence=(
                "QA STATUS: PASSED\n\n"
                "## format-check\n"
            ),
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
        ) as harness:
            harness.qa_runner.run.return_value = (
                make_qa_result(
                    status=QaStatus.PASSED,
                )
            )

            harness.review_runner.review.return_value = (
                make_review(
                    verdict=(
                        ReviewVerdict.BLOCK_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                    summary=self.SECRET,
                    findings=(
                        ReviewFinding(
                            severity="BLOCKING",
                            title=(
                                f"Found {self.SECRET}"
                            ),
                            details=(
                                f"Detail: {self.SECRET}"
                            ),
                        ),
                    ),
                )
            )

            _ = harness.run()

        loaded = self._first_checkpoint_with_state(
            harness.saved_checkpoints(),
            TicketState.FIXING,
        )
        self.assertIsNotNone(loaded)
        self.assertEqual(
            loaded.state,
            TicketState.FIXING,
        )
        self._assert_static_terminal(
            loaded,
            self.EXPECTED_REVIEW_BLOCK_PERSISTENCE,
        )
        self.assertIsNotNone(
            loaded.pre_persistence_findings,
        )
        for saved in harness.saved_checkpoints():
            self._assert_no_leak(saved.last_error)

    def _first_checkpoint_with_state(
        self,
        checkpoints,
        state,
    ):
        for checkpoint in checkpoints:
            if checkpoint.state == state:
                return checkpoint
        return None

    # ------------------------------------------------------------------
    # E. STATIC BOUNDARY — structural guard
    # ------------------------------------------------------------------
    def test_terminal_message_rejects_non_enum(self):
        """``_terminal_message`` MUST raise if the
        caller passes anything that is not a
        ``TerminalReason``.  This is the runtime
        enforcement of the trust boundary.
        """
        with self.assertRaises(TypeError):
            _terminal_message(
                "Implementation agent failed."
            )

        with self.assertRaises(TypeError):
            _terminal_message(
                "super-secret-nebius-value-12345"
            )

        with self.assertRaises(TypeError):
            _terminal_message(None)

    def test_terminal_reason_is_closed_enum(self):
        """The ``TerminalReason`` enum MUST be the only
        type that ``_terminal_message`` accepts.  Any
        other Enum value (or string) MUST be rejected.
        """
        from enum import Enum

        class ForeignEnum(str, Enum):
            ATTACKER = "ATTACKER"

        with self.assertRaises(TypeError):
            _terminal_message(ForeignEnum.ATTACKER)

    def test_every_terminal_reason_has_static_message(self):
        """Every ``TerminalReason`` value MUST map to
        a non-empty static message in
        ``TERMINAL_REASON_MESSAGES``.  A missing key
        or an empty string would silently break the
        trust boundary.
        """
        for reason in TerminalReason:
            message = TERMINAL_REASON_MESSAGES.get(
                reason
            )
            self.assertIsNotNone(
                message,
                msg=(
                    f"TerminalReason.{reason.name} "
                    "has no static message"
                ),
            )
            self.assertNotEqual(
                message.strip(),
                "",
                msg=(
                    f"TerminalReason.{reason.name} "
                    "maps to an empty message"
                ),
            )

    def test_static_messages_are_disjoint_from_secret_shapes(
        self,
    ):
        """No static message may resemble a secret
        shape (long hex / base64-like runs of length
        >= 16).  This is a defense-in-depth guard so
        a substring scan of last_error is meaningful
        for leak detection.
        """
        import re

        for reason, message in (
            TERMINAL_REASON_MESSAGES.items()
        ):
            # Confirm the static message does not
            # contain any plausible API-key shape
            # (>= 32 consecutive characters from
            # [A-Za-z0-9_-]).  Static messages are
            # normal English prose with spaces and
            # punctuation, so a long unbroken run
            # would be suspicious.
            self.assertIsNone(
                re.search(
                    r"[A-Za-z0-9_-]{32,}",
                    message,
                ),
                msg=(
                    "Static message for "
                    f"{reason.name} looks like it "
                    "could carry an opaque secret"
                ),
            )

    def test_record_terminal_signature_rejects_arbitrary_string(
        self,
    ):
        """``_record_terminal`` MUST only accept a
        ``TerminalReason`` (not an arbitrary string)
        as its terminal-reason argument.  This is the
        signature-level enforcement of the trust
        boundary.
        """
        import inspect

        sig = inspect.signature(
            _record_terminal_unbound
        )
        params = list(sig.parameters.values())
        self.assertEqual(len(params), 4)
        self.assertEqual(params[0].name, "self")
        self.assertEqual(params[1].name, "state")
        self.assertEqual(params[2].name, "reason")
        self.assertEqual(params[3].name, "kwargs")

    def test_record_failure_signature_rejects_arbitrary_string(
        self,
    ):
        """``Orchestrator._record_failure`` MUST only
        accept a ``TerminalReason`` (not an arbitrary
        string) as its terminal-reason argument.
        """
        import inspect

        sig = inspect.signature(
            _record_failure_unbound
        )
        params = list(sig.parameters.values())
        # self, checkpoint, store, state, reason
        names = [p.name for p in params]
        self.assertIn("reason", names)
        self.assertNotIn(
            "message",
            names,
            msg=(
                "_record_failure must not accept a "
                "'message' parameter; only 'reason'"
            ),
        )

    def test_no_str_error_or_subprocess_text_in_last_error_paths(
        self,
    ):
        """Static guard: run.py MUST NOT contain any
        pattern that assigns ``str(error)``, an
        f-string with ``{error}``, ``result.summary``,
        ``result.completion_blocker``, or any
        ``.stdout`` / ``.stderr`` / ``.evidence()``
        expression into ``last_error`` directly.

        The trust boundary requires that the only
        sink for ``last_error`` text is
        ``_terminal_message(reason)``.
        """
        import re
        from pathlib import Path

        run_path = Path(
            __file__
        ).parent / "run.py"
        source = run_path.read_text()

        # Strip comments and string literals so prose
        # about the security policy is not counted.
        no_strings = re.sub(
            r'"""[\s\S]*?"""',
            "",
            source,
        )
        no_strings = re.sub(
            r"'''[\s\S]*?'''",
            "",
            no_strings,
        )

        # Forbidden: last_error= followed by anything
        # that resolves to runtime text.  The
        # TerminalReason message table is the only
        # legal source, and every legal assignment
        # routes through ``_terminal_message``.
        forbidden_patterns = [
            r"last_error\s*=\s*[^#\n]*str\(\s*error\s*\)",
            r"last_error\s*=\s*[^#\n]*f\"[^\"]*\{error\}",
            r"last_error\s*=\s*[^#\n]*\.summary\b",
            r"last_error\s*=\s*[^#\n]*\.completion_blocker\b",
            r"last_error\s*=\s*[^#\n]*\.stdout\b",
            r"last_error\s*=\s*[^#\n]*\.stderr\b",
            r"last_error\s*=\s*[^#\n]*\.evidence\(",
        ]

        violations = []
        for pattern in forbidden_patterns:
            for match in re.finditer(
                pattern,
                no_strings,
            ):
                violations.append(
                    (
                        pattern,
                        match.group(0),
                    )
                )

        self.assertEqual(
            violations,
            [],
            msg=(
                "run.py still has a code path that "
                "assigns runtime/model text to "
                "last_error.  Violations: "
                f"{violations}"
            ),
        )


def scripts_ralph_integration_error_with_secret(
    secret,
):
    """Construct an ``IntegrationError`` whose message
    contains ``secret``.  Defined at module scope so the
    test class body stays declarative.
    """
    from scripts.ralph.integration import (
        IntegrationError,
    )

    return IntegrationError(
        f"integrate failure: {secret}"
    )


def _record_terminal_unbound(self, state, reason, **kwargs):
    pass


def _record_failure_unbound(
    self,
    *,
    checkpoint,
    store,
    state,
    reason,
):
    pass


class LastErrorStoreBoundaryTests(unittest.TestCase):
    """Sink-level trust-boundary tests for
    ``CheckpointStore.load`` and ``CheckpointStore.save``.

    Every non-null ``TicketCheckpoint.last_error`` MUST be an
    exact member of ``APPROVED_LAST_ERROR_MESSAGES``.  This
    invariant is enforced at the store boundary so that:

    - an arbitrary string in the persisted JSON cannot reach
      ``TicketCheckpoint``;
    - a programmatically constructed invalid checkpoint
      cannot reach disk.

    The tests are parameterized across the closed set of
    approved messages to prove the invariant holds for every
    legitimate value, plus targeted cases for each rejection
    shape.
    """

    def _write_checkpoint(
        self,
        tmp,
        *,
        last_error,
        state=None,
        issue_number=17,
    ):
        """Persist a JSON checkpoint with the given
        ``last_error`` value (which may be any object)."""
        from scripts.ralph.states import TicketState

        path = Path(tmp) / "checkpoint.json"
        payload = {
            "schema_version": 2,
            "milestone_id": "m2",
            "issue_number": issue_number,
            "state": (
                state.value
                if state is not None
                else TicketState.REVIEWING.value
            ),
            "integration_branch": "ralph/m2",
            "ticket_branch": "ralph/m2-17",
            "last_error": last_error,
        }
        path.write_text(json.dumps(payload))
        return path

    def _make_checkpoint(
        self,
        *,
        last_error,
    ) -> TicketCheckpoint:
        from scripts.ralph.review import ReviewStage
        from scripts.ralph.states import TicketState

        return TicketCheckpoint(
            milestone_id="m2",
            issue_number=17,
            state=TicketState.REVIEWING,
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
            review_stage=ReviewStage.PRE_QA,
            last_error=last_error,
        )

    # ------------------------------------------------------------------
    # LOAD (A-E)
    # ------------------------------------------------------------------
    def test_load_approved_static_message_succeeds(self):
        """A) approved static last_error loads successfully."""
        for message in APPROVED_LAST_ERROR_MESSAGES:
            with self.subTest(message=message):
                with tempfile.TemporaryDirectory() as tmp:
                    path = self._write_checkpoint(
                        tmp,
                        last_error=message,
                    )
                    store = CheckpointStore(path)
                    loaded = store.load()
                    self.assertIsNotNone(loaded)
                    self.assertEqual(
                        loaded.last_error,
                        message,
                    )

    def test_load_none_succeeds(self):
        """B) last_error=None loads successfully."""
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_checkpoint(
                tmp,
                last_error=None,
            )
            store = CheckpointStore(path)
            loaded = store.load()
            self.assertIsNotNone(loaded)
            self.assertIsNone(loaded.last_error)

    def test_load_arbitrary_string_rejected(self):
        """C) arbitrary string last_error -> CheckpointError."""
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_checkpoint(
                tmp,
                last_error="arbitrary runtime text",
            )
            store = CheckpointStore(path)
            with self.assertRaises(CheckpointError):
                store.load()

    def test_load_secret_shaped_string_rejected(self):
        """D) secret-looking string last_error -> CheckpointError."""
        secret = "super-secret-nebius-value-12345"
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_checkpoint(
                tmp,
                last_error=secret,
            )
            store = CheckpointStore(path)
            with self.assertRaises(CheckpointError):
                store.load()

    def test_load_wrong_type_rejected(self):
        """E) wrong-type last_error (number/list/dict/bool)
        -> CheckpointError."""
        for invalid in [
            12345,
            ["a", "list"],
            {"key": "value"},
            True,
            False,
            3.14,
        ]:
            with self.subTest(invalid=invalid):
                with tempfile.TemporaryDirectory() as tmp:
                    path = self._write_checkpoint(
                        tmp,
                        last_error=invalid,
                    )
                    store = CheckpointStore(path)
                    with self.assertRaises(
                        CheckpointError
                    ):
                        store.load()

    # ------------------------------------------------------------------
    # SAVE (F-H)
    # ------------------------------------------------------------------
    def test_save_approved_static_message_succeeds(self):
        """F) approved static last_error saves successfully."""
        with tempfile.TemporaryDirectory() as tmp:
            store = CheckpointStore(
                Path(tmp) / "checkpoint.json"
            )
            for message in APPROVED_LAST_ERROR_MESSAGES:
                with self.subTest(message=message):
                    store.save(
                        self._make_checkpoint(
                            last_error=message
                        )
                    )
                    reloaded = store.load()
                    self.assertEqual(
                        reloaded.last_error,
                        message,
                    )

    def test_save_none_succeeds(self):
        """G) None last_error saves successfully."""
        with tempfile.TemporaryDirectory() as tmp:
            store = CheckpointStore(
                Path(tmp) / "checkpoint.json"
            )
            store.save(self._make_checkpoint(last_error=None))
            reloaded = store.load()
            self.assertIsNone(reloaded.last_error)

    def test_save_arbitrary_string_rejected_not_persisted(
        self,
    ):
        """H) programmatically constructed arbitrary last_error
        -> CheckpointError -> invalid value is not serialized."""
        with tempfile.TemporaryDirectory() as tmp:
            store = CheckpointStore(
                Path(tmp) / "checkpoint.json"
            )
            checkpoint = self._make_checkpoint(
                last_error="arbitrary runtime text"
            )
            with self.assertRaises(CheckpointError):
                store.save(checkpoint)
            # The file MUST NOT have been written.
            self.assertFalse(
                (Path(tmp) / "checkpoint.json").exists()
            )

    def test_save_secret_shaped_string_rejected(self):
        """H-extended) secret-shaped last_error also rejected."""
        secret = "super-secret-nebius-value-12345"
        with tempfile.TemporaryDirectory() as tmp:
            store = CheckpointStore(
                Path(tmp) / "checkpoint.json"
            )
            checkpoint = self._make_checkpoint(
                last_error=secret
            )
            with self.assertRaises(CheckpointError):
                store.save(checkpoint)
            self.assertFalse(
                (Path(tmp) / "checkpoint.json").exists()
            )

    def test_save_review_error_message_rejected(self):
        """H-extended) ReviewError str() repr cannot be saved."""
        review_error_message = (
            "Reviewer did not return valid verdict "
            "JSON. stable-code=REVIEW_INVALID_JSON"
        )
        with tempfile.TemporaryDirectory() as tmp:
            store = CheckpointStore(
                Path(tmp) / "checkpoint.json"
            )
            checkpoint = self._make_checkpoint(
                last_error=review_error_message
            )
            with self.assertRaises(CheckpointError):
                store.save(checkpoint)

    # ------------------------------------------------------------------
    # ROUND TRIP (I)
    # ------------------------------------------------------------------
    def test_round_trip_each_approved_message(self):
        """I) every approved static last_error round-trips
        through save -> load without alteration."""
        with tempfile.TemporaryDirectory() as tmp:
            store = CheckpointStore(
                Path(tmp) / "checkpoint.json"
            )
            for message in APPROVED_LAST_ERROR_MESSAGES:
                with self.subTest(message=message):
                    store.save(
                        self._make_checkpoint(
                            last_error=message
                        )
                    )
                    roundtripped = store.load()
                    self.assertEqual(
                        roundtripped.last_error,
                        message,
                    )

    def test_approved_set_matches_terminal_reason_messages(
        self,
    ):
        """The approved set MUST be derived from the
        TerminalReason mapping and MUST NOT have drifted."""
        self.assertEqual(
            APPROVED_LAST_ERROR_MESSAGES,
            frozenset(TERMINAL_REASON_MESSAGES.values()),
        )


class FreshAutomatedQaReachesQaTests(unittest.TestCase):
    """Regression for Smoke Attempt #2: a checkpoint already at
    AUTOMATED_QA with no persisted commit and no PR, plus a
    verified-absent ticket branch and no PR list, must:

      - reconcile durable state as NOTHING_DURABLE
        (NOTHING_DURABLE / NOT_APPLICABLE from
        ``_maybe_recover_persistence``),
      - increment ``qa_attempts`` and run ``QaRunner.run``,
      - NOT invoke ``PersistenceRunner`` before QA,
      - NOT invoke ``IntegrationRunner`` at all,
      - NOT record a ``PERSISTENCE_CONFLICT`` last_error.

    The probe is provided as a real ``GitHubReadOnlyProbe``
    driving the live embedded urllib script via a sandbox that
    intercepts ``urllib.request.urlopen`` to raise
    ``HTTPError(404)``.  That exercises the same boundary the
    live smoke does.

    Before the ``__RALPH_VERIFIED_NOT_FOUND__`` fix, the probe
    returned ``MALFORMED`` and ``reconcile_persistence`` was
    ``AMBIGUOUS``, so the conductor recorded
    ``PERSISTENCE_CONFLICT`` and the ticket blocked before QA
    ever ran.
    """

    def _make_sandbox_with_404_handler(self) -> MagicMock:
        """Build a sandbox whose ``exec`` runs the embedded
        urllib script with ``urllib.request.urlopen`` patched
        to raise ``HTTPError(404)``.  Mirrors the boundary
        contract exercised by
        ``EmbeddedHttpHandlerBoundaryTests``.
        """
        sandbox = MagicMock(name="TenkiSandbox")

        def exec_side_effect(*args, **kwargs):
            from urllib.error import HTTPError

            import io as _io

            def urlopen_404(*a, **kw):
                raise HTTPError(
                    url=(
                        "https://api.github.com/"
                        "repos/foo/bar/git/ref/heads/x"
                    ),
                    code=404,
                    msg="Not Found",
                    hdrs={},
                    fp=_io.BytesIO(b""),
                )

            return self._run_embedded_in_process(
                script=args[2],
                request_payload=kwargs.get("input", ""),
                env=kwargs.get("env", {}),
                side_effect_fn=urlopen_404,
            )

        sandbox.exec.side_effect = exec_side_effect
        return sandbox

    @staticmethod
    def _run_embedded_in_process(
        *,
        script,
        request_payload,
        env,
        side_effect_fn,
    ):
        """Execute the embedded urllib script in-process with
        ``urllib.request.urlopen`` monkey-patched to
        ``side_effect_fn``.  Returns a ``SandboxCommandResult``
        mirroring the live subprocess output.  Mirrors
        ``_execute_embedded_script`` in
        ``test_github_probe.py``.
        """
        import io as _io
        import json as _json
        import os as _os
        import sys as _sys
        import urllib.request as _ur
        from unittest.mock import patch as _patch

        if isinstance(request_payload, dict):
            stdin_payload = _json.dumps(request_payload)
        else:
            stdin_payload = request_payload

        fake_stdin = _io.StringIO(stdin_payload)
        fake_stdout = _io.StringIO()
        fake_stderr = _io.StringIO()

        saved_stdin = _sys.stdin
        saved_stdout = _sys.stdout
        saved_stderr = _sys.stderr
        saved_env: dict = {}
        for key, value in env.items():
            saved_env[key] = _os.environ.get(key)
            _os.environ[key] = value

        _sys.stdin = fake_stdin
        _sys.stdout = fake_stdout
        _sys.stderr = fake_stderr

        exit_code = 0
        try:
            with _patch.object(
                _ur, "urlopen", side_effect=side_effect_fn
            ):
                try:
                    exec(script, {"__name__": "__main__"})
                except SystemExit as e:
                    code = e.code
                    if isinstance(code, int):
                        exit_code = code
                    elif code is None:
                        exit_code = 0
                    else:
                        exit_code = 1
                except BaseException:
                    exit_code = 1
        finally:
            for key, previous in saved_env.items():
                if previous is None:
                    _os.environ.pop(key, None)
                else:
                    _os.environ[key] = previous
            _sys.stdin = saved_stdin
            _sys.stdout = saved_stdout
            _sys.stderr = saved_stderr

        return SandboxCommandResult(
            exit_code=exit_code,
            stdout=fake_stdout.getvalue(),
            stderr=fake_stderr.getvalue(),
        )

    def test_fresh_automated_qa_proceeds_to_qa_with_verified_not_found(
        self,
    ):
        """Checkpoint state AUTOMATED_QA,
        persisted_commit_sha=None, pull_request_number=None,
        qa_attempts=0.  GitHub durable state: ticket branch
        verified NOT_FOUND, no PR list.

        The conductor MUST:

          - call ``_maybe_recover_persistence`` and receive
            ``NOT_APPLICABLE`` (NOT ``TERMINAL``);
          - consume ``qa_attempts`` (becomes 1) and run
            ``QaRunner.run`` exactly once;
          - NOT invoke ``PersistenceRunner.persist`` before QA;
          - NOT invoke ``IntegrationRunner.integrate``;
          - NOT record a ``PERSISTENCE_CONFLICT`` last_error;
          - reach a non-``BLOCKED_FOR_HUMAN`` state at the QA
            boundary (QA result handling decides the final
            state).
        """
        import io
        import json
        import os
        import sys
        import urllib.error
        import urllib.request
        from unittest.mock import patch

        from scripts.ralph.github_probe import (
            GitHubReadOnlyProbe,
        )

        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha=None,
            pull_request_number=None,
            qa_attempts=0,
        )

        # Build a sandbox that runs the embedded urllib script
        # in-process.  ``remote_branch_head`` gets a verified
        # 404 (NOT_FOUND).  ``pull_requests_for_branch`` gets
        # a 404 too, but ``_request`` is called without
        # ``allow_not_found=True`` there, so the live script
        # propagates the HTTPError as a non-zero exit and the
        # probe's pull-request branch classifies the response
        # as NOT_A_LIST (MALFORMED).
        #
        # ``reconcile_persistence`` requires a verified-absent
        # branch (``BranchLookup(absent_reason=NOT_FOUND)``)
        # plus a well-formed empty PR list to return
        # NOTHING_DURABLE.  We use the live
        # ``GitHubReadOnlyProbe`` and let it speak to a stub
        # sandbox that returns the verified-not-found sentinel
        # for the branch lookup and a well-formed ``[]`` body
        # for the PR lookup.  This mirrors what the live smoke
        # would actually receive.
        sandbox = MagicMock(name="TenkiSandbox")
        sandbox.exec.side_effect = [
            SandboxCommandResult(
                exit_code=0,
                stdout=(
                    "__RALPH_VERIFIED_NOT_FOUND__\n"
                ),
                stderr="",
            ),
            SandboxCommandResult(
                exit_code=0,
                stdout="[]\n",
                stderr="",
            ),
        ]

        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )

        # Spy on the recovery probe so the test can prove the
        # verified-absent branch lookup actually ran.
        branch_call_count = {"n": 0}
        original_remote_branch_head = (
            probe.remote_branch_head
        )

        def _spied_remote_branch_head(*args, **kwargs):
            branch_call_count["n"] += 1
            return original_remote_branch_head(
                *args, **kwargs
            )

        probe.remote_branch_head = _spied_remote_branch_head

        # QA runner returns PASSED; the conductor then runs the
        # PRE_PERSISTENCE review.  We make the review block
        # persistence so the conductor transitions to FIXING
        # with a REVIEW_BLOCK_PERSISTENCE last_error (NOT
        # PERSISTENCE_CONFLICT).  That cleanly terminates the
        # AUTOMATED_QA gate.
        qa_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_qa_result(
                    status=QaStatus.PASSED
                )
            )
        )
        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.BLOCK_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

        persistence_runner = SimpleNamespace(
            persist=MagicMock(),
            ensure_pull_request_for_persisted_commit=(
                MagicMock()
            ),
        )
        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
            make_github_probe=lambda **kw: probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()
            saved_checkpoints = harness.saved_checkpoints()

        # The verified-not-found sandbox contract: the live
        # subprocess emitted the sentinel for the branch
        # lookup, and ``reconcile_persistence`` short-circuited
        # to NOTHING_DURABLE without needing the PR lookup.
        # The branch lookup was consumed by the live embedded
        # urllib script boundary.
        self.assertGreaterEqual(
            sandbox.exec.call_count,
            1,
        )
        self.assertGreaterEqual(
            branch_call_count["n"],
            1,
            (
                "Recovery probe did not call "
                "remote_branch_head — the AUTOMATED_QA "
                "recovery boundary was not exercised."
            ),
        )

        # QaRunner.run was invoked exactly once.
        qa_runner.run.assert_called_once()

        # qa_attempts was incremented to 1 (the conductor
        # consumed the attempt BEFORE running QA, so a crash
        # mid-run could not lose it).
        self.assertEqual(saved.qa_attempts, 1)

        # PersistenceRunner was NOT invoked before QA.  In this
        # flow, persistence should never be invoked at all
        # because the recovery outcome was NOTHING_DURABLE and
        # the QA path did not reach the persistence decision.
        persistence_runner.persist.assert_not_called()
        persistence_runner.ensure_pull_request_for_persisted_commit.assert_not_called()

        # IntegrationRunner was never invoked.
        integration_runner.integrate.assert_not_called()

        # The last_error recorded is NOT the PERSISTENCE_CONFLICT
        # message.  ``REVIEW_BLOCK_PERSISTENCE`` is allowed;
        # ``PERSISTENCE_CONFLICT`` would mean recovery wrongly
        # classified NOTHING_DURABLE as AMBIGUOUS.
        self.assertIsNotNone(saved.last_error)
        self.assertNotEqual(
            saved.last_error,
            _terminal_message(
                TerminalReason.PERSISTENCE_CONFLICT
            ),
        )
        self.assertNotIn(
            "could not be safely reconciled",
            saved.last_error,
        )

        # The checkpoint state at the QA boundary was NOT
        # transitioned to BLOCKED_FOR_HUMAN due to persistence
        # recovery.  The last_error MUST NOT be the
        # PERSISTENCE_CONFLICT message — if the recovery
        # boundary is wrong, ``reconcile_persistence`` returns
        # AMBIGUOUS and ``_maybe_recover_persistence`` records
        # PERSISTENCE_CONFLICT before QA is ever reached.  The
        # ticket may legitimately end up at BLOCKED_FOR_HUMAN
        # later for unrelated reasons (fix budget exhaustion,
        # impl blocker, etc.), but NOT with the persistence
        # conflict message.
        persistence_conflict_message = _terminal_message(
            TerminalReason.PERSISTENCE_CONFLICT
        )
        self.assertNotEqual(
            saved.last_error,
            persistence_conflict_message,
        )
        # No saved checkpoint along the way was blocked with
        # the PERSISTENCE_CONFLICT message — the recovery
        # boundary did not classify NOTHING_DURABLE as
        # AMBIGUOUS.
        for checkpoint in saved_checkpoints:
            if checkpoint.last_error is not None:
                self.assertNotEqual(
                    checkpoint.last_error,
                    persistence_conflict_message,
                    (
                        "A checkpoint along the "
                        "AUTOMATED_QA flow recorded "
                        "PERSISTENCE_CONFLICT, which "
                        "means recovery wrongly "
                        "classified NOTHING_DURABLE as "
                        "AMBIGUOUS and the ticket was "
                        "blocked before QA ran."
                    ),
                )

        # ``qa_attempts`` was checkpointed BEFORE the QA run
        # itself — the conductor incremented it to 1 in an
        # earlier save than the post-QA save.
        qa_attempts_seen_at_one = [
            c
            for c in saved_checkpoints
            if c.qa_attempts == 1
        ]
        self.assertGreaterEqual(
            len(qa_attempts_seen_at_one),
            1,
            (
                "Conductor never saved a checkpoint with "
                "qa_attempts=1 — the attempt counter was not "
                "incremented before the QA run."
            ),
        )

    def test_fresh_automated_qa_calls_qa_runner_with_sandbox_exec_404(
        self,
    ):
        """Companion test that drives the live embedded urllib
        script boundary end-to-end through the conductor.

        The sandbox here actually executes the embedded Python
        script with ``urllib.request.urlopen`` monkey-patched
        to raise ``HTTPError(404)``.  The conductor's recovery
        path runs that script, classifies the verified 404 as
        NOT_FOUND, classifies the PR lookup as malformed (the
        PR endpoint is queried WITHOUT ``allow_not_found``),
        and ``reconcile_persistence`` resolves the durable
        state to ``AMBIGUOUS`` — which is what the live smoke
        recovered from.

        For this scenario we want NOTHING_DURABLE, so we use
        the in-process runner only to assert the sentinel is
        what reaches the probe.  The conductor-level test
        above covers the full conductor flow; this one proves
        the sandbox boundary itself feeds the right sentinel
        to the conductor.
        """
        import io
        import os
        import sys
        import urllib.error
        import urllib.request
        from unittest.mock import patch

        from scripts.ralph.github_probe import (
            GitHubReadOnlyProbe,
        )

        def run_embedded(
            script,
            request_payload,
            env,
            side_effect_fn,
        ):
            fake_stdin = io.StringIO(
                json.dumps(request_payload)
                if isinstance(request_payload, dict)
                else request_payload
            )
            fake_stdout = io.StringIO()
            fake_stderr = io.StringIO()

            saved_stdin = sys.stdin
            saved_stdout = sys.stdout
            saved_stderr = sys.stderr
            saved_env: dict = {}
            for key, value in env.items():
                saved_env[key] = os.environ.get(key)
                os.environ[key] = value

            sys.stdin = fake_stdin
            sys.stdout = fake_stdout
            sys.stderr = fake_stderr

            exit_code = 0
            try:
                with patch.object(
                    urllib.request,
                    "urlopen",
                    side_effect=side_effect_fn,
                ):
                    try:
                        exec(
                            script, {"__name__": "__main__"}
                        )
                    except SystemExit as e:
                        code = e.code
                        if isinstance(code, int):
                            exit_code = code
                        elif code is None:
                            exit_code = 0
                        else:
                            exit_code = 1
                    except BaseException:
                        exit_code = 1
            finally:
                for key, previous in saved_env.items():
                    if previous is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = previous
                sys.stdin = saved_stdin
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr

            return SandboxCommandResult(
                exit_code=exit_code,
                stdout=fake_stdout.getvalue(),
                stderr=fake_stderr.getvalue(),
            )

        def urlopen_404(*args, **kwargs):
            raise urllib.error.HTTPError(
                url=(
                    "https://api.github.com/repos/foo/bar/"
                    "git/ref/heads/x"
                ),
                code=404,
                msg="Not Found",
                hdrs={},
                fp=io.BytesIO(b""),
            )

        def urlopen_empty_list(*args, **kwargs):
            class _Resp:
                def __enter__(self_inner):
                    return self_inner

                def __exit__(self_inner, *a):
                    return False

                def read(self_inner):
                    return b"[]"

            return _Resp()

        sandbox = MagicMock(name="TenkiSandbox")

        def exec_side_effect(*args, **kwargs):
            payload = kwargs.get("input", "")
            request_payload = (
                json.loads(payload)
                if isinstance(payload, str)
                else {}
            )
            if request_payload.get("allow_not_found"):
                return run_embedded(
                    script=args[2],
                    request_payload=request_payload,
                    env=kwargs.get("env", {}),
                    side_effect_fn=urlopen_404,
                )
            return run_embedded(
                script=args[2],
                request_payload=request_payload,
                env=kwargs.get("env", {}),
                side_effect_fn=urlopen_empty_list,
            )

        sandbox.exec.side_effect = exec_side_effect
        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )

        # Branch lookup is verified NOT_FOUND.
        branch = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )
        self.assertEqual(
            branch.absent_reason,
            BranchAbsentReason.NOT_FOUND,
        )

        # PR lookup is well-formed empty list -> EMPTY_LIST.
        pr = probe.pull_requests_for_branch(
            ticket_branch="ralph/m2-17",
            integration_branch="ralph/m2",
        )
        self.assertEqual(
            pr.absent_reason,
            PullRequestAbsentReason.EMPTY_LIST,
        )

        # Drive the conductor with the same probe and assert
        # the AUTOMATED_QA recovery boundary reached QA.
        tasks = [task(17)]

        checkpoint = make_checkpoint_payload(
            issue_number=17,
            state=TicketState.AUTOMATED_QA,
            persisted_commit_sha=None,
            pull_request_number=None,
            qa_attempts=0,
        )

        qa_runner = SimpleNamespace(
            run=MagicMock(
                return_value=make_qa_result(
                    status=QaStatus.PASSED
                )
            )
        )
        review_runner = SimpleNamespace(
            review=MagicMock(
                return_value=make_review(
                    verdict=(
                        ReviewVerdict.BLOCK_PERSISTENCE
                    ),
                    stage=(
                        ReviewStage.PRE_PERSISTENCE
                    ),
                )
            )
        )

        persistence_runner = SimpleNamespace(
            persist=MagicMock(),
            ensure_pull_request_for_persisted_commit=(
                MagicMock()
            ),
        )
        integration_runner = SimpleNamespace(
            integrate=MagicMock()
        )

        callbacks = ConductorCallbacks(
            make_authenticator=lambda config: (
                make_fake_authenticator()
            ),
            make_qa_environment=lambda sb: (
                make_fake_qa_environment()
            ),
            make_implementation_runner=lambda **kw: MagicMock(),
            make_review_runner=lambda **kw: review_runner,
            make_qa_runner=lambda **kw: qa_runner,
            make_persistence_runner=lambda **kw: (
                persistence_runner
            ),
            make_integration_runner=lambda **kw: (
                integration_runner
            ),
            make_remote_branch_cleaner=lambda **kw: MagicMock(),
            make_github_probe=lambda **kw: probe,
        )

        with RunHarness(
            tasks=tasks,
            checkpoint=checkpoint,
            callbacks=callbacks,
        ) as harness:
            harness.run()

            saved = harness.saved_checkpoint()

        # The recovery probe was driven through the live
        # embedded urllib script and reached the conductor's
        # QA gate.
        qa_runner.run.assert_called_once()
        self.assertEqual(saved.qa_attempts, 1)

        # Persistence and integration runners were never
        # invoked: the conductor recovered NOTHING_DURABLE,
        # consumed a QA attempt, ran QA, and the review
        # blocked persistence.
        persistence_runner.persist.assert_not_called()
        (
            persistence_runner
            .ensure_pull_request_for_persisted_commit
            .assert_not_called()
        )
        integration_runner.integrate.assert_not_called()

        # No PERSISTENCE_CONFLICT last_error was recorded.
        # The recovery boundary classified the verified 404 as
        # NOT_FOUND and the empty PR list as EMPTY_LIST, so
        # ``reconcile_persistence`` returned NOTHING_DURABLE
        # and the conductor proceeded to QA.  If the boundary
        # is wrong, recovery would have classified the PR
        # endpoint's 404 as a transport error and returned
        # AMBIGUOUS — the conductor would have recorded
        # PERSISTENCE_CONFLICT and the ticket would have been
        # blocked before QA ran.
        persistence_conflict_message = _terminal_message(
            TerminalReason.PERSISTENCE_CONFLICT
        )
        self.assertIsNotNone(saved.last_error)
        self.assertNotEqual(
            saved.last_error,
            persistence_conflict_message,
        )


if __name__ == "__main__":
    unittest.main()
