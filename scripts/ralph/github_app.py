import json
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import jwt


class GitHubAppError(RuntimeError):
    """GitHub App authentication or token creation failed."""


@dataclass(frozen=True)
class InstallationToken:
    token: str = field(repr=False)
    expires_at: str


class GitHubAppAuthenticator:
    def __init__(
        self,
        *,
        app_id: str,
        private_key_path: str,
    ):
        self.app_id = app_id
        self.private_key_path = Path(private_key_path)

    def mint_repository_token(
        self,
        *,
        owner: str,
        repository: str,
    ) -> InstallationToken:
        app_jwt = self._create_app_jwt()

        installation = self._request_json(
            method="GET",
            url=(
                "https://api.github.com/repos/"
                f"{owner}/{repository}/installation"
            ),
            bearer_token=app_jwt,
        )

        installation_id = installation.get("id")
        if not installation_id:
            raise GitHubAppError(
                f"No GitHub App installation found for "
                f"{owner}/{repository}."
            )

        response = self._request_json(
            method="POST",
            url=(
                "https://api.github.com/app/installations/"
                f"{installation_id}/access_tokens"
            ),
            bearer_token=app_jwt,
            body={
                "repositories": [repository],
                "permissions": {
                    "contents": "write",
                    "issues": "write",
                },
            },
        )

        token = response.get("token")
        expires_at = response.get("expires_at")

        if not token or not expires_at:
            raise GitHubAppError(
                "GitHub did not return a valid installation token."
            )

        return InstallationToken(
            token=token,
            expires_at=expires_at,
        )

    def _create_app_jwt(self) -> str:
        if not self.private_key_path.is_file():
            raise GitHubAppError(
                f"GitHub App private key not found: "
                f"{self.private_key_path}"
            )

        private_key = self.private_key_path.read_bytes()

        now = int(time.time())

        return jwt.encode(
            {
                "iat": now - 60,
                "exp": now + (9 * 60),
                "iss": self.app_id,
            },
            private_key,
            algorithm="RS256",
        )

    @staticmethod
    def _request_json(
        *,
        method: str,
        url: str,
        bearer_token: str,
        body: dict | None = None,
    ) -> dict:
        data = None

        if body is not None:
            data = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {bearer_token}",
                "X-GitHub-Api-Version": "2026-03-10",
            },
        )

        try:
            with urllib.request.urlopen(request) as response:
                return json.load(response)
        except Exception as exc:
            raise GitHubAppError(
                f"GitHub App request failed: {method} {url}"
            ) from exc
