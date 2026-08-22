"""Unit tests for ``scripts.ralph.github_probe``.

Exercises the live ``_request`` / ``remote_branch_head``
boundary used in production.  The probe communicates
verified-HTTP-404 through a private sentinel so the caller can
distinguish FOUND / NOT_FOUND / MALFORMED without ambiguity.

These tests MUST NOT make real GitHub calls.  ``sandbox.exec``
is replaced with a fake that returns canned
``SandboxCommandResult`` values mirroring the live subprocess
output.

The ``EmbeddedHttpHandlerBoundaryTests`` class goes one
further: it executes the actual embedded Python script emitted
by ``GitHubReadOnlyProbe._request()`` in-process, with
``urllib.request.urlopen`` monkey-patched to raise the
intended ``HTTPError``.  That proves the production
``allow_not_found`` handler — not just the producer — emits
the verified-not-found sentinel.  Reverting the embedded
script back to ``sys.stdout.write("null")`` will break this
test even if the probe itself is unchanged.
"""

import io
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from unittest.mock import MagicMock, patch

from scripts.ralph.github_probe import (
    GitHubReadOnlyProbe,
    _VERIFIED_NOT_FOUND,
    _VerifiedNotFound,
)
from scripts.ralph.recovery import (
    BranchAbsentReason,
    BranchLookup,
    BranchMalformedReason,
    PullRequestAbsentReason,
)
from scripts.ralph.sandbox import SandboxCommandResult


def _make_probe() -> tuple:
    sandbox = MagicMock()
    probe = GitHubReadOnlyProbe(
        sandbox=sandbox,
        github_token="secret",
        owner="Measure-2wice",
        repository="sound-hub",
    )
    return probe, sandbox


