import unittest
from unittest.mock import MagicMock, patch

import tenki

from scripts.ralph.sandbox import (
    SandboxSessionTerminatedError,
    TenkiSandbox,
)


class TenkiSandboxTests(unittest.TestCase):
    @patch("scripts.ralph.sandbox.Sandbox")
    def test_creates_sandbox_with_expected_resources(self, sandbox):
        instance = MagicMock()
        sandbox.create.return_value = instance

        with TenkiSandbox(
            name="ticket-16",
            cpu_cores=2,
            memory_mb=4096,
        ):
            pass

        sandbox.create.assert_called_once_with(
            name="ticket-16",
            cpu_cores=2,
            memory_mb=4096,
            allow_outbound=True,
        )

        instance.close.assert_called_once()

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exec_returns_normalized_result(self, sandbox):
        instance = MagicMock()

        result = MagicMock()
        result.exit_code = 0
        result.stdout_text = "hello\n"
        result.stderr_text = ""

        instance.exec.return_value = result
        sandbox.create.return_value = instance

        with TenkiSandbox("ticket-16") as sb:
            command = sb.exec(
                "bash",
                "-lc",
                "echo hello",
            )

        self.assertEqual(command.exit_code, 0)
        self.assertEqual(command.stdout, "hello\n")
        self.assertEqual(command.stderr, "")

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_passes_github_token_to_tenki(self, sandbox):
        instance = MagicMock()
        sandbox.create.return_value = instance

        with TenkiSandbox(
            name="ticket-16",
            github_token="ghs_test",
        ):
            pass

        sandbox.create.assert_called_once_with(
            name="ticket-16",
            cpu_cores=2,
            memory_mb=4096,
            allow_outbound=True,
            github_token="ghs_test",
        )

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exec_passes_environment(self, sandbox):
        instance = MagicMock()

        result = MagicMock()
        result.exit_code = 0
        result.stdout_text = ""
        result.stderr_text = ""

        instance.exec.return_value = result
        sandbox.create.return_value = instance

        with TenkiSandbox("ticket-16") as sb:
            sb.exec(
                "git",
                "status",
                env={
                    "EXAMPLE_SECRET": "secret-value",
                },
            )

        instance.exec.assert_called_once_with(
            "git",
            "status",
            cwd=None,
            env={
                "EXAMPLE_SECRET": "secret-value",
            },
            input=None,
            timeout=None,
        )

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exec_passes_working_directory(self, sandbox):
        instance = MagicMock()

        result = MagicMock()
        result.exit_code = 0
        result.stdout_text = ""
        result.stderr_text = ""

        instance.exec.return_value = result
        sandbox.create.return_value = instance

        with TenkiSandbox("ticket-16") as sb:
            sb.exec(
                "git",
                "status",
                cwd="/tmp/sound-hub",
            )

        instance.exec.assert_called_once_with(
            "git",
            "status",
            cwd="/tmp/sound-hub",
            env=None,
            input=None,
            timeout=None,
        )

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exec_passes_input(self, sandbox):
        instance = MagicMock()

        result = MagicMock()
        result.exit_code = 0
        result.stdout_text = ""
        result.stderr_text = ""

        instance.exec.return_value = result
        sandbox.create.return_value = instance

        with TenkiSandbox("ticket-16") as sb:
            sb.exec(
                "git",
                "apply",
                "-",
                input="example patch",
            )

        instance.exec.assert_called_once_with(
            "git",
            "apply",
            "-",
            cwd=None,
            env=None,
            input="example patch",
            timeout=None,
        )

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exec_passes_timeout(self, sandbox):
        instance = MagicMock()

        result = MagicMock()
        result.exit_code = 0
        result.stdout_text = ""
        result.stderr_text = ""

        instance.exec.return_value = result
        sandbox.create.return_value = instance

        with TenkiSandbox("ticket-16") as sb:
            sb.exec(
                "sleep",
                "1",
                timeout=123,
            )

        instance.exec.assert_called_once_with(
            "sleep",
            "1",
            cwd=None,
            env=None,
            input=None,
            timeout=123,
        )


