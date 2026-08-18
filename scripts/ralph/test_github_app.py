import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.ralph.github_app import (
    GitHubAppAuthenticator,
    GitHubAppError,
)


class GitHubAppAuthenticatorTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.key_path = Path(self.tempdir.name) / "app.pem"
        self.key_path.write_text("fake-private-key")

        self.auth = GitHubAppAuthenticator(
            app_id="12345",
            private_key_path=str(self.key_path),
        )

    def tearDown(self):
        self.tempdir.cleanup()

    @patch("scripts.ralph.github_app.jwt.encode")
    def test_creates_app_jwt(self, encode):
        encode.return_value = "signed-jwt"

        token = self.auth._create_app_jwt()

        self.assertEqual(token, "signed-jwt")
        encode.assert_called_once()

    def test_missing_private_key_fails_closed(self):
        auth = GitHubAppAuthenticator(
            app_id="12345",
            private_key_path="/does/not/exist.pem",
        )

        with self.assertRaises(GitHubAppError):
            auth._create_app_jwt()

    @patch.object(
        GitHubAppAuthenticator,
        "_create_app_jwt",
        return_value="app-jwt",
    )
    @patch.object(
        GitHubAppAuthenticator,
        "_request_json",
    )
    def test_mints_repository_scoped_token(
        self,
        request_json,
        create_jwt,
    ):
        request_json.side_effect = [
            {
                "id": 999,
            },
            {
                "token": "ghs_test_token",
                "expires_at": "2026-08-18T12:00:00Z",
            },
        ]

        result = self.auth.mint_repository_token(
            owner="Measure-2wice",
            repository="sound-hub",
        )

        self.assertEqual(
            result.token,
            "ghs_test_token",
        )

        self.assertEqual(
            result.expires_at,
            "2026-08-18T12:00:00Z",
        )

        second_call = request_json.call_args_list[1]

        self.assertEqual(
            second_call.kwargs["body"],
            {
                "repositories": ["sound-hub"],
                "permissions": {
                    "contents": "write",
                    "issues": "write",
                },
            },
        )

    @patch.object(
        GitHubAppAuthenticator,
        "_create_app_jwt",
        return_value="app-jwt",
    )
    @patch.object(
        GitHubAppAuthenticator,
        "_request_json",
        return_value={},
    )
    def test_missing_installation_fails_closed(
        self,
        request_json,
        create_jwt,
    ):
        with self.assertRaises(GitHubAppError):
            self.auth.mint_repository_token(
                owner="Measure-2wice",
                repository="sound-hub",
            )


if __name__ == "__main__":
    unittest.main()
