from dataclasses import dataclass

from tenki import Sandbox


@dataclass(frozen=True)
class SandboxCommandResult:
    exit_code: int
    stdout: str
    stderr: str


class TenkiSandbox:
    def __init__(
        self,
        name: str,
        cpu_cores: int = 2,
        memory_mb: int = 4096,
        github_token: str | None = None,
    ):
        self.name = name
        self.cpu_cores = cpu_cores
        self.memory_mb = memory_mb
        self.github_token = github_token
        self._sandbox = None

    def __enter__(self):
        options = {
            "name": self.name,
            "cpu_cores": self.cpu_cores,
            "memory_mb": self.memory_mb,
            "allow_outbound": True,
        }

        if self.github_token is not None:
            options["github_token"] = self.github_token

        self._sandbox = Sandbox.create(**options)

        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self._sandbox is not None:
            self._sandbox.close()
            self._sandbox = None

    def exec(
        self,
        *command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
    ) -> SandboxCommandResult:
        if self._sandbox is None:
            raise RuntimeError("Sandbox is not running")

        result = self._sandbox.exec(
            *command,
            cwd=cwd,
            env=env,
        )

        return SandboxCommandResult(
            exit_code=result.exit_code,
            stdout=result.stdout_text,
            stderr=result.stderr_text,
        )