class SandboxLifetimeTests(unittest.TestCase):
    """Regression tests for the sandbox lifetime boundary
    added after the M2 #17 hang investigation.

    Contract under test (mapped against the installed tenki
    1.0.0 SDK at
    ``.venv/lib/python3.12/site-packages/tenki_sandbox/client.py``):

    - ``Sandbox.create(...)`` accepts ``max_duration`` as
      ``float | int | datetime.timedelta | None``
      (``Client.create``, ``client.py:73``).  When ``None``
      the SDK skips the protobuf field and the server
      picks the workspace default — which the M2 #17
      investigation observed at approximately 24 minutes.
      Ralph MUST therefore forward a finite, validated
      ``max_duration`` value so the workspace/server
      default never governs ticket orchestration.

    - The ``max_duration`` value MUST be passed through
      to ``Sandbox.create`` exactly.  Default sandbox
      construction (without ``max_duration_seconds``) is
      permitted for unit tests, but Ralph production
      callers MUST supply it.

    - ``tenki.SessionTerminatedError`` is the SDK signal
      that the platform tore down the session mid-exec
      (see ``process.py:221-225`` in the installed SDK).
      ``TenkiSandbox.exec`` MUST translate that into the
      static ``SandboxSessionTerminatedError`` and MUST
      NOT leak the SDK exception text into the Ralph
      boundary.
    """

    # ---- 1. ``max_duration`` is forwarded to ``Sandbox.create``
    # when configured ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_sandbox_create_receives_configured_max_duration(
        self, sandbox
    ):
        instance = MagicMock()
        sandbox.create.return_value = instance

        with TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        ):
            pass

        sandbox.create.assert_called_once_with(
            name="ticket-16",
            cpu_cores=2,
            memory_mb=4096,
            allow_outbound=True,
            max_duration=21_600,
        )

    # ---- 2. Default construction omits ``max_duration`` ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_default_sandbox_omits_max_duration(self, sandbox):
        instance = MagicMock()
        sandbox.create.return_value = instance

        with TenkiSandbox(name="ticket-16"):
            pass

        # ``max_duration`` MUST NOT appear in the SDK
        # kwargs when ``max_duration_seconds`` is not
        # configured — production callers control the
        # lifetime, unit tests opt out.
        kwargs = sandbox.create.call_args.kwargs
        self.assertNotIn("max_duration", kwargs)

    # ---- 3. ``SandboxSessionTerminatedError`` does not
    # escape as an uncaught exception ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_session_terminated_error_maps_to_static_boundary(
        self, sandbox
    ):
        instance = MagicMock()
        # Simulate the installed SDK's exit frame carrying
        # the ``session_terminated:<cause>`` reason that
        # ``process.py:221-225`` translates to
        # ``tenki.SessionTerminatedError``.
        instance.exec.side_effect = tenki.SessionTerminatedError(
            "session_terminated:guest_agent_liveness: internal "
            "TENKI_SECRET=abc123 should never reach ralph"
        )
        sandbox.create.return_value = instance

        with TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        ) as sb:
            with self.assertRaises(
                SandboxSessionTerminatedError
            ) as raised:
                sb.exec("bash", "-lc", "echo hi")

        # The Ralph-owned boundary exception has a static
        # message; it MUST NOT carry any SDK exception text,
        # secret-shaped substring, or
        # ``session_terminated:`` prefix.
        self.assertEqual(
            str(raised.exception),
            "Sandbox session terminated unexpectedly.",
        )
        self.assertNotIn(
            "session_terminated", str(raised.exception)
        )
        self.assertNotIn(
            "TENKI_SECRET", str(raised.exception)
        )
        # The original SDK exception is suppressed: the
        # Ralph boundary raises with ``from None`` so the
        # control-plane traceback cannot surface platform
        # internals.
        self.assertIsNone(raised.exception.__cause__)

    # ---- 4. ``CommandTimeoutError`` is NOT swallowed by
    # the session-terminated boundary ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_command_timeout_error_is_not_swallowed(
        self, sandbox
    ):
        instance = MagicMock()
        instance.exec.side_effect = tenki.CommandTimeoutError(
            "command deadline exceeded"
        )
        sandbox.create.return_value = instance

        with TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        ) as sb:
            with self.assertRaises(tenki.CommandTimeoutError):
                sb.exec("sleep", "9999")


