"""Regression tests for QA execution-directory correctness.

Smoke #43 produced::

    Command: pnpm format:check
    Exit code: 1
    STDOUT: (empty)
    STDERR:
      [ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND]
      No package.json ... was found in "/home/tenki".

The live Tenki sandbox executed the QA command from
``/home/tenki`` instead of the prepared
``workspace.repository_path`` even though ``QaRunner``
passed the path as the ``cwd`` argument to
``sandbox.exec``.

These tests prove the new contract:

  1. The shell command ``QaRunner`` builds explicitly
     enters ``workspace.repository_path`` via
     ``cd <shlex.quote(path)> &&``.
  2. When a sandbox implementation ignores the SDK
     ``cwd`` argument, the QA command still runs from
     the workspace because the explicit ``cd`` lives
     INSIDE the shell command.
  3. ``shlex.quote`` defends against path-injection
     for workspace paths that contain spaces or
     shell-significant characters.
  4. If the ``cd`` fails, the QA command MUST NOT
     run from the ambient / fallback directory.
  5. The QA environment, timeout, stdout/stderr
     capture, status classification, and console
     observability are all preserved.
"""

import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from scripts.ralph.qa import (
    QaCommand,
    QaCommandResult,
    QaError,
    QaRunner,
    QaStatus,
)
from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.workspace import TicketWorkspace


# ---------------------------------------------------------------------------
# Test fixtures and helpers
# ---------------------------------------------------------------------------


def _make_workspace(repository_path: str) -> TicketWorkspace:
    return TicketWorkspace(
        repository_path=repository_path,
        integration_branch="ralph/m2",
        ticket_branch="ralph/m2-17",
        base_sha="base123",
        ticket_sha="ticket123",
        resumed=False,
    )


class _IgnoringCwdSandbox:
    """A sandbox that mirrors the real Tenki SDK
    behaviour observed in smoke #43: the ``cwd``
    kwarg is IGNORED and the subprocess inherits
    whatever the ambient directory is.

    The point of the regression test is to prove
    that even when the SDK drops ``cwd`` on the
    floor, ``QaRunner`` still executes the QA
    command from ``workspace.repository_path``
    because the explicit ``cd`` is INSIDE the
    shell command.
    """

    def __init__(self, ambient_cwd: str | None = None) -> None:
        self._ambient_cwd = ambient_cwd
        self.calls: list[dict] = []

    def exec(
        self,
        *command: str,
        cwd=None,
        env=None,
        input=None,
        timeout=None,
    ):
        # The SDK-cwd kwarg is IGNORED on purpose.
        del cwd

        self.calls.append(
            {
                "command": list(command),
                "env": env,
                "input": input,
                "timeout": timeout,
            }
        )

        result = subprocess.run(
            list(command),
            capture_output=True,
            text=True,
            env=env,
            input=input,
            timeout=timeout,
            cwd=self._ambient_cwd,
        )

        return SandboxCommandResult(
            exit_code=result.returncode,
            stdout=result.stdout,
            stderr=result.stderr,
        )


# ---------------------------------------------------------------------------
# A. EXECUTION-DIRECTORY REGRESSION
# ---------------------------------------------------------------------------


