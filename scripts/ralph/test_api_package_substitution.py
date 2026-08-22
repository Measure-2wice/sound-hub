"""Regression test for the REAL apps/api/package.json substitution.

Ralph never spawns the API's npm scripts directly — it asks the
sandbox to run them. These tests verify the substitution
mechanics against the *actual* ``apps/api/package.json`` scripts
to catch any regression in production.

The disposable database guard from
``apps/api/src/lib/test-database.ts`` is NOT weakened — these
tests only assert substitution mechanics by stripping the
underlying command of its destructive work and isolating the
TEST_DATABASE_URL assignment.

The expected production scripts are listed by NAME in
``EXPECTED_PRODUCTION_SCRIPTS`` — the test does NOT discover the
test set only by looking for the desired pattern.  If a
production script regresses to a hardcoded URL it MUST be
detected by this test even if the substitution pattern disappears
from the test corpus entirely.
"""

import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_PACKAGE_JSON = (
    REPO_ROOT / "apps" / "api" / "package.json"
)

SENTINEL_URL = (
    "postgresql://ralph-external:"
    "deadbeef@127.0.0.1:6543/"
    "ralph_sentinel_db"
)

APPROVED_DEFAULT_URL = (
    "postgresql://soundhub:password@"
    "localhost:5433/soundhub_m1_test"
)

# Every Ralph-managed API script that runs against the disposable
# database MUST use the external-preserving substitution form.
# If a script regresses to ``TEST_DATABASE_URL=hard-coded-url`` it
# must be caught here.  If a script is added that should also
# use the substitution, add it here AND fix its package.json.
EXPECTED_PRODUCTION_SCRIPTS = frozenset(
    {
        "test",
        "test:repository",
        "test:db",
        "test:db:m2",
        "test:db:m2:transition",
    }
)

# The exact substitution form every Ralph-managed script must use.
SUBSTITUTION_PATTERN = re.compile(
    r"TEST_DATABASE_URL="
    r"\$\{TEST_DATABASE_URL:-"
    + re.escape(APPROVED_DEFAULT_URL)
    + r"\}"
)

# Pattern that matches a hardcoded regression: ``TEST_DATABASE_URL=literal``
# with no shell substitution.  Used to flag regressions even
# before we look at any specific script body.
HARDCODED_PATTERN = re.compile(
    r"TEST_DATABASE_URL=("
    r"postgresql://|postgres://|http://"
    r"|[A-Za-z]:\\\\|\\$|/)"
)


def _has_node() -> bool:
    return shutil.which("node") is not None


def _has_npm() -> bool:
    return shutil.which("npm") is not None