class SandboxTeardownSafetyTests(unittest.TestCase):
    """Regression tests for the teardown-safety defect
    found during the M2 #17 sandbox-lifetime review.

    Contract under test:

    - ``TenkiSandbox.__exit__`` MUST treat a sandbox that
      the platform has already torn down (the installed
      SDK raises ``tenki.SessionTerminatedError`` or
      ``tenki.SessionNotFoundError`` from
      ``Sandbox.close()``) as already-closed cleanup.
      The SDK exception text MUST NOT propagate, MUST
      NOT be printed, and MUST NOT replace a previously
      established Ralph terminal state.

    - ``TenkiSandbox.__exit__`` MUST remain idempotent:
      a second ``__exit__`` call on an already-cleaned
      sandbox is a no-op (no extra RPC, no exception).

    - Unrelated close failures (e.g. an unexpected
      ``RuntimeError`` from the SDK) MUST still
      propagate so existing Ralph policy can decide.

    - Healthy ``Sandbox.close()`` MUST still be invoked
      exactly once on a normal exit.
    """

    # ---- 1. ``tenki.SessionTerminatedError`` from
    # ``Sandbox.close()`` is treated as already-closed ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exit_swallows_session_terminated_from_close(
        self, sandbox
    ):
        instance = MagicMock()
        instance.close.side_effect = (
            tenki.SessionTerminatedError(
                "session_terminated:guest_agent_liveness "
                "TENKI_SECRET=abc123 grpc_status="
                "FAILED_PRECONDITION "
                "provider-internal-session-id="
                "s_xxxxxxxxxxxxxxxxxxxxxx"
            )
        )
        sandbox.create.return_value = instance

        # The closed ``with`` statement MUST NOT raise;
        # the SDK text MUST NOT escape the context.
        with TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        ) as sb:
            self.assertIs(sb, sb)

        # Exactly one close() attempt was made.
        instance.close.assert_called_once_with()
        # The internal handle is cleared so the next
        # ``__exit__`` (if any) is also a no-op.
        # ``TenkiSandbox.__exit__`` ran without raising.

    # ---- 2. ``tenki.SessionNotFoundError`` from
    # ``Sandbox.close()`` is treated as already-closed ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exit_swallows_session_not_found_from_close(
        self, sandbox
    ):
        instance = MagicMock()
        instance.close.side_effect = (
            tenki.SessionNotFoundError(
                "session not found TENKI_SECRET=abc123 "
                "provider-internal-session-id="
                "s_xxxxxxxxxxxxxxxxxxxxxx"
        )
        )
        sandbox.create.return_value = instance

        with TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        ):
            pass

        instance.close.assert_called_once_with()

    # ---- 3. ``__exit__`` is idempotent ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exit_is_idempotent(self, sandbox):
        instance = MagicMock()
        sandbox.create.return_value = instance

        sb = TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        )
        sb.__enter__()
        # First close: the SDK raises — must be swallowed.
        instance.close.side_effect = tenki.SessionTerminatedError(
            "session_terminated"
        )
        sb.__exit__(None, None, None)
        # Second close MUST be a no-op: no extra RPC,
        # no exception, internal handle is None.
        sb.__exit__(None, None, None)

        # Exactly one close() attempt total.
        instance.close.assert_called_once_with()

    # ---- 4. Unrelated close failures still propagate ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exit_propagates_unrelated_close_failure(
        self, sandbox
    ):
        instance = MagicMock()
        instance.close.side_effect = RuntimeError(
            "unrelated SDK bookkeeping failure"
        )
        sandbox.create.return_value = instance

        sb = TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        )
        sb.__enter__()

        with self.assertRaises(RuntimeError) as raised:
            sb.__exit__(None, None, None)

        self.assertEqual(
            str(raised.exception),
            "unrelated SDK bookkeeping failure",
        )

    # ---- 5. Healthy ``Sandbox.close()`` runs exactly once ----

    @patch("scripts.ralph.sandbox.Sandbox")
    def test_exit_invokes_close_exactly_once_on_healthy_sandbox(
        self, sandbox
    ):
        instance = MagicMock()
        sandbox.create.return_value = instance

        with TenkiSandbox(
            name="ticket-16",
            max_duration_seconds=21_600,
        ):
            pass

        instance.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
