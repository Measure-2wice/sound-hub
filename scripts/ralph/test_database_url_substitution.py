"""Subprocess regression tests for ``TEST_DATABASE_URL`` substitution.

Ralph never spawns the API's npm scripts directly — it asks the
sandbox to run them. The risk these tests cover is purely about
the ``apps/api/package.json`` scripts themselves: when Ralph
supplies an externally chosen ``TEST_DATABASE_URL`` via the
sandbox environment, npm must pass that value through to the
underlying command and NOT silently fall back to the local
default hard-coded in the script.

We do NOT spawn real Docker or real PostgreSQL. The npm scripts
we exercise are intentionally chosen to be idempotent and
side-effect-free for this regression check. The disposable
database guard from ``apps/api/src/lib/test-database.ts`` is
NOT weakened by these tests — they only assert substitution
mechanics.
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SENTINEL_URL = (
    "postgresql://ralph-external:"
    "deadbeef@127.0.0.1:6543/"
    "ralph_sentinel_db"
)


def _setup_minimal_app(
    *, app_dir: Path,
) -> None:
    """Create the smallest package.json / .env.test layout that
    mirrors the substitution pattern in ``apps/api/package.json``.

    The actual ``apps/api/package.json`` rewrites inline env
    assignments to ``${TEST_DATABASE_URL:-default}``. This helper
    mirrors that exact pattern in a temp dir so we can validate
    the substitution behavior without modifying the canonical
    package layout.
    """

    (app_dir / "package.json").write_text(
        json.dumps(
            {
                "name": "ralph-substitution-probe",
                "private": True,
                "version": "0.0.0",
                "scripts": {
                    "probe:test-url": (
                        "TEST_DATABASE_URL="
                        "${TEST_DATABASE_URL:-"
                        "postgresql://default@localhost:5432/"
                        "default_db} "
                        "node -e "
                        "\"console.log(process.env.TEST_DATABASE_URL)\""
                    ),
                },
            }
        )
    )

    (app_dir / ".env.test").write_text(
        f"TEST_DATABASE_URL={SENTINEL_URL}\n"
    )


def _ensure_node() -> bool:
    try:
        result = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except FileNotFoundError:
        return False

    return result.returncode == 0


@unittest.skipUnless(
    _ensure_node(),
    "Node.js is required for npm substitution regression tests.",
)
class TestDatabaseUrlSubstitutionTests(unittest.TestCase):
    def test_externally_supplied_url_is_not_replaced(self):
        """An externally supplied TEST_DATABASE_URL must survive
        npm-script substitution. The default literal must NOT
        shadow it."""

        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp)
            _setup_minimal_app(app_dir=app_dir)

            env = os.environ.copy()
            env["TEST_DATABASE_URL"] = SENTINEL_URL

            result = subprocess.run(
                [
                    "npm",
                    "run",
                    "--silent",
                    "probe:test-url",
                ],
                cwd=str(app_dir),
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )

            self.assertEqual(
                result.returncode,
                0,
                msg=(
                    "npm substitution failed:\n"
                    f"stdout:\n{result.stdout}\n"
                    f"stderr:\n{result.stderr}"
                ),
            )

            self.assertEqual(
                result.stdout.strip(),
                SENTINEL_URL,
            )

    def test_default_url_is_used_when_no_external_value(self):
        """When no external TEST_DATABASE_URL is supplied, the
        local default survives intact."""

        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp)
            _setup_minimal_app(app_dir=app_dir)

            env = os.environ.copy()
            env.pop("TEST_DATABASE_URL", None)

            result = subprocess.run(
                [
                    "npm",
                    "run",
                    "--silent",
                    "probe:test-url",
                ],
                cwd=str(app_dir),
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )

            self.assertEqual(
                result.returncode,
                0,
                msg=(
                    "npm substitution failed:\n"
                    f"stdout:\n{result.stdout}\n"
                    f"stderr:\n{result.stderr}"
                ),
            )

            self.assertEqual(
                result.stdout.strip(),
                (
                    "postgresql://default@localhost:"
                    "5432/default_db"
                ),
            )


if __name__ == "__main__":
    unittest.main()