class ExecutionDirectoryRegressionTests(unittest.TestCase):
    def test_explicit_cd_overrides_ambient_directory(self):
        # Build a real workspace with a marker file
        # in it.  The QA command would only succeed
        # if the shell actually enters the workspace.
        with tempfile.TemporaryDirectory() as tmp:
            workspace_dir = Path(tmp) / "repo"
            workspace_dir.mkdir()
            (workspace_dir / "package.json").write_text(
                '{"name":"fixture"}'
            )

            # Create a fake sandbox that runs in a
            # deliberately WRONG ambient cwd (the
            # simulated "/home/tenki" of the live
            # smoke) and ignores the SDK cwd kwarg.
            ambient = Path(tmp) / "ambient_home"
            ambient.mkdir()
            (ambient / "package.json").write_text(
                "WRONG-MARKER-IF-VISIBLE"
            )

            sandbox = _IgnoringCwdSandbox(
                ambient_cwd=str(ambient),
            )
            runner = QaRunner(
                sandbox=sandbox,
                workspace=_make_workspace(
                    str(workspace_dir)
                ),
            )

            result = runner.run(
                commands=(
                    QaCommand(
                        name="marker-test",
                        # ``test -f package.json`` is
                        # only true in the workspace.
                        command="test -f package.json",
                    ),
                )
            )

            self.assertTrue(
                result.passed,
                (
                    "QA command did not run from the "
                    "workspace.  stdout="
                    f"{result.commands[0].stdout!r}, "
                    f"stderr={result.commands[0].stderr!r}"
                ),
            )
            self.assertEqual(
                result.status,
                QaStatus.PASSED,
            )

    def test_explicit_cd_does_not_see_ambient_files(self):
        # Same setup, but the QA command reads the
        # contents of package.json.  The fixture in
        # the workspace has a unique marker string;
        # the ambient directory has a different
        # marker.  If the explicit cd works the
        # command prints the workspace marker; if
        # it does not, the command prints the
        # ambient marker or fails.
        workspace_marker = "WORKSPACE-MARKER-17"

        with tempfile.TemporaryDirectory() as tmp:
            workspace_dir = Path(tmp) / "repo"
            workspace_dir.mkdir()
            (workspace_dir / "package.json").write_text(
                f'{{"name":"fixture-{workspace_marker}"}}'
            )

            ambient = Path(tmp) / "ambient_home"
            ambient.mkdir()
            (ambient / "package.json").write_text(
                "AMBIENT-MARKER-IF-VISIBLE"
            )

            sandbox = _IgnoringCwdSandbox(
                ambient_cwd=str(ambient),
            )
            runner = QaRunner(
                sandbox=sandbox,
                workspace=_make_workspace(
                    str(workspace_dir)
                ),
            )

            result = runner.run(
                commands=(
                    QaCommand(
                        name="read-marker",
                        command="cat package.json",
                    ),
                )
            )

            self.assertTrue(result.passed)
            self.assertIn(
                workspace_marker,
                result.commands[0].stdout,
            )
            self.assertNotIn(
                "AMBIENT-MARKER-IF-VISIBLE",
                result.commands[0].stdout,
            )

    def test_failed_cd_fails_closed(self):
        # If the explicit cd fails (the workspace
        # path does not exist), the QA command MUST
        # NOT run from the ambient directory and
        # MUST NOT silently return PASSED.
        with tempfile.TemporaryDirectory() as tmp:
            missing = (
                Path(tmp) / "definitely-does-not-exist"
            )

            sandbox = _IgnoringCwdSandbox(
                ambient_cwd=tmp,
            )
            runner = QaRunner(
                sandbox=sandbox,
                workspace=_make_workspace(
                    str(missing)
                ),
            )

            result = runner.run(
                commands=(
                    QaCommand(
                        name="marker-test",
                        command="test -f package.json",
                    ),
                )
            )

            self.assertFalse(result.passed)
            # cd failure on an existing-but-empty
            # directory yields a non-zero exit code
            # that is classified as CODE_FAILURE (no
            # infrastructure signal in the text).
            self.assertEqual(
                result.status,
                QaStatus.CODE_FAILURE,
            )
            # The ambient directory MUST NOT have
            # been used: the QA command never ran.
            self.assertNotIn(
                "AMBIENT-MARKER",
                result.commands[0].stdout,
            )
            self.assertNotIn(
                "AMBIENT-MARKER",
                result.commands[0].stderr,
            )


# ---------------------------------------------------------------------------
# B. SHELL COMMAND SHAPE
# ---------------------------------------------------------------------------


