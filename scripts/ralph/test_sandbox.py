import unittest
from unittest.mock import MagicMock, patch

from scripts.ralph.sandbox import TenkiSandbox


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
            env={
                "EXAMPLE_SECRET": "secret-value",
            },
        )

if __name__ == "__main__":
    unittest.main()
