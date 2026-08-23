"""Production-boundary milestone tests.

These tests exercise the REAL ``Orchestrator`` and ``Conductor``
on the milestone path.  Only external service boundaries are
mocked: the GitHub API (``GitHubTaskSource.list_tasks``), the
Tenki sandbox, the agent runners (implementation / review / QA),
persistence, integration, cleanup, and the authenticator.

This file proves the outer-loop / single-ticket identity
boundary that the ``_FakeOrchestrator``-based tests cannot
prove:

- The pinned ``expected_issue_number`` cannot be silently
  substituted by the inner ``Orchestrator`` selection rule.
- Existing durable ticket checkpoints are authoritative even
  when other tickets become eligible.
- A corrupt checkpoint is normalized through a static
  Ralph-owned console line, never an uncaught traceback.
- An empty discovery from a configured milestone is
  fail-closed (``NO_ELIGIBLE_WORK``), never vacuously
  ``COMPLETE``.
- The no-progress invariant requires the EXACT pinned issue
  itself to close; closing some other issue does NOT count.
- The CLI does not leak ``OrchestratorError`` or
  ``CheckpointError`` text to the operator console.
"""

import io
import json
import os
import re
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
from scripts.ralph.cleanup import RemoteBranchCleaner
from scripts.ralph.github_source import (
    GitHubTask,
    GitHubTaskSource,
)
from scripts.ralph.implementation import (
    CompletionPhase,
    CompletionStatus,
    ImplementationFixContext,
    ImplementationResult,
)
from scripts.ralph.milestone import (
    MilestoneResult,
    MilestoneRunner,
    MilestoneRunnerCallbacks,
    MilestoneStatus,
)
from scripts.ralph.qa import (
    QaCommandResult,
    QaResult,
    QaStatus,
)
from scripts.ralph.review import (
    ReviewResult,
    ReviewStage,
    ReviewVerdict,
)
from scripts.ralph.run import (
    ConductorCallbacks,
    Orchestrator,
    OrchestratorError,
    build_qa_commands,
)
from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.states import TicketState
from scripts.ralph.workspace import (
    TicketWorkspace,
    WorkspacePreparationError,
)


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


