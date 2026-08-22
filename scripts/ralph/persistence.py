import json
from dataclasses import dataclass
from enum import Enum
from typing import Optional
from urllib.parse import quote

from scripts.ralph.git_policy import GitPushPolicy
from scripts.ralph.sandbox import TenkiSandbox
from scripts.ralph.states import TicketState
from scripts.ralph.workspace import TicketWorkspace


class PersistenceError(RuntimeError):
    pass


class PersistenceRecoveryDisposition(str, Enum):
    """Explicit three-valued result of the conductor's
    persistence-recovery step.  Replaces an ambiguous boolean.

      NOT_APPLICABLE:
        No recovered persistence requires continuation.  The
        caller may proceed through normal persistence logic.

      READY_TO_INTEGRATE:
        Recovery and/or the COMMIT_ONLY continuation succeeded.
        Verified persisted commit + PR are checkpointed.  The
        caller may transition to INTEGRATING.

      TERMINAL:
        Recovery or the COMMIT_ONLY continuation detected an
        unsafe/ambiguous condition.  A terminal
        ``BLOCKED_FOR_HUMAN`` checkpoint has already been saved
        by the recovery path.  The caller MUST return
        immediately — no persistence retry, no INTEGRATING
        transition, no IntegrationRunner invocation.
    """

    NOT_APPLICABLE = "NOT_APPLICABLE"
    READY_TO_INTEGRATE = "READY_TO_INTEGRATE"
    TERMINAL = "TERMINAL"


@dataclass(frozen=True)
class PersistenceResult:
    commit_sha: str
    remote_sha: str

    pull_request_number: int
    pull_request_url: str
    pull_request_created: bool


@dataclass(frozen=True)
class CommitOnlyContinuationResult:
    """Outcome of ``ensure_pull_request_for_persisted_commit``.

    Either an existing exact PR was recovered or a new PR was
    created.  ``pull_request_created=False`` means Ralph did NOT
    push, force-push, or create any new commits.
    """

    pull_request_number: int
    pull_request_url: str
    pull_request_created: bool
    commit_sha: str
    remote_sha: str


