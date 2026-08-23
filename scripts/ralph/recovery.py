"""Durable persistence reconciliation.

The persistence runner can:

  - create the implementation commit
  - push the ticket branch
  - open the pull request

and then the process can crash before the checkpoint captures
``persisted_commit_sha`` and ``pull_request_number``. On restart,
the remote durable state already proves what happened.

This module classifies what is recoverable:

  - NOTHING_DURABLE: no durable implementation beyond original
    ``ticket_sha``. Persistence may begin normally.

  - COMMIT_ONLY: the expected ticket branch exists and its HEAD
    differs from the original baseline, identity is otherwise
    valid, but no PR was opened yet. Recover the durable commit
    and let the persistence runner create only the missing PR.

  - COMMIT_AND_PR: branch exists, HEAD differs from baseline, and
    exactly one matching PR exists with verified repository, base,
    head ref, and head SHA. Recover both ``persisted_commit_sha``
    and ``pull_request_number`` and skip duplicate side effects.

  - AMBIGUOUS: any case where Ralph cannot prove what happened.
    Multiple candidate PRs, wrong repository, wrong base, wrong
    head ref, wrong head SHA, invalid PR number, malformed
    GitHub response, unexpected ticket branch, or partial
    checkpoint values that contradict verified durable state.
    The orchestrator must transition to ``BLOCKED_FOR_HUMAN``.

Partial checkpoint values are reconciled against verified GitHub
evidence in EVERY outcome:

  - absent remote branch + checkpoint SHA/PR  -> AMBIGUOUS
  - baseline remote branch + checkpoint SHA/PR -> AMBIGUOUS
  - remote T + checkpoint SHA contradicting remote -> AMBIGUOUS
  - remote T + checkpoint PR contradicting verified PR -> AMBIGUOUS
  - remote T + missing checkpoint SHA but matching PR -> recover SHA
  - remote T + missing checkpoint PR but matching PR -> recover PR
  - remote T + matching PR + matching checkpoint values -> COMMIT_AND_PR
  - remote T + no PR + no checkpoint PR -> COMMIT_ONLY

AMBIGUOUS reaches ``BLOCKED_FOR_HUMAN`` BEFORE any persistence
write — the conductor never invokes ``PersistenceRunner`` or PR
creation on an ambiguous outcome.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Union

from scripts.ralph.checkpoint import TicketCheckpoint
from scripts.ralph.git_policy import GitPushPolicy


class RecoveryOutcome(str, Enum):
    NOTHING_DURABLE = "NOTHING_DURABLE"
    COMMIT_ONLY = "COMMIT_ONLY"
    COMMIT_AND_PR = "COMMIT_AND_PR"
    AMBIGUOUS = "AMBIGUOUS"


@dataclass(frozen=True)
class RecoveryState:
    outcome: RecoveryOutcome
    commit_sha: Optional[str]
    pull_request_number: Optional[int]


# --- Probe boundary primitives ---------------------------------------
#
# These types distinguish verified absence from malformed responses
# at the GitHub read-only probe boundary.  ``RecoveryState`` and
# downstream code must treat ``MALFORMED`` (an invalid / unparseable
# response) as NOT a substitute for ``ABSENT``.  Only a verified
# well-formed empty result or an explicit 404 may mean "absent".


class BranchAbsentReason(str, Enum):
    """A branch lookup returned a verified ``absent`` result."""

    NOT_FOUND = "NOT_FOUND"


class BranchMalformedReason(str, Enum):
    """A branch lookup returned something Ralph cannot interpret."""

    MALFORMED_RESPONSE = "MALFORMED_RESPONSE"
    WRONG_TYPE = "WRONG_TYPE"
    MISSING_OBJECT = "MISSING_OBJECT"
    EMPTY_SHA = "EMPTY_SHA"


@dataclass(frozen=True)
class BranchLookup:
    """Result of looking up a remote ticket branch.

    Exactly one of ``head_sha`` or ``absent_reason`` or
    ``malformed_reason`` is set.  Ralph must treat
    ``malformed_reason`` as AMBIGUOUS, never as NOTHING_DURABLE.
    """

    head_sha: Optional[str] = None
    absent_reason: Optional[BranchAbsentReason] = None
    malformed_reason: Optional[BranchMalformedReason] = None


class PullRequestAbsentReason(str, Enum):
    EMPTY_LIST = "EMPTY_LIST"


class PullRequestMalformedReason(str, Enum):
    NOT_A_LIST = "NOT_A_LIST"
    CANDIDATE_MALFORMED = "CANDIDATE_MALFORMED"
    CANDIDATE_WRONG_REPOSITORY = "CANDIDATE_WRONG_REPOSITORY"
    CANDIDATE_WRONG_BASE = "CANDIDATE_WRONG_BASE"
    CANDIDATE_WRONG_HEAD_REF = "CANDIDATE_WRONG_HEAD_REF"
    CANDIDATE_WRONG_HEAD_SHA = "CANDIDATE_WRONG_HEAD_SHA"
    CANDIDATE_INVALID_NUMBER = "CANDIDATE_INVALID_NUMBER"


@dataclass(frozen=True)
class CandidateEvaluation:
    """How Ralph classified one PR candidate from GitHub."""

    number: Optional[int]
    head_sha: Optional[str]
    reasons: tuple[PullRequestMalformedReason, ...]


@dataclass(frozen=True)
class PullRequestLookup:
    """Result of looking up PRs for a ticket branch.

    ``candidates`` is the list of well-formed candidates whose
    head SHA equals the verified remote implementation SHA.
    ``malformed_reasons`` lists every candidate that was rejected
    for any structural reason.  ``absent_reason`` is set only
    when GitHub returned a well-formed empty list.

    If ``malformed_reasons`` is non-empty AND ``candidates`` is
    non-empty the recovery outcome is AMBIGUOUS — Ralph must NOT
    silently filter bad candidates.
    """

    candidates: tuple[CandidateEvaluation, ...]
    absent_reason: Optional[PullRequestAbsentReason] = None
    malformed_reasons: tuple[PullRequestMalformedReason, ...] = ()


class DurableStateProbe:
    """Abstracts the GitHub-side reads needed to reconcile a
    partially-persisted ticket.

    The real implementation queries GitHub; tests substitute a fake
    returning deterministic responses.

    Implementations MUST distinguish verified absence from
    malformed responses.  ``None`` is reserved for malformed /
    unparseable; a well-formed empty list is the only signal of
    "no durable PR".  Likewise, ``None`` from ``remote_branch_head``
    is malformed — a verified 404 must return ``BranchLookup`` with
    ``absent_reason`` set.
    """

    def remote_branch_head(
        self, *, ticket_branch: str
    ) -> Union[BranchLookup, None]:
        """Return a ``BranchLookup`` distinguishing FOUND / ABSENT
        / MALFORMED.  ``None`` is reserved for "the probe itself
        could not answer" (network / sandbox error); see
        ``GitHubReadOnlyProbe`` which raises on transport errors
        but returns ``None`` for non-JSON output."""
        raise NotImplementedError

    def pull_requests_for_branch(
        self, *, ticket_branch: str, integration_branch: str
    ) -> Union[PullRequestLookup, None]:
        """Return a ``PullRequestLookup`` distinguishing FOUND /
        ABSENT / MALFORMED.  ``None`` is reserved for "the probe
        itself could not answer"."""
        raise NotImplementedError

    def pull_request_merged(
        self, *, pull_request_number: int
    ) -> Optional[bool]:
        """Return True if the PR has been merged, False if it has
        not, None if the response was malformed."""
        raise NotImplementedError

    def pull_request_detail(
        self, *, pull_request_number: int
    ) -> Optional[dict]:
        """Fetch the detailed PR record from
        ``GET /repos/{owner}/{repository}/pulls/{pull_request_number}``.

        This is the canonical source of the ``merged`` boolean
        for identity proof.  Returns the raw GitHub dict,
        ``None`` for malformed responses, or raises on
        transport errors.
        """
        raise NotImplementedError