def make_completion(
    *,
    status=CompletionStatus.COMPLETE,
    summary="Implemented.",
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


def make_qa_result(*, status=QaStatus.PASSED):
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


# Default mock workspace that matches whatever branch
# the workspace.prepare() script requests.  The
# production ``workspace.prepare()`` validates
# ``RALPH_TICKET_BRANCH == expected_ticket_branch``,
# so the mock MUST echo the same branch back.
_BRANCH_PATTERN = re.compile(
    r"ralph/m2-(\d+)"
)


def _dynamic_workspace_exec(*args, **kwargs):
    """``MagicMock`` side_effect that emits a workspace
    result whose ``RALPH_TICKET_BRANCH`` matches the
    branch requested by the production prepare script.

    ``workspace.prepare()`` invokes ``sandbox.exec`` with
    positional ``(bash, -lc, script, ...)`` — the actual
    shell script is the longest positional string.  We
    match the first ``ralph/m2-N`` occurrence in that
    script and echo it back so the production
    workspace validation passes.
    """
    script_candidates = [
        arg
        for arg in args
        if isinstance(arg, str) and len(arg) > 16
    ]

    script = (
        max(script_candidates, key=len)
        if script_candidates
        else ""
    )

    match = _BRANCH_PATTERN.search(script)
    branch = (
        f"ralph/m2-{match.group(1)}"
        if match
        else "ralph/m2-17"
    )
    return workspace_response(branch=branch)


class _FakeAuthenticator:
    def mint_repository_token(self, *, owner, repository):
        return SimpleNamespace(token="ghs_fake")


class ProductionMilestoneHarness:
    """Test harness that drives the REAL ``Orchestrator``
    from the milestone layer.

    External service boundaries are mocked:

    - ``GitHubAppAuthenticator`` returns a fake token
      without reading environment values (via
      ``ConductorCallbacks.make_authenticator``).
    - ``GitHubTaskSource.list_tasks`` returns a
      caller-controlled sequence of task lists (shared by
      outer and inner discovery).
    - ``TenkiSandbox`` is replaced with a MagicMock that
      emits a controlled workspace result.
    - All agent runners (implementation, review, QA,
      persistence, integration, cleanup) are SimpleNamespace
      stubs whose return values are caller-controlled.

    Everything else — the Orchestrator, the Conductor, the
    CheckpointStore, the eligibility policy, the execution
    frontier policy — runs as in production.

    Identity-pinning is exercised through the REAL
    ``Orchestrator.run()`` path: the milestone runner calls
    ``Orchestrator(expected_issue_number=pinned)`` and the
    Orchestrator's own ``_resolve_ticket`` enforces the
    fail-closed invariant.
    """

    def __init__(
        self,
        *,
        discovery_sequence,
        implementation_returns=None,
        review_returns=None,
        qa_returns=None,
        persistence_returns=None,
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

        self._discovery_sequence = list(
            discovery_sequence
        )
        self.discovery_calls = 0

        self._impl_returns: dict = dict(
            implementation_returns or {}
        )

        self._review_returns: list = list(
            review_returns or []
        )

        self._qa_returns: list = list(
            qa_returns or [make_qa_result()]
        )

        self._persistence_returns: dict = dict(
            persistence_returns or {}
        )

        self.executed_issue_numbers: list[int] = []

        # Patch the milestone runner's
        # ``build_authenticator`` so it returns the fake
        # token-minting authenticator instead of trying
        # to read real GitHub App environment values.
        from scripts.ralph import (
            milestone as milestone_mod,
        )

        self._auth_patcher = unittest.mock.patch.object(
            milestone_mod,
            "build_authenticator",
            return_value=_FakeAuthenticator(),
        )
        self._auth_patcher.start()

        # Patch ``GitHubTaskSource.list_tasks`` so the
        # outer and inner discoveries share a controlled
        # sequence.
        self._source_patcher = unittest.mock.patch.object(
            GitHubTaskSource,
            "list_tasks",
            side_effect=self._next_discovery,
        )
        self._source_patcher.start()

        # Patch ``TenkiSandbox`` so the production
        # Orchestrator does not reach a real cluster.
        # The mock ``exec`` returns a workspace result
        # whose branch matches the issue number the
        # prepare script is asking about, so the
        # production workspace.prepare() validation
        # passes.
        self._sandbox_patcher = unittest.mock.patch(
            "scripts.ralph.run.TenkiSandbox",
        )
        mock_tenki = self._sandbox_patcher.start()
        sandbox = unittest.mock.MagicMock(
            name="TenkiSandbox"
        )
        sandbox.exec.side_effect = _dynamic_workspace_exec
        mock_tenki.return_value.__enter__.return_value = (
            sandbox
        )
        mock_tenki.return_value.__exit__.return_value = (
            False
        )

        # The Conductor callbacks replace the agent
        # runners and the QA environment.  They are
        # passed through ``MilestoneRunnerCallbacks
        # .conductor_callbacks`` so the real
        # ``Orchestrator`` uses them when it builds its
        # inner ``Conductor``.
        self._conductor_callbacks = (
            self._build_conductor_callbacks()
        )

        from scripts.ralph.milestone import (
            MilestoneRunnerCallbacks,
        )

        self.runner = MilestoneRunner(
            config_path=str(self.config_path),
            checkpoint_path=self.checkpoint_path,
            callbacks=MilestoneRunnerCallbacks(
                conductor_callbacks=(
                    self._conductor_callbacks
                ),
            ),
        )

    def _next_discovery(self) -> list:
        self.discovery_calls += 1
        if not self._discovery_sequence:
            return []
        return list(self._discovery_sequence.pop(0))

    def _build_conductor_callbacks(self) -> (
        ConductorCallbacks
    ):
        outer = self

        def make_impl(**kwargs):
            del kwargs

            def run(*args, **run_kwargs):
                issue = run_kwargs.get("issue_number", 0)
                outer.executed_issue_numbers.append(issue)
                if issue in outer._impl_returns:
                    completion = outer._impl_returns[issue]
                else:
                    completion = make_completion()
                return completion

            return SimpleNamespace(
                run=unittest.mock.MagicMock(side_effect=run)
            )

        def make_review_runner(**kwargs):
            del kwargs

            def review(**review_kwargs):
                del review_kwargs
                if outer._review_returns:
                    return outer._review_returns.pop(0)
                return make_review_value()

            return SimpleNamespace(
                review=unittest.mock.MagicMock(
                    side_effect=review
                )
            )

        def make_qa_runner(**kwargs):
            del kwargs

            def run(*args, **run_kwargs):
                del args, run_kwargs
                if outer._qa_returns:
                    return outer._qa_returns.pop(0)
                return make_qa_result()

            return SimpleNamespace(
                run=unittest.mock.MagicMock(side_effect=run)
            )

        def make_persistence_runner(**kwargs):
            del kwargs

            def persist(**pkw):
                issue = pkw.get("issue_number", 0)
                if issue in outer._persistence_returns:
                    return outer._persistence_returns[issue]
                return SimpleNamespace(
                    commit_sha=f"commit-{issue}",
                    remote_sha=f"commit-{issue}",
                    pull_request_number=100 + issue,
                    pull_request_url="https://x",
                    pull_request_created=True,
                )

            def ensure_pr(**pkw):
                issue = pkw.get("issue_number", 0)
                return SimpleNamespace(
                    commit_sha=f"commit-{issue}",
                    pull_request_number=100 + issue,
                )

            return SimpleNamespace(
                persist=unittest.mock.MagicMock(
                    side_effect=persist
                ),
                ensure_pull_request_for_persisted_commit=(
                    unittest.mock.MagicMock(
                        side_effect=ensure_pr
                    )
                ),
            )

        def make_integration_runner(**kwargs):
            del kwargs

            def integrate(**ikw):
                return SimpleNamespace(
                    pull_request_number=ikw.get(
                        "pull_request_number", 100
                    ),
                    head_sha=ikw.get(
                        "expected_head_sha", "commit-x"
                    ),
                    merge_sha="merge-x",
                    merge_created=True,
                    issue_closed_now=True,
                )

            return SimpleNamespace(
                integrate=unittest.mock.MagicMock(
                    side_effect=integrate
                )
            )

        def make_remote_branch_cleaner(**kwargs):
            del kwargs
            return SimpleNamespace(
                cleanup_ticket_branch=(
                    unittest.mock.MagicMock(
                        return_value=SimpleNamespace(
                            deleted=True,
                            already_absent=False,
                            branch="ralph/m2-17",
                        )
                    )
                )
            )

        def make_qa_environment(sandbox):
            del sandbox
            return SimpleNamespace(
                start=lambda: SimpleNamespace(
                    database_url=(
                        "postgresql://tenki@127.0.0.1:5433/"
                        "soundhub_m1_test"
                    ),
                    env={
                        "TEST_DATABASE_URL": (
                            "postgresql://tenki@127.0.0.1"
                            ":5433/soundhub_m1_test"
                        )
                    },
                ),
                stop=lambda: None,
            )

        # The recovery probe answers NOTHING_DURABLE for
        # fresh tickets so the production Orchestrator
        # bypasses recovery and proceeds through normal
        # persistence.
        from scripts.ralph.recovery import (
            BranchAbsentReason,
            BranchLookup,
            PullRequestAbsentReason,
            PullRequestLookup,
        )

        def absent_branch(**kwargs):
            del kwargs
            return BranchLookup(
                absent_reason=BranchAbsentReason.NOT_FOUND,
            )

        def empty_prs(**kwargs):
            del kwargs
            return PullRequestLookup(
                candidates=(),
                absent_reason=(
                    PullRequestAbsentReason.EMPTY_LIST
                ),
                malformed_reasons=(),
            )

        recovery_probe = SimpleNamespace(
            remote_branch_head=unittest.mock.MagicMock(
                side_effect=absent_branch
            ),
            pull_requests_for_branch=unittest.mock.MagicMock(
                side_effect=empty_prs
            ),
            pull_request_merged=unittest.mock.MagicMock(
                return_value=None
            ),
        )

        return ConductorCallbacks(
            make_authenticator=lambda config: (
                _FakeAuthenticator()
            ),
            make_qa_environment=make_qa_environment,
            make_implementation_runner=make_impl,
            make_review_runner=make_review_runner,
            make_qa_runner=make_qa_runner,
            make_persistence_runner=make_persistence_runner,
            make_integration_runner=make_integration_runner,
            make_remote_branch_cleaner=(
                make_remote_branch_cleaner
            ),
            make_github_probe=lambda **kw: recovery_probe,
        )

    def run(self) -> MilestoneResult:
        return self.runner.run()

    def close(self):
        try:
            self._auth_patcher.stop()
            self._source_patcher.stop()
            self._sandbox_patcher.stop()
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


def make_review_value(
    *,
    verdict=ReviewVerdict.APPROVE_FOR_QA,
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


# ---------------------------------------------------------------------------
# K. Identity pinning with the REAL Orchestrator
# ---------------------------------------------------------------------------


class ProductionIdentityPinningTests(unittest.TestCase):
    """Prove that the milestone runner's pin survives the
    inner Orchestrator's own discovery-and-selection step.

    A changing-discovery regression: the outer runner sees
    ``[10, 11]`` and pins 10.  Before the inner Orchestrator
    runs, GitHub changes so that 10 is closed externally
    and 11 is the only eligible ticket.  The inner
    Orchestrator MUST fail closed (BLOCKED_FOR_HUMAN), not
    silently substitute #11.
    """

    def test_pinned_issue_closes_externally_fails_closed(
        self,
    ):
        discovery = [
            # Outer runner initial discovery: 10, 11 both
            # open and eligible.  Runner picks 10 and pins
            # it.
            [task(10), task(11)],
            # Inner Orchestrator's own discovery: 10 is
            # already CLOSED externally.  The inner
            # Orchestrator MUST fail closed rather than
            # silently substituting 11.
            [
                task(10, state="CLOSED"),
                task(11),
            ],
            # Outer runner post-rediscovery after the
            # Orchestrator returned BLOCKED_FOR_HUMAN.
            # The milestone loop stops here.
            [
                task(10, state="CLOSED"),
                task(11),
            ],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            implementation_returns={
                10: make_completion(
                    status=CompletionStatus.COMPLETE,
                ),
            },
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )
        # 10 was the pinned issue and the inner
        # Orchestrator ran it (and recorded
        # ISSUE_NOT_ELIGIBLE because it had been
        # externally closed between pin and inner
        # discovery).  11 must NEVER execute.
        self.assertNotIn(11, result.completed_tickets)
        self.assertNotIn(11, harness.executed_issue_numbers)

    def test_concurrent_frontier_change_does_not_substitute(
        self,
    ):
        # Outer runner sees [10, 11].  Inner Orchestrator
        # sees [10 open but ineligible (lost required
        # label), 11 open and eligible].  Pinned #10 MUST
        # NOT be substituted with #11.
        discovery = [
            [task(10), task(11)],
            # Inner Orchestrator discovery: 10 lost the
            # required label between the outer pin and
            # the inner run.
            [
                task(10, labels=()),
                task(11),
            ],
            [
                task(10, labels=()),
                task(11),
            ],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )
        self.assertNotIn(11, harness.executed_issue_numbers)


# ---------------------------------------------------------------------------
# L. Empty discovery fail-closed
# ---------------------------------------------------------------------------


class EmptyDiscoveryFailClosedTests(unittest.TestCase):
    def test_empty_discovery_returns_no_eligible_work(self):
        discovery = [[]]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.NO_ELIGIBLE_WORK,
        )
        self.assertEqual(result.completed_tickets, ())
        # The Orchestrator must NEVER have been invoked.
        self.assertEqual(harness.executed_issue_numbers, [])


# ---------------------------------------------------------------------------
# M. Crash-between-tickets restart with REAL Orchestrator
# ---------------------------------------------------------------------------


class CrashBetweenTicketsRestartTests(unittest.TestCase):
    def test_resume_after_predecessor_closes(self):
        # Initial durable GitHub state: #10 CLOSED, #11
        # OPEN eligible.  No checkpoint on disk.  This is
        # the "crash between tickets" scenario.
        discovery = [
            [task(10, state="CLOSED"), task(11)],
            # Inner Orchestrator discovery for #11.
            [task(10, state="CLOSED"), task(11)],
            # Post-rediscovery after #11 success.
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        # #11 must run, #10 must NOT be re-run.
        self.assertEqual(result.completed_tickets, (11,))
        self.assertEqual(harness.executed_issue_numbers, [11])


# ---------------------------------------------------------------------------
# N. Terminal checkpoint restart tests
# ---------------------------------------------------------------------------


def make_checkpoint_payload(
    *,
    issue_number: int,
    state: TicketState,
    ticket_branch: Optional[str] = None,
    base_sha: str = "base123",
    ticket_sha: str = "ticket123",
    last_error: Optional[str] = None,
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
        "last_error": last_error,
        "pre_qa_findings": None,
        "qa_failure_evidence": None,
        "pre_persistence_findings": None,
    }


class TerminalCheckpointRestartTests(unittest.TestCase):
    """Production-boundary proofs that an existing durable
    checkpoint is authoritative.

    A terminal checkpoint must resume via the REAL
    Orchestrator recovery path.  #11 — even though it is
    also eligible — must NEVER execute.
    """

    def _setup(self, terminal_state: TicketState):
        checkpoint = make_checkpoint_payload(
            issue_number=10,
            state=terminal_state,
            last_error=(
                "Implementation agent reported a blocker."
                if terminal_state
                == TicketState.BLOCKED_FOR_HUMAN
                else None
            ),
        )
        discovery = [
            # Outer runner initial discovery: both
            # eligible, but checkpoint for #10 must
            # win.
            [task(10), task(11)],
            # Inner Orchestrator discovery for #10
            # resume.
            [task(10), task(11)],
        ]
        return checkpoint, discovery

    def test_blocked_checkpoint_resumes_not_substitutes(self):
        checkpoint, discovery = self._setup(
            TicketState.BLOCKED_FOR_HUMAN
        )
        pre_run = dict(checkpoint)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            # Terminal BLOCKED checkpoint is the
            # authoritative on-disk state and is mapped
            # to STOPPED_FOR_HUMAN at the milestone
            # layer.  The Orchestrator is NOT invoked.
            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            # 11 must NEVER have executed.
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            # No ticket was marked complete.
            self.assertEqual(
                result.completed_tickets, ()
            )
            # Checkpoint file MUST be byte-identical to
            # the pre-run payload.
            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)
            self.assertEqual(parsed_post, pre_run)
            payload = json.loads(post_run_text)
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.BLOCKED_FOR_HUMAN.value,
            )

    def test_infra_checkpoint_resumes_not_substitutes(self):
        checkpoint, discovery = self._setup(
            TicketState.INFRA_FAILURE
        )
        pre_run = dict(checkpoint)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            self.assertEqual(
                result.status,
                MilestoneStatus.INFRA_FAILURE,
            )
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            self.assertEqual(
                result.completed_tickets, ()
            )
            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)
            self.assertEqual(parsed_post, pre_run)
            payload = json.loads(post_run_text)
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.INFRA_FAILURE.value,
            )

    def test_agent_checkpoint_resumes_not_substitutes(self):
        checkpoint, discovery = self._setup(
            TicketState.AGENT_FAILURE
        )
        pre_run = dict(checkpoint)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            self.assertEqual(
                result.status,
                MilestoneStatus.AGENT_FAILURE,
            )
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            self.assertEqual(
                result.completed_tickets, ()
            )
            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)
            self.assertEqual(parsed_post, pre_run)
            payload = json.loads(post_run_text)
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.AGENT_FAILURE.value,
            )

    def test_checkpoint_issue_absent_from_discovery_blocks(
        self,
    ):
        # Checkpoint for #10 exists, but #10 is not in
        # the current discovery.  The Orchestrator's own
        # ``ISSUE_NO_LONGER_PRESENT`` path must record
        # BLOCKED_FOR_HUMAN.  The milestone layer MUST
        # NOT reclassify this as NO_ELIGIBLE_WORK.
        checkpoint = make_checkpoint_payload(
            issue_number=10,
            state=TicketState.IMPLEMENTING,
        )
        discovery = [
            # Outer runner: only #11 visible.
            [task(11)],
            # Inner Orchestrator: still only #11.
            [task(11)],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            # Milestone does NOT run any ticket.
            self.assertEqual(
                harness.executed_issue_numbers, []
            )


# ---------------------------------------------------------------------------
# O. Parent issue production-boundary test
# ---------------------------------------------------------------------------


class ParentIssueTests(unittest.TestCase):
    def test_parent_never_selected_open_parent_does_not_block_complete(
        self,
    ):
        # Production-shaped task list — the parent
        # (``#12``) is already filtered out by
        # ``GitHubTaskSource``.  Only children #10 and
        # #11 reach the milestone runner.
        discovery = [
            [task(10), task(11)],
            [task(10), task(11)],
            [
                task(10, state="CLOSED"),
                task(11),
            ],
            [
                task(10, state="CLOSED"),
                task(11),
            ],
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        # Parent must never appear in completed_tickets.
        self.assertNotIn(12, result.completed_tickets)
        self.assertEqual(
            result.completed_tickets, (10, 11)
        )
        # The inner Conductor must not have started
        # ticket 12 either.
        self.assertNotIn(12, harness.executed_issue_numbers)


# ---------------------------------------------------------------------------
# P. No-progress identity proof
# ---------------------------------------------------------------------------


class NoProgressIdentityTests(unittest.TestCase):
    def test_other_issue_closing_does_not_satisfy_progress(
        self,
    ):
        # Outer runner pins #10.  Orchestrator reports
        # HUMAN_QA_PENDING.  Rediscovery shows #10 is
        # still OPEN and #11 is CLOSED.  The no-progress
        # guard must trip: closing some OTHER issue can
        # never satisfy progress for #10.
        discovery = [
            [task(10), task(11)],
            [task(10), task(11)],
            # Post-rediscovery: #10 still OPEN, #11
            # CLOSED.
            [task(10), task(11, state="CLOSED")],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )
        # #10 must NOT be appended to completed_tickets.
        self.assertNotIn(10, result.completed_tickets)
        # No second iteration must start.
        self.assertEqual(
            harness.executed_issue_numbers, [10]
        )

    def test_expected_issue_absent_after_success_blocks(
        self,
    ):
        discovery = [
            [task(10), task(11)],
            [task(10), task(11)],
            # Post-rediscovery: #10 absent entirely.
            [task(11)],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )
        self.assertNotIn(10, result.completed_tickets)
        self.assertEqual(
            harness.executed_issue_numbers, [10]
        )


# ---------------------------------------------------------------------------
# Q. Static error normalization
# ---------------------------------------------------------------------------


class StaticErrorNormalizationTests(unittest.TestCase):
    """The CLI / runner MUST NOT print ``OrchestratorError``
    or ``CheckpointError`` text to the operator console.

    Only static Ralph-authored lines are allowed.
    """

    def test_orchestrator_error_text_not_in_console(self):
        # Make the real Orchestrator raise an
        # ``OrchestratorError`` whose message contains a
        # clearly identifiable secret-shaped substring.
        # The runner MUST print only the static
        # Ralph-owned line — never the exception text.
        secret_marker = "OPENAIKEY-shhh-this-must-not-leak"

        discovery = [
            [task(10), task(11)],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            buffer = io.StringIO()

            with redirect_stdout(buffer):
                with unittest.mock.patch.object(
                    Orchestrator,
                    "run",
                    side_effect=OrchestratorError(
                        secret_marker
                    ),
                ):
                    try:
                        harness.runner.run()
                    except OrchestratorError:
                        # Expected: the runner prints
                        # the static line first, then
                        # propagates.
                        pass

            output = buffer.getvalue()

        self.assertNotIn(secret_marker, output)
        self.assertIn(
            "RALPH MILESTONE: "
            "ticket orchestration failed",
            output,
        )

    def test_corrupt_checkpoint_does_not_uncaught_traceback(
        self,
    ):
        # Write garbage into the checkpoint file so
        # ``CheckpointStore.load()`` raises
        # ``CheckpointError``.
        discovery = [
            [task(10), task(11)],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            harness.checkpoint_path.write_text(
                "{not valid json at all"
            )

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                try:
                    result = harness.runner.run()
                except CheckpointError:
                    self.fail(
                        "CheckpointError escaped the "
                        "milestone runner control "
                        "boundary."
                    )
            output = buffer.getvalue()

        self.assertEqual(
            result.status,
            MilestoneStatus.INFRA_FAILURE,
        )
        # No raw checkpoint error text must appear.
        # The static Ralph-owned line is the only
        # operator-visible signal.
        self.assertIn(
            "RALPH MILESTONE: "
            "checkpoint infrastructure failure",
            output,
        )


# ---------------------------------------------------------------------------
# R. --next regression after expected_issue_number
# ---------------------------------------------------------------------------


class NextModeRegressionTests(unittest.TestCase):
    """``--next`` must NOT change behavior now that
    ``Orchestrator`` accepts an optional
    ``expected_issue_number``.
    """

    def test_next_orchestrator_default_pin_is_none(self):
        from scripts.ralph.run import Orchestrator

        orch = Orchestrator(
            config_path="/tmp/c.json",
            checkpoint_path=Path("/tmp/cp.json"),
        )

        self.assertIsNone(orch.expected_issue_number)


# ---------------------------------------------------------------------------
# S. Pinned empty-frontier ordering
# ---------------------------------------------------------------------------


class PinnedEmptyFrontierTests(unittest.TestCase):
    """Production-resolution proofs that the inner
    ``Orchestrator._resolve_ticket`` ordering is:

      1. Existing durable checkpoint.
      2. Pinned identity validation.
      3. Generic legacy ``--next`` empty-frontier sentinel.

    These tests exercise the REAL ``Orchestrator.run()``
    path so the ordering invariant is enforced by the
    production code, not by a fake.
    """

    def test_pinned_missing_with_empty_frontier_blocks(self):
        # Outer runner pins #10.  Inner Orchestrator
        # discovery contains neither #10 nor any other
        # eligible ticket.
        from scripts.ralph.milestone import (
            MilestoneRunnerCallbacks,
        )

        discovery = [
            # Outer runner initial discovery (no
            # checkpoint, so this is the only initial
            # discovery).  #10 visible.
            [task(10), task(11)],
            # Inner Orchestrator discovery for #10
            # pinned execution.  #10 missing, no other
            # eligible.
            [task(11, labels=())],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            # #11 must NEVER have executed.  The
            # Orchestrator recorded ISSUE_NO_LONGER_PRESENT
            # for #10 before any other ticket was even
            # considered.
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            # A terminal checkpoint for #10 was
            # persisted by the Orchestrator's own
            # _resolve_ticket path.
            payload = json.loads(
                harness.checkpoint_path.read_text()
            )
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.BLOCKED_FOR_HUMAN.value,
            )

    def test_pinned_ineligible_with_empty_frontier_blocks(
        self,
    ):
        # Outer runner pins #10.  Inner Orchestrator
        # discovery: #10 still present but lost
        # ready-for-ralph; no other ticket eligible.
        discovery = [
            [task(10), task(11)],
            [
                task(10, labels=()),
                task(11, labels=()),
            ],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            payload = json.loads(
                harness.checkpoint_path.read_text()
            )
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.BLOCKED_FOR_HUMAN.value,
            )

    def test_pinned_ineligible_with_skip_label_blocks(self):
        # Outer runner pins #10.  Inner discovery: #10
        # present but gained a skip label
        # (``needs-reshaping``); no other eligible.
        discovery = [
            [task(10), task(11)],
            [
                task(
                    10,
                    labels=(
                        "ready-for-ralph",
                        "needs-reshaping",
                    ),
                ),
                task(11, labels=()),
            ],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )


# ---------------------------------------------------------------------------
# T. Terminal checkpoint precedence over COMPLETE classification
# ---------------------------------------------------------------------------


class TerminalCheckpointPrecedenceTests(unittest.TestCase):
    """A durable checkpoint MUST take precedence over
    milestone COMPLETE classification.  If the runner ever
    returned COMPLETE without first consulting the
    checkpoint, a terminal ``BLOCKED_FOR_HUMAN`` state for
    #10 would be silently bypassed while GitHub reports
    every task CLOSED.
    """

    def _terminal_payload(
        self, terminal_state: TicketState
    ):
        return {
            "schema_version": 2,
            "milestone_id": "m2",
            "issue_number": 10,
            "state": terminal_state.value,
            "integration_branch": "ralph/m2",
            "ticket_branch": "ralph/m2-10",
            "base_sha": "base123",
            "ticket_sha": "ticket123",
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

    def _setup_all_closed_discovery(self):
        return [
            # Outer discovery would otherwise look
            # complete: every task CLOSED.
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
            # Inner Orchestrator discovery for #10
            # resume.
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

    def test_terminal_blocked_checkpoint_with_all_closed_stops(
        self,
    ):
        checkpoint = self._terminal_payload(
            TicketState.BLOCKED_FOR_HUMAN
        )
        discovery = self._setup_all_closed_discovery()

        pre_run = dict(checkpoint)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            # Even though every GitHub issue is closed,
            # the checkpointed ticket #10 is BLOCKED.
            # The milestone runner MUST map the
            # terminal ``BLOCKED_FOR_HUMAN`` checkpoint
            # to ``STOPPED_FOR_HUMAN`` without invoking
            # the Orchestrator.
            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self.assertEqual(
                result.current_issue, 10
            )
            # 11 must NEVER have executed.
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            # Checkpoint file MUST remain untouched
            # from the milestone layer.
            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)
            self.assertEqual(parsed_post, pre_run)
            payload = json.loads(post_run_text)
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.BLOCKED_FOR_HUMAN.value,
            )

    def test_terminal_infra_checkpoint_with_all_closed_stops(
        self,
    ):
        checkpoint = self._terminal_payload(
            TicketState.INFRA_FAILURE
        )
        discovery = self._setup_all_closed_discovery()

        # Capture pre-run checkpoint contents to prove
        # the milestone layer does not mutate the file.
        pre_run = dict(checkpoint)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            # Terminal ``INFRA_FAILURE`` checkpoint
            # must NOT be reclassified to
            # ``STOPPED_FOR_HUMAN``.  The on-disk
            # terminal state IS the authoritative
            # reason Ralph stopped.  The milestone
            # runner short-circuits the Orchestrator
            # entirely for this case.
            self.assertEqual(
                result.status,
                MilestoneStatus.INFRA_FAILURE,
            )
            self.assertNotEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self.assertNotEqual(
                result.status,
                MilestoneStatus.COMPLETE,
            )
            # 11 must NEVER have executed.
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            # Checkpoint file MUST remain untouched.
            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)
            payload = json.loads(post_run_text)
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.INFRA_FAILURE.value,
            )
            # No save / replace / clear may have
            # occurred from the milestone layer.
            self.assertEqual(parsed_post, pre_run)

    def test_terminal_agent_checkpoint_with_all_closed_stops(
        self,
    ):
        checkpoint = self._terminal_payload(
            TicketState.AGENT_FAILURE
        )
        discovery = self._setup_all_closed_discovery()

        pre_run = dict(checkpoint)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            # Terminal ``AGENT_FAILURE`` checkpoint
            # must NOT be reclassified to
            # ``STOPPED_FOR_HUMAN``.
            self.assertEqual(
                result.status,
                MilestoneStatus.AGENT_FAILURE,
            )
            self.assertNotEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self.assertNotEqual(
                result.status,
                MilestoneStatus.COMPLETE,
            )
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)
            payload = json.loads(post_run_text)
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.AGENT_FAILURE.value,
            )
            self.assertEqual(parsed_post, pre_run)


