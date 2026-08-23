import unittest
from unittest.mock import MagicMock

from scripts.ralph.qa_environment import (
    PostgresQaEnvironment,
    QaEnvironment,
    QaEnvironmentError,
)
from scripts.ralph.sandbox import (
    SandboxCommandResult,
    SandboxSessionTerminatedError,
)


def _exec_ok(*args, **kwargs):
    if args and args[0] == "pg_config":
        return SandboxCommandResult(
            exit_code=0,
            stdout="/usr/lib/postgresql/16/bin\n",
            stderr="",
        )

    return SandboxCommandResult(
        exit_code=0,
        stdout="",
        stderr="",
    )


class PostgresQaEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = MagicMock()
        self.sandbox.exec.side_effect = _exec_ok

        self.environment = PostgresQaEnvironment(
            sandbox=self.sandbox,
        )

    def _command_text(self):
        parts = []

        for call in self.sandbox.exec.call_args_list:
            for arg in call.args:
                parts.append(str(arg))

        return " ".join(parts)

    def _find_calls(self, *needles):
        matches = []

        for call in self.sandbox.exec.call_args_list:
            args_text = " ".join(str(a) for a in call.args)

            if all(n in args_text for n in needles):
                matches.append(call)

        return matches

    def test_start_returns_approved_database_url(self):
        env = self.environment.start()

        self.assertIsInstance(env, QaEnvironment)

        self.assertEqual(
            env.database_url,
            "postgresql://tenki@127.0.0.1:5433/"
            "soundhub_m1_test",
        )

        self.assertEqual(
            env.env["TEST_DATABASE_URL"],
            env.database_url,
        )

    def test_provisioning_uses_port_5433(self):
        self.environment.start()

        self.assertIn("5433", self._command_text())

    def test_provisioning_uses_soundhub_m1_test(self):
        self.environment.start()

        self.assertIn(
            "soundhub_m1_test",
            self._command_text(),
        )

    def test_provisioning_specifies_writable_socket_dir(self):
        self.environment.start()

        start_calls = self._find_calls("pg_ctl", "start")
        self.assertEqual(len(start_calls), 1)

        start_text = " ".join(
            str(a) for a in start_calls[0].args
        )

        self.assertIn("-k", start_text)
        self.assertIn(
            "/tmp/ralph-postgres-socket",
            start_text,
        )
        self.assertNotIn(
            "/var/run/postgresql",
            start_text,
        )

    def test_readiness_targets_soundhub_m1_test(self):
        self.environment.start()

        ready_calls = self._find_calls("pg_isready")
        self.assertEqual(len(ready_calls), 1)

        ready_args = ready_calls[0].args

        self.assertIn("-d", ready_args)
        self.assertEqual(
            ready_args[ready_args.index("-d") + 1],
            "soundhub_m1_test",
        )

    def test_provisioning_failure_raises_qa_environment_error(self):
        def _exec_fail_install(*args, **kwargs):
            if (
                len(args) >= 3
                and args[0] == "sudo"
                and args[1] == "apt-get"
                and args[2] == "install"
            ):
                return SandboxCommandResult(
                    exit_code=100,
                    stdout="",
                    stderr=(
                        "E: Unable to locate package "
                        "postgresql"
                    ),
                )

            return _exec_ok(*args, **kwargs)

        self.sandbox.exec.side_effect = _exec_fail_install

        with self.assertRaises(QaEnvironmentError):
            self.environment.start()

    def test_stop_requests_postgresql_shutdown(self):
        self.environment.start()

        self.sandbox.exec.reset_mock()

        self.environment.stop()

        self.assertEqual(
            self.sandbox.exec.call_count,
            1,
        )

        stop_call = self.sandbox.exec.call_args_list[0]
        stop_args = stop_call.args
        joined = " ".join(str(a) for a in stop_args)

        self.assertIn("pg_ctl", joined)
        self.assertIn("stop", stop_args)
        self.assertIn("-D", stop_args)
        self.assertIn(self.environment.data_dir, stop_args)

    def test_repeated_stop_is_safe(self):
        self.environment.start()

        self.environment.stop()

        self.sandbox.exec.reset_mock()

        self.environment.stop()

        self.assertEqual(
            self.sandbox.exec.call_count,
            0,
        )

    def test_no_docker_command(self):
        self.environment.start()
        self.environment.stop()

        for call in self.sandbox.exec.call_args_list:
            for arg in call.args:
                text = str(arg)

                self.assertFalse(
                    text == "docker",
                    f"unexpected docker invocation: {text}",
                )
                self.assertFalse(
                    text.startswith("/docker"),
                    f"unexpected docker invocation: {text}",
                )
                self.assertNotIn(
                    "docker ",
                    text,
                )
                self.assertNotIn(
                    "docker-compose",
                    text,
                )

    def test_partial_start_stop_still_called_when_createdb_fails(
        self,
    ):
        """If pg_ctl start succeeds but createdb fails, stop() must
        still run so the postgres process is not leaked.

        The lifecycle invariant: _started must flip to True the
        instant pg_ctl start succeeds, and any later failure must
        trigger stop() before the exception escapes.
        """

        def _exec_fail_createdb(*args, **kwargs):
            if (
                len(args) >= 1
                and args[0]
                == f"{self.environment._bindir}/createdb"
            ):
                return SandboxCommandResult(
                    exit_code=1,
                    stdout="",
                    stderr="createdb: database creation failed",
                )

            return _exec_ok(*args, **kwargs)

        self.sandbox.exec.side_effect = _exec_fail_createdb

        with self.assertRaises(QaEnvironmentError):
            self.environment.start()

        stop_calls = self._find_calls("pg_ctl", "stop")
        self.assertGreaterEqual(
            len(stop_calls),
            1,
            "pg_ctl stop was not invoked when post-start work failed",
        )

    def test_partial_start_stop_still_called_when_sql_verify_fails(
        self,
    ):
        def _exec_fail_sql(*args, **kwargs):
            if (
                len(args) >= 1
                and args[0]
                == f"{self.environment._bindir}/psql"
            ):
                return SandboxCommandResult(
                    exit_code=1,
                    stdout="",
                    stderr="psql: connection to server failed",
                )

            return _exec_ok(*args, **kwargs)

        self.sandbox.exec.side_effect = _exec_fail_sql

        with self.assertRaises(QaEnvironmentError):
            self.environment.start()

        stop_calls = self._find_calls("pg_ctl", "stop")
        self.assertGreaterEqual(
            len(stop_calls),
            1,
            "pg_ctl stop was not invoked when SQL verify failed",
        )

    def test_partial_start_stop_still_called_when_readiness_fails(
        self,
    ):
        def _exec_fail_ready(*args, **kwargs):
            if (
                len(args) >= 1
                and args[0]
                == f"{self.environment._bindir}/pg_isready"
            ):
                return SandboxCommandResult(
                    exit_code=2,
                    stdout="",
                    stderr="pg_isready: no response",
                )

            return _exec_ok(*args, **kwargs)

        self.sandbox.exec.side_effect = _exec_fail_ready

        with self.assertRaises(QaEnvironmentError):
            self.environment.start()

        stop_calls = self._find_calls("pg_ctl", "stop")
        self.assertGreaterEqual(
            len(stop_calls),
            1,
            "pg_ctl stop was not invoked when readiness verify failed",
        )