# --- Merged-PR identity proof --------------------------------------
#
# Before relaxing the post-merge integration-base guard the
# conductor must prove the EXPECTED persisted PR is the EXACT
# PR that GitHub shows as merged.  This is an additional proof
# for workspace preparation, not a replacement for
# ``IntegrationRunner``'s safety checks.


class MergedPRVerification(str, Enum):
    """Three-valued outcome of the post-merge identity proof."""

    VERIFIED_MERGED = "VERIFIED_MERGED"
    VERIFIED_NOT_MERGED = "VERIFIED_NOT_MERGED"
    AMBIGUOUS = "AMBIGUOUS"


class MergedPRFailureReason(str, Enum):
    """Why a merged-PR identity check failed."""

    MALFORMED_RESPONSE = "MALFORMED_RESPONSE"
    MISSING_FIELDS = "MISSING_FIELDS"
    WRONG_REPOSITORY = "WRONG_REPOSITORY"
    WRONG_BASE = "WRONG_BASE"
    WRONG_HEAD_REF = "WRONG_HEAD_REF"
    WRONG_HEAD_SHA = "WRONG_HEAD_SHA"
    MERGED_NOT_BOOLEAN = "MERGED_NOT_BOOLEAN"
    UNEXPECTED_NUMBER = "UNEXPECTED_NUMBER"


