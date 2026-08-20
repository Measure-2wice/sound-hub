import json
import unittest
from unittest.mock import MagicMock

from scripts.ralph.review import (
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


if __name__ == "__main__":
    unittest.main()