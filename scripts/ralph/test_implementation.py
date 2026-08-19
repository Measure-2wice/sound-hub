import json
import unittest
from unittest.mock import MagicMock

from scripts.ralph.implementation import (
    ImplementationRunner,
)
from scripts.ralph.sandbox import SandboxCommandResult
from scripts.ralph.workspace import TicketWorkspace


class ImplementationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = MagicMock()

        self.workspace = TicketWorkspace(
            repository_path="/tmp/sound-hub",
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-16",
            base_sha="base123",
            ticket_sha="ticket123",
            resumed=True,
        )

        self.runner = ImplementationRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
            model="MiniMax-M2.7",
            max_turns=60,
        )

    def test_parses_successful_agent_result(self):
        result = SandboxCommandResult(
            exit_code=0,
            stdout=json.dumps(
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "session_id": "session-123",
                    "num_turns": 4,
                    "stop_reason": None,
                    "terminal_reason": "completed",
                    "result": (
                        "Implementation complete."
                    ),
                }
            ),
            stderr="",
        )

        parsed = self.runner._parse_result(
            result,
            changed_files=("file.py",),
        )

        self.assertFalse(parsed.is_error)
        self.assertFalse(parsed.exhausted)
        self.assertEqual(
            parsed.terminal_reason,
            "completed",
        )
        self.assertEqual(parsed.num_turns, 4)
        self.assertEqual(
            parsed.result_text,
            "Implementation complete.",
        )

    def test_detects_max_turn_exhaustion(self):
        result = SandboxCommandResult(
            exit_code=1,
            stdout=json.dumps(
                {
                    "type": "result",
                    "subtype": "error_max_turns",
                    "is_error": True,
                    "terminal_reason": "max_turns",
                    "stop_reason": "tool_use",
                    "num_turns": 3,
                    "session_id": "session-456",
                    "result": None,
                }
            ),
            stderr="",
        )

        parsed = self.runner._parse_result(
            result,
            changed_files=("migration.sql",),
        )

        self.assertTrue(parsed.is_error)
        self.assertTrue(parsed.exhausted)
        self.assertEqual(parsed.num_turns, 3)
        self.assertEqual(
            parsed.terminal_reason,
            "max_turns",
        )
        self.assertEqual(
            parsed.stop_reason,
            "tool_use",
        )

    def test_prompt_forbids_git_persistence(self):
        prompt = self.runner._build_prompt(
            issue_number=16,
            packet_path="/tmp/issue.md",
        )

        self.assertIn(
            "Do not push, merge, rebase, reset, switch branches",
            prompt,
        )
        self.assertIn(
            "Do not create a git commit",
            prompt,
        )

    def test_changed_files_reads_worktree(self):
        self.sandbox.exec.return_value = SandboxCommandResult(
            exit_code=0,
            stdout=(
                " M packages/db/file.ts\n"
                "?? packages/db/new.sql\n"
            ),
            stderr="",
        )

        changed = self.runner._changed_files()

        self.assertEqual(
            changed,
            (
                "packages/db/file.ts",
                "packages/db/new.sql",
            ),
        )


if __name__ == "__main__":
    unittest.main()