class ShellCommandShapeTests(unittest.TestCase):
    def test_shell_command_includes_explicit_cd(self):
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="",
            stderr="",
        )

        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace("/tmp/repo-17"),
        )

        runner.run(
            commands=(
                QaCommand(
                    name="format-check",
                    command="pnpm format:check",
                ),
            )
        )

        self.assertTrue(sandbox.exec.called)
        args, kwargs = sandbox.exec.call_args

        # The shell command MUST be the third
        # positional argument to bash -lc.
        self.assertEqual(args[0], "bash")
        self.assertEqual(args[1], "-lc")
        self.assertTrue(args[2].startswith("cd "))
        self.assertIn(
            "pnpm format:check",
            args[2],
        )
        # The cd argument MUST be shlex.quote'd.
        self.assertIn(
            f"cd {shlex.quote('/tmp/repo-17')}",
            args[2],
        )
        # And the configured QA command MUST
        # follow the cd, joined with &&.
        self.assertRegex(
            args[2],
            (
                r"^cd "
                + re.escape(shlex.quote("/tmp/repo-17"))
                + r" && pnpm format:check$"
            ),
        )

        # Defense-in-depth: the SDK cwd kwarg is
        # still passed (so a working Tenki SDK
        # behaves the same).
        self.assertEqual(
            kwargs.get("cwd"),
            "/tmp/repo-17",
        )

    def test_quoting_handles_paths_with_spaces(self):
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="",
            stderr="",
        )

        with_spaces = "/tmp/sound hub/repo 17"
        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace(with_spaces),
        )

        runner.run(
            commands=(
                QaCommand(
                    name="format-check",
                    command="pnpm format:check",
                ),
            )
        )

        args, _ = sandbox.exec.call_args
        shell_command = args[2]
        # The full shlex.quote'd path must appear.
        self.assertIn(
            f"cd {shlex.quote(with_spaces)}",
            shell_command,
        )
        # The path MUST appear ONLY inside the
        # shlex.quote'd cd argument.  An
        # attacker-controlled workspace path MUST
        # NOT leak as an unquoted token.
        unquoted = shell_command.replace(
            shlex.quote(with_spaces), ""
        )
        self.assertNotIn(
            with_spaces,
            unquoted,
            (
                "Workspace path appeared unquoted in "
                f"shell command: {shell_command!r}"
            ),
        )
        # Defense-in-depth: the path with spaces
        # MUST NOT appear as a bare token (no
        # surrounding quotes) anywhere in the
        # command.
        for delimiter in (" ", "&&", ";", "|"):
            self.assertNotIn(
                f"{delimiter}{with_spaces}{delimiter}",
                shell_command,
                (
                    f"Path with spaces appears between "
                    f"{delimiter!r} delimiters: "
                    f"{shell_command!r}"
                ),
            )

    def test_quoting_handles_shell_metacharacters(self):
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="",
            stderr="",
        )

        tricky = "/tmp/repo;rm -rf /"
        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace(tricky),
        )

        runner.run(
            commands=(
                QaCommand(
                    name="format-check",
                    command="pnpm format:check",
                ),
            )
        )

        args, _ = sandbox.exec.call_args
        shell_command = args[2]
        # The literal ``rm -rf /`` substring MUST
        # NOT be visible to the shell as a separate
        # token.  ``shlex.quote`` wraps the entire
        # path in single quotes.
        self.assertNotIn(
            f"cd {tricky}",
            shell_command,
        )
        self.assertIn(
            f"cd {shlex.quote(tricky)}",
            shell_command,
        )


# ---------------------------------------------------------------------------
# C. ENV / TIMEOUT / STATUS / OBSERVABILITY PRESERVED
# ---------------------------------------------------------------------------


