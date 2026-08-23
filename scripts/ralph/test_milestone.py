"""Unit tests for scripts.ralph.milestone.

These tests MUST NOT make real Tenki, MiniMax, Nebius, PostgreSQL,
or GitHub calls.  The milestone runner is tested by injecting
fake ``Orchestrator`` instances and a fake ``GitHubTaskSource``
so the discovery sequence and the per-ticket terminal state can
be controlled without any external system.
"""

import io
import json
import os
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

from scripts.ralph.checkpoint import (
    CheckpointError,
    CheckpointStore,
    TicketCheckpoint,
)
from scripts.ralph.github_source import (
    GitHubTask,
)
from scripts.ralph.milestone import (
    MilestoneResult,
    MilestoneRunner,
    MilestoneRunnerCallbacks,
    MilestoneStatus,
)
from scripts.ralph.review import ReviewStage
from scripts.ralph.states import TicketState


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


def make_checkpoint_payload(
    *,
    issue_number: int,
    state: TicketState,
    ticket_branch: Optional[str] = None,
    base_sha: str = "base123",
    ticket_sha: str = "ticket123",
):
    if ticket_branch is None:
        ticket_branch = f"ralph/m2-{issue_number}"
    return {
        "schema_version": 2,
        "milestone_id": "m2",
        "issue_number": issue_number,
        "state": state.value,
        "integration_branch": "ralph/m2",
        "ticket_branch": ticket_branch,
        "base_sha": base_sha,
        "ticket_sha": ticket_sha,
        "implementation_session_id": None,
        "review_attempts": 0,
        "review_cycles_consumed": 0,
        "qa_attempts": 0,
        "implementation_attempts": 0,
        "fix_attempts": 0,
        "persisted_commit_sha": None,
        "pull_request_number": None,
        "review_stage": ReviewStage.PRE_QA.value,
        "qa_evidence": None,
        "last_error": None,
        "pre_qa_findings": None,
        "qa_failure_evidence": None,
        "pre_persistence_findings": None,
    }


class _FakeAuthenticator:
    def mint_repository_token(self, *, owner, repository):
        return SimpleNamespace(token="ghs_fake")


class _FakeOrchestrator:
    """Stand-in for ``Orchestrator`` that records every
    instantiation and every ``run()`` call.

    The milestone runner MUST instantiate one fresh
    ``Orchestrator`` per ticket and MUST call ``run()``
    exactly once per ticket.  This fake enforces both
    invariants at the test layer so a regression in the
    production code is caught.

    On ``HUMAN_QA_PENDING`` the fake mirrors the production
    Orchestrator's checkpoint-clear behavior so subsequent
    milestone iterations behave like a real between-tickets
    restart.
    """

    def __init__(
        self,
        *,
        config_path,
        checkpoint_path,
        return_values=None,
    ):
        self.config_path = config_path
        self.checkpoint_path = Path(checkpoint_path)
        self.run_calls = 0

        if return_values is None:
            return_values = [TicketState.HUMAN_QA_PENDING]
        self._return_values = list(return_values)

        MilestoneHarness.orchestrator_instances.append(self)

    def run(self) -> TicketState:
        self.run_calls += 1
        if not self._return_values:
            result = TicketState.HUMAN_QA_PENDING
        else:
            result = self._return_values.pop(0)

        if result == TicketState.HUMAN_QA_PENDING:
            # Production Orchestrator clears the
            # checkpoint when it transitions to
            # HUMAN_QA_PENDING.  Mirror that here so the
            # milestone runner sees a real
            # between-tickets state on the next iteration.
            try:
                if self.checkpoint_path.exists():
                    self.checkpoint_path.unlink()
            except OSError:
                pass

        return result


