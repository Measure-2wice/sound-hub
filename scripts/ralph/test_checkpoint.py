import json
import tempfile
import unittest
from pathlib import Path

from scripts.ralph.checkpoint import (
    CheckpointError,
    CheckpointStore,
    TicketCheckpoint,
)
from scripts.ralph.states import TicketState


class CheckpointStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()

        self.path = (
            Path(self.tempdir.name)
            / "m2.json"
        )

        self.store = CheckpointStore(
            self.path
        )

    def tearDown(self):
        self.tempdir.cleanup()

    def test_missing_checkpoint_returns_none(self):
        self.assertIsNone(
            self.store.load()
        )

    def test_round_trip_checkpoint(self):
        checkpoint = TicketCheckpoint(
            milestone_id="m2",
            issue_number=17,
            state=TicketState.REVIEWING,
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
            base_sha="base123",
            ticket_sha="ticket123",
            implementation_session_id=(
                "session-123"
            ),
            review_attempts=2,
            qa_attempts=1,
            pull_request_number=40,
        )

        self.store.save(
            checkpoint
        )

        loaded = self.store.load()

        self.assertEqual(
            loaded,
            checkpoint,
        )

    def test_corrupt_checkpoint_fails_closed(self):
        self.path.write_text(
            "{not-json"
        )

        with self.assertRaises(
            CheckpointError
        ):
            self.store.load()

    def test_unknown_ticket_state_fails_closed(self):
        self.path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "milestone_id": "m2",
                    "issue_number": 17,
                    "state": "MAGIC_STATE",
                    "integration_branch":
                        "ralph/m2",
                    "ticket_branch":
                        "ralph/m2-17",
                }
            )
        )

        with self.assertRaises(
            CheckpointError
        ):
            self.store.load()

    def test_clear_removes_checkpoint(self):
        checkpoint = TicketCheckpoint(
            milestone_id="m2",
            issue_number=17,
            state=TicketState.READY,
            integration_branch="ralph/m2",
            ticket_branch="ralph/m2-17",
        )

        self.store.save(
            checkpoint
        )

        self.store.clear()

        self.assertIsNone(
            self.store.load()
        )


if __name__ == "__main__":
    unittest.main()