class PostgresQaEnvironmentTeardownSafetyTests(unittest.TestCase):
    """Regression tests for the teardown-safety defect
    found during the M2 #17 sandbox-lifetime review.

    Contract under test:

    - ``PostgresQaEnvironment.stop()`` MUST treat a
      sandbox that the platform has already torn down as
      cleanup-complete; the Ralph-owned
      ``SandboxSessionTerminatedError`` MUST NOT
      propagate (it would replace a previously recorded
      ``INFRA_FAILURE`` on the Ralph control plane).

    - ``stop()`` MUST remain idempotent: the second call
      is a no-op (the existing ``if not self._started:
      return`` guard).

    - Healthy ``pg_ctl stop`` MUST still run normally on
      a healthy sandbox.

    - Unrelated cleanup bugs (non-session errors) MUST
      NOT be silently swallowed.
    """

    def setUp(self):
        self.sandbox = MagicMock()
        self.environment = PostgresQaEnvironment(
            sandbox=self.sandbox,
        )

    def _start_with_healthy_sandbox(self):
        # ``pg_config`` lookup succeeds, all install /
        # start / verify commands succeed.
        self.sandbox.exec.side_effect = _exec_ok
        self.environment.start()

    def _find_calls(self, *needles):
        matches = []

        for call in self.sandbox.exec.call_args_list:
            args_text = " ".join(str(a) for a in call.args)

            if all(n in args_text for n in needles):
                matches.append(call)

        return matches

    # ---- 1. ``SandboxSessionTerminatedError`` during
    # ``pg_ctl stop`` is treated as already-stopped
    # cleanup ----

    def test_stop_swallows_sandbox_session_terminated(self):
        self._start_with_healthy_sandbox()

        def _exec_fail_on_stop(*args, **kwargs):
            if (
                len(args) >= 2
                and args[0].endswith("pg_ctl")
                and args[1] == "stop"
            ):
                raise SandboxSessionTerminatedError(
                    "Sandbox session terminated unexpectedly."
                )

            return _exec_ok(*args, **kwargs)

        self.sandbox.exec.side_effect = _exec_fail_on_stop

        # The closed ``stop()`` MUST NOT raise; the
        # terminal state already recorded by the
        # Conductor MUST survive.
        try:
            self.environment.stop()
        except SandboxSessionTerminatedError as err:
            self.fail(
                "stop() leaked SandboxSessionTerminatedError: "
                f"{err!r}"
            )

    # ---- 2. Stop remains idempotent when invoked twice ----

    def test_repeated_stop_with_dead_sandbox_is_safe(self):
        self._start_with_healthy_sandbox()

        def _exec_fail_on_stop(*args, **kwargs):
            if (
                len(args) >= 2
                and args[0].endswith("pg_ctl")
                and args[1] == "stop"
            ):
                raise SandboxSessionTerminatedError(
                    "Sandbox session terminated unexpectedly."
                )

            return _exec_ok(*args, **kwargs)

        self.sandbox.exec.side_effect = _exec_fail_on_stop

        # First ``stop()`` runs ``pg_ctl stop`` (which
        # raises) and is treated as cleanup-complete.
        self.environment.stop()

        # Second ``stop()`` MUST short-circuit on the
        # ``_started`` guard and not invoke ``pg_ctl``
        # at all — no extra RPC against the dead
        # sandbox.
        self.environment.stop()

    # ---- 3. Healthy ``pg_ctl stop`` still runs ----

    def test_healthy_stop_remains_unchanged(self):
        self._start_with_healthy_sandbox()

        self.sandbox.exec.reset_mock()
        self.environment.stop()

        stop_calls = self._find_calls("pg_ctl", "stop")
        self.assertEqual(len(stop_calls), 1)

    # ---- 4. Non-session-related cleanup bugs are NOT
    # silently swallowed by the new safety net ----

    def test_unrelated_cleanup_bugs_are_not_swallowed(self):
        self._start_with_healthy_sandbox()

        def _exec_fail_on_stop(*args, **kwargs):
            if (
                len(args) >= 2
                and args[0].endswith("pg_ctl")
                and args[1] == "stop"
            ):
                raise QaEnvironmentError(
                    "PostgreSQL provisioning command failed: "
                    "['pg_ctl', 'stop']\n"
                    "exit_code: 1\n"
                    "stderr: unexpected cleanup error"
                )

            return _exec_ok(*args, **kwargs)

        self.sandbox.exec.side_effect = _exec_fail_on_stop

        # ``QaEnvironmentError`` is the existing
        # cleanup-bug signal; it MUST still be
        # swallowed at the cleanup boundary (existing
        # behavior preserved).  This test guards
        # against a regression where the new
        # safety net accidentally widened the catch.
        self.environment.stop()


if __name__ == "__main__":
    unittest.main()