class QaPreservedSemanticsTests(unittest.TestCase):
    def test_environment_is_still_passed_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace_dir = Path(tmp) / "repo"
            workspace_dir.mkdir()

            sandbox = _IgnoringCwdSandbox(
                ambient_cwd=tmp,
            )
            runner = QaRunner(
                sandbox=sandbox,
                workspace=_make_workspace(
                    str(workspace_dir)
                ),
            )

            result = runner.run(
                commands=(
                    QaCommand(
                        name="env-test",
                        # Echo an env var the QA env
                        # is supposed to provide.
                        command=(
                            'echo "url=$TEST_DATABASE_URL"'
                        ),
                    ),
                ),
                env={
                    "TEST_DATABASE_URL": (
                        "postgresql://tenki@127.0.0.1:"
                        "5433/soundhub_m1_test"
                    ),
                },
            )

            self.assertTrue(result.passed)
            self.assertIn(
                "postgresql://tenki@127.0.0.1:5433/",
                result.commands[0].stdout,
            )

    def test_timeout_is_still_passed_through(self):
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="",
            stderr="",
        )

        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace("/tmp/repo"),
        )

        runner.run(
            commands=(
                QaCommand(
                    name="t",
                    command="true",
                    timeout_seconds=42,
                ),
            )
        )

        _, kwargs = sandbox.exec.call_args
        self.assertEqual(kwargs.get("timeout"), 42)

    def test_console_observability_preserved(self):
        import io
        from contextlib import redirect_stdout

        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout="",
            stderr="",
        )

        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace("/tmp/repo"),
        )

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            result = runner.run(
                commands=(
                    QaCommand(
                        name="format-check",
                        command="pnpm format:check",
                    ),
                )
            )

        output = buffer.getvalue()

        self.assertTrue(result.passed)
        # Operator-facing console lines remain
        # unchanged.
        self.assertIn("RALPH QA: starting format-check", output)
        self.assertIn(
            "RALPH QA: format-check -> PASS\n",
            output,
        )
        # And the QA command text MUST NOT leak
        # into the operator console.
        self.assertNotIn("pnpm format:check", output)
        # The repository path MUST NOT be in the
        # operator console either.
        self.assertNotIn("/tmp/repo", output)

    def test_infra_failure_classification_preserved(self):
        sandbox = MagicMock()
        sandbox.exec.return_value = SandboxCommandResult(
            exit_code=1,
            stdout="",
            stderr=(
                "connect ECONNREFUSED 127.0.0.1:5433"
            ),
        )

        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace("/tmp/repo"),
        )

        result = runner.run(
            commands=(
                QaCommand(
                    name="db-tests",
                    command="pnpm test:db",
                ),
            )
        )

        self.assertEqual(
            result.status,
            QaStatus.INFRA_FAILURE,
        )


# ---------------------------------------------------------------------------
# D. EXISTING QA BEHAVIOR
# ---------------------------------------------------------------------------


class ExistingQaBehaviorPreservedTests(unittest.TestCase):
    """Make sure the explicit-cd change did not
    regress the previously-covered QA behavior.
    """

    def test_stops_after_first_failure(self):
        sandbox = MagicMock()
        sandbox.exec.side_effect = [
            SandboxCommandResult(
                exit_code=1,
                stdout="test failed",
                stderr="",
            ),
            SandboxCommandResult(
                exit_code=0,
                stdout="should never run",
                stderr="",
            ),
        ]

        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace("/tmp/repo"),
        )

        result = runner.run(
            commands=(
                QaCommand(
                    name="tests",
                    command="pnpm test",
                ),
                QaCommand(
                    name="typecheck",
                    command="pnpm type-check",
                ),
            )
        )

        self.assertEqual(
            len(result.commands),
            1,
        )
        self.assertEqual(
            sandbox.exec.call_count,
            1,
        )

    def test_empty_plan_fails_closed(self):
        sandbox = MagicMock()
        runner = QaRunner(
            sandbox=sandbox,
            workspace=_make_workspace("/tmp/repo"),
        )

        with self.assertRaises(QaError):
            runner.run(())

        sandbox.exec.assert_not_called()


import re  # noqa: E402  (used by the regex above)


if __name__ == "__main__":
    unittest.main()
