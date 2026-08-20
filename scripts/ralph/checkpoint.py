import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from scripts.ralph.states import TicketState


CHECKPOINT_SCHEMA_VERSION = 1


class CheckpointError(RuntimeError):
    pass


@dataclass(frozen=True)
class TicketCheckpoint:
    milestone_id: str
    issue_number: int
    state: TicketState

    integration_branch: str
    ticket_branch: str

    base_sha: Optional[str] = None
    ticket_sha: Optional[str] = None

    implementation_session_id: Optional[str] = None

    review_attempts: int = 0
    qa_attempts: int = 0

    pull_request_number: Optional[int] = None

    last_error: Optional[str] = None


class CheckpointStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> Optional[TicketCheckpoint]:
        if not self.path.exists():
            return None

        try:
            payload = json.loads(
                self.path.read_text()
            )
        except (
            OSError,
            json.JSONDecodeError,
        ) as error:
            raise CheckpointError(
                "Unable to read Ralph checkpoint."
            ) from error

        if (
            payload.get("schema_version")
            != CHECKPOINT_SCHEMA_VERSION
        ):
            raise CheckpointError(
                "Unsupported Ralph checkpoint schema."
            )

        try:
            return TicketCheckpoint(
                milestone_id=payload["milestone_id"],
                issue_number=int(
                    payload["issue_number"]
                ),
                state=TicketState(
                    payload["state"]
                ),
                integration_branch=payload[
                    "integration_branch"
                ],
                ticket_branch=payload[
                    "ticket_branch"
                ],
                base_sha=payload.get(
                    "base_sha"
                ),
                ticket_sha=payload.get(
                    "ticket_sha"
                ),
                implementation_session_id=payload.get(
                    "implementation_session_id"
                ),
                review_attempts=int(
                    payload.get(
                        "review_attempts",
                        0,
                    )
                ),
                qa_attempts=int(
                    payload.get(
                        "qa_attempts",
                        0,
                    )
                ),
                pull_request_number=payload.get(
                    "pull_request_number"
                ),
                last_error=payload.get(
                    "last_error"
                ),
            )
        except (
            KeyError,
            TypeError,
            ValueError,
        ) as error:
            raise CheckpointError(
                "Invalid Ralph checkpoint."
            ) from error

    def save(
        self,
        checkpoint: TicketCheckpoint,
    ) -> None:
        self.path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        payload = {
            "schema_version":
                CHECKPOINT_SCHEMA_VERSION,
            "milestone_id":
                checkpoint.milestone_id,
            "issue_number":
                checkpoint.issue_number,
            "state":
                checkpoint.state.value,
            "integration_branch":
                checkpoint.integration_branch,
            "ticket_branch":
                checkpoint.ticket_branch,
            "base_sha":
                checkpoint.base_sha,
            "ticket_sha":
                checkpoint.ticket_sha,
            "implementation_session_id":
                checkpoint.implementation_session_id,
            "review_attempts":
                checkpoint.review_attempts,
            "qa_attempts":
                checkpoint.qa_attempts,
            "pull_request_number":
                checkpoint.pull_request_number,
            "last_error":
                checkpoint.last_error,
        }

        temporary_path = self.path.with_suffix(
            self.path.suffix + ".tmp"
        )

        try:
            temporary_path.write_text(
                json.dumps(
                    payload,
                    indent=2,
                    sort_keys=True,
                )
                + "\n"
            )

            os.replace(
                temporary_path,
                self.path,
            )
        except OSError as error:
            raise CheckpointError(
                "Unable to persist Ralph checkpoint."
            ) from error

    def clear(self) -> None:
        try:
            self.path.unlink(
                missing_ok=True
            )
        except OSError as error:
            raise CheckpointError(
                "Unable to clear Ralph checkpoint."
            ) from error