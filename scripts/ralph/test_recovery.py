"""Unit tests for scripts.ralph.recovery."""

import unittest
from types import SimpleNamespace
from typing import Optional
from unittest.mock import MagicMock

from scripts.ralph.checkpoint import TicketCheckpoint
from scripts.ralph.git_policy import GitPushPolicy
from scripts.ralph.recovery import (
    BranchAbsentReason,
    BranchLookup,
    BranchMalformedReason,
    CandidateEvaluation,
    DurableStateProbe,
    PullRequestAbsentReason,
    PullRequestLookup,
    PullRequestMalformedReason,
    RecoveryOutcome,
    RecoveryState,
    _evaluate_candidate,
    reconcile_persistence,
)
from scripts.ralph.states import TicketState


class FakeProbe(DurableStateProbe):
    def __init__(
        self,
        *,
        branch=None,
        pull_requests=None,
    ):
        self.branch = branch
        self.pull_requests = pull_requests
        self.branch_calls = 0
        self.pr_calls = 0

    def remote_branch_head(
        self, *, ticket_branch: str
    ) -> Optional[BranchLookup]:
        self.branch_calls += 1
        return self.branch

    def pull_requests_for_branch(
        self, *, ticket_branch, integration_branch
    ):
        self.pr_calls += 1
        return self.pull_requests

    def pull_request_merged(
        self, *, pull_request_number: int
    ):
        return None

    def pull_request_detail(
        self, *, pull_request_number: int
    ):
        return None


def _checkpoint(**overrides) -> TicketCheckpoint:
    base = dict(
        milestone_id="m2",
        issue_number=17,
        state=TicketState.AUTOMATED_QA,
        integration_branch="ralph/m2",
        ticket_branch="ralph/m2-17",
        base_sha="baseline123",
        ticket_sha="ORIGINAL_BASELINE",
        persisted_commit_sha=None,
        pull_request_number=None,
    )
    base.update(overrides)
    return TicketCheckpoint(**base)


def _present_branch(head: str) -> BranchLookup:
    return BranchLookup(head_sha=head)


def _absent_branch() -> BranchLookup:
    return BranchLookup(
        absent_reason=BranchAbsentReason.NOT_FOUND
    )


def _empty_pr_lookup() -> PullRequestLookup:
    return PullRequestLookup(
        candidates=(),
        absent_reason=PullRequestAbsentReason.EMPTY_LIST,
        malformed_reasons=(),
    )


def _matching_pr_lookup(
    *, head_sha: str, number: int
) -> PullRequestLookup:
    return PullRequestLookup(
        candidates=(
            CandidateEvaluation(
                number=number,
                head_sha=head_sha,
                reasons=(),
            ),
        ),
        absent_reason=None,
        malformed_reasons=(),
    )


def _evaluate_pr(
    pr: dict,
    *,
    expected_repo="Measure-2wice/sound-hub",
    expected_base="ralph/m2",
    expected_head="ralph/m2-17",
) -> CandidateEvaluation:
    return _evaluate_candidate(
        pr,
        expected_repository=expected_repo,
        expected_base=expected_base,
        expected_head_ref=expected_head,
    )


# ----------------------------------------------------------------------------
# Probe boundary: malformed vs absent must be distinguishable at the
# boundary, not collapsed inside recovery.
# ----------------------------------------------------------------------------