@dataclass(frozen=True)
class MergedPRProof:
    """Result of ``verify_merged_pull_request``.

    Only ``outcome == VERIFIED_MERGED`` may relax the
    integration-base guard.  ``VERIFIED_NOT_MERGED`` means
    the PR exists and is the expected one but has not been
    merged yet.  ``AMBIGUOUS`` means Ralph cannot prove what
    happened — fail closed.
    """

    outcome: MergedPRVerification
    reasons: tuple[MergedPRFailureReason, ...] = ()


def verify_merged_pull_request(
    *,
    probe: DurableStateProbe,
    expected_repository: str,
    expected_base: str,
    expected_head_ref: str,
    expected_head_sha: str,
    expected_pull_request_number: int,
) -> MergedPRProof:
    """Verify that the EXACT expected persisted PR is the one
    GitHub reports as merged.

    Uses the DETAILED PR endpoint
    (``GET /repos/{owner}/{repository}/pulls/{number}``) via
    ``probe.pull_request_detail`` — the LIST endpoint does
    not reliably return the ``merged`` boolean, so it cannot
    be used here.

    Identity is validated independently for:

      - PR number == expected persisted PR number
      - base repository == expected SoundHub repository
      - head repository == expected repository
      - base ref == expected integration branch
      - head ref == expected ticket branch
      - head SHA == expected persisted commit SHA
      - ``merged`` is exactly the literal boolean ``True``
        (NOT ``"true"``, NOT ``"false"``, NOT ``1``, NOT any
        truthy value)

    Outcomes:

      - ``VERIFIED_MERGED`` — every identity field matches
        and ``merged`` is exactly ``True``.  Caller may
        relax the post-merge workspace base guard.

      - ``VERIFIED_NOT_MERGED`` — every identity field
        matches but ``merged`` is exactly ``False``.
        Caller must retain the original base.

      - ``AMBIGUOUS`` — any other outcome (malformed
        response, missing field, wrong identity, unexpected
        PR number, non-boolean ``merged``).  Fail closed.

    Note: this function is a focused identity proof for
    workspace preparation.  ``IntegrationRunner`` still owns
    its own final validation before any GitHub writes; this
    proof supplements but does not replace those checks.
    """
    detail = probe.pull_request_detail(
        pull_request_number=expected_pull_request_number
    )

    if detail is None:
        return MergedPRProof(
            outcome=MergedPRVerification.AMBIGUOUS,
            reasons=(
                MergedPRFailureReason.MALFORMED_RESPONSE,
            ),
        )

    if not isinstance(detail, dict):
        return MergedPRProof(
            outcome=MergedPRVerification.AMBIGUOUS,
            reasons=(
                MergedPRFailureReason.MALFORMED_RESPONSE,
            ),
        )

    try:
        number = int(detail["number"])
        head_sha = str(detail["head"]["sha"])
        head_ref = str(detail["head"]["ref"])
        base_ref = str(detail["base"]["ref"])
        base_repo = str(
            detail["base"]["repo"]["full_name"]
        )
        head_repo = str(
            detail["head"]["repo"]["full_name"]
        )
    except (KeyError, TypeError, ValueError):
        return MergedPRProof(
            outcome=MergedPRVerification.AMBIGUOUS,
            reasons=(MergedPRFailureReason.MISSING_FIELDS,),
        )

    reasons: list[MergedPRFailureReason] = []

    if base_repo != expected_repository:
        reasons.append(
            MergedPRFailureReason.WRONG_REPOSITORY
        )
    if head_repo != expected_repository:
        reasons.append(
            MergedPRFailureReason.WRONG_REPOSITORY
        )
    if base_ref != expected_base:
        reasons.append(MergedPRFailureReason.WRONG_BASE)
    if head_ref != expected_head_ref:
        reasons.append(
            MergedPRFailureReason.WRONG_HEAD_REF
        )
    if head_sha != expected_head_sha:
        reasons.append(
            MergedPRFailureReason.WRONG_HEAD_SHA
        )
    if number != expected_pull_request_number:
        reasons.append(
            MergedPRFailureReason.UNEXPECTED_NUMBER
        )

    if reasons:
        return MergedPRProof(
            outcome=MergedPRVerification.AMBIGUOUS,
            reasons=tuple(reasons),
        )

    # ``merged`` MUST be the literal boolean True.  Truthy
    # values like ``"false"`` (the string), ``"true"`` (the
    # string), or ``1`` (the integer) are NOT accepted.
    merged_raw = detail.get("merged")

    if not isinstance(merged_raw, bool):
        return MergedPRProof(
            outcome=MergedPRVerification.AMBIGUOUS,
            reasons=(
                MergedPRFailureReason.MERGED_NOT_BOOLEAN,
            ),
        )

    if merged_raw is True:
        return MergedPRProof(
            outcome=MergedPRVerification.VERIFIED_MERGED,
        )

    return MergedPRProof(
        outcome=MergedPRVerification.VERIFIED_NOT_MERGED,
    )


