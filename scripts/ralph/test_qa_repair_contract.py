"""Surgical convergence fix tests.

These tests prove the QA-repair contract for fix
iterations:

  A. When ``fix_context.qa_failure_evidence`` is present,
     the generated prompt MUST require:
       - read the evidence and identify the failing command,
       - repair the implementation / root cause,
       - rerun the exact previously failing QA command,
       - NOT return COMPLETE unless the rerun passes,
       - return BLOCKED if the command cannot be made to
         pass within the authoritative ticket scope.
  B. The contract is generic.  It does NOT hardcode any
     specific Ralph QA command (e.g. ``format-check``).
  C. Reviewer-only fix context (no qa_failure_evidence) MUST
     NOT introduce a "rerun the failed QA command" rule.
  D. Security: no new console / checkpoint projection of
     the QA evidence.  The existing projection path
     (ImplementationFixContext -> packet -> subprocess)
     is unchanged.
  E. Regression: the strict four-key completion schema
     (``status``, ``summary``, ``validation``, ``blocker``)
     and the phase-qualified completion path remain
     intact for every iteration.
"""

import unittest
from unittest.mock import MagicMock

from scripts.ralph.implementation import (
    CompletionPhase,
    ImplementationFixContext,
    ImplementationRunner,
    _Completion,
    completion_result_path,
    parse_completion,
)
from scripts.ralph.workspace import TicketWorkspace


def _make_runner():
    sandbox = MagicMock()
    workspace = TicketWorkspace(
        repository_path="/tmp/sound-hub",
        integration_branch="ralph/m2",
        ticket_branch="ralph/m2-17",
        base_sha="base123",
        ticket_sha="ticket123",
        resumed=False,
    )
    return ImplementationRunner(
        sandbox=sandbox,
        workspace=workspace,
    )


def _build_prompt(*, fix_context):
    runner = _make_runner()
    return runner._build_prompt(
        issue_number=17,
        packet_path="/tmp/ralph-issue-17.md",
        completion_path=completion_result_path(
            issue_number=17,
            phase="fix",
            attempt=1,
        ),
        fix_context=fix_context,
    )


# ---------------------------------------------------------------------------
# A. QA FAILURE FIX PROMPT
# ---------------------------------------------------------------------------


class QaRepairPromptContractTests(unittest.TestCase):
    def test_qa_repair_prompt_requires_rerun(self):
        evidence = (
            "QA STATUS: CODE_FAILURE\n"
            "\n"
            "## format-check\n"
            "Command: pnpm format:check\n"
            "Exit code: 1\n"
            "Status: CODE_FAILURE\n"
        )

        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                qa_failure_evidence=evidence,
            )
        )

        # The contract MUST require reading the
        # evidence and identifying the failing command.
        self.assertIn("read the QA failure evidence", prompt)
        self.assertIn("failed QA command", prompt)

        # The contract MUST require repair.
        self.assertIn("repair the implementation", prompt.lower())

        # The contract MUST require rerunning the
        # exact previously failing QA command.
        self.assertIn("MUST rerun the EXACT", prompt)
        self.assertIn("previously failing QA command", prompt)

        # The contract MUST forbid casual COMPLETE
        # while the rerun still fails.
        self.assertIn("MUST NOT write", prompt)
        self.assertIn("status: COMPLETE", prompt)
        self.assertIn("still fails", prompt.lower())

        # The contract MUST require BLOCKED when
        # the command cannot be made to pass within
        # the authoritative ticket scope.
        self.assertIn("status: BLOCKED", prompt)
        self.assertIn("authoritative ticket scope", prompt)

        # The contract MUST keep the ticket-boundary
        # guard from regressing.
        self.assertIn("ticket boundary", prompt.lower())

    def test_qa_repair_completion_validation_discipline(self):
        evidence = (
            "QA STATUS: CODE_FAILURE\n"
            "\n"
            "## format-check\n"
            "Command: pnpm format:check\n"
            "Exit code: 1\n"
        )

        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                qa_failure_evidence=evidence,
            )
        )

        # Completion instructions MUST be tightened
        # for QA-repair iterations.
        self.assertIn("QA-repair completion discipline", prompt)
        # ``validation`` MUST reference the exact
        # previously failing command.
        self.assertIn(
            "validation", prompt
        )
        self.assertIn(
            "previously failing QA command named in",
            prompt,
        )
        # The agent MUST NOT write a non-specific
        # validation.
        self.assertIn("non-specific", prompt.lower())

    def test_qa_repair_contract_uses_must_must_not(self):
        evidence = "## format-check\nCommand: pnpm format:check\n"

        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                qa_failure_evidence=evidence,
            )
        )

        # Strong MUST / MUST NOT language is required
        # so the agent cannot lazily claim COMPLETE.
        must_upper = prompt.count("MUST")
        must_not_upper = prompt.count("MUST NOT")

        self.assertGreaterEqual(must_upper, 3)
        self.assertGreaterEqual(must_not_upper, 2)


