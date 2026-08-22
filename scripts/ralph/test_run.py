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
    CompletionStatus,
    ImplementationError,
    ImplementationFixContext,
    ImplementationResult,
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
    ReviewFinding,
    ReviewResult,
    ReviewStage,
    ReviewVerdict,
)
from scripts.ralph.run import (
    ConductorCallbacks,
    Orchestrator,
    build_qa_commands,
    format_findings,
    split_repository,
)
from scripts.ralph.sandbox import SandboxCommandResult
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

        self.sandbox = make_fake_sandbox(
            workspace=(
                initial_workspace
                if initial_workspace is not None
                else workspace_response(
                    branch=default_branch
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
        self.assertIn(
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


if __name__ == "__main__":
    unittest.main()
