"""Read-only GitHub probe for restart reconciliation.

Uses an installation token via ``urllib`` inside the Tenki sandbox
the same way ``cleanup.py`` does. Reads only — never writes.

Boundary contract:

  - ``remote_branch_head`` returns a ``BranchLookup`` that
    distinguishes FOUND / ABSENT / MALFORMED.  ``None`` is reserved
    for "the probe itself could not answer" (transport / sandbox
    errors).  ``_request`` raises on HTTP failure so transport
    errors propagate; ``None`` here means the request returned a
    payload the probe could not interpret as JSON.

  - ``pull_requests_for_branch`` returns a ``PullRequestLookup``
    distinguishing FOUND / ABSENT / MALFORMED.  A well-formed
    empty list means "no PR exists"; ``None`` means malformed
    JSON.  PR candidates that are individually malformed or have
    the wrong identity (repository, base, head ref, head SHA,
    invalid number) are surfaced via ``malformed_reasons`` — the
    recovery layer uses that to AMBIGUOUS-collapse rather than
    silently drop bad candidates.

Verified HTTP 404 vs. malformed boundary:

  ``_request`` uses a private ``_VerifiedNotFound`` sentinel to
  represent a verified HTTP 404 received with
  ``allow_not_found=True``.  This sentinel is intentionally
  distinct from ``None`` (malformed / unparseable body) and from
  any well-formed JSON value (FOUND).  Callers MUST map the
  sentinel to an ABSENT classification and ``None`` (or any
  malformed indicator) to a MALFORMED classification.  The
  recovery layer depends on this distinction to choose
  NOTHING_DURABLE vs AMBIGUOUS.
"""


class _VerifiedNotFound:
    """Private sentinel returned by ``_request`` for a verified
    HTTP 404 received with ``allow_not_found=True``.

    This sentinel is the only signal that distinguishes a real
    GitHub 404 from a malformed/null response body.  It is
    deliberately not equal to any other object the probe could
    return.  Callers MUST handle it explicitly.
    """

    __slots__ = ()

    def __repr__(self) -> str:
        return "_VerifiedNotFound()"


_VERIFIED_NOT_FOUND = _VerifiedNotFound()


import json
from typing import Optional
from urllib.parse import quote

from scripts.ralph.recovery import (
    BranchAbsentReason,
    BranchLookup,
    BranchMalformedReason,
    CandidateEvaluation,
    PullRequestAbsentReason,
    PullRequestLookup,
    PullRequestMalformedReason,
    _evaluate_candidate,
)
from scripts.ralph.sandbox import TenkiSandbox


