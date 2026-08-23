import json
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote

from scripts.ralph.git_policy import GitPushPolicy
from scripts.ralph.sandbox import TenkiSandbox
from scripts.ralph.states import TicketState
from scripts.ralph.workspace import TicketWorkspace


class IntegrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class IntegrationResult:
    pull_request_number: int

    head_sha: str
    merge_sha: str

    merge_created: bool
    issue_closed_now: bool


class IntegrationRunner:
    def __init__(
        self,
        *,
        sandbox: TenkiSandbox,
        workspace: TicketWorkspace,
        git_policy: GitPushPolicy,
        github_token: str,
        owner: str,
        repository: str,
    ):
        self.sandbox = sandbox
        self.workspace = workspace
        self.git_policy = git_policy
        self.github_token = github_token
        self.owner = owner
        self.repository = repository

    def integrate(
        self,
        *,
        issue_number: int,
        state: TicketState,
        pull_request_number: int,
        expected_head_sha: str,
    ) -> IntegrationResult:
        # A GitHub PR merge is logically a write to the
        # integration branch, even though GitHub performs
        # the write server-side rather than via `git push`.
        self.git_policy.assert_push_allowed(
            branch=self.workspace.integration_branch,
            state=state,
            issue_number=issue_number,
        )

        pull_request = self._get_pull_request(
            pull_request_number
        )

        self._assert_pull_request_identity(
            pull_request=pull_request,
            pull_request_number=pull_request_number,
            expected_head_sha=expected_head_sha,
        )

        already_merged = bool(
            pull_request.get("merged")
        )

        if already_merged:
            merge_sha = self._merged_sha(
                pull_request
            )

            merge_created = False

        else:
            self._assert_fresh_integration_base()

            merge_sha = self._merge_pull_request(
                pull_request_number=
                    pull_request_number,
                expected_head_sha=
                    expected_head_sha,
            )

            merge_created = True

        self._assert_merge_reachable(
            merge_sha
        )

        issue_closed_now = self._close_issue(
            issue_number
        )

        return IntegrationResult(
            pull_request_number=
                pull_request_number,
            head_sha=
                expected_head_sha,
            merge_sha=
                merge_sha,
            merge_created=
                merge_created,
            issue_closed_now=
                issue_closed_now,
        )

    def _get_pull_request(
        self,
        pull_request_number: int,
    ) -> dict:
        response = self._github_request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/pulls/"
                f"{pull_request_number}"
            ),
        )

        if not isinstance(response, dict):
            raise IntegrationError(
                "GitHub returned invalid "
                "pull-request data."
            )

        return response

    def _assert_pull_request_identity(
        self,
        *,
        pull_request: dict,
        pull_request_number: int,
        expected_head_sha: str,
    ) -> None:
        try:
            actual_number = int(
                pull_request["number"]
            )

            state = str(
                pull_request["state"]
            ).lower()

            merged = bool(
                pull_request["merged"]
            )

            draft = bool(
                pull_request.get(
                    "draft",
                    False,
                )
            )

            base = pull_request["base"]
            head = pull_request["head"]

            base_ref = str(
                base["ref"]
            )

            head_ref = str(
                head["ref"]
            )

            head_sha = str(
                head["sha"]
            )

            base_repository = str(
                base["repo"]["full_name"]
            )

            head_repository = str(
                head["repo"]["full_name"]
            )

        except (
            KeyError,
            TypeError,
            ValueError,
        ) as error:
            raise IntegrationError(
                "GitHub returned malformed "
                "pull-request identity data."
            ) from error

        expected_repository = (
            f"{self.owner}/"
            f"{self.repository}"
        )

        if (
            actual_number
            != pull_request_number
        ):
            raise IntegrationError(
                "Pull-request number mismatch."
            )

        if (
            base_repository
            != expected_repository
        ):
            raise IntegrationError(
                "Pull request targets an "
                "unexpected repository."
            )

        if (
            head_repository
            != expected_repository
        ):
            raise IntegrationError(
                "Pull request originates from an "
                "unexpected repository."
            )

        if (
            base_ref
            != self.workspace.integration_branch
        ):
            raise IntegrationError(
                "Pull request targets the wrong "
                "base branch: "
                f"{base_ref!r}; expected "
                f"{self.workspace.integration_branch!r}."
            )

        if (
            head_ref
            != self.workspace.ticket_branch
        ):
            raise IntegrationError(
                "Pull request originates from the "
                "wrong ticket branch: "
                f"{head_ref!r}; expected "
                f"{self.workspace.ticket_branch!r}."
            )

        if head_sha != expected_head_sha:
            raise IntegrationError(
                "Pull-request head changed after "
                "persistence.\n"
                f"expected: {expected_head_sha}\n"
                f"actual:   {head_sha}"
            )

        if not merged:
            if state != "open":
                raise IntegrationError(
                    "Pull request is closed without "
                    "being merged."
                )

            if draft:
                raise IntegrationError(
                    "Ralph may not integrate a "
                    "draft pull request."
                )

    def _assert_fresh_integration_base(
        self,
    ) -> None:
        remote_base_sha = self._get_ref_sha(
            self.workspace.integration_branch
        )

        if (
            remote_base_sha
            != self.workspace.base_sha
        ):
            raise IntegrationError(
                "Integration branch changed after "
                "this ticket workspace was created.\n"
                f"expected base: "
                f"{self.workspace.base_sha}\n"
                f"current base:  "
                f"{remote_base_sha}\n"
                "Ralph will not merge a stale "
                "ticket automatically."
            )

    def _get_ref_sha(
        self,
        branch: str,
    ) -> str:
        encoded_branch = quote(
            branch,
            safe="",
        )

        response = self._github_request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/git/ref/"
                f"heads/{encoded_branch}"
            ),
        )

        try:
            sha = str(
                response["object"]["sha"]
            )
        except (
            KeyError,
            TypeError,
        ) as error:
            raise IntegrationError(
                "GitHub returned an invalid "
                "branch reference."
            ) from error

        if not sha:
            raise IntegrationError(
                "GitHub returned an empty "
                "branch SHA."
            )

        return sha

    def _merge_pull_request(
        self,
        *,
        pull_request_number: int,
        expected_head_sha: str,
    ) -> str:
        response = self._github_request(
            method="PUT",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/pulls/"
                f"{pull_request_number}/merge"
            ),
            body={
                "sha": expected_head_sha,
                "merge_method": "merge",
            },
        )

        if not isinstance(response, dict):
            raise IntegrationError(
                "GitHub returned invalid "
                "merge data."
            )

        if response.get("merged") is not True:
            raise IntegrationError(
                "GitHub refused to merge the "
                "pull request.\n"
                f"message: "
                f"{response.get('message')}"
            )

        merge_sha = response.get("sha")

        if (
            not isinstance(merge_sha, str)
            or not merge_sha
        ):
            raise IntegrationError(
                "GitHub merged the pull request "
                "without returning a merge SHA."
            )

        return merge_sha

    @staticmethod
    def _merged_sha(
        pull_request: dict,
    ) -> str:
        merge_sha = pull_request.get(
            "merge_commit_sha"
        )

        if (
            not isinstance(merge_sha, str)
            or not merge_sha
        ):
            raise IntegrationError(
                "Merged pull request is missing "
                "its merge commit SHA."
            )

        return merge_sha

    def _assert_merge_reachable(
        self,
        merge_sha: str,
    ) -> None:
        encoded_merge_sha = quote(
            merge_sha,
            safe="",
        )

        encoded_branch = quote(
            self.workspace.integration_branch,
            safe="",
        )

        response = self._github_request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/compare/"
                f"{encoded_merge_sha}..."
                f"{encoded_branch}"
            ),
        )

        if not isinstance(response, dict):
            raise IntegrationError(
                "GitHub returned invalid "
                "merge-verification data."
            )

        status = response.get("status")

        # identical:
        #   integration branch currently points
        #   directly at this merge.
        #
        # ahead:
        #   integration branch has advanced, but
        #   this merge remains an ancestor.
        if status not in {
            "identical",
            "ahead",
        }:
            raise IntegrationError(
                "Merged commit is not safely "
                "contained in the integration "
                "branch.\n"
                f"merge_sha: {merge_sha}\n"
                f"status: {status!r}"
            )

    def _close_issue(
        self,
        issue_number: int,
    ) -> bool:
        issue = self._github_request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/issues/"
                f"{issue_number}"
            ),
        )

        if not isinstance(issue, dict):
            raise IntegrationError(
                "GitHub returned invalid "
                "issue data."
            )

        current_state = str(
            issue.get("state", "")
        ).lower()

        if current_state == "closed":
            return False

        if current_state != "open":
            raise IntegrationError(
                "GitHub issue has an unexpected "
                f"state: {current_state!r}."
            )

        response = self._github_request(
            method="PATCH",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/issues/"
                f"{issue_number}"
            ),
            body={
                "state": "closed",
                "state_reason": "completed",
            },
        )

        if (
            not isinstance(response, dict)
            or str(
                response.get(
                    "state",
                    "",
                )
            ).lower() != "closed"
        ):
            raise IntegrationError(
                "GitHub did not confirm that the "
                "integrated issue was closed."
            )

        return True

    def _github_request(
        self,
        *,
        method: str,
        path: str,
        body: Optional[dict] = None,
    ):
        request_payload = {
            "method": method,
            "path": path,
            "body": body,
        }

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
        "Authorization": (
            "Bearer "
            + os.environ[
                "RALPH_GITHUB_TOKEN"
            ]
        ),
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
        print(
            json.dumps(
                json.load(response)
            )
        )

except urllib.error.HTTPError as error:
    response_body = error.read().decode(
        "utf-8",
        errors="replace",
    )

    print(
        (
            f"GitHub HTTP "
            f"{error.code}: "
            f"{response_body}"
        ),
        file=sys.stderr,
    )

    raise
"""

        result = self.sandbox.exec(
            "python3",
            "-c",
            script,
            env={
                "RALPH_GITHUB_TOKEN":
                    self.github_token,
            },
            input=json.dumps(
                request_payload
            ),
            timeout=90,
        )

        if result.exit_code != 0:
            raise IntegrationError(
                "GitHub integration request "
                "failed.\n"
                f"exit_code: "
                f"{result.exit_code}\n"
                f"stdout:\n"
                f"{result.stdout}\n"
                f"stderr:\n"
                f"{result.stderr}"
            )

        try:
            return json.loads(
                result.stdout
            )

        except json.JSONDecodeError as error:
            raise IntegrationError(
                "GitHub integration request "
                "returned invalid JSON."
            ) from error