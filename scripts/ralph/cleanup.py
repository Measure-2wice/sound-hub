"""Idempotent remote ticket-branch cleanup.

The disposable Tenki sandbox teardown naturally removes its local clone,
worktree, and local ticket branch. This module owns the remote side:

- verify the requested branch is the exact expected Ralph ticket branch
- verify its SHA matches the persisted implementation SHA
- never delete protected branches (integration, main)
- missing branch on restart means cleanup already succeeded
- unexpected branch SHA must fail closed

Authorization rules:

- The cleanup branch MUST equal ``expected_branch``. We do NOT accept
  merely "any branch that is not protected" — an unrelated non-protected
  branch with a matching SHA would otherwise be silently destroyed.
- Protected branches (``main``, integration branch) are rejected before
  any GitHub call is made.
- A successful 204 No Content or otherwise empty successful response is
  treated as a valid None result and does NOT raise.
"""

import json
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote

from scripts.ralph.sandbox import TenkiSandbox


class RemoteBranchCleanupError(RuntimeError):
    """A remote Ralph ticket branch could not be safely cleaned up."""


@dataclass(frozen=True)
class RemoteBranchCleanupResult:
    branch: str
    deleted: bool
    already_absent: bool


class RemoteBranchCleaner:
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

    def cleanup_ticket_branch(
        self,
        *,
        ticket_branch: str,
        expected_branch: str,
        expected_head_sha: str,
        protected_branches: tuple[str, ...] = ("main",),
    ) -> RemoteBranchCleanupResult:
        if ticket_branch in protected_branches:
            raise RemoteBranchCleanupError(
                f"Ralph will never delete protected branch "
                f"`{ticket_branch}`."
            )

        if ticket_branch != expected_branch:
            raise RemoteBranchCleanupError(
                "Refusing to delete remote branch "
                f"`{ticket_branch}`: only the exact ticket "
                f"branch `{expected_branch}` may be cleaned up "
                "by Ralph."
            )

        if not expected_head_sha:
            raise RemoteBranchCleanupError(
                "Refusing to delete remote ticket branch "
                f"`{ticket_branch}`: no persisted commit SHA "
                "is recorded to verify the branch against."
            )

        ref = self._get_branch_ref(ticket_branch)

        if ref is None:
            return RemoteBranchCleanupResult(
                branch=ticket_branch,
                deleted=False,
                already_absent=True,
            )

        actual_sha = ref.get("object", {}).get("sha")

        if not actual_sha:
            raise RemoteBranchCleanupError(
                "GitHub returned an empty branch SHA for "
                f"`{ticket_branch}`."
            )

        if actual_sha != expected_head_sha:
            raise RemoteBranchCleanupError(
                "Refusing to delete remote ticket branch "
                f"`{ticket_branch}`: SHA {actual_sha!r} does "
                f"not match persisted commit {expected_head_sha!r}."
            )

        self._delete_branch_ref(ticket_branch)

        return RemoteBranchCleanupResult(
            branch=ticket_branch,
            deleted=True,
            already_absent=False,
        )

    def _get_branch_ref(
        self,
        branch: str,
    ) -> Optional[dict]:
        encoded = quote(branch, safe="")
        response = self._github_request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/git/ref/heads/"
                f"{encoded}"
            ),
            allow_not_found=True,
        )

        if response is None:
            return None

        if not isinstance(response, dict):
            raise RemoteBranchCleanupError(
                "GitHub returned invalid branch-reference "
                "data."
            )

        return response

    def _delete_branch_ref(self, branch: str) -> None:
        encoded = quote(branch, safe="")
        # ``treat_empty_as_none=True`` makes a successful 204 (or any
        # other successful response with no body) a valid None result
        # instead of a JSON-decode error.
        self._github_request(
            method="DELETE",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/git/refs/heads/"
                f"{encoded}"
            ),
            treat_empty_as_none=True,
        )

    def _github_request(
        self,
        *,
        method: str,
        path: str,
        body: Optional[dict] = None,
        allow_not_found: bool = False,
        treat_empty_as_none: bool = False,
    ):
        request_payload = {
            "method": method,
            "path": path,
            "body": body,
        }

        if allow_not_found:
            request_payload["allow_not_found"] = True

        if treat_empty_as_none:
            request_payload["treat_empty_as_none"] = True

        script = r"""
import json
import os
import sys
import urllib.error
import urllib.request

request_data = json.load(sys.stdin)

method = request_data["method"]
path = request_data["path"]
body = request_data.get("body")
treat_empty_as_none = bool(
    request_data.get("treat_empty_as_none")
)

data = None

if body is not None:
    data = json.dumps(
        body
    ).encode("utf-8")

request = urllib.request.Request(
    "https://api.github.com" + path,
    data=data,
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
        try:
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
        except (ValueError, json.JSONDecodeError):
            if treat_empty_as_none:
                sys.stdout.write("")
                sys.exit(0)
            sys.stdout.write(raw.decode("utf-8", errors="replace"))
except urllib.error.HTTPError as error:
    body = error.read().decode(
        "utf-8",
        errors="replace",
    )

    if (
        error.code == 404
        and "allow_not_found" in request_data
    ):
        sys.stdout.write("null")
        sys.exit(0)

    sys.stderr.write(
        (
            f"GitHub HTTP "
            f"{error.code}: "
            f"{body}"
        )
    )

    raise
"""

        kwargs = {
            "input": json.dumps(request_payload),
            "env": {"RALPH_GITHUB_TOKEN": self.github_token},
            "timeout": 90,
        }

        result = self.sandbox.exec(
            "python3",
            "-c",
            script,
            **kwargs,
        )

        if result.exit_code != 0:
            raise RemoteBranchCleanupError(
                "GitHub cleanup request failed.\n"
                f"exit_code: {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        if not result.stdout.strip():
            return None

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RemoteBranchCleanupError(
                "GitHub cleanup request returned "
                "invalid JSON."
            ) from error