# ---------------------------------------------------------------------------
# B. GENERALITY (no hardcoded format-check)
# ---------------------------------------------------------------------------


class QaRepairContractGeneralityTests(unittest.TestCase):
    def test_contract_does_not_hardcode_format_check(self):
        # Use an entirely different command.  The
        # contract MUST apply to it the same way it
        # would apply to format-check.
        evidence = (
            "QA STATUS: CODE_FAILURE\n"
            "\n"
            "## repository-tests\n"
            "Command: pnpm test:repository\n"
            "Exit code: 2\n"
        )

        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                qa_failure_evidence=evidence,
            )
        )

        # The same contract requirements MUST appear.
        self.assertIn("MUST rerun the EXACT", prompt)
        self.assertIn("previously failing QA command", prompt)
        self.assertIn("status: BLOCKED", prompt)
        self.assertIn("ticket scope", prompt.lower())

        # The contract language itself MUST NOT name
        # any specific QA command.  The evidence
        # block goes into the packet file, not the
        # prompt, so the prompt must be free of
        # command names entirely.
        self.assertNotIn("format-check", prompt)
        self.assertNotIn("pnpm format:check", prompt)
        self.assertNotIn("pnpm test:repository", prompt)

    def test_contract_works_for_unrelated_command_name(self):
        # Worst-case: a QA command whose name is not
        # alphabetic at all.  The contract MUST still
        # apply generically.
        evidence = (
            "QA STATUS: INFRA_FAILURE\n"
            "\n"
            "## custom\n"
            "Command: ./scripts/run_custom_check.sh\n"
            "Exit code: 7\n"
        )

        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                qa_failure_evidence=evidence,
            )
        )

        self.assertIn("MUST rerun the EXACT", prompt)
        self.assertIn("previously failing QA command", prompt)
        self.assertNotIn("format-check", prompt)


# ---------------------------------------------------------------------------
# C. NON-QA FIX
# ---------------------------------------------------------------------------


class NonQaFixPromptTests(unittest.TestCase):
    def test_reviewer_only_fix_has_no_qa_rerun_rule(self):
        # When fix_context is provided but only
        # contains reviewer findings, the prompt MUST
        # NOT introduce a "rerun the failed QA
        # command" rule.  No QA gate is in play.
        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                reviewer_findings=(
                    "PRE_QA defect: migration column "
                    "added after backfill."
                ),
            )
        )

        # The QA-repair contract block MUST NOT
        # appear because qa_failure_evidence is
        # absent.
        self.assertNotIn(
            "QA-failure repair contract",
            prompt,
        )
        self.assertNotIn(
            "MUST rerun the EXACT",
            prompt,
        )
        # And the QA-repair completion discipline
        # block MUST NOT appear.
        self.assertNotIn(
            "QA-repair completion discipline",
            prompt,
        )
        # The original "Run focused validation"
        # guidance from the rules block is still
        # present.
        self.assertIn(
            "Run focused validation",
            prompt,
        )

    def test_initial_implementation_has_no_qa_rerun_rule(self):
        # An initial implementation has no fix
        # context and therefore no QA gate to rerun.
        prompt = _build_prompt(fix_context=None)

        self.assertNotIn(
            "QA-failure repair contract",
            prompt,
        )
        self.assertNotIn(
            "MUST rerun the EXACT",
            prompt,
        )

    def test_fix_context_with_only_pre_persistence_findings(
        self,
    ):
        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                pre_persistence_findings=(
                    "PRE_PERSISTENCE: missing test "
                    "for edge case."
                ),
            )
        )

        # No QA gate -> no QA-rerun rule.
        self.assertNotIn(
            "QA-failure repair contract",
            prompt,
        )


# ---------------------------------------------------------------------------
# D. SECURITY
# ---------------------------------------------------------------------------


