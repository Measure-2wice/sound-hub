import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from scripts.ralph.review import ReviewStage
from scripts.ralph.states import TicketState


CHECKPOINT_SCHEMA_VERSION = 2


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
    review_cycles_consumed: int = 0
    qa_attempts: int = 0
    implementation_attempts: int = 0
    fix_attempts: int = 0

    persisted_commit_sha: Optional[str] = None

    pull_request_number: Optional[int] = None

    review_stage: ReviewStage = ReviewStage.PRE_QA
    qa_evidence: Optional[str] = None

    pre_qa_findings: Optional[str] = None
    qa_failure_evidence: Optional[str] = None
    pre_persistence_findings: Optional[str] = None

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

        schema_version = payload.get(
            "schema_version"
        )

        if schema_version not in {
            CHECKPOINT_SCHEMA_VERSION,
            1,
        }:
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
                review_cycles_consumed=int(
                    payload.get(
                        "review_cycles_consumed",
                        0,
                    )
                ),
                qa_attempts=int(
                    payload.get(
                        "qa_attempts",
                        0,
                    )
                ),
                implementation_attempts=int(
                    payload.get(
                        "implementation_attempts",
                        0,
                    )
                ),
                fix_attempts=int(
                    payload.get(
                        "fix_attempts",
                        0,
                    )
                ),
                persisted_commit_sha=payload.get(
                    "persisted_commit_sha"
                ),
                pull_request_number=payload.get(
                    "pull_request_number"
                ),
                review_stage=ReviewStage(
                    payload.get(
                        "review_stage",
                        ReviewStage.PRE_QA.value,
                    )
                ),
                qa_evidence=payload.get(
                    "qa_evidence"
                ),
                pre_qa_findings=payload.get(
                    "pre_qa_findings"
                ),
                qa_failure_evidence=payload.get(
                    "qa_failure_evidence"
                ),
                pre_persistence_findings=payload.get(
                    "pre_persistence_findings"
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
            "review_cycles_consumed":
                checkpoint.review_cycles_consumed,
            "qa_attempts":
                checkpoint.qa_attempts,
            "implementation_attempts":
                checkpoint.implementation_attempts,
            "fix_attempts":
                checkpoint.fix_attempts,
            "persisted_commit_sha":
                checkpoint.persisted_commit_sha,
            "pull_request_number":
                checkpoint.pull_request_number,
            "review_stage":
                checkpoint.review_stage.value,
            "qa_evidence":
                checkpoint.qa_evidence,
            "pre_qa_findings":
                checkpoint.pre_qa_findings,
            "qa_failure_evidence":
                checkpoint.qa_failure_evidence,
            "pre_persistence_findings":
                checkpoint.pre_persistence_findings,
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
