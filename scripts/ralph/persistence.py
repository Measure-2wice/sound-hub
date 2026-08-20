import json
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote

from scripts.ralph.git_policy import GitPushPolicy
from scripts.ralph.sandbox import TenkiSandbox
from scripts.ralph.states import TicketState
from scripts.ralph.workspace import TicketWorkspace


class PersistenceError(RuntimeError):
    pass


@dataclass(frozen=True)
class PersistenceResult:
    commit_sha: str
    remote_sha: str

    pull_request_number: int
    pull_request_url: str
    pull_request_created: bool


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