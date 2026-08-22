import json
import unittest
from unittest.mock import MagicMock

from scripts.ralph.review import (
    REVIEW_FINDINGS_NOT_LIST,
    REVIEW_INVALID_JSON,
    REVIEW_INVALID_WRAPPER_JSON,
    REVIEW_MALFORMED_FINDING,
    REVIEW_MISSING_CONTENT,
    REVIEW_NEBIUS_FAILED,
    REVIEW_UNKNOWN_VERDICT,
    REVIEW_VERDICT_INVALID_FOR_STAGE,
    ReviewError,
    ReviewRunner,
    ReviewStage,
    ReviewVerdict,
)
from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.workspace import TicketWorkspace


class ReviewRunnerTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = MagicMock()

        self.workspace = TicketWorkspace(
            repository_path="/tmp/sound-hub",
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
            base_sha="base123",
            ticket_sha="ticket123",
            resumed=False,
        )

        self.runner = ReviewRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
            model="moonshotai/Kimi-K2.7-Code",
            api_key="test-secret",
        )

    def test_parses_fix_before_qa(self):
        response = {
            "content": json.dumps(
                {
                    "verdict": "FIX_BEFORE_QA",
                    "summary": "Correctness issue found.",
                    "findings": [
                        {
                            "severity": "BLOCKING",
                            "title": "Broken division",
                            "details": (
                                "The implementation multiplies "
                                "instead of dividing."
                            ),
                        }
                    ],
                }
            ),
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150,
            },
        }

        parsed = self.runner._parse_response(
            response,
            stage=ReviewStage.PRE_QA,
        )

        self.assertEqual(
            parsed.verdict,
            ReviewVerdict.FIX_BEFORE_QA,
        )

        self.assertEqual(
            len(parsed.findings),
            1,
        )

        self.assertEqual(
            parsed.findings[0].severity,
            "BLOCKING",
        )

        self.assertEqual(
            parsed.total_tokens,
            150,
        )

    def test_parses_persistence_approval(self):
        response = {
            "content": json.dumps(
                {
                    "verdict":
                        "APPROVE_FOR_PERSISTENCE",
                    "summary":
                        "All persistence gates satisfied.",
                    "findings": [],
                }
            ),
            "usage": {},
        }

        parsed = self.runner._parse_response(
            response,
            stage=ReviewStage.PRE_PERSISTENCE,
        )

        self.assertEqual(
            parsed.verdict,
            ReviewVerdict.APPROVE_FOR_PERSISTENCE,
        )

    def test_pre_qa_rejects_persistence_verdict(self):
        response = {
            "content": json.dumps(
                {
                    "verdict":
                        "APPROVE_FOR_PERSISTENCE",
                    "summary": "",
                    "findings": [],
                }
            ),
            "usage": {},
        }

        with self.assertRaises(
            ReviewError
        ):
            self.runner._parse_response(
                response,
                stage=ReviewStage.PRE_QA,
            )

    def test_invalid_json_fails_closed(self):
        response = {
            "content": (
                "Looks good to me!"
            ),
            "usage": {},
        }

        with self.assertRaises(
            ReviewError
        ):
            self.runner._parse_response(
                response,
                stage=ReviewStage.PRE_QA,
            )

    def test_code_fenced_json_is_supported(self):
        response = {
            "content": (
                "```json\n"
                "{"
                "\"verdict\":\"APPROVE_FOR_QA\","
                "\"summary\":\"Ready.\","
                "\"findings\":[]"
                "}\n"
                "```"
            ),
            "usage": {},
        }

        parsed = self.runner._parse_response(
            response,
            stage=ReviewStage.PRE_QA,
        )

        self.assertEqual(
            parsed.verdict,
            ReviewVerdict.APPROVE_FOR_QA,
        )

    def test_pre_qa_does_not_require_qa_evidence(self):
        prompt = self.runner._build_prompt(
            issue_number=17,
            issue_context="Implement the ticket.",
            diff_text="diff --git a/file.py b/file.py",
            stage=ReviewStage.PRE_QA,
            previous_findings=None,
            qa_evidence=None,
        )

        self.assertIn(
            "Executable QA has intentionally not run yet",
            prompt,
        )

        self.assertIn(
            "Do not create a finding merely because QA "
            "evidence is absent",
            prompt,
        )

        self.assertNotIn(
            "No QA evidence supplied.",
            prompt,
        )

    def test_pre_persistence_prompt_requires_qa_evidence(self):
        prompt = self.runner._build_prompt(
            issue_number=17,
            issue_context="Implement the ticket.",
            diff_text="diff --git a/file.py b/file.py",
            stage=ReviewStage.PRE_PERSISTENCE,
            previous_findings=None,
            qa_evidence=None,
        )

        self.assertIn(
            "PRE_PERSISTENCE review must fail closed",
            prompt,
        )