class MilestoneHarness:
    """Test harness for ``MilestoneRunner``.

    Provides:

    - a temporary config + checkpoint path,
    - a controllable sequence of ``GitHubTaskSource.list_tasks``
      return values,
    - a controllable sequence of ``Orchestrator.run()`` return
      values,
    - instrumentation: count of Orchestrator instances, count
      of ``run()`` calls, and the discovery sequence.
    """

    orchestrator_instances: list = []

    def __init__(
        self,
        *,
        discovery_sequence: list,
        orchestrator_returns: Optional[
            list
        ] = None,
        checkpoint: Optional[dict] = None,
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
        self.config_path.write_text(
            json.dumps(CONFIG)
        )

        self.checkpoint_path = (
            self.root / "checkpoint.json"
        )

        if checkpoint is not None:
            self.checkpoint_path.write_text(
                json.dumps(checkpoint)
            )

        # Sequence of task lists returned by successive
        # ``list_tasks`` calls.  First call is for the
        # initial discovery, subsequent calls are for
        # rediscovery after each successful ticket.
        self._discovery_sequence = list(
            discovery_sequence
        )
        self.discovery_calls = 0

        # Sequence of return values for successive
        # ``Orchestrator.run()`` calls.
        self._orchestrator_returns = list(
            orchestrator_returns
            or [TicketState.HUMAN_QA_PENDING]
        )

        # Reset the shared list so each test starts clean.
        MilestoneHarness.orchestrator_instances = []

        # Patch the milestone runner's discovery to feed
        # the next pre-canned task list.
        from scripts.ralph import milestone as milestone_mod

        self._discovery_patcher = unittest.mock.patch.object(
            MilestoneRunner,
            "_discover_tasks",
            side_effect=self._next_discovery,
        )
        self._discovery_patcher.start()

        # Patch the milestone runner's authenticator
        # builder so it does not try to read real
        # environment values.
        self._auth_patcher = unittest.mock.patch.object(
            milestone_mod,
            "build_authenticator",
            return_value=_FakeAuthenticator(),
        )
        self._auth_patcher.start()

        # Patch ``GitHubTaskSource.list_tasks`` in case the
        # production code path is exercised (the
        # ``_discover_tasks`` patch above already intercepts
        # before it would be called, but patching the
        # underlying call keeps the test robust).
        from scripts.ralph.github_source import (
            GitHubTaskSource,
        )

        self._source_patcher = unittest.mock.patch.object(
            GitHubTaskSource,
            "list_tasks",
            side_effect=lambda: (
                self._discovery_sequence[
                    self.discovery_calls - 1
                ]
                if self.discovery_calls > 0
                else self._next_discovery()
            ),
        )
        self._source_patcher.start()

        # Inject the fake orchestrator factory.  Each
        # factory call MUST yield a fresh orchestrator
        # that owns its own copy of the return-value
        # sequence — two tickets in a milestone must
        # each receive the first configured value, not
        # share a single mutable list.
        self._runner_callbacks = MilestoneRunnerCallbacks(
            make_orchestrator=lambda **kw: _FakeOrchestrator(
                config_path=kw["config_path"],
                checkpoint_path=kw["checkpoint_path"],
                return_values=list(
                    self._orchestrator_returns
                ),
            ),
        )

        self.runner = MilestoneRunner(
            config_path=str(self.config_path),
            checkpoint_path=self.checkpoint_path,
            callbacks=self._runner_callbacks,
        )

    def _next_discovery(self, **kwargs) -> list:
        del kwargs
        self.discovery_calls += 1
        if not self._discovery_sequence:
            return []
        return list(
            self._discovery_sequence.pop(0)
        )

    def run(self) -> MilestoneResult:
        return self.runner.run()

    def close(self):
        try:
            self._discovery_patcher.stop()
            self._auth_patcher.stop()
            self._source_patcher.stop()
        finally:
            self.tempdir.cleanup()
            for key, value in (
                self._saved_env.items()
            ):
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


# ---------------------------------------------------------------------------
# A. Two independent tickets
# ---------------------------------------------------------------------------


class TwoIndependentTicketsTests(unittest.TestCase):
    def test_two_independent_tickets_run_sequentially(self):
        discovery = [
            # Initial discovery: both OPEN.
            [
                task(10),
                task(11),
            ],
            # Rediscovery after #10 succeeds: #10 CLOSED.
            [
                task(10, state="CLOSED"),
                task(11),
            ],
            # Rediscovery after #11 succeeds: both CLOSED.
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        self.assertEqual(
            result.completed_tickets,
            (10, 11),
        )
        self.assertIsNone(result.current_issue)

        # Fresh Orchestrator instance per ticket.
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            2,
        )

        # Each Orchestrator ran exactly once.
        for instance in (
            MilestoneHarness.orchestrator_instances
        ):
            self.assertEqual(instance.run_calls, 1)

        # Discovery was called three times: initial +
        # one after each ticket.
        self.assertEqual(harness.discovery_calls, 3)


# ---------------------------------------------------------------------------
# B. Dependency unlock
# ---------------------------------------------------------------------------


class DependencyUnlockTests(unittest.TestCase):
    def test_dependency_unblock_after_dependency_closes(self):
        discovery = [
            # Initial: #10 ready, #11 blocked by #10.
            [
                task(10),
                task(
                    11,
                    dependencies=(10,),
                ),
            ],
            # Rediscovery: #10 closed, #11 ready.
            [
                task(10, state="CLOSED"),
                task(
                    11,
                    dependencies=(10,),
                ),
            ],
            # Rediscovery: both closed.
            [
                task(10, state="CLOSED"),
                task(
                    11,
                    state="CLOSED",
                    dependencies=(10,),
                ),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        self.assertEqual(
            result.completed_tickets,
            (10, 11),
        )
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            2,
        )


# ---------------------------------------------------------------------------
# C. Single-ticket failure stops milestone
# ---------------------------------------------------------------------------


class SingleTicketFailureStopsMilestoneTests(
    unittest.TestCase
):
    def _setup_two_open_tasks(self):
        return [
            [
                task(10),
                task(11),
            ],
        ]

    def test_blocked_for_human_stops_milestone(self):
        with MilestoneHarness(
            discovery_sequence=(
                self._setup_two_open_tasks()
            ),
            orchestrator_returns=[
                TicketState.BLOCKED_FOR_HUMAN,
            ],
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )
        self.assertEqual(
            result.current_issue,
            10,
        )
        # #11 must never be invoked.
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            1,
        )
        self.assertEqual(
            MilestoneHarness
            .orchestrator_instances[0]
            .run_calls,
            1,
        )

    def test_infra_failure_stops_milestone(self):
        with MilestoneHarness(
            discovery_sequence=(
                self._setup_two_open_tasks()
            ),
            orchestrator_returns=[
                TicketState.INFRA_FAILURE,
            ],
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.INFRA_FAILURE,
        )
        self.assertEqual(
            result.current_issue,
            10,
        )
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            1,
        )

    def test_agent_failure_stops_milestone(self):
        with MilestoneHarness(
            discovery_sequence=(
                self._setup_two_open_tasks()
            ),
            orchestrator_returns=[
                TicketState.AGENT_FAILURE,
            ],
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.AGENT_FAILURE,
        )
        self.assertEqual(
            result.current_issue,
            10,
        )
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            1,
        )

    def test_blocked_keeps_checkpoint_intact(self):
        # The Orchestrator's own checkpoint clear/save
        # behavior is exercised in test_run.py.  At the
        # milestone layer we only require that the runner
        # does NOT clear the checkpoint on its own when
        # stopping.
        checkpoint = make_checkpoint_payload(
            issue_number=10,
            state=TicketState.IMPLEMENTING,
        )

        with MilestoneHarness(
            discovery_sequence=(
                self._setup_two_open_tasks()
            ),
            orchestrator_returns=[
                TicketState.BLOCKED_FOR_HUMAN,
            ],
            checkpoint=checkpoint,
        ) as harness:
            # The Orchestrator instance is a fake in this
            # test, so it will NOT touch the checkpoint
            # itself.  The milestone runner must also not
            # delete it.
            result = harness.run()

            self.assertTrue(
                harness.checkpoint_path.exists()
            )

        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )


