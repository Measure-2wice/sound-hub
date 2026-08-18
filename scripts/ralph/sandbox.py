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
    ):
        self.name = name
        self.cpu_cores = cpu_cores
        self.memory_mb = memory_mb
        self._sandbox = None

    def __enter__(self):
        self._sandbox = Sandbox.create(
            name=self.name,
            cpu_cores=self.cpu_cores,
            memory_mb=self.memory_mb,
            allow_outbound=True,
        )
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self._sandbox is not None:
            self._sandbox.close()
            self._sandbox = None

    def exec(
        self,
        *command: str,
    ) -> SandboxCommandResult:
        if self._sandbox is None:
            raise RuntimeError("Sandbox is not running")

        result = self._sandbox.exec(*command)

        return SandboxCommandResult(
            exit_code=result.exit_code,
            stdout=result.stdout_text,
            stderr=result.stderr_text,
        )
