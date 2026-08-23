from dataclasses import dataclass
from typing import Optional

from scripts.ralph.sandbox import (
    SandboxCommandResult,
    TenkiSandbox,
)


class QaEnvironmentError(RuntimeError):
    """Disposable QA environment provisioning failed."""


@dataclass(frozen=True)
class QaEnvironment:
    database_url: str
    env: dict[str, str]


class PostgresQaEnvironment:
    """Provisions a disposable PostgreSQL cluster inside a Tenki sandbox.

    The cluster is owned by the unprivileged `tenki` user, listens on
    127.0.0.1 at a non-default port, and uses a writable /tmp unix socket
    directory so PostgreSQL never reaches for /var/run/postgresql.

    Authentication is local trust only. No password is fabricated.

    Lifecycle invariant: once ``_start_cluster`` succeeds, ``_started`` is
    ``True`` and ``stop()`` will tear the cluster down. If anything after
    the cluster start (createdb, SQL verification, readiness verification,
    etc.) fails, the error escapes only after ``stop()`` has run in the
    ``finally`` block, so the postgres process cannot leak.
    """

    def __init__(
        self,
        sandbox: TenkiSandbox,
        *,
        port: int = 5433,
        database_name: str = "soundhub_m1_test",
        data_dir: str = "/tmp/ralph-postgres",
        socket_dir: str = "/tmp/ralph-postgres-socket",
    ):
        self.sandbox = sandbox
        self.port = port
        self.database_name = database_name
        self.data_dir = data_dir
        self.socket_dir = socket_dir

        self._bindir: Optional[str] = None
        self._started = False

    def start(self) -> QaEnvironment:
        self._install_postgres()
        self._bindir = self._locate_bindir()
        self._prepare_directories()
        self._init_cluster()
        try:
            self._start_cluster()
        except BaseException:
            self._safe_stop()
            raise

        # From this point forward the cluster is running; if anything
        # below fails, ``stop()`` MUST be invoked before the error
        # escapes so the postgres process is not leaked.
        self._started = True

        try:
            self._create_database()
            self._verify_sql()
            self._verify_readiness()
        except BaseException:
            self._safe_stop()
            raise

        database_url = (
            f"postgresql://tenki@127.0.0.1:"
            f"{self.port}/{self.database_name}"
        )

        env = {"TEST_DATABASE_URL": database_url}

        return QaEnvironment(
            database_url=database_url,
            env=env,
        )

    def stop(self) -> None:
        if not self._started:
            return

        if self._bindir is not None:
            try:
                self._run([
                    f"{self._bindir}/pg_ctl",
                    "-D", self.data_dir,
                    "-m", "fast",
                    "stop",
                ])
            except QaEnvironmentError:
                pass

        self._started = False

    def _safe_stop(self) -> None:
        """Best-effort stop used in failure paths. Never re-raises."""
        try:
            self.stop()
        except Exception:
            pass

    def _install_postgres(self) -> None:
        self._run(["sudo", "apt-get", "update"])
        self._run([
            "sudo", "apt-get", "install", "-y",
            "--no-install-recommends",
            "postgresql",
            "postgresql-client",
        ])

    def _locate_bindir(self) -> str:
        result = self._run(["pg_config", "--bindir"])
        return result.stdout.strip()

    def _prepare_directories(self) -> None:
        self._run(["rm", "-rf", self.data_dir])
        self._run(["mkdir", "-p", self.data_dir])

        self._run(["rm", "-rf", self.socket_dir])
        self._run(["mkdir", "-p", self.socket_dir])

    def _init_cluster(self) -> None:
        self._run([
            f"{self._bindir}/initdb",
            "-D", self.data_dir,
            "-U", "tenki",
            "--auth=trust",
            "--no-locale",
            "--encoding=UTF8",
        ])

    def _start_cluster(self) -> None:
        self._run([
            f"{self._bindir}/pg_ctl",
            "-D", self.data_dir,
            "-l", "/tmp/ralph-postgres.log",
            "-o",
            (
                f"-p {self.port} "
                f"-h 127.0.0.1 "
                f"-k {self.socket_dir}"
            ),
            "start",
        ])

    def _create_database(self) -> None:
        self._run([
            f"{self._bindir}/createdb",
            "-h", self.socket_dir,
            "-p", str(self.port),
            "-U", "tenki",
            self.database_name,
        ])

    def _verify_sql(self) -> None:
        self._run([
            f"{self._bindir}/psql",
            "-h", self.socket_dir,
            "-p", str(self.port),
            "-U", "tenki",
            "-d", self.database_name,
            "-tAc",
            "SELECT current_database(), current_user, 1 + 1",
        ])

    def _verify_readiness(self) -> None:
        self._run([
            f"{self._bindir}/pg_isready",
            "-h", self.socket_dir,
            "-p", str(self.port),
            "-d", self.database_name,
        ])

    def _run(
        self,
        command: list[str],
    ) -> SandboxCommandResult:
        result = self.sandbox.exec(*command)

        if result.exit_code != 0:
            raise QaEnvironmentError(
                "PostgreSQL provisioning command failed: "
                f"{command}\n"
                f"exit_code: {result.exit_code}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

        return result