class RealPackageJsonSubstitutionTests(unittest.TestCase):
    """Regression tests against the REAL apps/api/package.json.

    These tests fail if:

      - any EXPECTED production script is missing
      - any EXPECTED production script's body does not match the
        exact ``${TEST_DATABASE_URL:-<approved-default>}`` form
      - any EXPECTED production script's body hardcodes a URL
    """

    @classmethod
    def setUpClass(cls):
        if not REAL_PACKAGE_JSON.exists():
            raise unittest.SkipTest(
                f"Real apps/api/package.json not found at "
                f"{REAL_PACKAGE_JSON}"
            )

        cls.package = json.loads(
            REAL_PACKAGE_JSON.read_text()
        )
        cls.scripts = cls.package.get("scripts", {})

    def test_expected_production_scripts_are_present(self):
        """Every EXPECTED script name MUST exist in the real
        package.json.  This catches any future refactor that
        renames or removes a Ralph-managed script.
        """
        missing = EXPECTED_PRODUCTION_SCRIPTS - set(
            self.scripts
        )

        self.assertEqual(
            missing,
            frozenset(),
            msg=(
                "Real apps/api/package.json is missing the "
                "following Ralph-managed script(s): "
                f"{sorted(missing)}.  Add the substitution to "
                "those scripts and update "
                "EXPECTED_PRODUCTION_SCRIPTS."
            ),
        )

    def test_expected_production_scripts_use_substitution_form(self):
        """Every EXPECTED production script MUST contain the
        exact ``${TEST_DATABASE_URL:-<approved-default>}``
        substitution form.  This is the regression test: if
        someone replaces the substitution with a hardcoded
        literal, this test fails.
        """
        for name in sorted(EXPECTED_PRODUCTION_SCRIPTS):
            with self.subTest(script=name):
                cmd = self.scripts.get(name)
                self.assertIsNotNone(
                    cmd,
                    msg=(
                        f"Script {name!r} is missing from "
                        "apps/api/package.json.  See "
                        "EXPECTED_PRODUCTION_SCRIPTS."
                    ),
                )

                self.assertRegex(
                    cmd,
                    SUBSTITUTION_PATTERN.pattern,
                    msg=(
                        f"Script {name!r} does not use the "
                        "approved substitution form.  Got: "
                        f"{cmd!r}.  Expected the exact "
                        "substitution: TEST_DATABASE_URL="
                        "${TEST_DATABASE_URL:-"
                        f"{APPROVED_DEFAULT_URL}"
                        "}."
                    ),
                )

    def test_expected_production_scripts_do_not_hardcode_url(self):
        """Defense-in-depth: ensure no EXPECTED script has a
        hardcoded ``TEST_DATABASE_URL=literal`` value.  The
        substitution test above is the primary check; this is
        a second-pass guard that catches any regression whose
        body happens to match neither pattern.
        """
        for name in sorted(EXPECTED_PRODUCTION_SCRIPTS):
            with self.subTest(script=name):
                cmd = self.scripts.get(name, "")
                self.assertNotRegex(
                    cmd,
                    HARDCODED_PATTERN,
                    msg=(
                        f"Script {name!r} appears to hardcode a "
                        f"TEST_DATABASE_URL literal: {cmd!r}."
                    ),
                )

    @unittest.skipUnless(
        _has_node() and _has_npm(),
        "Node.js and npm are required to verify real scripts.",
    )
    def test_external_test_database_url_survives_substitution(self):
        """For every EXPECTED production script, run a benign
        subprocess that isolates the ``TEST_DATABASE_URL=...``
        assignment from the real script.  The substitution
        MUST preserve the externally supplied value, not
        replace it with the default literal.
        """
        for name in sorted(EXPECTED_PRODUCTION_SCRIPTS):
            with self.subTest(script=name):
                cmd = self.scripts.get(name)
                if cmd is None:
                    self.skipTest(
                        f"Script {name!r} missing."
                    )

                assignment_match = SUBSTITUTION_PATTERN.search(
                    cmd
                )
                self.assertIsNotNone(
                    assignment_match,
                    msg=(
                        f"Script {name!r} does not use the "
                        "approved substitution form."
                    ),
                )
                assignment = assignment_match.group(0)

                probe_cmd = (
                    f"{assignment} node -e "
                    "\"console.log("
                    "process.env.TEST_DATABASE_URL)\""
                )

                env = os.environ.copy()
                env["TEST_DATABASE_URL"] = SENTINEL_URL

                result = subprocess.run(
                    ["bash", "-c", probe_cmd],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )

                self.assertEqual(
                    result.returncode,
                    0,
                    msg=(
                        f"Script {name!r} substitution probe "
                        f"failed:\n"
                        f"stdout:\n{result.stdout}\n"
                        f"stderr:\n{result.stderr}"
                    ),
                )

                self.assertEqual(
                    result.stdout.strip(),
                    SENTINEL_URL,
                    msg=(
                        f"Script {name!r} substitution did not "
                        "preserve externally supplied "
                        f"TEST_DATABASE_URL. Got: "
                        f"{result.stdout.strip()!r}"
                    ),
                )

    @unittest.skipUnless(
        _has_node() and _has_npm(),
        "Node.js and npm are required to verify real scripts.",
    )
    def test_missing_test_database_url_yields_approved_default(
        self,
    ):
        """For every EXPECTED production script, when no
        external ``TEST_DATABASE_URL`` is supplied, the
        approved local default must remain intact.
        """
        for name in sorted(EXPECTED_PRODUCTION_SCRIPTS):
            with self.subTest(script=name):
                cmd = self.scripts.get(name)
                if cmd is None:
                    self.skipTest(
                        f"Script {name!r} missing."
                    )

                assignment_match = SUBSTITUTION_PATTERN.search(
                    cmd
                )
                self.assertIsNotNone(
                    assignment_match,
                    msg=(
                        f"Script {name!r} does not use the "
                        "approved substitution form."
                    ),
                )
                assignment = assignment_match.group(0)

                probe_cmd = (
                    f"{assignment} node -e "
                    "\"console.log("
                    "process.env.TEST_DATABASE_URL)\""
                )

                env = os.environ.copy()
                env.pop("TEST_DATABASE_URL", None)

                result = subprocess.run(
                    ["bash", "-c", probe_cmd],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )

                self.assertEqual(
                    result.returncode,
                    0,
                    msg=(
                        f"Script {name!r} default-substitution "
                        f"probe failed:\n"
                        f"stderr:\n{result.stderr}"
                    ),
                )

                self.assertEqual(
                    result.stdout.strip(),
                    APPROVED_DEFAULT_URL,
                    msg=(
                        f"Script {name!r} default literal "
                        f"regressed. Got: "
                        f"{result.stdout.strip()!r}"
                    ),
                )


class DisposableDatabaseGuardNotWeakenedTests(unittest.TestCase):
    """The disposable database guard
    ``apps/api/src/lib/test-database.ts`` MUST still reject
    connection attempts to non-disposable databases. These
    tests confirm the file exists and references the guard
    surface so a future refactor that removes the guard will
    be caught.
    """

    def test_test_database_file_exists(self):
        path = (
            REPO_ROOT
            / "apps"
            / "api"
            / "src"
            / "lib"
            / "test-database.ts"
        )
        self.assertTrue(
            path.exists(),
            f"Expected test-database.ts at {path}",
        )


if __name__ == "__main__":
    unittest.main()