# ---------------------------------------------------------------------------
# D. No eligible work is not complete
# ---------------------------------------------------------------------------


class NoEligibleWorkTests(unittest.TestCase):
    def test_missing_required_label_not_complete(self):
        # #10 OPEN but missing the required label.
        discovery = [
            [
                task(
                    10,
                    labels=(),
                ),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.NO_ELIGIBLE_WORK,
        )
        # Orchestrator must NEVER be invoked.
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            0,
        )

    def test_unresolved_dependency_not_complete(self):
        # #10 OPEN, #11 OPEN but blocked by #10.  10 is
        # eligible; 11 is NOT.  Ralph must NOT mark the
        # milestone complete while 11 is still open.
        # After #10 closes, 11 becomes eligible and the
        # milestone should continue to completion.
        discovery = [
            [
                task(10),
                task(
                    11,
                    dependencies=(10,),
                ),
            ],
            [
                task(10, state="CLOSED"),
                task(
                    11,
                    dependencies=(10,),
                ),
            ],
            [
                task(10, state="CLOSED"),
                task(
                    11,
                    state="CLOSED",
                    dependencies=(10,),
                ),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        # Both tickets ran; milestone is complete.
        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        self.assertEqual(
            result.completed_tickets,
            (10, 11),
        )

    def test_skip_label_not_complete(self):
        # #10 has the required label but also a skip
        # label.  Execution frontier is empty.
        discovery = [
            [
                task(
                    10,
                    labels=(
                        "ready-for-ralph",
                        "needs-reshaping",
                    ),
                ),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.NO_ELIGIBLE_WORK,
        )
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            0,
        )


# ---------------------------------------------------------------------------
# E. All closed is complete (no Tenki, no checkpoint touch)
# ---------------------------------------------------------------------------


class AllClosedIsCompleteTests(unittest.TestCase):
    def test_all_closed_immediately_complete(self):
        discovery = [
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            # Capture stdout so we can prove the runner
            # printed the expected milestone-level line.
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = harness.run()

            output = buffer.getvalue()

        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        self.assertEqual(
            result.completed_tickets,
            (),
        )
        self.assertIsNone(result.current_issue)

        # No Orchestrator was instantiated.
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            0,
        )

        # Only the initial discovery call is made.
        self.assertEqual(
            harness.discovery_calls, 1
        )

        self.assertIn(
            "RALPH MILESTONE: COMPLETE", output
        )

    def test_parent_issue_excluded_from_completion_check(
        self,
    ):
        # #10 OPEN, #12 OPEN (parent).  The parent is
        # excluded from the completion predicate.  The
        # orchestrator returns HUMAN_QA_PENDING but #10
        # remains open.  The no-progress guard must trip
        # even though the parent issue keeps the
        # completion predicate from being True.
        discovery = [
            [
                task(10),
                task(12),
            ],
            [
                task(10),
                task(12),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        # #10 is eligible.  Orchestrator runs once and
        # returns HUMAN_QA_PENDING.  Rediscovery shows
        # #10 still open AND #12 still open, so the
        # no-progress guard trips.
        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )


# ---------------------------------------------------------------------------
# F. No-progress guard
# ---------------------------------------------------------------------------


class NoProgressGuardTests(unittest.TestCase):
    def test_human_qa_pending_but_issue_still_open_stops(
        self,
    ):
        discovery = [
            # Initial: #10 OPEN.
            [task(10)],
            # Rediscovery after Orchestrator returns
            # HUMAN_QA_PENDING: #10 STILL OPEN.
            [task(10)],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
            orchestrator_returns=[
                TicketState.HUMAN_QA_PENDING,
            ],
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )
        self.assertEqual(
            result.current_issue,
            10,
        )
        # No second Orchestrator instantiation.
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            1,
        )
        self.assertEqual(
            MilestoneHarness
            .orchestrator_instances[0]
            .run_calls,
            1,
        )

    def test_no_progress_with_other_open_tickets_stops(
        self,
    ):
        discovery = [
            # Initial: #10 OPEN, #11 OPEN eligible too.
            [task(10), task(11)],
            # Rediscovery after Orchestrator returns
            # HUMAN_QA_PENDING: #10 STILL OPEN, #11 OPEN.
            [task(10), task(11)],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
            orchestrator_returns=[
                TicketState.HUMAN_QA_PENDING,
            ],
        ) as harness:
            result = harness.run()

        # No-progress guard must trip: #10 is still open
        # and the milestone is NOT complete because
        # other open tickets remain.
        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            1,
        )


# ---------------------------------------------------------------------------
# G. Restart with existing ticket checkpoint
# ---------------------------------------------------------------------------


class RestartWithExistingCheckpointTests(
    unittest.TestCase
):
    def test_resume_via_checkpoint_then_run_next_ticket(
        self,
    ):
        checkpoint = make_checkpoint_payload(
            issue_number=10,
            state=TicketState.IMPLEMENTING,
        )

        # With the new runner, an existing checkpoint
        # short-circuits the initial discovery: the
        # runner goes straight to resume.  The first
        # discovery call therefore happens AFTER the
        # Orchestrator returns HUMAN_QA_PENDING for
        # #10.  The discovery sequence below reflects
        # that ordering: post-#10 state, then post-#11
        # state.
        discovery = [
            # Post-#10 state (after Orchestrator cleared
            # its checkpoint): #10 closed.
            [
                task(10, state="CLOSED"),
                task(11),
            ],
            # Post-#11 state: both closed.
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        self.assertEqual(
            result.completed_tickets,
            (10, 11),
        )
        # Two Orchestrator instances: one for the
        # checkpoint-resumed #10 ticket, one for #11.
        self.assertEqual(
            len(
                MilestoneHarness.orchestrator_instances
            ),
            2,
        )


# ---------------------------------------------------------------------------
# H. Observability
# ---------------------------------------------------------------------------


class ObservabilityTests(unittest.TestCase):
    def test_no_tokens_or_model_text_in_milestone_output(
        self,
    ):
        discovery = [
            [task(10), task(11)],
            [
                task(10, state="CLOSED"),
                task(11),
            ],
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                harness.run()
            output = buffer.getvalue()

        # Expected milestone-level lines appear.
        self.assertIn(
            "RALPH MILESTONE: starting m2", output
        )
        self.assertIn(
            "RALPH MILESTONE: executing issue #10",
            output,
        )
        self.assertIn(
            "RALPH MILESTONE: issue #10 completed",
            output,
        )
        self.assertIn(
            "RALPH MILESTONE: rediscovering tasks",
            output,
        )
        self.assertIn(
            "RALPH MILESTONE: executing issue #11",
            output,
        )
        self.assertIn(
            "RALPH MILESTONE: issue #11 completed",
            output,
        )
        self.assertIn(
            "RALPH MILESTONE: COMPLETE — 2 tickets "
            "completed",
            output,
        )

        # Forbidden content: secrets, exception text,
        # model output, QA stdout/stderr.
        for forbidden in (
            "ghs_",
            "OPENAI",
            "NEBIUS",
            "MINIMAX",
            "Traceback",
            "Error",
        ):
            self.assertNotIn(forbidden, output)

    def test_stopped_state_prints_safe_summary(self):
        discovery = [
            [task(10), task(11)],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
            orchestrator_returns=[
                TicketState.BLOCKED_FOR_HUMAN,
            ],
        ) as harness:
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                harness.run()
            output = buffer.getvalue()

        self.assertIn(
            "RALPH MILESTONE: stopped on issue #10 "
            "— BLOCKED_FOR_HUMAN",
            output,
        )

    def test_no_eligible_work_prints_safe_summary(self):
        discovery = [
            [task(10, labels=())],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                harness.run()
            output = buffer.getvalue()

        self.assertIn(
            "RALPH MILESTONE: no eligible "
            "execution-frontier tickets; 1 open "
            "milestone tickets remain.",
            output,
        )


# ---------------------------------------------------------------------------
# I. CLI integration
# ---------------------------------------------------------------------------


class CliModeMutualExclusionTests(unittest.TestCase):
    def test_no_mode_prints_help(self):
        from scripts.ralph.run import main

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            exit_code = main([])
        output = buffer.getvalue()

        self.assertEqual(exit_code, 0)
        self.assertIn("--next", output)
        self.assertIn("--milestone", output)
        self.assertIn("--config", output)
        self.assertIn("--checkpoint", output)

    def test_next_and_milestone_mutually_exclusive(self):
        from scripts.ralph.run import main

        # argparse exits the process with code 2 on
        # ``parser.error``; assert that behavior here.
        with self.assertRaises(SystemExit) as cm:
            main(["--next", "--milestone"])

        self.assertEqual(cm.exception.code, 2)

    def test_milestone_dispatches_to_milestone_runner(self):
        from scripts.ralph import milestone as milestone_mod
        from scripts.ralph.run import main

        # Patch the runner constructor so the CLI call
        # never touches real config or discovery.
        sentinel_result = MilestoneResult(
            status=MilestoneStatus.COMPLETE,
            completed_tickets=(10,),
            current_issue=None,
        )

        captured: dict = {}

        class FakeRunner:
            def __init__(self, **kw):
                captured["kwargs"] = kw

            def run(self):
                captured["ran"] = True
                return sentinel_result

        with unittest.mock.patch.object(
            milestone_mod,
            "MilestoneRunner",
            FakeRunner,
        ):
            exit_code = main(["--milestone"])

        self.assertEqual(exit_code, 0)
        self.assertTrue(captured.get("ran"))
        self.assertIn(
            "config_path", captured["kwargs"]
        )
        self.assertIn(
            "checkpoint_path", captured["kwargs"]
        )

    def test_milestone_non_complete_returns_nonzero(self):
        from scripts.ralph import milestone as milestone_mod
        from scripts.ralph.run import main

        sentinel_result = MilestoneResult(
            status=MilestoneStatus.STOPPED_FOR_HUMAN,
            completed_tickets=(),
            current_issue=17,
        )

        class FakeRunner:
            def __init__(self, **kw):
                pass

            def run(self):
                return sentinel_result

        with unittest.mock.patch.object(
            milestone_mod,
            "MilestoneRunner",
            FakeRunner,
        ):
            exit_code = main(["--milestone"])

        self.assertNotEqual(exit_code, 0)

    def test_next_still_invokes_orchestrator(self):
        from scripts.ralph import run as run_mod
        from scripts.ralph.run import main

        # ``main`` constructs ``Orchestrator(config_path,
        # checkpoint_path)``.  Patch the class to a fake
        # that records the invocation and returns a
        # terminal state so ``--next`` exits cleanly.
        captured: dict = {}

        class FakeOrchestrator:
            def __init__(self, **kw):
                captured["kwargs"] = kw

            def run(self):
                captured["ran"] = True
                return TicketState.HUMAN_QA_PENDING

        with unittest.mock.patch.object(
            run_mod,
            "Orchestrator",
            FakeOrchestrator,
        ):
            exit_code = main(["--next"])

        self.assertEqual(exit_code, 0)
        self.assertTrue(captured.get("ran"))
        self.assertIn(
            "config_path", captured["kwargs"]
        )
        self.assertIn(
            "checkpoint_path", captured["kwargs"]
        )


# ---------------------------------------------------------------------------
# J. No new milestone checkpoint is created
# ---------------------------------------------------------------------------


class NoMilestoneCheckpointTests(unittest.TestCase):
    def test_milestone_does_not_create_extra_checkpoint_file(
        self,
    ):
        discovery = [
            [task(10)],
            [task(10, state="CLOSED")],
        ]

        with MilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            harness.run()

            # The existing single-ticket checkpoint path
            # is the ONLY checkpoint path the milestone
            # runner touches.  No milestone-level
            # checkpoint file should appear anywhere in
            # the working tree.
            json_files = sorted(
                path.name
                for path in harness.root.glob("*.json")
            )
            # Production Orchestrator clears the ticket
            # checkpoint on success, so by the time the
            # run finishes only the harness's own config
            # file remains.  Either way, no new file with
            # "milestone" in the name must exist.
            for name in json_files:
                self.assertNotIn("milestone", name)

            # And no extra files appeared beyond the
            # harness's own setup files.
            self.assertEqual(
                json_files,
                ["config.json"],
            )


if __name__ == "__main__":
    unittest.main()