class ProbeBoundaryTests(unittest.TestCase):
    def test_branch_lookup_distinguishes_found_absent_malformed(self):
        found = BranchLookup(head_sha="abc")
        absent = BranchLookup(
            absent_reason=BranchAbsentReason.NOT_FOUND
        )
        malformed = BranchLookup(
            malformed_reason=(
                BranchMalformedReason.MALFORMED_RESPONSE
            )
        )

        self.assertEqual(found.head_sha, "abc")
        self.assertIsNone(found.absent_reason)
        self.assertIsNone(found.malformed_reason)

        self.assertIsNone(absent.head_sha)
        self.assertEqual(
            absent.absent_reason,
            BranchAbsentReason.NOT_FOUND,
        )
        self.assertIsNone(absent.malformed_reason)

        self.assertIsNone(malformed.head_sha)
        self.assertIsNone(malformed.absent_reason)
        self.assertEqual(
            malformed.malformed_reason,
            BranchMalformedReason.MALFORMED_RESPONSE,
        )

    def test_pr_lookup_empty_list_means_absent_not_malformed(self):
        lookup = PullRequestLookup(
            candidates=(),
            absent_reason=PullRequestAbsentReason.EMPTY_LIST,
            malformed_reasons=(),
        )

        self.assertEqual(
            lookup.absent_reason,
            PullRequestAbsentReason.EMPTY_LIST,
        )
        self.assertEqual(lookup.malformed_reasons, ())

    def test_candidate_evaluation_surfaces_wrong_base_reason(self):
        ev = _evaluate_pr(
            {
                "number": 1,
                "head": {
                    "ref": "ralph/m2-17",
                    "sha": "X",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
                "base": {
                    "ref": "wrong-branch",
                    "repo": {
                        "full_name": "Measure-2wice/sound-hub"
                    },
                },
            }
        )

        self.assertIn(
            PullRequestMalformedReason.CANDIDATE_WRONG_BASE,
            ev.reasons,
        )


# ----------------------------------------------------------------------------
# NOTHING_DURABLE matrix
# ----------------------------------------------------------------------------


class NothingDurableTests(unittest.TestCase):
    def setUp(self):
        self.policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

    def test_absent_branch_empty_checkpoint_returns_nothing_durable(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_absent_branch(),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.NOTHING_DURABLE,
        )
        # PR probe MUST NOT be called when branch is verified absent.
        self.assertEqual(probe.pr_calls, 0)

    def test_baseline_branch_empty_checkpoint_returns_nothing_durable(
        self,
    ):
        checkpoint = _checkpoint(ticket_sha="SAME_SHA")
        probe = FakeProbe(
            branch=_present_branch("SAME_SHA"),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.NOTHING_DURABLE,
        )


# ----------------------------------------------------------------------------
# COMMIT_ONLY matrix
# ----------------------------------------------------------------------------


class CommitOnlyTests(unittest.TestCase):
    def setUp(self):
        self.policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

    def test_branch_with_commit_no_pr_returns_commit_only(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.COMMIT_ONLY,
        )
        self.assertEqual(
            state.commit_sha,
            "IMPLEMENTATION_SHA",
        )
        self.assertIsNone(state.pull_request_number)

    def test_branch_with_commit_and_matching_checkpoint_sha_returns_commit_only(
        self,
    ):
        checkpoint = _checkpoint(
            persisted_commit_sha="IMPLEMENTATION_SHA",
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.COMMIT_ONLY,
        )
        self.assertEqual(
            state.commit_sha,
            "IMPLEMENTATION_SHA",
        )

    def test_checkpoint_pr_contradicts_no_pr_returns_ambiguous(self):
        checkpoint = _checkpoint(
            pull_request_number=99,
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_checkpoint_sha_contradicts_remote_returns_ambiguous(self):
        checkpoint = _checkpoint(
            persisted_commit_sha="WRONG_SHA",
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )


# ----------------------------------------------------------------------------
# COMMIT_AND_PR matrix
# ----------------------------------------------------------------------------


class CommitAndPrTests(unittest.TestCase):
    def setUp(self):
        self.policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

    def test_exact_branch_and_exact_pr_returns_commit_and_pr(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_matching_pr_lookup(
                head_sha="IMPLEMENTATION_SHA",
                number=42,
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.COMMIT_AND_PR,
        )
        self.assertEqual(
            state.commit_sha,
            "IMPLEMENTATION_SHA",
        )
        self.assertEqual(state.pull_request_number, 42)

    def test_missing_checkpoint_sha_recovered_from_remote(self):
        checkpoint = _checkpoint(
            persisted_commit_sha=None,
            pull_request_number=42,
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_matching_pr_lookup(
                head_sha="IMPLEMENTATION_SHA",
                number=42,
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.COMMIT_AND_PR,
        )
        self.assertEqual(
            state.commit_sha,
            "IMPLEMENTATION_SHA",
        )
        self.assertEqual(state.pull_request_number, 42)

    def test_missing_checkpoint_pr_recovered_from_pr_lookup(self):
        checkpoint = _checkpoint(
            persisted_commit_sha="IMPLEMENTATION_SHA",
            pull_request_number=None,
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_matching_pr_lookup(
                head_sha="IMPLEMENTATION_SHA",
                number=42,
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.COMMIT_AND_PR,
        )
        self.assertEqual(state.pull_request_number, 42)

    def test_checkpoint_both_match_returns_commit_and_pr(self):
        checkpoint = _checkpoint(
            persisted_commit_sha="IMPLEMENTATION_SHA",
            pull_request_number=42,
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_matching_pr_lookup(
                head_sha="IMPLEMENTATION_SHA",
                number=42,
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.COMMIT_AND_PR,
        )


# ----------------------------------------------------------------------------
# AMBIGUOUS matrix — every listed case must collapse to AMBIGUOUS.
# ----------------------------------------------------------------------------


class AmbiguousTests(unittest.TestCase):
    def setUp(self):
        self.policy = GitPushPolicy(
            integration_branch="ralph/m2",
            ticket_branch_prefix="ralph/m2-",
        )

    def test_malformed_branch_response_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=BranchLookup(
                malformed_reason=(
                    BranchMalformedReason.MALFORMED_RESPONSE
                )
            ),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_branch_probe_returns_none_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=None,
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_malformed_pr_lookup_not_a_list_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.NOT_A_LIST,
                ),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_malformed_pr_candidate_in_list_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(
                    CandidateEvaluation(
                        number=42,
                        head_sha="IMPLEMENTATION_SHA",
                        reasons=(),
                    ),
                ),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.CANDIDATE_MALFORMED,
                ),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_multiple_matching_prs_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(
                    CandidateEvaluation(
                        number=1,
                        head_sha="IMPLEMENTATION_SHA",
                        reasons=(),
                    ),
                    CandidateEvaluation(
                        number=2,
                        head_sha="IMPLEMENTATION_SHA",
                        reasons=(),
                    ),
                ),
                absent_reason=None,
                malformed_reasons=(),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_wrong_base_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(
                    CandidateEvaluation(
                        number=1,
                        head_sha="IMPLEMENTATION_SHA",
                        reasons=(
                            PullRequestMalformedReason.CANDIDATE_WRONG_BASE,
                        ),
                    ),
                ),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.CANDIDATE_WRONG_BASE,
                ),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_wrong_head_ref_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.CANDIDATE_WRONG_HEAD_REF,
                ),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_wrong_head_sha_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(
                    CandidateEvaluation(
                        number=1,
                        head_sha="OTHER_SHA",
                        reasons=(
                            PullRequestMalformedReason.CANDIDATE_WRONG_HEAD_SHA,
                        ),
                    ),
                ),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.CANDIDATE_WRONG_HEAD_SHA,
                ),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_wrong_repository_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.CANDIDATE_WRONG_REPOSITORY,
                ),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_invalid_pr_number_returns_ambiguous(self):
        checkpoint = _checkpoint()
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=PullRequestLookup(
                candidates=(),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.CANDIDATE_INVALID_NUMBER,
                ),
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_absent_branch_with_checkpoint_sha_returns_ambiguous(self):
        checkpoint = _checkpoint(
            persisted_commit_sha="IMPLEMENTATION_SHA",
        )
        probe = FakeProbe(
            branch=_absent_branch(),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_absent_branch_with_checkpoint_pr_returns_ambiguous(self):
        checkpoint = _checkpoint(
            pull_request_number=42,
        )
        probe = FakeProbe(
            branch=_absent_branch(),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_baseline_branch_with_checkpoint_sha_returns_ambiguous(self):
        checkpoint = _checkpoint(
            persisted_commit_sha="DIFFERENT",
            ticket_sha="SAME_SHA",
        )
        probe = FakeProbe(
            branch=_present_branch("SAME_SHA"),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_baseline_branch_with_checkpoint_pr_returns_ambiguous(self):
        checkpoint = _checkpoint(
            pull_request_number=42,
            ticket_sha="SAME_SHA",
        )
        probe = FakeProbe(
            branch=_present_branch("SAME_SHA"),
            pull_requests=_empty_pr_lookup(),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_unexpected_checkpoint_ticket_branch_returns_ambiguous(self):
        checkpoint = _checkpoint(
            ticket_branch="ralph/m2-WRONG",
        )
        probe = FakeProbe(branch=_present_branch("X"))

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_checkpoint_pr_contradicts_verified_pr_returns_ambiguous(self):
        checkpoint = _checkpoint(
            pull_request_number=999,
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_matching_pr_lookup(
                head_sha="IMPLEMENTATION_SHA",
                number=42,
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )

    def test_checkpoint_sha_contradicts_verified_pr_head_returns_ambiguous(
        self,
    ):
        checkpoint = _checkpoint(
            persisted_commit_sha="OTHER_SHA",
            pull_request_number=42,
        )
        probe = FakeProbe(
            branch=_present_branch("IMPLEMENTATION_SHA"),
            pull_requests=_matching_pr_lookup(
                head_sha="IMPLEMENTATION_SHA",
                number=42,
            ),
        )

        state = reconcile_persistence(
            checkpoint=checkpoint,
            policy=self.policy,
            probe=probe,
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            state.outcome,
            RecoveryOutcome.AMBIGUOUS,
        )


class MergedPRIdentityTests(unittest.TestCase):
    """#3 — strict identity proof for the post-merge base-guard
    relaxation.  Only VERIFIED_MERGED may relax the guard.
    Anything else (verified-not-merged, ambiguous, malformed,
    wrong identity, non-boolean ``merged``) returns False so
    the caller preserves the original ``expected_base_sha``.
    """

    REPO = "Measure-2wice/sound-hub"
    BASE = "ralph/m2"
    HEAD = "ralph/m2-17"
    SHA = "IMPLEMENTATION_SHA"
    PR = 202

    def _expected_kwargs(self):
        return dict(
            expected_repository=self.REPO,
            expected_base=self.BASE,
            expected_head_ref=self.HEAD,
            expected_head_sha=self.SHA,
            expected_pull_request_number=self.PR,
        )

    def _verified_probe(self, *, merged: bool):
        return SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": self.HEAD,
                        "sha": self.SHA,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "merged": merged,
                }
            )
        )

    def test_a_merged_true_with_full_identity_returns_verified_merged(
        self,
    ):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        proof = verify_merged_pull_request(
            probe=self._verified_probe(merged=True),
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.VERIFIED_MERGED,
        )

    def test_b_merged_false_returns_verified_not_merged(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        proof = verify_merged_pull_request(
            probe=self._verified_probe(merged=False),
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.VERIFIED_NOT_MERGED,
        )

    def test_c_merged_string_false_returns_ambiguous(self):
        """``"false"`` is a truthy string in Python.  The
        verifier MUST NOT treat it as a verified-merge
        signal.  Only the literal boolean True qualifies.
        """
        from scripts.ralph.recovery import (
            MergedPRFailureReason,
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": self.HEAD,
                        "sha": self.SHA,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "merged": "false",
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )
        self.assertIn(
            MergedPRFailureReason.MERGED_NOT_BOOLEAN,
            proof.reasons,
        )

    def test_c2_merged_string_true_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": self.HEAD,
                        "sha": self.SHA,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "merged": "true",
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )

    def test_d_wrong_repository_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": self.HEAD,
                        "sha": self.SHA,
                        "repo": {
                            "full_name": "OtherOwner/other-repo"
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": "OtherOwner/other-repo"
                        },
                    },
                    "merged": True,
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )

    def test_e_wrong_base_ref_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": self.HEAD,
                        "sha": self.SHA,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": "wrong-base",
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "merged": True,
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )

    def test_f_wrong_head_ref_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": "ralph/m2-other",
                        "sha": self.SHA,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "merged": True,
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )

    def test_g_wrong_head_sha_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": self.HEAD,
                        "sha": "OTHER_SHA",
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "merged": True,
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )

    def test_h_malformed_pr_response_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value=None
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )

    def test_wrong_pr_number_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": 999,
                    "head": {
                        "ref": self.HEAD,
                        "sha": self.SHA,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "merged": True,
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )

    def test_missing_fields_returns_ambiguous(self):
        from scripts.ralph.recovery import (
            MergedPRVerification,
            verify_merged_pull_request,
        )

        # Missing ``merged`` entirely.
        probe = SimpleNamespace(
            pull_request_detail=MagicMock(
                return_value={
                    "number": self.PR,
                    "head": {
                        "ref": self.HEAD,
                        "sha": self.SHA,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                    "base": {
                        "ref": self.BASE,
                        "repo": {
                            "full_name": self.REPO
                        },
                    },
                }
            )
        )

        proof = verify_merged_pull_request(
            probe=probe,
            **self._expected_kwargs(),
        )

        self.assertEqual(
            proof.outcome,
            MergedPRVerification.AMBIGUOUS,
        )


if __name__ == "__main__":
    unittest.main()