class GitHubReadOnlyProbe:
    def __init__(
        self,
        *,
        sandbox: TenkiSandbox,
        github_token: str,
        owner: str,
        repository: str,
    ):
        self.sandbox = sandbox
        self.github_token = github_token
        self.owner = owner
        self.repository = repository

    def remote_branch_head(
        self, *, ticket_branch: str
    ) -> Optional[BranchLookup]:
        encoded = quote(ticket_branch, safe="")
        response = self._request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/git/ref/heads/"
                f"{encoded}"
            ),
            allow_not_found=True,
        )

        # A verified HTTP 404 with ``allow_not_found=True`` is
        # the canonical "branch does not exist" signal from
        # GitHub and MUST be reported as ABSENT, not as
        # malformed.  Transport errors raise via ``_request``;
        # ``None`` here means the response body was not
        # parseable JSON, which Ralph classifies as malformed.
        if isinstance(response, _VerifiedNotFound):
            return BranchLookup(
                absent_reason=(
                    BranchAbsentReason.NOT_FOUND
                ),
            )

        if response is None:
            return BranchLookup(
                malformed_reason=(
                    BranchMalformedReason.MALFORMED_RESPONSE
                ),
            )

        if not isinstance(response, dict):
            return BranchLookup(
                malformed_reason=(
                    BranchMalformedReason.WRONG_TYPE
                ),
            )

        try:
            sha = response["object"]["sha"]
        except (KeyError, TypeError):
            return BranchLookup(
                malformed_reason=(
                    BranchMalformedReason.MISSING_OBJECT
                ),
            )

        if not isinstance(sha, str) or not sha:
            return BranchLookup(
                malformed_reason=(
                    BranchMalformedReason.EMPTY_SHA
                ),
            )

        return BranchLookup(head_sha=sha)

    def pull_requests_for_branch(
        self,
        *,
        ticket_branch: str,
        integration_branch: str,
    ) -> Optional[PullRequestLookup]:
        encoded_owner = quote(self.owner, safe="")
        encoded_head = quote(ticket_branch, safe="")
        encoded_base = quote(
            integration_branch,
            safe="",
        )

        response = self._request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/pulls"
                f"?state=all"
                f"&head={encoded_owner}%3A{encoded_head}"
                f"&base={encoded_base}"
            ),
        )

        if response is None:
            return PullRequestLookup(
                candidates=(),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.NOT_A_LIST,
                ),
            )

        if not isinstance(response, list):
            return PullRequestLookup(
                candidates=(),
                absent_reason=None,
                malformed_reasons=(
                    PullRequestMalformedReason.NOT_A_LIST,
                ),
            )

        expected_repository = (
            f"{self.owner}/{self.repository}"
        )

        # Preserve the original GitHub payload so the
        # ``pull_request_for_branch`` legacy accessor can
        # forward identity fields (including ``merged``) to
        # callers that need full identity proof.
        self._raw_candidates = list(response)

        evaluated = [
            _evaluate_candidate(
                pr,
                expected_repository=expected_repository,
                expected_base=integration_branch,
                expected_head_ref=ticket_branch,
            )
            for pr in response
        ]

        malformed_reasons: list[
            PullRequestMalformedReason
        ] = []

        for ev in evaluated:
            for reason in ev.reasons:
                malformed_reasons.append(reason)

        return PullRequestLookup(
            candidates=tuple(evaluated),
            absent_reason=(
                PullRequestAbsentReason.EMPTY_LIST
                if not evaluated
                else None
            ),
            malformed_reasons=tuple(
                dict.fromkeys(
                    malformed_reasons
                )
            ),
        )

    def pull_request_for_branch(
        self,
        *,
        ticket_branch: str,
        integration_branch: str,
    ) -> Optional[dict]:
        """Convenience accessor — returns the first well-formed
        PR candidate for back-compat callers.  Does NOT classify
        absence vs malformed vs multi-PR ambiguity; callers needing
        AMBIGUOUS semantics MUST use ``pull_requests_for_branch``
        directly.

        The returned dict includes the same identity fields
        GitHub emits on its ``/pulls`` endpoint (number,
        head.ref, head.sha, head.repo.full_name, base.ref,
        base.repo.full_name, ``merged``) so callers performing
        identity proof can validate every required field.
        """
        lookup = self.pull_requests_for_branch(
            ticket_branch=ticket_branch,
            integration_branch=integration_branch,
        )

        if lookup is None:
            return None

        # ``_raw_candidates`` preserves the original GitHub
        # payload so we can return it verbatim.  If absent
        # (older fixture or non-real probe), fall back to a
        # minimal dict.
        for index, candidate in enumerate(
            lookup.candidates
        ):
            if (
                candidate.reasons
                or candidate.number is None
                or candidate.head_sha is None
            ):
                continue

            if hasattr(self, "_raw_candidates"):
                raw = self._raw_candidates[index]
                if isinstance(raw, dict):
                    return raw

            return {
                "number": candidate.number,
                "head": {
                    "sha": candidate.head_sha,
                },
                "merged": None,
            }

        return None

    def pull_request_detail(
        self, *, pull_request_number: int
    ) -> Optional[dict]:
        """Fetch the detailed PR record via
        ``GET /repos/{owner}/{repository}/pulls/{pull_request_number}``.

        This is the canonical source of the ``merged`` boolean
        (the LIST endpoint does not return it reliably).  Returns
        the raw GitHub dict, or ``None`` if the response was
        malformed (not a JSON object) or the request could not
        be completed.

        Callers performing strict identity proof MUST use this
        endpoint rather than the LIST representation.
        """
        raw = self._request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/pulls/"
                f"{pull_request_number}"
            ),
        )

        if raw is None:
            return None

        if not isinstance(raw, dict):
            return None

        return raw

    def pull_request_merged(
        self, *, pull_request_number: int
    ) -> Optional[bool]:
        """Return True if the PR has been merged, False if it has
        not, None if the response was malformed."""
        response = self._request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/pulls/"
                f"{pull_request_number}"
            ),
        )

        if response is None:
            return None

        if not isinstance(response, dict):
            return None

        return bool(response.get("merged"))

    def _request(
        self,
        *,
        method: str,
        path: str,
        allow_not_found: bool = False,
    ):
        request_payload = {
            "method": method,
            "path": path,
        }

        if allow_not_found:
            request_payload["allow_not_found"] = True

        script = r"""
import json
import os
import sys
import urllib.error
import urllib.request

request_data = json.load(sys.stdin)

method = request_data["method"]
path = request_data["path"]

request = urllib.request.Request(
    "https://api.github.com" + path,
    method=method,
    headers={
        "Accept":
            "application/vnd.github+json",
        "Authorization":
            "Bearer "
            + os.environ[
                "RALPH_GITHUB_TOKEN"
            ],
        "X-GitHub-Api-Version":
            "2022-11-28",
        "Content-Type":
            "application/json",
    },
)

try:
    with urllib.request.urlopen(
        request,
        timeout=60,
    ) as response:
        raw = response.read()
        if not raw:
            sys.stdout.write("")
            sys.exit(0)
        sys.stdout.write(
            json.dumps(
                json.loads(
                    raw.decode(
                        "utf-8",
                        errors="replace",
                    )
                )
            )
        )
except urllib.error.HTTPError as error:
    body = error.read().decode(
        "utf-8",
        errors="replace",
    )

    if (
        error.code == 404
        and "allow_not_found" in request_data
    ):
        sys.stdout.write("__RALPH_VERIFIED_NOT_FOUND__")
        sys.exit(0)

    sys.stderr.write(
        f"GitHub HTTP {error.code}: {body}"
    )
    raise
"""

        result = self.sandbox.exec(
            "python3",
            "-c",
            script,
            input=json.dumps(request_payload),
            env={"RALPH_GITHUB_TOKEN": self.github_token},
            timeout=90,
        )

        if result.exit_code != 0:
            raise RuntimeError(
                "GitHub read-only probe failed.\n"
                f"exit_code: {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        raw = result.stdout.strip()

        # A verified HTTP 404 (allow_not_found=True) is reported
        # by the subprocess with the literal sentinel string
        # ``__RALPH_VERIFIED_NOT_FOUND__``.  This MUST NOT be
        # conflated with empty stdout, the JSON ``null`` literal,
        # or unparseable JSON — those are all malformed bodies
        # and Ralph must fail closed on them.
        if raw == "__RALPH_VERIFIED_NOT_FOUND__":
            return _VERIFIED_NOT_FOUND

        if not raw or raw == "null":
            return None

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None