def _evaluate_candidate(
    pr,
    *,
    expected_repository: str,
    expected_base: str,
    expected_head_ref: str,
) -> CandidateEvaluation:
    """Classify one PR candidate as either matching or malformed
    with an explicit reason.

    Ralph does NOT silently drop bad candidates: every rejection
    reason is reported via ``PullRequestLookup.malformed_reasons``
    so that downstream code can collapse the outcome to AMBIGUOUS
    whenever there is any unverified candidate in the response.
    """
    reasons = []

    if not isinstance(pr, dict):
        return CandidateEvaluation(
            number=None,
            head_sha=None,
            reasons=(
                PullRequestMalformedReason.CANDIDATE_MALFORMED,
            ),
        )

    try:
        number = int(pr["number"])
    except (KeyError, TypeError, ValueError):
        return CandidateEvaluation(
            number=None,
            head_sha=None,
            reasons=(
                PullRequestMalformedReason.CANDIDATE_MALFORMED,
            ),
        )

    if number <= 0:
        reasons.append(
            PullRequestMalformedReason.CANDIDATE_INVALID_NUMBER
        )

    try:
        base = str(pr["base"]["ref"])
        head_ref = str(pr["head"]["ref"])
        head_sha = str(pr["head"]["sha"])
        base_repo = str(pr["base"]["repo"]["full_name"])
        head_repo = str(pr["head"]["repo"]["full_name"])
    except (KeyError, TypeError, ValueError):
        reasons.append(
            PullRequestMalformedReason.CANDIDATE_MALFORMED
        )
        return CandidateEvaluation(
            number=number,
            head_sha=None,
            reasons=tuple(reasons),
        )

    if not head_sha:
        reasons.append(
            PullRequestMalformedReason.CANDIDATE_MALFORMED
        )

    if base_repo != expected_repository:
        reasons.append(
            PullRequestMalformedReason.CANDIDATE_WRONG_REPOSITORY
        )

    if head_repo != expected_repository:
        reasons.append(
            PullRequestMalformedReason.CANDIDATE_WRONG_REPOSITORY
        )

    if base != expected_base:
        reasons.append(
            PullRequestMalformedReason.CANDIDATE_WRONG_BASE
        )

    if head_ref != expected_head_ref:
        reasons.append(
            PullRequestMalformedReason.CANDIDATE_WRONG_HEAD_REF
        )

    if not head_sha:
        head_sha_value = None
    else:
        head_sha_value = head_sha

    return CandidateEvaluation(
        number=number if not reasons else number,
        head_sha=head_sha_value,
        reasons=tuple(reasons),
    )