class NebiusJSONModeTests(unittest.TestCase):
    """Smoke #43 first-failure blocker: Nebius returned
    non-JSON content during PRE_QA review.  Ralph must
    request ``response_format={"type": "json_object"}``
    so the model returns a parseable JSON object."""

    def setUp(self):
        self.sandbox = MagicMock()

        self.workspace = TicketWorkspace(
            repository_path="/tmp/sound-hub",
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
            base_sha="base123",
            ticket_sha="ticket123",
            resumed=False,
        )

        self.runner = ReviewRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
            model="moonshotai/Kimi-K2.7-Code",
            api_key="test-secret",
        )

    def _captured_request_payload(self):
        """Pull the JSON request payload the runner sent
        to the sandbox.  ``_call_nebius`` calls
        ``self.sandbox.exec(..., input=...)`` with the
        JSON-encoded payload."""
        self.assertTrue(
            self.sandbox.exec.called,
            "sandbox.exec was not invoked",
        )

        # Find the call that passed an ``input`` kwarg.
        for call in self.sandbox.exec.call_args_list:
            kwargs = call.kwargs
            if "input" in kwargs:
                return json.loads(kwargs["input"])

        self.fail(
            "sandbox.exec was invoked but no call "
            "passed an 'input' kwarg"
        )

    def test_request_payload_enables_json_mode(self):
        """The Nebius request payload MUST include
        ``response_format={"type": "json_object"}``.
        Without it, the smoke failure reproduces
        immediately."""
        # Stub the sandbox exec to return a valid JSON
        # response so _call_nebius completes normally.
        valid_content = json.dumps(
            {
                "verdict": "APPROVE_FOR_QA",
                "summary": "Ready.",
                "findings": [],
            }
        )
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout=json.dumps(
                    {
                        "content": valid_content,
                        "usage": {},
                    }
                ),
                stderr="",
            )
        )

        self.runner._call_nebius(
            "Return JSON for ticket #17."
        )

        payload = self._captured_request_payload()

        self.assertEqual(
            payload.get("response_format"),
            {"type": "json_object"},
        )

    def test_valid_json_response_still_parses(self):
        """With JSON mode on, a well-formed response
        must still parse end-to-end."""
        valid_content = json.dumps(
            {
                "verdict": "APPROVE_FOR_QA",
                "summary": "All good.",
                "findings": [],
            }
        )
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout=json.dumps(
                    {
                        "content": valid_content,
                        "usage": {
                            "prompt_tokens": 10,
                            "completion_tokens": 5,
                            "total_tokens": 15,
                        },
                    }
                ),
                stderr="",
            )
        )

        parsed = self.runner._parse_response(
            {
                "content": valid_content,
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
            stage=ReviewStage.PRE_QA,
        )

        self.assertEqual(
            parsed.verdict,
            ReviewVerdict.APPROVE_FOR_QA,
        )
        self.assertEqual(parsed.total_tokens, 15)

    def test_fenced_valid_json_still_parses(self):
        """If a model still emits ```json ... ``` fences
        even with JSON mode on, the existing fence-strip
        behavior must keep working."""
        fenced = (
            "```json\n"
            + json.dumps(
                {
                    "verdict": "APPROVE_FOR_QA",
                    "summary": "Ready.",
                    "findings": [],
                }
            )
            + "\n```"
        )

        parsed = self.runner._parse_response(
            {
                "content": fenced,
                "usage": {},
            },
            stage=ReviewStage.PRE_QA,
        )

        self.assertEqual(
            parsed.verdict,
            ReviewVerdict.APPROVE_FOR_QA,
        )

    def test_non_json_response_still_raises(self):
        """If the reviewer emits prose instead of JSON,
        Ralph must STILL fail closed with ReviewError."""
        with self.assertRaises(ReviewError):
            self.runner._parse_response(
                {
                    "content": (
                        "Looks good to me — ship it."
                    ),
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )

    def test_malformed_verdict_json_still_raises(self):
        """JSON that parses but contains an unknown
        verdict must STILL fail closed.  JSON mode
        does not weaken strict verdict validation."""
        with self.assertRaises(ReviewError):
            self.runner._parse_response(
                {
                    "content": json.dumps(
                        {
                            "verdict": (
                                "DEFINITELY_APPROVED"
                            ),
                            "summary": "",
                            "findings": [],
                        }
                    ),
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )


class PersistedReviewErrorSafetyTests(unittest.TestCase):
    """Persisted-error policy: ``str(ReviewError)`` is
    the literal text that flows into
    ``checkpoint.last_error``.  Every ReviewError
    raised by the reviewer boundary MUST be a static
    categorical message plus a stable error code —
    never content from the model response, never
    subprocess stdout/stderr, never a digest of any
    of those values.
    """

    def setUp(self):
        self.sandbox = MagicMock()

        self.workspace = TicketWorkspace(
            repository_path="/tmp/sound-hub",
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
            base_sha="base123",
            ticket_sha="ticket123",
            resumed=False,
        )

        self.runner = ReviewRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
            model="moonshotai/Kimi-K2.7-Code",
            api_key="test-secret",
        )

    # ------------------------------------------------------------------
    # A. INVALID MODEL CONTENT
    # ------------------------------------------------------------------
    def test_invalid_model_content_keeps_secret_out_of_error(
        self,
    ):
        """Use content equal to a mocked secret and
        trigger invalid JSON.  The ReviewError MUST
        NOT contain the secret, any 4-char substring
        of it, or the secret length."""
        secret = "super-secret-nebius-value-12345"

        try:
            self.runner._parse_response(
                {
                    "content": secret,
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail(
                "expected ReviewError for invalid "
                "JSON content"
            )
        except ReviewError as error:
            message = str(error)

            # The static categorical message MUST
            # still be present.
            self.assertIn(
                "Reviewer did not return valid "
                "verdict JSON.",
                message,
            )
            self.assertIn(
                REVIEW_INVALID_JSON,
                message,
            )

            # The secret MUST NOT appear in any
            # form.
            self.assertNotIn(secret, message)

            # No 4-char substring of the secret
            # may appear.  A 3-char prefix leak
            # would be enough to recover the
            # secret by brute force.
            for start in range(
                0,
                len(secret) - 3,
            ):
                fragment = secret[start : start + 4]
                self.assertNotIn(
                    fragment,
                    message,
                    msg=(
                        "substring leak: "
                        f"{fragment!r} found in error"
                    ),
                )

            # No SHA/digest/prefix/suffix/length
            # of the secret may be persisted.
            self.assertNotIn(
                "content_sha256=",
                message,
            )
            self.assertNotIn(
                "content_length=",
                message,
            )
            self.assertNotIn(
                "fence_stripped=",
                message,
            )

            # No fragment of the literal secret
            # in any of its common encodings.
            encoded_secret = json.dumps(secret)
            self.assertNotIn(
                encoded_secret,
                message,
            )

            # No JSON fragment from the payload
            # may appear.
            self.assertNotIn(
                json.dumps({"content": secret}),
                message,
            )

    # ------------------------------------------------------------------
    # B. SUBPROCESS stdout LEAK
    # ------------------------------------------------------------------
    def test_subprocess_stdout_leak_is_blocked(self):
        """A nonzero subprocess result with the secret
        in stdout MUST NOT leak it into ReviewError."""
        secret = "super-secret-nebius-value-12345"

        # _call_nebius re-uses the runner sandbox
        # for its Python wrapper script.  Stub
        # exit_code=1 and stdout=secret.
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=1,
                stdout=secret,
                stderr="",
            )
        )

        try:
            self.runner._call_nebius(
                "Return JSON for ticket #17."
            )
            self.fail(
                "expected ReviewError on nonzero "
                "subprocess exit"
            )
        except ReviewError as error:
            message = str(error)

            # Static categorical message and code.
            self.assertIn(
                "Reviewer subprocess invocation "
                "failed.",
                message,
            )
            self.assertIn(
                REVIEW_NEBIUS_FAILED,
                message,
            )

            # Exit code is acceptable — it's
            # generated by the process boundary.
            self.assertIn("exit_code=1", message)

            # The secret MUST NOT appear.
            self.assertNotIn(secret, message)

            # The raw stdout MUST NOT appear.
            self.assertNotIn(secret, message)
            self.assertNotIn("stdout:", message)
            self.assertNotIn("stderr:", message)

            # No 4-char substring of the secret.
            for start in range(
                0,
                len(secret) - 3,
            ):
                fragment = secret[start : start + 4]
                self.assertNotIn(
                    fragment,
                    message,
                )

    # ------------------------------------------------------------------
    # C. SUBPROCESS stderr LEAK
    # ------------------------------------------------------------------
    def test_subprocess_stderr_leak_is_blocked(self):
        """A nonzero subprocess result with the secret
        in stderr MUST NOT leak it into ReviewError."""
        secret = "super-secret-nebius-value-12345"

        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=1,
                stdout="",
                stderr=secret,
            )
        )

        try:
            self.runner._call_nebius(
                "Return JSON for ticket #17."
            )
            self.fail(
                "expected ReviewError on nonzero "
                "subprocess exit"
            )
        except ReviewError as error:
            message = str(error)

            self.assertIn(
                "Reviewer subprocess invocation "
                "failed.",
                message,
            )
            self.assertIn(
                REVIEW_NEBIUS_FAILED,
                message,
            )

            self.assertNotIn(secret, message)
            self.assertNotIn("stdout:", message)
            self.assertNotIn("stderr:", message)

            for start in range(
                0,
                len(secret) - 3,
            ):
                fragment = secret[start : start + 4]
                self.assertNotIn(
                    fragment,
                    message,
                )

    # ------------------------------------------------------------------
    # D. BOTH STREAMS
    # ------------------------------------------------------------------
    def test_subprocess_both_streams_blocked(self):
        """Pathological case: distinct secrets in
        stdout and stderr.  Neither can enter
        ReviewError."""
        stdout_secret = (
            "super-secret-nebius-stdout-12345"
        )
        stderr_secret = (
            "super-secret-nebius-stderr-67890"
        )

        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=2,
                stdout=stdout_secret,
                stderr=stderr_secret,
            )
        )

        try:
            self.runner._call_nebius(
                "Return JSON for ticket #17."
            )
            self.fail(
                "expected ReviewError on nonzero "
                "subprocess exit"
            )
        except ReviewError as error:
            message = str(error)

            self.assertIn(
                REVIEW_NEBIUS_FAILED,
                message,
            )
            self.assertIn("exit_code=2", message)

            self.assertNotIn(stdout_secret, message)
            self.assertNotIn(stderr_secret, message)
            self.assertNotIn("stdout:", message)
            self.assertNotIn("stderr:", message)

            for secret in (
                stdout_secret,
                stderr_secret,
            ):
                for start in range(
                    0,
                    len(secret) - 3,
                ):
                    fragment = (
                        secret[start : start + 4]
                    )
                    self.assertNotIn(
                        fragment,
                        message,
                    )

    # ------------------------------------------------------------------
    # E. CHECKPOINT FLOW
    # ------------------------------------------------------------------
    def test_checkpoint_flow_only_static_message(self):
        """Exercise the full path:

        ReviewError raised by the runner
        -> conductor catches it
        -> _record_terminal(reason=REVIEW_AGENT_FAILURE)
        -> checkpoint.last_error
        -> CheckpointStore.save()
        -> CheckpointStore.load()

        The persisted ``last_error`` MUST be the static
        closed-set terminal message associated with
        ``REVIEW_AGENT_FAILURE``.  It MUST NOT contain the
        ReviewError's message text, the secret, any
        substring of the secret, or any digest/length
        metadata.

        This test also verifies that ``CheckpointStore.save``
        and ``CheckpointStore.load`` reject any
        programmatically supplied ``last_error`` value that
        is not a member of the closed approved set.
        """
        self._checkpoint_flow_only_static_message_impl()

    def _checkpoint_flow_only_static_message_impl(self):
        import dataclasses
        import tempfile
        from pathlib import Path

        from scripts.ralph.checkpoint import (
            CheckpointError,
            CheckpointStore,
            TicketCheckpoint,
        )
        from scripts.ralph.run import (
            APPROVED_LAST_ERROR_MESSAGES,
            TerminalReason,
            _terminal_message,
        )
        from scripts.ralph.states import TicketState
        from scripts.ralph.transitions import (
            assert_transition,
        )

        secret = "super-secret-nebius-value-12345"

        with tempfile.TemporaryDirectory() as tmp:
            checkpoint_path = Path(tmp) / (
                "checkpoint.json"
            )

            store = CheckpointStore(checkpoint_path)

            initial = TicketCheckpoint(
                milestone_id="m2",
                issue_number=17,
                state=TicketState.REVIEWING,
                integration_branch="ralph/m2",
                ticket_branch="ralph/m2-17",
                review_stage=ReviewStage.PRE_QA,
            )
            store.save(initial)

            try:
                self.runner._parse_response(
                    {
                        "content": secret,
                        "usage": {},
                    },
                    stage=ReviewStage.PRE_QA,
                )
                self.fail(
                    "expected ReviewError for "
                    "invalid JSON content"
                )
            except ReviewError as error:
                review_error_message = str(error)

            self.assertIn(
                REVIEW_INVALID_JSON,
                review_error_message,
            )

            assert_transition(
                TicketState.REVIEWING,
                TicketState.AGENT_FAILURE,
            )
            approved_message = _terminal_message(
                TerminalReason.REVIEW_AGENT_FAILURE
            )
            self.assertIn(
                approved_message,
                APPROVED_LAST_ERROR_MESSAGES,
            )
            updated = dataclasses.replace(
                store.load(),
                state=TicketState.AGENT_FAILURE,
                last_error=approved_message,
            )
            store.save(updated)

            persisted = store.load()

            self.assertEqual(
                persisted.state,
                TicketState.AGENT_FAILURE,
            )
            self.assertEqual(
                persisted.last_error,
                approved_message,
            )

            self.assertNotIn(
                REVIEW_INVALID_JSON,
                persisted.last_error,
            )
            self.assertNotIn(
                secret,
                persisted.last_error,
            )
            for start in range(
                0,
                len(secret) - 3,
            ):
                fragment = secret[start : start + 4]
                self.assertNotIn(
                    fragment,
                    persisted.last_error,
                )

            self.assertNotIn(
                "content_sha256=",
                persisted.last_error,
            )
            self.assertNotIn(
                "content_length=",
                persisted.last_error,
            )

            roundtrip = store.load()
            self.assertEqual(
                roundtrip.last_error,
                persisted.last_error,
            )

            # And: CheckpointStore.save() MUST
            # refuse a programmatically
            # constructed checkpoint that smuggles
            # the review-error text into last_error.
            smuggled = dataclasses.replace(
                persisted,
                last_error=review_error_message,
            )
            try:
                store.save(smuggled)
                self.fail(
                    "CheckpointStore.save must reject "
                    "an unapproved last_error value."
                )
            except CheckpointError:
                pass

            # And: CheckpointStore.load() MUST
            # refuse a checkpoint file whose JSON
            # contains an unapproved last_error.
            tampered_path = Path(tmp) / (
                "tampered.json"
            )
            tampered_path.write_text(
                json.dumps(
                    {
                        "schema_version": 2,
                        "milestone_id": "m2",
                        "issue_number": 17,
                        "state": (
                            TicketState.AGENT_FAILURE.value
                        ),
                        "integration_branch": "ralph/m2",
                        "ticket_branch": "ralph/m2-17",
                        "last_error": review_error_message,
                    }
                )
            )
            tampered_store = CheckpointStore(
                tampered_path
            )
            try:
                tampered_store.load()
                self.fail(
                    "CheckpointStore.load must reject "
                    "an unapproved last_error value."
                )
            except CheckpointError:
                pass

    # ------------------------------------------------------------------
    # CATEGORICAL MESSAGE TESTS
    # ------------------------------------------------------------------
    def test_invalid_json_uses_categorical_message(self):
        """Invalid reviewer JSON must produce a
        ReviewError that is purely categorical."""
        try:
            self.runner._parse_response(
                {
                    "content": "definitely not json",
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertIn(
                "Reviewer did not return valid "
                "verdict JSON.",
                message,
            )
            self.assertIn(REVIEW_INVALID_JSON, message)

    def test_invalid_wrapper_json_uses_categorical_message(
        self,
    ):
        """A Nebius subprocess that returns
        non-JSON stdout must produce a categorical
        ReviewError without stdout content."""
        self.sandbox.exec.return_value = (
            SandboxCommandResult(
                exit_code=0,
                stdout="not-json",
                stderr="",
            )
        )

        try:
            self.runner._call_nebius(
                "Return JSON for ticket #17."
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertIn(
                "Reviewer subprocess returned invalid "
                "wrapper JSON.",
                message,
            )
            self.assertIn(
                REVIEW_INVALID_WRAPPER_JSON,
                message,
            )
            # Raw stdout MUST NOT appear.
            self.assertNotIn("not-json", message)

    def test_unknown_verdict_uses_categorical_message(self):
        """A verdict string outside the enum must
        produce a categorical ReviewError."""
        try:
            self.runner._parse_response(
                {
                    "content": json.dumps(
                        {
                            "verdict": (
                                "DEFINITELY_APPROVED"
                            ),
                            "summary": "",
                            "findings": [],
                        }
                    ),
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertIn(
                "Reviewer returned an unknown "
                "verdict.",
                message,
            )
            self.assertIn(
                REVIEW_UNKNOWN_VERDICT,
                message,
            )

    def test_verdict_invalid_for_stage_uses_categorical_message(
        self,
    ):
        """A verdict that is valid for the wrong
        stage must produce a categorical ReviewError
        that does not include the verdict value."""
        try:
            self.runner._parse_response(
                {
                    "content": json.dumps(
                        {
                            "verdict":
                                "APPROVE_FOR_PERSISTENCE",
                            "summary": "",
                            "findings": [],
                        }
                    ),
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertIn(
                "Reviewer returned a verdict that is "
                "invalid for the current stage.",
                message,
            )
            self.assertIn(
                REVIEW_VERDICT_INVALID_FOR_STAGE,
                message,
            )
            # The verdict value MUST NOT appear in
            # the persisted message — it's still
            # model output.
            self.assertNotIn(
                "APPROVE_FOR_PERSISTENCE",
                message,
            )

    def test_findings_not_list_uses_categorical_message(self):
        """``findings`` not being a list must produce
        a categorical ReviewError."""
        try:
            self.runner._parse_response(
                {
                    "content": json.dumps(
                        {
                            "verdict": "APPROVE_FOR_QA",
                            "summary": "",
                            "findings": "not-a-list",
                        }
                    ),
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertIn(
                "Reviewer findings must be a list.",
                message,
            )
            self.assertIn(
                REVIEW_FINDINGS_NOT_LIST,
                message,
            )

    def test_malformed_finding_uses_categorical_message(self):
        """A finding missing a required field must
        produce a categorical ReviewError."""
        try:
            self.runner._parse_response(
                {
                    "content": json.dumps(
                        {
                            "verdict": "APPROVE_FOR_QA",
                            "summary": "",
                            "findings": [
                                {
                                    # Missing 'title'
                                    # and 'details'.
                                    "severity":
                                        "BLOCKING",
                                }
                            ],
                        }
                    ),
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertIn(
                "Reviewer returned malformed "
                "finding.",
                message,
            )
            self.assertIn(
                REVIEW_MALFORMED_FINDING,
                message,
            )

    def test_missing_content_uses_categorical_message(self):
        """A response without a string ``content``
        must produce a categorical ReviewError."""
        try:
            self.runner._parse_response(
                {
                    "content": None,
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertIn(
                "Reviewer response is missing content.",
                message,
            )
            self.assertIn(
                REVIEW_MISSING_CONTENT,
                message,
            )

    def test_supplied_api_key_does_not_appear_in_error(self):
        """The exact value the runner is configured
        with as ``NEBIUS_API_KEY`` must NEVER appear
        in the ReviewError when model content
        echoes the key."""
        api_key = self.runner.api_key
        self.assertTrue(api_key)

        try:
            self.runner._parse_response(
                {
                    "content": api_key,
                    "usage": {},
                },
                stage=ReviewStage.PRE_QA,
            )
            self.fail("expected ReviewError")
        except ReviewError as error:
            message = str(error)
            self.assertNotIn(api_key, message)

            for start in range(
                0,
                len(api_key) - 3,
            ):
                fragment = api_key[start : start + 4]
                self.assertNotIn(
                    fragment,
                    message,
                )


if __name__ == "__main__":
    unittest.main()
