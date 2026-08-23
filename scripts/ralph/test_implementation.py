import json
import unittest
from unittest.mock import MagicMock

from scripts.ralph.implementation import (
    ImplementationRunner,
    CompletionPhase,
    CompletionStatus,
    completion_result_path,
    parse_completion,
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
            completion_path=(
                "/tmp/ralph-implementation-result-16-"
                "implementation-1.json"
            ),
            fix_context=None,
        )

        self.assertIn(
            "Do not push, merge, rebase, reset, switch branches",
            prompt,
        )
        self.assertIn(
            "Do not create a git commit",
            prompt,
        )

    def test_prompt_uses_phase_qualified_completion_path(self):
        runner = ImplementationRunner(
            sandbox=self.sandbox,
            workspace=self.workspace,
            attempt=3,
            phase=CompletionPhase.IMPLEMENTATION,
        )

        prompt = runner._build_prompt(
            issue_number=16,
            packet_path="/tmp/issue.md",
            completion_path=completion_result_path(
                issue_number=16,
                phase="implementation",
                attempt=3,
            ),
            fix_context=None,
        )

        self.assertIn(
            (
                "/tmp/ralph-implementation-result-16-"
                "implementation-3.json"
            ),
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


class CompletionSchemaTests(unittest.TestCase):
    def _ok_complete(self):
        return {
            "status": "COMPLETE",
            "summary": "Implemented feature X.",
            "validation": "pnpm test passed",
            "blocker": None,
        }

    def _ok_blocked(self):
        return {
            "status": "BLOCKED",
            "summary": "Cannot decide between A and B",
            "validation": "Read AGENTS.md",
            "blocker": "Need human decision",
        }

    def test_complete_passes_when_required_strings_present(self):
        c = parse_completion(
            payload=self._ok_complete(),
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.COMPLETE)
        self.assertEqual(
            c.summary,
            "Implemented feature X.",
        )
        self.assertEqual(
            c.validation,
            "pnpm test passed",
        )
        self.assertIsNone(c.blocker)

    def test_complete_with_absent_blocker_blocks(self):
        # Strict schema: every key MUST be present.  COMPLETE
        # without the blocker key fails closed.
        payload = {
            "status": "COMPLETE",
            "summary": "Did the work.",
            "validation": "pnpm test passed",
        }
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("blocker", c.blocker or "")
        self.assertIn("missing keys", c.blocker or "")

    def test_complete_with_string_blocker_blocks(self):
        # COMPLETE requires blocker IS null. A string blocker is
        # a contradiction.
        payload = self._ok_complete()
        payload["blocker"] = "leftover"

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn(
            "blocker strictly equal to null",
            c.blocker or "",
        )

    def test_blocked_passes_with_non_empty_blocker(self):
        c = parse_completion(
            payload=self._ok_blocked(),
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertEqual(c.blocker, "Need human decision")

    def test_blocked_with_empty_summary_blocks(self):
        payload = self._ok_blocked()
        payload["summary"] = ""

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn(
            "missing or empty required fields",
            c.blocker or "",
        )

    def test_blocked_with_empty_validation_blocks(self):
        payload = self._ok_blocked()
        payload["validation"] = ""

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn(
            "missing or empty required fields",
            c.blocker or "",
        )

    def test_complete_without_summary_blocks(self):
        payload = self._ok_complete()
        payload["summary"] = ""

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("summary", c.blocker or "")

    def test_complete_without_validation_blocks(self):
        payload = self._ok_complete()
        payload["validation"] = ""

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("validation", c.blocker or "")

    def test_complete_with_non_null_blocker_blocks(self):
        payload = self._ok_complete()
        payload["blocker"] = ""

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)

    def test_blocked_without_blocker_blocks(self):
        payload = self._ok_blocked()
        payload["blocker"] = ""

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn(
            "missing or empty required fields",
            c.blocker or "",
        )

    def test_unknown_status_blocks(self):
        payload = self._ok_complete()
        payload["status"] = "PARTIALLY_DONE"

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("unknown status", c.blocker or "")

    def test_extra_keys_block(self):
        payload = self._ok_complete()
        payload["extra_field"] = "nope"

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("unexpected keys", c.blocker or "")

    def test_wrong_type_summary_blocks(self):
        payload = self._ok_complete()
        payload["summary"] = 12345

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("wrong field type", c.blocker or "")

    def test_missing_required_field_blocks(self):
        payload = {
            "status": "COMPLETE",
            "validation": "x",
            "blocker": None,
        }

        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)

    def test_non_object_payload_blocks(self):
        c = parse_completion(
            payload=["not", "an", "object"],
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(c.status, CompletionStatus.BLOCKED)


class CompletionSchemaMissingKeyTests(unittest.TestCase):
    """Every missing-key combination must fail closed with a
    BLOCKED status and an informative blocker string."""

    def _ok_complete(self):
        return {
            "status": "COMPLETE",
            "summary": "Did the work.",
            "validation": "pnpm test passed",
            "blocker": None,
        }

    def _ok_blocked(self):
        return {
            "status": "BLOCKED",
            "summary": "Cannot decide",
            "validation": "Read AGENTS.md",
            "blocker": "Need human decision",
        }

    def test_complete_missing_blocker_blocks(self):
        payload = self._ok_complete()
        del payload["blocker"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("missing keys", c.blocker or "")
        self.assertIn("blocker", c.blocker or "")

    def test_complete_missing_summary_blocks(self):
        payload = self._ok_complete()
        del payload["summary"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("missing keys", c.blocker or "")

    def test_complete_missing_validation_blocks(self):
        payload = self._ok_complete()
        del payload["validation"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("missing keys", c.blocker or "")

    def test_complete_missing_status_blocks(self):
        payload = self._ok_complete()
        del payload["status"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)

    def test_blocked_missing_blocker_blocks(self):
        payload = self._ok_blocked()
        del payload["blocker"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("missing keys", c.blocker or "")
        self.assertIn("blocker", c.blocker or "")

    def test_blocked_missing_summary_blocks(self):
        payload = self._ok_blocked()
        del payload["summary"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("missing keys", c.blocker or "")

    def test_blocked_missing_validation_blocks(self):
        payload = self._ok_blocked()
        del payload["validation"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)
        self.assertIn("missing keys", c.blocker or "")

    def test_blocked_missing_status_blocks(self):
        payload = self._ok_blocked()
        del payload["status"]
        c = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )
        self.assertEqual(c.status, CompletionStatus.BLOCKED)


class ResultPathTests(unittest.TestCase):
    def test_initial_implementation_and_fix_attempt_1_dont_collide(
        self,
    ):
        impl = completion_result_path(
            issue_number=17,
            phase="implementation",
            attempt=1,
        )
        fix = completion_result_path(
            issue_number=17,
            phase="fix",
            attempt=1,
        )
        self.assertNotEqual(impl, fix)
        self.assertIn("implementation-1", impl)
        self.assertIn("fix-1", fix)

    def test_phase_attempt_combos_are_unique(self):
        paths = {
            completion_result_path(
                issue_number=17,
                phase=phase,
                attempt=attempt,
            )
            for phase in (
                CompletionPhase.IMPLEMENTATION,
                CompletionPhase.FIX,
            )
            for attempt in (1, 2, 3)
        }
        self.assertEqual(len(paths), 6)


if __name__ == "__main__":
    unittest.main()