def reconcile_persistence(
    *,
    checkpoint: TicketCheckpoint,
    policy: GitPushPolicy,
    probe: DurableStateProbe,
    owner: str,
    repository: str,
) -> RecoveryState:
    """Reconcile durable GitHub state with the in-memory
    checkpoint and return an explicit outcome."""

    expected_branch = policy.ticket_branch(
        checkpoint.issue_number
    )

    expected_repository = f"{owner}/{repository}"

    if checkpoint.ticket_branch != expected_branch:
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    raw_branch = probe.remote_branch_head(
        ticket_branch=expected_branch
    )

    if raw_branch is None:
        # The probe could not answer.  Ralph cannot distinguish
        # absence from a malformed response — fail closed.
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    if raw_branch.malformed_reason is not None:
        # A branch response that Ralph cannot interpret must NOT
        # be treated as "absent".  Fail closed.
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    if raw_branch.absent_reason is not None:
        # Verified absence: GitHub explicitly returned not-found.
        # If the checkpoint believes anything was persisted,
        # that contradicts the verified reality -> AMBIGUOUS.
        if (
            checkpoint.persisted_commit_sha is not None
            or checkpoint.pull_request_number is not None
        ):
            return RecoveryState(
                outcome=RecoveryOutcome.AMBIGUOUS,
                commit_sha=None,
                pull_request_number=None,
            )
        return RecoveryState(
            outcome=RecoveryOutcome.NOTHING_DURABLE,
            commit_sha=None,
            pull_request_number=None,
        )

    remote_head = raw_branch.head_sha

    original_baseline = checkpoint.ticket_sha

    if (
        original_baseline
        and remote_head == original_baseline
    ):
        # Remote branch is at the original pre-implementation
        # baseline. If the checkpoint believes anything was
        # persisted, that contradicts the verified reality.
        if (
            checkpoint.persisted_commit_sha is not None
            or checkpoint.pull_request_number is not None
        ):
            return RecoveryState(
                outcome=RecoveryOutcome.AMBIGUOUS,
                commit_sha=None,
                pull_request_number=None,
            )
        return RecoveryState(
            outcome=RecoveryOutcome.NOTHING_DURABLE,
            commit_sha=None,
            pull_request_number=None,
        )

    # From here: durable implementation exists beyond baseline.

    raw_pr = probe.pull_requests_for_branch(
        ticket_branch=expected_branch,
        integration_branch=(
            checkpoint.integration_branch
        ),
    )

    if raw_pr is None:
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    # If the probe reported any malformed candidate, fail closed.
    # Ralph does NOT silently filter bad PRs.
    if raw_pr.malformed_reasons:
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    matching: list[CandidateEvaluation] = []

    for candidate in raw_pr.candidates:
        if candidate.reasons:
            # Re-evaluated for defense-in-depth.  If a candidate
            # has reasons but the probe didn't surface them above,
            # fail closed.
            return RecoveryState(
                outcome=RecoveryOutcome.AMBIGUOUS,
                commit_sha=None,
                pull_request_number=None,
            )

        if (
            candidate.head_sha is None
            or candidate.number is None
            or candidate.head_sha != remote_head
        ):
            # Head SHA didn't match the verified remote branch.
            return RecoveryState(
                outcome=RecoveryOutcome.AMBIGUOUS,
                commit_sha=None,
                pull_request_number=None,
            )

        matching.append(candidate)

    if len(matching) > 1:
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    if len(matching) == 1:
        # COMMIT_AND_PR.
        pr = matching[0]
        pr_number = pr.number
        pr_head_sha = pr.head_sha

        # Contradiction detection: a partial checkpoint value that
        # disagrees with verified GitHub evidence collapses to
        # AMBIGUOUS.
        if (
            checkpoint.persisted_commit_sha is not None
            and checkpoint.persisted_commit_sha != remote_head
        ):
            return RecoveryState(
                outcome=RecoveryOutcome.AMBIGUOUS,
                commit_sha=None,
                pull_request_number=None,
            )

        if (
            checkpoint.pull_request_number is not None
            and checkpoint.pull_request_number != pr_number
        ):
            return RecoveryState(
                outcome=RecoveryOutcome.AMBIGUOUS,
                commit_sha=None,
                pull_request_number=None,
            )

        sha = (
            checkpoint.persisted_commit_sha
            if checkpoint.persisted_commit_sha is not None
            else remote_head
        )
        number = (
            checkpoint.pull_request_number
            if checkpoint.pull_request_number is not None
            else pr_number
        )

        return RecoveryState(
            outcome=RecoveryOutcome.COMMIT_AND_PR,
            commit_sha=sha,
            pull_request_number=number,
        )

    # No matching PR — branch exists with implementation commit
    # but no PR.  Empty list with no malformed candidates is the
    # only "no PR" signal.
    if checkpoint.pull_request_number is not None:
        # Checkpoint claims a PR exists; GitHub proves otherwise.
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    if (
        checkpoint.persisted_commit_sha is not None
        and checkpoint.persisted_commit_sha != remote_head
    ):
        # Checkpoint claims a different SHA than the verified
        # remote HEAD.  Fail closed rather than guess.
        return RecoveryState(
            outcome=RecoveryOutcome.AMBIGUOUS,
            commit_sha=None,
            pull_request_number=None,
        )

    return RecoveryState(
        outcome=RecoveryOutcome.COMMIT_ONLY,
        commit_sha=remote_head,
        pull_request_number=None,
    )