class PersistenceRunner:
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

    def persist(
        self,
        *,
        issue_number: int,
        state: TicketState,
        commit_message: str,
        pull_request_title: str,
        pull_request_body: str,
    ) -> PersistenceResult:
        self.git_policy.assert_push_allowed(
            branch=self.workspace.ticket_branch,
            state=state,
            issue_number=issue_number,
        )

        self._assert_ticket_branch()

        commit_sha = self._commit_or_resume(
            commit_message=commit_message,
        )

        remote_sha = self._push_ticket_branch(
            issue_number=issue_number,
            state=state,
        )

        if remote_sha != commit_sha:
            raise PersistenceError(
                "Remote ticket branch does not match "
                "the persisted commit.\n"
                f"local:  {commit_sha}\n"
                f"remote: {remote_sha}"
            )

        (
            pull_request_number,
            pull_request_url,
            pull_request_created,
        ) = self._create_or_recover_pull_request(
            title=pull_request_title,
            body=pull_request_body,
        )

        return PersistenceResult(
            commit_sha=commit_sha,
            remote_sha=remote_sha,
            pull_request_number=pull_request_number,
            pull_request_url=pull_request_url,
            pull_request_created=pull_request_created,
        )

    def ensure_pull_request_for_persisted_commit(
        self,
        *,
        issue_number: int,
        recovered_sha: str,
        original_ticket_sha: Optional[str],
        pull_request_title: str,
        pull_request_body: str,
    ) -> CommitOnlyContinuationResult:
        """Recover an already-durable commit by creating only the
        missing pull request.

        This is the COMMIT_ONLY restart path:

          1. ``recovered_sha`` is the durable SHA the conductor
             received from ``reconcile_persistence``.  The
             runner treats it as the AUTHORITATIVE identity for
             the durable commit and requires it to equal the
             local HEAD and the remote ticket branch HEAD.

             The runner does NOT derive the durable commit
             identity from ``workspace.ticket_sha`` — that
             value may reflect the HEAD of a resumed remote
             branch and is not the authoritative recovery
             identity.

          2. verify ``recovered_sha != original_ticket_sha``
             (i.e., it is not the pre-implementation baseline)

          3. verify the current local branch is the expected
             Ralph ticket branch

          4. read local HEAD independently and require
             ``local_head == recovered_sha``

          5. read remote ticket branch HEAD independently and
             require ``remote_sha == recovered_sha``

          6. require ``local_head == remote_sha`` (proves the
             local workspace and the remote durable state
             agree)

          7. perform NO new git commit

          8. perform NO SHA-changing push

          9. perform NO force push

         10. find an existing exact PR if one appeared meanwhile
             (a race between recovery and continuation)

         11. otherwise create exactly one PR from the expected
             ticket branch into the expected integration branch

         12. return the SHA that was actually verified (NOT the
             input — the input was checked but the result
             contains the SHA the runner independently
             confirmed via local + remote reads).  The
             conductor MUST checkpoint the SHA from the result,
             never from the unverified input.

        Failure cases — all fail closed before any PR operation:

          - ``recovered_sha`` is empty or otherwise invalid
          - ``recovered_sha == original_ticket_sha``
          - local HEAD cannot be read
          - local HEAD != ``recovered_sha``
          - remote HEAD cannot be read
          - remote HEAD != ``recovered_sha``
          - local HEAD != remote HEAD
        """
        self._assert_ticket_branch()

        expected_branch = self.git_policy.ticket_branch(
            issue_number
        )

        if self.workspace.ticket_branch != expected_branch:
            raise PersistenceError(
                "Workspace ticket branch does not match "
                "expected Ralph ticket branch: "
                f"{self.workspace.ticket_branch!r} vs "
                f"{expected_branch!r}."
            )

        # Validate the recovered SHA parameter itself before
        # any local/remote verification.
        if not recovered_sha or not isinstance(
            recovered_sha, str
        ):
            raise PersistenceError(
                "Recovered persisted commit SHA must be a "
                "non-empty string."
            )

        if (
            original_ticket_sha
            and recovered_sha == original_ticket_sha
        ):
            raise PersistenceError(
                "Recovered persisted commit SHA matches "
                "the original pre-implementation baseline; "
                "no durable commit exists beyond baseline."
            )

        # Independent local verification: do NOT trust
        # workspace.ticket_sha.  Read HEAD afresh from git.
        local_head = self._local_head_sha()

        if local_head != recovered_sha:
            raise PersistenceError(
                "Local ticket branch HEAD does not match "
                "the recovered persisted commit SHA.\n"
                f"local:   {local_head}\n"
                f"recovered: {recovered_sha}"
            )

        # Independent remote verification: a read-only
        # ``git ls-remote`` against origin.  No push, no
        # commit, no force.
        remote_sha = self._read_remote_ticket_head(
            ticket_branch=self.workspace.ticket_branch,
        )

        if remote_sha != recovered_sha:
            raise PersistenceError(
                "Remote ticket branch HEAD does not match "
                "the recovered persisted commit SHA.\n"
                f"remote:  {remote_sha}\n"
                f"recovered: {recovered_sha}"
            )

        # Final invariant: local and remote agree on the
        # authoritative recovered SHA.
        if local_head != remote_sha:
            raise PersistenceError(
                "Local and remote ticket branch HEADs disagree.\n"
                f"local:   {local_head}\n"
                f"remote:  {remote_sha}"
            )

        # Find an existing exact PR or create exactly one.
        # Never modify the git history.
        (
            pull_request_number,
            pull_request_url,
            pull_request_created,
        ) = self._create_or_recover_pull_request(
            title=pull_request_title,
            body=pull_request_body,
        )

        # Return the SHA the runner ACTUALLY verified (local
        # HEAD, which equals remote HEAD, which equals the
        # input recovered_sha).  The conductor MUST checkpoint
        # this returned SHA — never the unverified input.
        return CommitOnlyContinuationResult(
            pull_request_number=pull_request_number,
            pull_request_url=pull_request_url,
            pull_request_created=pull_request_created,
            commit_sha=remote_sha,
            remote_sha=remote_sha,
        )

    def _assert_ticket_branch(self) -> None:
        result = self.sandbox.exec(
            "git",
            "-C",
            self.workspace.repository_path,
            "branch",
            "--show-current",
        )

        if result.exit_code != 0:
            raise PersistenceError(
                "Unable to inspect current Git branch.\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        branch = result.stdout.strip()

        if branch != self.workspace.ticket_branch:
            raise PersistenceError(
                "Persistence workspace is on the wrong branch: "
                f"{branch!r}; expected "
                f"{self.workspace.ticket_branch!r}."
            )

    def _local_head_sha(self) -> str:
        result = self.sandbox.exec(
            "git",
            "-C",
            self.workspace.repository_path,
            "rev-parse",
            "HEAD",
        )

        if result.exit_code != 0:
            raise PersistenceError(
                "Unable to read local Git HEAD.\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        head = result.stdout.strip()

        if not head:
            raise PersistenceError(
                "Local Git HEAD was empty."
            )

        return head

    def _read_remote_ticket_head(
        self,
        *,
        ticket_branch: str,
    ) -> str:
        """Read-only verification of the remote ticket branch HEAD.

        This performs NO push, NO commit, NO force operation.  It
        is a plain ``git ls-remote`` against origin.  Used by the
        COMMIT_ONLY restart path to confirm a recoverable SHA is
        still present on the remote.
        """
        result = self.sandbox.exec(
            "bash",
            "-lc",
            r"""
set -euo pipefail

cat > /tmp/ralph-git-askpass <<'EOF'
#!/bin/sh

case "$1" in
    *Username*)
        printf '%s\n' "$RALPH_GIT_USERNAME"
        ;;
    *Password*)
        printf '%s\n' "$RALPH_GITHUB_TOKEN"
        ;;
    *)
        exit 1
        ;;
esac
EOF

chmod 700 /tmp/ralph-git-askpass

cleanup() {
    rm -f /tmp/ralph-git-askpass
}

trap cleanup EXIT

remote_sha="$(
    git ls-remote \
      origin \
      "refs/heads/$RALPH_TICKET_BRANCH" \
    | awk '{print $1}'
)"

test -n "$remote_sha"

echo "RALPH_REMOTE_SHA=$remote_sha"
""",
            env={
                "RALPH_TICKET_BRANCH":
                    ticket_branch,
                "RALPH_GIT_USERNAME":
                    "x-access-token",
                "RALPH_GITHUB_TOKEN":
                    self.github_token,
                "GIT_ASKPASS":
                    "/tmp/ralph-git-askpass",
                "GIT_TERMINAL_PROMPT":
                    "0",
            },
            timeout=120,
        )

        if result.exit_code != 0:
            raise PersistenceError(
                "Unable to read remote ticket branch HEAD.\n"
                f"exit_code: {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        return self._extract_marker(
            result.stdout,
            "RALPH_REMOTE_SHA",
        )

    def _commit_or_resume(
        self,
        *,
        commit_message: str,
    ) -> str:
        result = self.sandbox.exec(
            "bash",
            "-lc",
            r"""
set -euo pipefail

cd "$RALPH_REPOSITORY_PATH"

git config user.name "SoundHub Ralph App"
git config user.email "ralph@users.noreply.github.com"

git add -A

if git diff --cached --quiet
then
    head_sha="$(git rev-parse HEAD)"

    if [ "$head_sha" = "$RALPH_TICKET_SHA" ]; then
        echo \
          "No implementation changes are available to persist." \
          >&2
        exit 44
    fi

    echo "RALPH_COMMIT_MODE=RESUMED"
else
    git diff --cached --check

    git commit \
      -m "$RALPH_COMMIT_MESSAGE"

    head_sha="$(git rev-parse HEAD)"

    echo "RALPH_COMMIT_MODE=CREATED"
fi

echo "RALPH_COMMIT_SHA=$head_sha"
""",
            env={
                "RALPH_REPOSITORY_PATH":
                    self.workspace.repository_path,
                "RALPH_TICKET_SHA":
                    self.workspace.ticket_sha,
                "RALPH_COMMIT_MESSAGE":
                    commit_message,
            },
        )

        if result.exit_code != 0:
            raise PersistenceError(
                "Unable to persist implementation commit.\n"
                f"exit_code: {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        return self._extract_marker(
            result.stdout,
            "RALPH_COMMIT_SHA",
        )

    def _push_ticket_branch(
        self,
        *,
        issue_number: int,
        state: TicketState,
    ) -> str:
        self.git_policy.assert_push_allowed(
            branch=self.workspace.ticket_branch,
            state=state,
            issue_number=issue_number,
        )

        result = self.sandbox.exec(
            "bash",
            "-lc",
            r"""
set -euo pipefail

cd "$RALPH_REPOSITORY_PATH"

cat > /tmp/ralph-git-askpass <<'EOF'
#!/bin/sh

case "$1" in
    *Username*)
        printf '%s\n' "$RALPH_GIT_USERNAME"
        ;;
    *Password*)
        printf '%s\n' "$RALPH_GITHUB_TOKEN"
        ;;
    *)
        exit 1
        ;;
esac
EOF

chmod 700 /tmp/ralph-git-askpass

cleanup() {
    rm -f /tmp/ralph-git-askpass
}

trap cleanup EXIT

git push \
  --set-upstream \
  origin \
  "$RALPH_TICKET_BRANCH"

remote_sha="$(
    git ls-remote \
      origin \
      "refs/heads/$RALPH_TICKET_BRANCH" \
    | awk '{print $1}'
)"

test -n "$remote_sha"

echo "RALPH_REMOTE_SHA=$remote_sha"
""",
            env={
                "RALPH_REPOSITORY_PATH":
                    self.workspace.repository_path,
                "RALPH_TICKET_BRANCH":
                    self.workspace.ticket_branch,
                "RALPH_GIT_USERNAME":
                    "x-access-token",
                "RALPH_GITHUB_TOKEN":
                    self.github_token,
                "GIT_ASKPASS":
                    "/tmp/ralph-git-askpass",
                "GIT_TERMINAL_PROMPT":
                    "0",
            },
            timeout=300,
        )

        if result.exit_code != 0:
            raise PersistenceError(
                "Unable to push Ralph ticket branch.\n"
                f"exit_code: {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        return self._extract_marker(
            result.stdout,
            "RALPH_REMOTE_SHA",
        )

    def _create_or_recover_pull_request(
        self,
        *,
        title: str,
        body: str,
    ) -> tuple[int, str, bool]:
        existing = self._find_existing_pull_request()

        if existing is not None:
            return (
                int(existing["number"]),
                str(existing["html_url"]),
                False,
            )

        payload = {
            "title": title,
            "head": self.workspace.ticket_branch,
            "base": self.workspace.integration_branch,
            "body": body,
        }

        response = self._github_request(
            method="POST",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/pulls"
            ),
            body=payload,
        )

        try:
            number = int(response["number"])
            url = str(response["html_url"])
        except (
            KeyError,
            TypeError,
            ValueError,
        ) as error:
            raise PersistenceError(
                "GitHub returned an invalid pull request."
            ) from error

        return number, url, True

    def _find_existing_pull_request(
        self,
    ) -> Optional[dict]:
        owner = quote(
            self.owner,
            safe="",
        )

        branch = quote(
            self.workspace.ticket_branch,
            safe="",
        )

        base = quote(
            self.workspace.integration_branch,
            safe="",
        )

        response = self._github_request(
            method="GET",
            path=(
                f"/repos/{self.owner}/"
                f"{self.repository}/pulls"
                f"?state=open"
                f"&head={owner}%3A{branch}"
                f"&base={base}"
            ),
        )

        if not isinstance(response, list):
            raise PersistenceError(
                "GitHub returned invalid pull-request search data."
            )

        if not response:
            return None

        first = response[0]

        if not isinstance(first, dict):
            raise PersistenceError(
                "GitHub returned malformed pull-request data."
            )

        return first

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
    data = json.dumps(body).encode("utf-8")

request = urllib.request.Request(
    "https://api.github.com" + path,
    data=data,
    method=method,
    headers={
        "Accept": "application/vnd.github+json",
        "Authorization": (
            "Bearer " + os.environ["RALPH_GITHUB_TOKEN"]
        ),
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
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
    body = error.read().decode(
        "utf-8",
        errors="replace",
    )

    print(
        f"GitHub HTTP {error.code}: {body}",
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
            raise PersistenceError(
                "GitHub persistence request failed.\n"
                f"exit_code: {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        try:
            return json.loads(
                result.stdout
            )
        except json.JSONDecodeError as error:
            raise PersistenceError(
                "GitHub persistence request returned "
                "invalid JSON."
            ) from error

    @staticmethod
    def _extract_marker(
        output: str,
        key: str,
    ) -> str:
        prefix = f"{key}="

        for line in output.splitlines():
            if line.startswith(prefix):
                return line[len(prefix):].strip()

        raise PersistenceError(
            f"Missing {key} in persistence output."
        )