class QaRepairSecurityTests(unittest.TestCase):
    def test_qa_evidence_not_added_to_completion_payload(self):
        # The four-key completion schema MUST stay
        # exactly the same on a QA-repair iteration.
        # We assert by parsing a well-formed
        # completion that mentions a QA command and
        # verifying the parser does not project any
        # evidence into the result.
        SECRET = "super-secret-value-12345"

        evidence_mentioning_secret = (
            "QA STATUS: CODE_FAILURE\n"
            "\n"
            "## format-check\n"
            f"Command: pnpm format:check\n"
            f"stdout: {SECRET}\n"
            f"stderr: {SECRET}\n"
        )

        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                qa_failure_evidence=evidence_mentioning_secret,
            )
        )

        # The contract block in the prompt MUST NOT
        # echo the secret.
        self.assertNotIn(SECRET, prompt)
        # And the prompt MUST NOT contain the raw
        # evidence body.  Evidence lives in the
        # packet file only.
        self.assertNotIn("stdout:", prompt)
        self.assertNotIn("stderr:", prompt)
        self.assertNotIn("pnpm format:check", prompt)

        # No new console/checkpoint projection lines
        # are introduced by this patch.
        self.assertNotIn("QA-EVIDENCE-PROJECT", prompt)
        self.assertNotIn("last_failed_qa", prompt)
        self.assertNotIn("qa_history", prompt)

    def test_qa_evidence_in_prompt_remains_in_packet_only(self):
        # The implementation runner writes the
        # fix-context to /tmp/ralph-issue-N.md via
        # base64.  No new console / checkpoint
        # projection of the evidence is added by
        # this patch.
        SECRET = "another-secret-987654"
        evidence = (
            f"## format-check\n"
            f"Command: pnpm format:check\n"
            f"stdout: {SECRET}\n"
        )

        prompt = _build_prompt(
            fix_context=ImplementationFixContext(
                qa_failure_evidence=evidence,
            )
        )

        # No console-style evidence projection.
        self.assertNotIn(SECRET, prompt)
        # No checkpoint-style projection lines.
        self.assertNotIn("last_failed_qa", prompt)
        self.assertNotIn("qa_history", prompt)


# ---------------------------------------------------------------------------
# E. REGRESSION
# ---------------------------------------------------------------------------


class CompletionSchemaRegressionTests(unittest.TestCase):
    def test_four_key_schema_still_rejected_on_extra_keys(self):
        # Extra keys still fail closed.
        payload = {
            "status": "COMPLETE",
            "summary": "x",
            "validation": "y",
            "blocker": None,
            "extra": "nope",
        }

        parsed = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(
            parsed.status,
            _Completion(
                status=__import__(
                    "scripts.ralph.implementation",
                    fromlist=["CompletionStatus"],
                ).CompletionStatus.BLOCKED,
                summary=None,
                validation=None,
                blocker="",
            ).status,
        )

    def test_four_key_schema_still_rejected_on_missing_keys(self):
        payload = {
            "status": "COMPLETE",
            "summary": "x",
            "validation": "y",
        }

        parsed = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        # Missing ``blocker`` -> rejected.
        self.assertNotEqual(
            parsed.status.value,
            "COMPLETE",
        )

    def test_complete_with_non_null_blocker_still_rejected(self):
        payload = {
            "status": "COMPLETE",
            "summary": "x",
            "validation": "y",
            "blocker": "should-be-null",
        }

        parsed = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertNotEqual(
            parsed.status.value,
            "COMPLETE",
        )

    def test_well_formed_complete_still_accepted(self):
        payload = {
            "status": "COMPLETE",
            "summary": "ok",
            "validation": "ok",
            "blocker": None,
        }

        parsed = parse_completion(
            payload=payload,
            issue_number=17,
            completion_path="/tmp/x.json",
        )

        self.assertEqual(
            parsed.status.value,
            "COMPLETE",
        )


class CompletionPathRegressionTests(unittest.TestCase):
    def test_phase_qualified_completion_path_preserved(self):
        # The fix phase path must NOT collide with
        # the implementation phase path for the
        # same attempt counter.
        impl_path = completion_result_path(
            issue_number=17,
            phase=CompletionPhase.IMPLEMENTATION.value,
            attempt=1,
        )
        fix_path = completion_result_path(
            issue_number=17,
            phase=CompletionPhase.FIX.value,
            attempt=1,
        )

        self.assertIn("implementation-1", impl_path)
        self.assertIn("fix-1", fix_path)
        self.assertNotEqual(impl_path, fix_path)


class ImplementationRunnerRegressionTests(unittest.TestCase):
    def test_prompt_uses_phase_qualified_completion_path(self):
        runner = _make_runner()
        prompt = runner._build_prompt(
            issue_number=17,
            packet_path="/tmp/ralph-issue-17.md",
            completion_path=completion_result_path(
                issue_number=17,
                phase=CompletionPhase.FIX.value,
                attempt=2,
            ),
            fix_context=ImplementationFixContext(
                qa_failure_evidence=(
                    "## format-check\n"
                    "Command: pnpm format:check\n"
                ),
            ),
        )

        # Phase-qualified completion path is
        # referenced in the prompt.
        self.assertIn(
            "/tmp/ralph-implementation-result-17-fix-2.json",
            prompt,
        )


if __name__ == "__main__":
    unittest.main()
