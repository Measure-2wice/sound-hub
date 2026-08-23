from dataclasses import dataclass

import tenki
from tenki import Sandbox


@dataclass(frozen=True)
class SandboxCommandResult:
    exit_code: int
    stdout: str
    stderr: str


# Ralph-owned boundary exception raised when the
# installed tenki 1.0.0 SDK reports that the sandbox
# session was torn down by the platform
# (``tenki.SessionTerminatedError``).  Callers MUST
# treat this as an infrastructure failure and MUST NOT
# surface the SDK exception text in any persisted or
# log surface.  This is the closed Ralph control-plane
# boundary on the sandbox lifetime surface.
class SandboxSessionTerminatedError(RuntimeError):
    """The Tenki sandbox session was terminated by the
    platform before ``Sandbox.exec`` could complete.

    The original SDK ``tenki.SessionTerminatedError``
    has been suppressed; only this Ralph-owned static
    message survives into the control plane.
    """


class TenkiSandbox:
    def __init__(
        self,
        name: str,
        cpu_cores: int = 2,
        memory_mb: int = 4096,
        github_token: str | None = None,
        max_duration_seconds: int | None = None,
    ):
        self.name = name
        self.cpu_cores = cpu_cores
        self.memory_mb = memory_mb
        self.github_token = github_token
        # Hard ceiling forwarded to the installed tenki
        # 1.0.0 SDK as ``Sandbox.create(max_duration=...)``.
        # ``None`` is allowed for unit tests that patch
        # ``Sandbox.create`` and do not need to exercise
        # the SDK lifetime surface; production callers
        # (the Ralph Orchestrator) MUST supply a
        # validated positive integer from
        # ``Budgets.sandbox_max_duration_seconds`` so the
        # SDK does not fall back to the
        # workspace/server default lifetime.
        self.max_duration_seconds = max_duration_seconds
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

        if self.max_duration_seconds is not None:
            # ``tenki_sandbox.client.Client.create`` accepts
            # ``max_duration`` as ``float | int | timedelta``.
            # We forward the already-validated positive
            # integer seconds directly.
            options["max_duration"] = (
                self.max_duration_seconds
            )

        self._sandbox = Sandbox.create(**options)

        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self._sandbox is not None:
            try:
                self._sandbox.close()
            except (
                # The installed tenki 1.0.0 SDK translates
                # the platform-level teardown of an
                # already-dead session to either of these
                # closed categorical signals:
                #
                #   - ``tenki.SessionTerminatedError`` —
                #     ``map_rpc_error`` returns this for
                #     ``FAILED_PRECONDITION`` whose
                #     details contain ``"terminated"``
                #     (``errors.py:425-427``);
                #   - ``tenki.SessionNotFoundError`` —
                #     ``map_rpc_error`` returns this for
                #     ``NOT_FOUND`` whose details do not
                #     match the volume / snapshot /
                #     template / registry / file branches
                #     (``errors.py:401-412``).
                #
                # Either signal means the session is
                # already gone from the platform's view,
                # so the cleanup we are attempting here is
                # redundant.  Treat it as already-closed
                # cleanup; do NOT re-raise the SDK
                # exception text — that text MAY carry
                # provider-internal detail (RPC status,
                # session IDs, secret-shaped substrings)
                # that must never cross the Ralph control
                # plane.  ``self._sandbox = None`` runs in
                # the ``finally`` clause below so the
                # second ``__exit__`` call is also a
                # no-op.
                tenki.SessionTerminatedError,
                tenki.SessionNotFoundError,
            ):
                # Intentionally swallowed at the teardown
                # boundary.  The Orchestrator has already
                # classified the ticket; do NOT override
                # the established terminal state with a
                # secondary exception text.
                pass
            finally:
                self._sandbox = None

    def exec(
        self,
        *command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        input: str | bytes | None = None,
        timeout: float | int | None = None,
    ) -> SandboxCommandResult:
        if self._sandbox is None:
            raise RuntimeError("Sandbox is not running")

        try:
            result = self._sandbox.exec(
                *command,
                cwd=cwd,
                env=env,
                input=input,
                timeout=timeout,
            )
        except tenki.SessionTerminatedError:
            # The installed SDK raised a closed categorical
            # signal that the platform tore the sandbox
            # down.  The original exception text MAY carry
            # platform-internal detail
            # (``session_terminated:<cause>[: detail]``);
            # we MUST NOT let that reach
            # ``checkpoint.last_error``, the operator
            # console, or any other Ralph control-plane
            # surface.  Translate to the static
            # Ralph-owned boundary exception so the
            # Orchestrator can map it to
            # ``TerminalReason.SANDBOX_SESSION_TERMINATED``.
            raise SandboxSessionTerminatedError(
                "Sandbox session terminated unexpectedly."
            ) from None

        return SandboxCommandResult(
            exit_code=result.exit_code,
            stdout=result.stdout_text,
            stderr=result.stderr_text,
        )