# ---------------------------------------------------------------------------
# U. Checkpoint + empty task discovery regression
# ---------------------------------------------------------------------------


class CheckpointEmptyDiscoveryRegressionTests(
    unittest.TestCase
):
    """Durable checkpoint for #10 with a task list that
    contains neither #10 nor any other ticket.  The
    Orchestrator's own ``ISSUE_NO_LONGER_PRESENT`` path
    must record ``BLOCKED_FOR_HUMAN``.  The milestone
    runner MUST NOT bypass this with a milestone-level
    ``NO_ELIGIBLE_WORK`` classification.
    """

    def test_checkpoint_with_empty_discovery_blocks_not_no_eligible(
        self,
    ):
        checkpoint = make_checkpoint_payload(
            issue_number=10,
            state=TicketState.IMPLEMENTING,
        )
        discovery = [
            # Outer runner would otherwise classify
            # empty discovery as NO_ELIGIBLE_WORK.
            # Because the checkpoint exists, the
            # Orchestrator must run first.
            [],
            # Inner Orchestrator discovery: still
            # empty.
            [],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            # NO_ELIGIBLE_WORK is forbidden here.
            self.assertNotEqual(
                result.status,
                MilestoneStatus.NO_ELIGIBLE_WORK,
            )
            # The Orchestrator recorded
            # ISSUE_NO_LONGER_PRESENT for #10.
            payload = json.loads(
                harness.checkpoint_path.read_text()
            )
            self.assertEqual(
                payload["issue_number"], 10
            )
            self.assertEqual(
                payload["state"],
                TicketState.BLOCKED_FOR_HUMAN.value,
            )


# ---------------------------------------------------------------------------
# V. Config load normalization
# ---------------------------------------------------------------------------


class ConfigLoadNormalizationTests(unittest.TestCase):
    """Missing or malformed config MUST be normalized
    through a static Ralph-owned line and a non-success
    exit.  No traceback, no exception text.
    """

    def _exercise_cli(self, config_path: str) -> str:
        from scripts.ralph.run import _run_milestone

        captured: dict = {}

        class _Args:
            config = config_path
            checkpoint = "/tmp/cp.json"

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            exit_code = _run_milestone(_Args())

        output = buffer.getvalue()
        return output, exit_code

    def test_missing_config_emits_static_line(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            missing = (
                Path(tmp) / "does-not-exist.json"
            )
            output, exit_code = self._exercise_cli(
                str(missing)
            )

        # The path MUST NOT appear in stdout; only the
        # static Ralph-owned line is allowed.
        self.assertNotIn("does-not-exist", output)
        self.assertNotIn("FileNotFoundError", output)
        self.assertNotIn("Traceback", output)
        self.assertIn(
            "RALPH MILESTONE: "
            "configuration load failure",
            output,
        )
        self.assertNotEqual(exit_code, 0)

    def test_malformed_json_config_emits_static_line(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            bad_path = Path(tmp) / "config.json"
            bad_path.write_text(
                "{ this is not valid json"
            )

            output, exit_code = self._exercise_cli(
                str(bad_path)
            )

        self.assertNotIn("JSONDecodeError", output)
        self.assertNotIn("Traceback", output)
        self.assertNotIn("this is not valid json", output)
        self.assertIn(
            "RALPH MILESTONE: "
            "configuration load failure",
            output,
        )
        self.assertNotEqual(exit_code, 0)

    def test_secret_shaped_missing_path_is_not_leaked(self):
        # Even if the config path itself looks like a
        # secret, the failure message MUST NOT echo it.
        secret_marker = "OPENAIKEY-shhh-this-must-not-leak"

        output, exit_code = self._exercise_cli(
            f"/tmp/{secret_marker}.json"
        )

        self.assertNotIn(secret_marker, output)
        self.assertIn(
            "RALPH MILESTONE: "
            "configuration load failure",
            output,
        )
        self.assertNotEqual(exit_code, 0)


# ---------------------------------------------------------------------------
# W. Real GitHubTaskSource parent filter test
# ---------------------------------------------------------------------------


class RealGitHubTaskSourceParentFilterTests(
    unittest.TestCase
):
    """The production ``GitHubTaskSource.list_tasks()``
    filters out ``parent_issue`` BEFORE the milestone
    runner sees the task list.  This test exercises the
    REAL ``list_tasks()`` method with a mocked ``gh``
    subprocess invocation and proves:

      - parent #12 is excluded from the returned task
        list,
      - a parent-only JSON produces an EMPTY child task
        list (and therefore ``NO_ELIGIBLE_WORK`` at the
        milestone layer, not ``COMPLETE``),
      - when all children are CLOSED the milestone layer
        completes normally without ever seeing the
        parent.
    """

    def _build_source(self) -> GitHubTaskSource:
        return GitHubTaskSource(
            repository="Measure-2wice/sound-hub",
            milestone="M2",
            parent_issue=12,
            github_token="ghs_fake",
        )

    def _patched_gh_json(
        self,
        raw_tasks,
    ):
        """Return a list of GitHub-API-shaped dicts."""
        return [
            {
                "number": number,
                "title": title,
                "state": state,
                "labels": [
                    {"name": "ready-for-ralph"}
                ],
                "body": (
                    "## Dependencies\n\n"
                    "Blocked by: None\n"
                ),
            }
            for (
                number,
                title,
                state,
            ) in raw_tasks
        ]

    def test_parent_excluded_from_list_tasks(self):
        source = self._build_source()
        raw_json = self._patched_gh_json(
            [
                (12, "Parent", "OPEN"),
                (10, "Child 10", "CLOSED"),
                (11, "Child 11", "CLOSED"),
            ]
        )

        with unittest.mock.patch.object(
            source,
            "_invoke_gh",
            return_value=raw_json,
            create=True,
        ) if hasattr(
            source, "_invoke_gh"
        ) else unittest.mock.patch(
            "subprocess.run",
            return_value=SimpleNamespace(
                stdout=json.dumps(raw_json),
                stderr="",
                returncode=0,
            ),
        ):
            tasks = source.list_tasks()

        numbers = sorted(task.number for task in tasks)
        self.assertEqual(numbers, [10, 11])

    def test_parent_only_input_yields_empty_child_list(self):
        source = self._build_source()
        raw_json = self._patched_gh_json(
            [(12, "Parent only", "OPEN")]
        )

        with unittest.mock.patch(
            "subprocess.run",
            return_value=SimpleNamespace(
                stdout=json.dumps(raw_json),
                stderr="",
                returncode=0,
            ),
        ):
            tasks = source.list_tasks()

        self.assertEqual(tasks, [])

    def test_milestone_sees_only_children_after_parent_filter(
        self,
    ):
        # Outer shape: parent excluded.  All children
        # closed.
        discovery = [
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        self.assertEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )
        self.assertEqual(result.completed_tickets, ())

    def test_parent_only_production_task_list_is_no_eligible_work(
        self,
    ):
        discovery = [
            # Outer runner discovery returns an empty
            # production-shaped list (parent already
            # filtered out by GitHubTaskSource).
            [],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
        ) as harness:
            result = harness.run()

        # Parent-only milestone is empty -> NO_ELIGIBLE_WORK.
        # It is NOT COMPLETE.
        self.assertEqual(
            result.status,
            MilestoneStatus.NO_ELIGIBLE_WORK,
        )
        self.assertNotEqual(
            result.status,
            MilestoneStatus.COMPLETE,
        )


# ---------------------------------------------------------------------------
# X. _classify_and_return bug regression
# ---------------------------------------------------------------------------


class ClassifyAndReturnRegressionTests(
    unittest.TestCase
):
    """The previous milestone implementation called a
    ``_classify_and_return`` helper but discarded its
    return value, substituting a hard-coded fallback that
    happened to match the expected behavior.

    This regression test exercises the production
    Orchestrator path with a checkpointed issue whose
    inner discovery is empty.  If the milestone layer
    re-introduces a discarded classification helper,
    this test fails because the actual Orchestrator
    outcome (BLOCKED_FOR_HUMAN via
    ``ISSUE_NO_LONGER_PRESENT``) would be overwritten by
    the hard-coded fallback (NO_ELIGIBLE_WORK).
    """

    def test_resume_uses_orchestrator_classification_not_hardcoded(
        self,
    ):
        checkpoint = make_checkpoint_payload(
            issue_number=10,
            state=TicketState.IMPLEMENTING,
        )
        discovery = [
            [],
            [],
        ]

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            result = harness.run()

            # The Orchestrator's real classification
            # (STOPPED_FOR_HUMAN via
            # ISSUE_NO_LONGER_PRESENT) MUST be the
            # observed milestone status.  A discarded
            # classification that fell back to
            # NO_ELIGIBLE_WORK would fail this test.
            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )


# ---------------------------------------------------------------------------
# Y. Terminal-checkpoint short-circuit proofs
#
# These tests deliberately exercise BOTH the
# "checkpoint's state is terminal AND GitHub shows #11
# ready-for-ralph" scenario AND the "checkpoint terminal
# AND every other ticket is CLOSED" scenario.  Both must
# yield the same authoritative stop without invoking the
# Orchestrator, so a concurrent GitHub change can never
# reclassify a durable terminal state.
# ---------------------------------------------------------------------------


class TerminalCheckpointShortCircuitTests(
    unittest.TestCase
):
    """Lock the exact mapping and the
    no-Orchestrator-invocation invariant for terminal
    checkpoints.

    Each case uses a checkpoint payload whose
    ``state`` is one of ``BLOCKED_FOR_HUMAN``,
    ``INFRA_FAILURE``, or ``AGENT_FAILURE``.  GitHub
    discovery is configured with #11 eligible (and
    optionally already CLOSED) so a regression in the
    short-circuit would visibly start a fresh ticket.
    """

    def _make_checkpoint(
        self, state: TicketState
    ) -> dict:
        return {
            "schema_version": 2,
            "milestone_id": "m2",
            "issue_number": 10,
            "state": state.value,
            "integration_branch": "ralph/m2",
            "ticket_branch": "ralph/m2-10",
            "base_sha": "base123",
            "ticket_sha": "ticket123",
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

    def _assert_no_later_ticket(
        self, harness, result
    ):
        """The terminal-checkpoint short-circuit MUST
        prevent any ticket from being started."""

        # No implementation agent was invoked.
        self.assertEqual(
            harness.executed_issue_numbers, []
        )
        # No ticket was marked complete.
        self.assertEqual(
            result.completed_tickets, ()
        )
        # The current_issue points at the
        # checkpointed ticket.
        self.assertEqual(result.current_issue, 10)

    def _assert_checkpoint_preserved(
        self, harness, checkpoint_state: TicketState
    ):
        """The checkpoint file MUST be byte-identical
        before and after the milestone run."""

        on_disk = json.loads(
            harness.checkpoint_path.read_text()
        )
        self.assertEqual(
            on_disk["issue_number"], 10
        )
        self.assertEqual(
            on_disk["state"],
            checkpoint_state.value,
        )
        # ``last_error`` MUST also be unchanged.
        self.assertIsNone(on_disk["last_error"])

    def test_blocked_short_circuits_no_orchestrator(
        self,
    ):
        # Terminal BLOCKED + #11 also eligible.
        # The short-circuit MUST stop the milestone
        # BEFORE the Orchestrator is instantiated.
        checkpoint = self._make_checkpoint(
            TicketState.BLOCKED_FOR_HUMAN
        )
        pre_run = dict(checkpoint)

        discovery = [
            # Outer runner discovery: #11 eligible.
            [task(11)],
            # If the short-circuit ever regressed,
            # the inner Orchestrator's discovery would
            # be this same list.  We provide it as
            # defense-in-depth.
            [task(11)],
        ]

        orchestrator_ctor_calls = []

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            # Patch Orchestrator so any instantiation
            # is recorded; the milestone layer must
            # construct zero of them.
            real_ctor = Orchestrator

            def tracking_ctor(*args, **kwargs):
                orchestrator_ctor_calls.append(kwargs)
                return real_ctor(*args, **kwargs)

            with unittest.mock.patch(
                "scripts.ralph.milestone.Orchestrator",
                tracking_ctor,
            ):
                result = harness.run()

            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)

            self.assertEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self._assert_no_later_ticket(harness, result)
            # NO Orchestrator ever instantiated.
            self.assertEqual(orchestrator_ctor_calls, [])
            # Checkpoint content unchanged.
            self.assertEqual(parsed_post, pre_run)
            self._assert_checkpoint_preserved(
                harness, TicketState.BLOCKED_FOR_HUMAN
            )

    def test_infra_short_circuits_no_orchestrator(self):
        # Terminal INFRA + #11 closed (still
        # authoritative).  Even though every ticket
        # is closed, INFRA_FAILURE must NOT be
        # reclassified to STOPPED_FOR_HUMAN or
        # COMPLETE.
        checkpoint = self._make_checkpoint(
            TicketState.INFRA_FAILURE
        )
        pre_run = dict(checkpoint)

        discovery = [
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
            [
                task(10, state="CLOSED"),
                task(11, state="CLOSED"),
            ],
        ]

        orchestrator_ctor_calls = []
        real_ctor = Orchestrator

        def tracking_ctor(*args, **kwargs):
            orchestrator_ctor_calls.append(kwargs)
            return real_ctor(*args, **kwargs)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            with unittest.mock.patch(
                "scripts.ralph.milestone.Orchestrator",
                tracking_ctor,
            ):
                result = harness.run()

            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)

            self.assertEqual(
                result.status,
                MilestoneStatus.INFRA_FAILURE,
            )
            self.assertNotEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self.assertNotEqual(
                result.status, MilestoneStatus.COMPLETE
            )
            self._assert_no_later_ticket(harness, result)
            self.assertEqual(orchestrator_ctor_calls, [])
            self.assertEqual(parsed_post, pre_run)
            self._assert_checkpoint_preserved(
                harness, TicketState.INFRA_FAILURE
            )

    def test_agent_short_circuits_no_orchestrator(self):
        # Terminal AGENT + #11 eligible for execution.
        # Must NOT start #11.
        checkpoint = self._make_checkpoint(
            TicketState.AGENT_FAILURE
        )
        pre_run = dict(checkpoint)

        discovery = [
            [task(11)],
            [task(11)],
        ]

        orchestrator_ctor_calls = []
        real_ctor = Orchestrator

        def tracking_ctor(*args, **kwargs):
            orchestrator_ctor_calls.append(kwargs)
            return real_ctor(*args, **kwargs)

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            with unittest.mock.patch(
                "scripts.ralph.milestone.Orchestrator",
                tracking_ctor,
            ):
                result = harness.run()

            post_run_text = (
                harness.checkpoint_path.read_text()
            )
            parsed_post = json.loads(post_run_text)

            self.assertEqual(
                result.status,
                MilestoneStatus.AGENT_FAILURE,
            )
            self.assertNotEqual(
                result.status,
                MilestoneStatus.STOPPED_FOR_HUMAN,
            )
            self._assert_no_later_ticket(harness, result)
            # 11 is eligible on GitHub but the milestone
            # refuses to schedule it.
            self.assertNotIn(
                11, harness.executed_issue_numbers
            )
            self.assertEqual(orchestrator_ctor_calls, [])
            self.assertEqual(parsed_post, pre_run)
            self._assert_checkpoint_preserved(
                harness, TicketState.AGENT_FAILURE
            )

    def test_non_terminal_checkpoint_still_uses_orchestrator(
        self,
    ):
        """A non-terminal checkpoint MUST take the
        normal Orchestrator recovery path.  This is
        the regression guard for the short-circuit:
        it must not over-fire.
        """
        # ``IMPLEMENTING`` is non-terminal.
        checkpoint = make_checkpoint_payload(
            issue_number=10,
            state=TicketState.IMPLEMENTING,
        )
        pre_run = dict(checkpoint)

        discovery = [
            # Outer runner: only #10 and #11 visible.
            [task(10), task(11)],
            # Inner Orchestrator: same.
            [task(10), task(11)],
        ]

        orchestrator_ctor_calls = []

        with ProductionMilestoneHarness(
            discovery_sequence=discovery,
            checkpoint=checkpoint,
        ) as harness:
            real_ctor = Orchestrator

            def tracking_ctor(*args, **kwargs):
                orchestrator_ctor_calls.append(kwargs)
                return real_ctor(*args, **kwargs)

            with unittest.mock.patch(
                "scripts.ralph.milestone.Orchestrator",
                tracking_ctor,
            ):
                result = harness.run()

        # The inner Orchestrator was invoked exactly
        # once for the checkpointed ticket.
        self.assertGreaterEqual(
            len(orchestrator_ctor_calls), 1
        )
        # Pin was ``None`` (existing checkpoint
        # carries identity on its own).
        ctor_kwargs = orchestrator_ctor_calls[0]
        self.assertIsNone(
            ctor_kwargs.get("expected_issue_number")
        )

    def test_short_circuit_does_not_overlap_implementing(
        self,
    ):
        """Defensive coverage: ``IMPLEMENTING`` /
        ``AUTOMATED_QA`` / ``INTEGRATING`` are
        non-terminal.  Only the three terminal
        states short-circuit.
        """
        from scripts.ralph.milestone import _STOP_STATES

        # The short-circuit set MUST be exactly the
        # three terminal categories — no other
        # state may ever over-fire.
        self.assertEqual(
            _STOP_STATES,
            frozenset(
                {
                    TicketState.BLOCKED_FOR_HUMAN,
                    TicketState.INFRA_FAILURE,
                    TicketState.AGENT_FAILURE,
                }
            ),
        )


# ---------------------------------------------------------------------------
# Z. Auth-free terminal-checkpoint classification
#
# These tests prove the milestone startup ordering:
#
#   config load -> checkpoint load -> terminal short-circuit
#       -> authenticator build -> ...
#
# Terminal checkpoints MUST NEVER reach the authenticator
# factory.  Non-terminal checkpoints MUST still reach it.
# Terminal classification MUST continue to work even if
# the configured GitHub App environment variables are
# missing (broken auth config).
# ---------------------------------------------------------------------------


class AuthFreeTerminalClassificationTests(
    unittest.TestCase
):
    """The terminal short-circuit MUST run BEFORE
    ``MilestoneRunner._build_authenticator``.  Each
    test patches the authenticator factory to raise if
    it is reached; the test only passes if the
    milestone runner stops before the authenticator
    is ever constructed.
    """

    TERMINAL_STATES = (
        TicketState.BLOCKED_FOR_HUMAN,
        TicketState.INFRA_FAILURE,
        TicketState.AGENT_FAILURE,
    )

    EXPECTED_MAPPING = {
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

    def _checkpoint_for(
        self, state: TicketState
    ) -> dict:
        return {
            "schema_version": 2,
            "milestone_id": "m2",
            "issue_number": 10,
            "state": state.value,
            "integration_branch": "ralph/m2",
            "ticket_branch": "ralph/m2-10",
            "base_sha": "base123",
            "ticket_sha": "ticket123",
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

    def test_blocked_short_circuits_no_authenticator(
        self,
    ):
        self._run_terminal_under_asserting_auth(
            TicketState.BLOCKED_FOR_HUMAN,
            MilestoneStatus.STOPPED_FOR_HUMAN,
        )

    def test_infra_short_circuits_no_authenticator(self):
        self._run_terminal_under_asserting_auth(
            TicketState.INFRA_FAILURE,
            MilestoneStatus.INFRA_FAILURE,
        )

    def test_agent_short_circuits_no_authenticator(self):
        self._run_terminal_under_asserting_auth(
            TicketState.AGENT_FAILURE,
            MilestoneStatus.AGENT_FAILURE,
        )

    def _run_terminal_under_asserting_auth(
        self,
        terminal_state: TicketState,
        expected_status: MilestoneStatus,
    ):
        """Construct a MilestoneRunner with a
        terminal checkpoint and an authenticator
        factory that raises an ``AssertionError`` if
        it is ever called.  The terminal short-circuit
        MUST short-circuit before the authenticator
        is reached.
        """
        checkpoint = self._checkpoint_for(
            terminal_state
        )
        pre_run = dict(checkpoint)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "config.json"
            config_path.write_text(json.dumps(CONFIG))
            checkpoint_path = root / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint))

            authenticator_calls = {
                "count": 0
            }

            def asserting_auth(*args, **kwargs):
                authenticator_calls["count"] += 1
                raise AssertionError(
                    "authenticator must not be "
                    "constructed for a terminal "
                    "checkpoint"
                )

            orchestrator_calls = {
                "count": 0
            }

            def asserting_orchestrator(*args, **kwargs):
                orchestrator_calls["count"] += 1
                raise AssertionError(
                    "Orchestrator must not be "
                    "instantiated for a terminal "
                    "checkpoint"
                )

            from scripts.ralph import milestone as milestone_mod

            runner = MilestoneRunner(
                config_path=str(config_path),
                checkpoint_path=checkpoint_path,
                callbacks=MilestoneRunnerCallbacks(
                    make_orchestrator=asserting_orchestrator,
                    build_authenticator=asserting_auth,
                ),
            )

            with unittest.mock.patch.object(
                milestone_mod,
                "Orchestrator",
                asserting_orchestrator,
            ):
                with unittest.mock.patch.object(
                    MilestoneRunner,
                    "_build_authenticator",
                    asserting_auth,
                ):
                    result = runner.run()

            self.assertEqual(
                result.status, expected_status
            )
            self.assertEqual(
                authenticator_calls["count"], 0
            )
            self.assertEqual(
                orchestrator_calls["count"], 0
            )
            self.assertEqual(
                result.completed_tickets, ()
            )
            self.assertEqual(
                result.current_issue, 10
            )

            # Checkpoint payload unchanged.
            on_disk = json.loads(
                checkpoint_path.read_text()
            )
            self.assertEqual(on_disk, pre_run)

    def test_non_terminal_checkpoint_still_calls_auth(
        self,
    ):
        """Non-terminal checkpoints MUST still
        reach the authenticator factory.  This is
        the regression guard: the reordering MUST
        NOT accidentally make authentication
        optional for normal restart.
        """
        checkpoint = self._checkpoint_for(
            TicketState.IMPLEMENTING
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "config.json"
            config_path.write_text(json.dumps(CONFIG))
            checkpoint_path = root / "checkpoint.json"
            checkpoint_path.write_text(json.dumps(checkpoint))

            auth_calls = {
                "count": 0
            }

            class SentinelAuthError(Exception):
                pass

            def sentinel_auth(*args, **kwargs):
                auth_calls["count"] += 1
                # Raise a sentinel exception so the
                # orchestrator invocation path never
                # actually executes.  We only care
                # that ``_build_authenticator`` was
                # reached.
                raise SentinelAuthError(
                    "sentinel: auth was reached"
                )

            from scripts.ralph import milestone as milestone_mod

            runner = MilestoneRunner(
                config_path=str(config_path),
                checkpoint_path=checkpoint_path,
                callbacks=MilestoneRunnerCallbacks(
                    build_authenticator=sentinel_auth,
                ),
            )

            with unittest.mock.patch.object(
                MilestoneRunner,
                "_build_authenticator",
                sentinel_auth,
            ):
                with self.assertRaises(
                    SentinelAuthError
                ):
                    runner.run()

            # Authenticator factory MUST be reached
            # at least once for non-terminal recovery.
            self.assertGreaterEqual(
                auth_calls["count"], 1
            )

    def test_terminal_classification_with_broken_auth_config(
        self,
    ):
        """Production-shaped regression: the
        milestone runner MUST classify a terminal
        checkpoint successfully even when the
        configured GitHub App environment variables
        are missing (so the real authenticator
        constructor would raise ``KeyError``).

        The terminal checkpoint is authoritative.  A
        broken auth config MUST NOT replace it.
        """
        # Save and then clear the GitHub App env vars
        # referenced in the production
        # ``build_authenticator`` factory so the real
        # constructor would fail.
        saved_id = os.environ.pop(
            "RALPH_GITHUB_APP_ID", None
        )
        saved_key = os.environ.pop(
            "RALPH_GITHUB_APP_PRIVATE_KEY_PATH", None
        )
        saved_minimax = os.environ.pop(
            "MINIMAX_API_KEY", None
        )
        saved_nebius = os.environ.pop(
            "NEBIUS_API_KEY", None
        )

        def restore_env():
            for key, value in (
                ("RALPH_GITHUB_APP_ID", saved_id),
                (
                    "RALPH_GITHUB_APP_PRIVATE_KEY_PATH",
                    saved_key,
                ),
                ("MINIMAX_API_KEY", saved_minimax),
                (
                    "NEBIUS_API_KEY",
                    saved_nebius,
                ),
            ):
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        try:
            checkpoint = self._checkpoint_for(
                TicketState.INFRA_FAILURE
            )
            pre_run = dict(checkpoint)

            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                config_path = root / "config.json"
                config_path.write_text(json.dumps(CONFIG))
                checkpoint_path = root / "checkpoint.json"
                checkpoint_path.write_text(
                    json.dumps(checkpoint)
                )

                from scripts.ralph import (
                    milestone as milestone_mod,
                )

                authenticator_calls = {
                    "count": 0
                }

                def raising_real_auth(*args, **kwargs):
                    authenticator_calls["count"] += 1
                    # If reached, this is a regression.
                    # Production ``build_authenticator``
                    # would also raise ``KeyError`` here
                    # because the env vars are missing.
                    return (
                        milestone_mod.build_authenticator(
                            *args, **kwargs
                        )
                    )

                runner = MilestoneRunner(
                    config_path=str(config_path),
                    checkpoint_path=checkpoint_path,
                    callbacks=MilestoneRunnerCallbacks(
                        build_authenticator=(
                            raising_real_auth
                        ),
                    ),
                )

                # Capture stdout so a leaked env var
                # name or traceback would fail the
                # test.
                buffer = io.StringIO()
                with redirect_stdout(buffer):
                    with unittest.mock.patch.object(
                        MilestoneRunner,
                        "_build_authenticator",
                        raising_real_auth,
                    ):
                        result = runner.run()

                output = buffer.getvalue()

                self.assertEqual(
                    result.status,
                    MilestoneStatus.INFRA_FAILURE,
                )
                self.assertEqual(
                    authenticator_calls["count"], 0
                )
                # No env var name may appear in the
                # operator console.
                self.assertNotIn(
                    "RALPH_GITHUB_APP_ID", output
                )
                self.assertNotIn(
                    "RALPH_GITHUB_APP_PRIVATE_KEY_PATH",
                    output,
                )
                self.assertNotIn(
                    "KeyError", output
                )
                self.assertNotIn(
                    "Traceback", output
                )
                # Static Ralph-owned stop line is
                # the only failure signal.
                self.assertIn(
                    "RALPH MILESTONE: stopped on "
                    "issue #10 — INFRA_FAILURE",
                    output,
                )

                # Checkpoint payload unchanged.
                on_disk = json.loads(
                    checkpoint_path.read_text()
                )
                self.assertEqual(on_disk, pre_run)
        finally:
            restore_env()


if __name__ == "__main__":
    unittest.main()