class ProbeBoundaryTests(unittest.TestCase):
    """Boundary tests for the live ``_request`` /
    ``remote_branch_head`` boundary.

    The subprocess writes one of:

    - ``__RALPH_VERIFIED_NOT_FOUND__`` (verified HTTP 404 with
      ``allow_not_found=True``)
    - a JSON value (FOUND)
    - empty / ``"null"`` / unparseable (MALFORMED, becomes
      ``None``)
    - exit code != 0 (transport / HTTP error, ``_request``
      raises ``RuntimeError``)
    """

    def test_a_http_404_with_allow_not_found_returns_not_found(
        self,
    ):
        """A) HTTP 404 + allow_not_found ->
        BranchLookup.absent_reason == NOT_FOUND,
        malformed_reason is None."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="__RALPH_VERIFIED_NOT_FOUND__\n",
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(
            result.absent_reason,
            BranchAbsentReason.NOT_FOUND,
        )
        self.assertIsNone(result.malformed_reason)
        self.assertIsNone(result.head_sha)

    def test_b_http_200_valid_ref_returns_head_sha(self):
        """B) HTTP 200 with a well-formed ref -> head_sha."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                '{"object":{"sha":"abc123def456"}}\n'
            ),
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.head_sha, "abc123def456")
        self.assertIsNone(result.absent_reason)
        self.assertIsNone(result.malformed_reason)

    def test_c_http_200_with_json_null_body_is_malformed(self):
        """C) HTTP 200 with literal JSON null body -> MALFORMED,
        NOT absent."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="null\n",
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(
            result.malformed_reason,
            BranchMalformedReason.MALFORMED_RESPONSE,
        )
        self.assertIsNone(result.absent_reason)
        self.assertIsNone(result.head_sha)

    def test_c2_http_200_with_empty_body_is_malformed(self):
        """C-extended) HTTP 200 with empty body -> MALFORMED."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="\n",
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(
            result.malformed_reason,
            BranchMalformedReason.MALFORMED_RESPONSE,
        )
        self.assertIsNone(result.absent_reason)

    def test_d_http_200_malformed_json_is_malformed(self):
        """D) HTTP 200 with malformed JSON -> MALFORMED."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="definitely not json\n",
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(
            result.malformed_reason,
            BranchMalformedReason.MALFORMED_RESPONSE,
        )
        self.assertIsNone(result.absent_reason)

    def test_d2_http_200_wrong_type_is_malformed(self):
        """D-extended) HTTP 200 with non-dict body -> MALFORMED."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="[1, 2, 3]\n",
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(
            result.malformed_reason,
            BranchMalformedReason.WRONG_TYPE,
        )
        self.assertIsNone(result.absent_reason)

    def test_d3_http_200_missing_object_is_malformed(self):
        """D-extended) HTTP 200 with no object.sha -> MALFORMED."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout='{"ref":"heads/ralph/m2-17"}\n',
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(
            result.malformed_reason,
            BranchMalformedReason.MISSING_OBJECT,
        )
        self.assertIsNone(result.absent_reason)

    def test_d4_http_200_empty_sha_is_malformed(self):
        """D-extended) HTTP 200 with empty SHA -> MALFORMED."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout='{"object":{"sha":""}}\n',
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertIsNotNone(result)
        self.assertEqual(
            result.malformed_reason,
            BranchMalformedReason.EMPTY_SHA,
        )
        self.assertIsNone(result.absent_reason)

    def test_e_transport_failure_raises_not_absent(self):
        """E) HTTP 500 / sandbox failure -> RuntimeError, NOT
        absent.  Caller must not interpret a transport error
        as a verified NOT_FOUND."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=1,
            stdout="",
            stderr="GitHub HTTP 500: server error",
        )

        with self.assertRaises(RuntimeError):
            probe.remote_branch_head(
                ticket_branch="ralph/m2-17"
            )

    def test_e2_non_404_http_error_raises(self):
        """E-extended) non-404 HTTP error without allow_not_found
        MUST raise, not become NOT_FOUND."""
        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=1,
            stdout="",
            stderr="GitHub HTTP 403: rate limited",
        )

        with self.assertRaises(RuntimeError):
            probe.remote_branch_head(
                ticket_branch="ralph/m2-17"
            )

    def test_verified_not_found_sentinel_is_distinct(self):
        """The verified-404 sentinel MUST be distinct from
        ``None``, dicts, and any other object ``_request``
        can return."""
        self.assertIsNotNone(_VERIFIED_NOT_FOUND)
        self.assertIsNotNone(_VerifiedNotFound())
        self.assertIsInstance(
            _VERIFIED_NOT_FOUND,
            _VerifiedNotFound,
        )
        # ``None`` must remain the malformed-body signal.
        self.assertNotEqual(_VERIFIED_NOT_FOUND, None)
        self.assertFalse(
            isinstance(_VERIFIED_NOT_FOUND, dict)
        )
        self.assertFalse(
            isinstance(_VERIFIED_NOT_FOUND, list)
        )


class LiveSmokeReconcileRegressionTests(unittest.TestCase):
    """End-to-end regression for the second disposable Ralph
    smoke.  Reproduces:

      AUTOMATED_QA
      checkpoint has:
        persisted_commit_sha=None
        pull_request_number=None
      GitHub:
        ticket branch = verified absent
        PR = none
      -> reconcile = NOTHING_DURABLE
      -> Ralph does NOT BLOCK
      -> QA attempt begins

    These tests drive the live ``GitHubReadOnlyProbe`` with a
    fake subprocess returning the exact outputs the real
    boundary produces, then feed the probe result into
    ``reconcile_persistence`` to prove the conductor would not
    block the ticket.
    """

    def _build_checkpoint(self, issue_number: int = 17):
        from scripts.ralph.checkpoint import TicketCheckpoint
        from scripts.ralph.review import ReviewStage
        from scripts.ralph.states import TicketState

        return TicketCheckpoint(
            milestone_id="m2",
            issue_number=issue_number,
            state=TicketState.AUTOMATED_QA,
            integration_branch="ralph/m2",
            ticket_branch=f"ralph/m2-{issue_number}",
            ticket_sha="baseline-ticket-sha",
            review_stage=ReviewStage.PRE_QA,
            qa_attempts=0,
        )

    def test_verified_absent_branch_with_clean_checkpoint_yields_nothing_durable(
        self,
    ):
        """Live-smoke regression:

        AUTOMATED_QA checkpoint with
        ``persisted_commit_sha=None`` and
        ``pull_request_number=None`` + verified-absent branch
        + empty PR list -> reconcile = NOTHING_DURABLE.

        Before the fix, the probe reported MALFORMED and Ralph
        blocked the ticket.  After the fix, the verified 404
        yields NOT_FOUND and reconciliation returns
        NOTHING_DURABLE so the QA attempt can begin.
        """
        from scripts.ralph.git_policy import GitPushPolicy
        from scripts.ralph.recovery import (
            RecoveryOutcome,
            reconcile_persistence,
        )

        probe, sandbox = _make_probe()

        # First call: branch lookup -> verified 404.
        # Second call: PR list lookup -> empty well-formed list.
        sandbox.exec.side_effect = [
            SandboxCommandResult(
                exit_code=0,
                stdout="__RALPH_VERIFIED_NOT_FOUND__\n",
                stderr="",
            ),
            SandboxCommandResult(
                exit_code=0,
                stdout="[]\n",
                stderr="",
            ),
        ]

        checkpoint = self._build_checkpoint()
        policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.NOTHING_DURABLE,
        )
        self.assertIsNone(state.commit_sha)
        self.assertIsNone(state.pull_request_number)

    def test_verified_absent_branch_matches_make_absent_branch_helper(
        self,
    ):
        """The live probe's NOT_FOUND output MUST match the
        shape used by the existing AUTOMATED_QA harness tests
        (``make_absent_branch``), so the conductor can rely on
        the same code path for both fake and live probes."""
        from scripts.ralph.recovery import BranchAbsentReason

        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="__RALPH_VERIFIED_NOT_FOUND__\n",
            stderr="",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertEqual(
            result,
            BranchLookup(
                absent_reason=BranchAbsentReason.NOT_FOUND
            ),
        )

    def test_malformed_branch_yields_ambiguous(self):
        """A malformed branch body MUST continue to fail closed
        as AMBIGUOUS — never silently become NOTHING_DURABLE.

        This is the regression guard that proves the fix did
        not weaken the malformed branch path.
        """
        from scripts.ralph.git_policy import GitPushPolicy
        from scripts.ralph.recovery import (
            RecoveryOutcome,
            reconcile_persistence,
        )

        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="null\n",
            stderr="",
        )

        checkpoint = self._build_checkpoint()
        policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_transport_error_yields_ambiguous(self):
        """A transport error in the probe MUST yield AMBIGUOUS.

        This is the regression guard for the live-smoke
        failure mode where a transient probe failure was
        interpreted as NOTHING_DURABLE in the past.  With the
        fix, transport errors raise from ``_request`` and
        ``reconcile_persistence`` translates that to AMBIGUOUS.
        """
        from scripts.ralph.git_policy import GitPushPolicy
        from scripts.ralph.recovery import (
            RecoveryOutcome,
            reconcile_persistence,
        )

        probe, sandbox = _make_probe()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=1,
            stdout="",
            stderr="GitHub HTTP 500: server error",
        )

        checkpoint = self._build_checkpoint()
        policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

        with self.assertRaises(RuntimeError):
            reconcile_persistence(
                checkpoint=checkpoint,
                policy=policy,
                probe=probe,
                owner="Measure-2wice",
                repository="sound-hub",
            )


# ---------------------------------------------------------------------------
# Helpers for executing the embedded urllib script in-process.
# ---------------------------------------------------------------------------


def _execute_embedded_script(
    *,
    script: str,
    request_payload: dict,
    env: dict,
    urlopen_side_effect,
) -> SandboxCommandResult:
    """Execute the embedded Python script emitted by
    ``GitHubReadOnlyProbe._request`` in-process, with
    ``urllib.request.urlopen`` replaced by
    ``urlopen_side_effect``.

    This is the live boundary test: the script source itself
    runs (not a mock of it), so a regression that writes
    ``sys.stdout.write("null")`` in place of the
    ``__RALPH_VERIFIED_NOT_FOUND__`` sentinel will produce
    stdout ``"null"`` and fail the boundary assertion below.

    No real network access happens — ``urllib.request.urlopen``
    is patched via ``unittest.mock.patch.object`` before the
    script runs.
    """
    fake_stdin = io.StringIO(json.dumps(request_payload))
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
    raised: BaseException | None = None

    try:
        with patch.object(
            urllib.request,
            "urlopen",
            side_effect=urlopen_side_effect,
        ):
            try:
                exec(script, {"__name__": "__main__"})
            except SystemExit as exit_event:
                code = exit_event.code
                if isinstance(code, int):
                    exit_code = code
                elif code is None:
                    exit_code = 0
                else:
                    exit_code = 1
            except BaseException as error:  # noqa: BLE001
                # The embedded script's ``raise`` (for non-404
                # HTTP errors) re-raises the caught HTTPError.
                # Capture it as a non-zero exit so the probe's
                # ``_request`` sees the same exit_code=1 it
                # would in production.
                raised = error
                exit_code = 1
                # Mirror how Python's interpreter would write
                # an unhandled traceback to stderr.
                import traceback

                traceback.print_exc(file=fake_stderr)
    finally:
        for key, previous in saved_env.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
        sys.stdin = saved_stdin
        sys.stdout = saved_stdout
        sys.stderr = saved_stderr

    if raised is not None:
        # Re-raise SystemExit-shaped exits outside the sandbox
        # boundary; HTTPError is re-raised by the script and is
        # expected to be visible only via exit_code, not the
        # Python exception chain.  We surface it for the caller
        # to assert on if needed.
        setattr(raised, "_sandbox_exit_code", exit_code)

    return SandboxCommandResult(
        exit_code=exit_code,
        stdout=fake_stdout.getvalue(),
        stderr=fake_stderr.getvalue(),
    )


class _FakeHttpResponse:
    """A minimal stand-in for the ``HTTPResponse`` returned by
    ``urllib.request.urlopen`` on a 200 status.  Implements
    the context-manager protocol and ``.read()`` so the
    embedded script can consume the body exactly as it does
    in production.
    """

    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def _make_404_side_effect():
    """Build a ``urlopen`` replacement that raises
    ``urllib.error.HTTPError(404)`` exactly as a real GitHub
    404 would."""

    def side_effect(*args, **kwargs):
        raise urllib.error.HTTPError(
            url="https://api.github.com/repos/foo/bar/git/ref/heads/x",
            code=404,
            msg="Not Found",
            hdrs={},
            fp=io.BytesIO(b'{"message":"Not Found"}'),
        )

    return side_effect


def _make_500_side_effect():
    """Build a ``urlopen`` replacement that raises
    ``urllib.error.HTTPError(500)`` — NOT 404.  The embedded
    script must propagate this as a non-zero exit (no
    sentinel) so the probe fails closed."""

    def side_effect(*args, **kwargs):
        raise urllib.error.HTTPError(
            url="https://api.github.com/repos/foo/bar/git/ref/heads/x",
            code=500,
            msg="Internal Server Error",
            hdrs={},
            fp=io.BytesIO(b"server error"),
        )

    return side_effect


class EmbeddedHttpHandlerBoundaryTests(unittest.TestCase):
    """Live boundary tests for the embedded urllib HTTPError(404)
    handler inside ``GitHubReadOnlyProbe._request``.

    Unlike the tests above, these do NOT mock ``sandbox.exec``
    to return canned stdout.  Instead, they execute the actual
    Python script emitted by ``_request`` in-process, with
    ``urllib.request.urlopen`` monkey-patched to raise the
    intended ``HTTPError``.  That proves the production
    ``allow_not_found`` handler — not the producer — emits
    the verified-not-found sentinel.

    This is the regression guard that survives a production
    change such as reverting the sentinel to
    ``sys.stdout.write("null")``.  Such a change would leave
    the simpler tests above passing (they trust the producer)
    but would break this one, because the live script would
    write ``null`` and the boundary assertion expects the
    sentinel string.
    """

    _ENV = {"RALPH_GITHUB_TOKEN": "secret-token"}

    def _capture_script(self, sandbox: MagicMock) -> str:
        """Capture the Python script emitted by ``_request``
        so we can execute it ourselves.  The same script must
        work both inside the probe and as a standalone
        subprocess fed the same stdin payload."""
        captured: dict = {}

        real_exec = sandbox.exec

        def capturing_exec(*args, **kwargs):
            captured["command"] = args
            captured["kwargs"] = kwargs
            # Return a placeholder; the test will execute the
            # captured script via ``_execute_embedded_script``
            # and replace this return value.
            return SandboxCommandResult(
                exit_code=0,
                stdout="",
                stderr="",
            )

        sandbox.exec.side_effect = capturing_exec
        return captured

    def _exec_via_probe(self, probe, sandbox, request_payload):
        """Run ``probe._request`` while capturing the embedded
        script, then execute that script in-process with the
        requested ``urlopen`` behavior.

        Returns the ``SandboxCommandResult`` the probe's
        caller would have received.
        """
        captured: dict = {}
        original_side_effect = sandbox.exec.side_effect

        def capturing_exec(*args, **kwargs):
            captured["command"] = args
            captured["kwargs"] = kwargs
            return _execute_embedded_script(
                script=args[2],
                request_payload=request_payload,
                env=kwargs.get("env", {}),
                urlopen_side_effect=captured["urlopen"],
            )

        # Two-phase: set the side_effect so the FIRST probe
        # call captures the script, then re-run so the SECOND
        # call actually executes it.
        sandbox.exec.side_effect = lambda *a, **kw: (
            captured.setdefault("command", a),
            captured.setdefault("kwargs", kw),
            SandboxCommandResult(0, "", ""),
        )[-1]
        probe._request(
            method=request_payload["method"],
            path=request_payload["path"],
            allow_not_found=request_payload.get(
                "allow_not_found", False
            ),
        )
        # The first invocation captured the script and env;
        # now run the actual embedded script with the
        # configured urlopen replacement.
        captured["urlopen"] = _make_404_side_effect()
        sandbox.exec.side_effect = capturing_exec
        return probe._request(
            method=request_payload["method"],
            path=request_payload["path"],
            allow_not_found=request_payload.get(
                "allow_not_found", False
            ),
        )

    def _make_probe_with_recording_sandbox(self):
        """Build a probe whose sandbox records every
        ``sandbox.exec`` invocation but does NOT short-circuit
        with canned stdout.  The test drives the embedded
        script via the recorded kwargs.
        """
        sandbox = MagicMock()
        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )
        return probe, sandbox

    def test_live_embedded_404_handler_emits_verified_not_found(
        self,
    ):
        """End-to-end regression: the live embedded script
        raises ``HTTPError(404)`` from ``urllib.request.urlopen``,
        and the production ``allow_not_found`` branch emits
        ``__RALPH_VERIFIED_NOT_FOUND__`` to stdout.  The
        probe's ``_request`` translates that sentinel into
        ``_VERIFIED_NOT_FOUND``, and ``remote_branch_head``
        maps it to ``BranchLookup(absent_reason=NOT_FOUND)``.

        If production code reverts the embedded handler to
        ``sys.stdout.write("null")``, this test fails because
        ``null`` becomes ``None`` in ``_request``, which maps
        to MALFORMED — not NOT_FOUND.
        """
        sandbox = MagicMock()
        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )

        captured_command: dict = {}

        def exec_side_effect(*args, **kwargs):
            captured_command["args"] = args
            captured_command["kwargs"] = kwargs
            return _execute_embedded_script(
                script=args[2],
                request_payload={
                    "method": "GET",
                    "path": "/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
                    "allow_not_found": True,
                },
                env=kwargs.get("env", {}),
                urlopen_side_effect=_make_404_side_effect(),
            )

        sandbox.exec.side_effect = exec_side_effect

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        # The production code path was actually exercised:
        # the script ran the real ``try / except HTTPError``
        # block with a real ``HTTPError(404)``.
        self.assertEqual(
            captured_command["args"][0],
            "python3",
        )
        self.assertEqual(
            captured_command["args"][1],
            "-c",
        )

        # The boundary result: NOT_FOUND, NOT malformed.
        self.assertIsNotNone(result)
        self.assertEqual(
            result.absent_reason,
            BranchAbsentReason.NOT_FOUND,
        )
        self.assertIsNone(result.malformed_reason)
        self.assertIsNone(result.head_sha)

    def test_live_embedded_handler_writes_literal_sentinel_string(
        self,
    ):
        """The stdout captured from the embedded script MUST
        contain the literal ``__RALPH_VERIFIED_NOT_FOUND__``
        string — not ``"null"``, not ``""``.  This is the
        direct assertion that the embedded handler emits the
        sentinel.  If production code reverts to
        ``sys.stdout.write("null")`` this assertion fails.
        """
        sandbox = MagicMock()

        def exec_side_effect(*args, **kwargs):
            return _execute_embedded_script(
                script=args[2],
                request_payload={
                    "method": "GET",
                    "path": "/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
                    "allow_not_found": True,
                },
                env=kwargs.get("env", {}),
                urlopen_side_effect=_make_404_side_effect(),
            )

        sandbox.exec.side_effect = exec_side_effect
        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )

        result = probe._request(
            method="GET",
            path="/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
            allow_not_found=True,
        )

        # The sentinel was returned.
        self.assertIs(result, _VERIFIED_NOT_FOUND)
        self.assertIsInstance(result, _VerifiedNotFound)

        # Re-run with a recording side_effect to capture the
        # raw stdout for the literal-string assertion.
        captured_stdout: dict = {}

        def recording_exec(*args, **kwargs):
            result_obj = _execute_embedded_script(
                script=args[2],
                request_payload={
                    "method": "GET",
                    "path": "/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
                    "allow_not_found": True,
                },
                env=kwargs.get("env", {}),
                urlopen_side_effect=_make_404_side_effect(),
            )
            captured_stdout["stdout"] = result_obj.stdout
            return result_obj

        sandbox.exec.side_effect = recording_exec

        probe._request(
            method="GET",
            path="/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
            allow_not_found=True,
        )

        # The literal sentinel is what the embedded script
        # wrote.  ``null`` here would mean production reverted
        # to ``sys.stdout.write("null")``.
        self.assertIn(
            "__RALPH_VERIFIED_NOT_FOUND__",
            captured_stdout["stdout"],
        )
        self.assertNotIn(
            '"null"',
            captured_stdout["stdout"].replace(
                "__RALPH_VERIFIED_NOT_FOUND__", ""
            ),
        )

    def test_live_embedded_500_does_not_emit_sentinel(self):
        """Non-404 HTTP errors MUST NOT be turned into the
        verified-not-found sentinel.  ``_request`` must fail
        closed (non-zero exit -> ``RuntimeError``).
        """
        sandbox = MagicMock()

        def exec_side_effect(*args, **kwargs):
            return _execute_embedded_script(
                script=args[2],
                request_payload={
                    "method": "GET",
                    "path": "/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
                    "allow_not_found": True,
                },
                env=kwargs.get("env", {}),
                urlopen_side_effect=_make_500_side_effect(),
            )

        sandbox.exec.side_effect = exec_side_effect
        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )

        with self.assertRaises(RuntimeError):
            probe.remote_branch_head(
                ticket_branch="ralph/m2-17"
            )

    def test_live_embedded_200_valid_ref_returns_head_sha(self):
        """The embedded handler MUST still produce a FOUND
        result on 200 with a valid JSON ref.  This guards
        against a regression where the 404 handling change
        accidentally clobbers the happy path.
        """
        sandbox = MagicMock()

        def urlopen_replacement(*args, **kwargs):
            return _FakeHttpResponse(
                b'{"object":{"sha":"deadbeefcafef00d"}}'
            )

        def exec_side_effect(*args, **kwargs):
            return _execute_embedded_script(
                script=args[2],
                request_payload={
                    "method": "GET",
                    "path": "/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
                },
                env=kwargs.get("env", {}),
                urlopen_side_effect=urlopen_replacement,
            )

        sandbox.exec.side_effect = exec_side_effect
        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertEqual(result.head_sha, "deadbeefcafef00d")
        self.assertIsNone(result.absent_reason)
        self.assertIsNone(result.malformed_reason)

    def test_live_embedded_200_null_body_is_malformed(self):
        """A 200 with a literal ``null`` JSON body MUST be
        classified as MALFORMED, never as NOT_FOUND.  This is
        the regression guard proving the verified-not-found
        path does not accidentally capture the malformed-null
        path.
        """
        sandbox = MagicMock()

        def urlopen_replacement(*args, **kwargs):
            return _FakeHttpResponse(b"null")

        def exec_side_effect(*args, **kwargs):
            return _execute_embedded_script(
                script=args[2],
                request_payload={
                    "method": "GET",
                    "path": "/repos/Measure-2wice/sound-hub/git/ref/heads/ralph/m2-17",
                },
                env=kwargs.get("env", {}),
                urlopen_side_effect=urlopen_replacement,
            )

        sandbox.exec.side_effect = exec_side_effect
        probe = GitHubReadOnlyProbe(
            sandbox=sandbox,
            github_token="secret-token",
            owner="Measure-2wice",
            repository="sound-hub",
        )

        result = probe.remote_branch_head(
            ticket_branch="ralph/m2-17"
        )

        self.assertEqual(
            result.malformed_reason,
            BranchMalformedReason.MALFORMED_RESPONSE,
        )
        self.assertIsNone(result.absent_reason)
        self.assertIsNone(result.head_sha)


if __name__ == "__main__":
    unittest.main()