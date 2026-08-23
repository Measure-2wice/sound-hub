import unittest

from scripts.ralph.states import TicketState
from scripts.ralph.transitions import assert_transition, can_transition


class TicketTransitionTests(unittest.TestCase):
    def test_ready_can_start_implementation(self):
        self.assertTrue(
            can_transition(
                TicketState.READY,
                TicketState.IMPLEMENTING,
            )
        )

    def test_implementation_can_continue_fresh_iteration(self):
        self.assertTrue(
            can_transition(
                TicketState.IMPLEMENTING,
                TicketState.IMPLEMENTING,
            )
        )

    def test_implementation_can_move_to_review(self):
        self.assertTrue(
            can_transition(
                TicketState.IMPLEMENTING,
                TicketState.REVIEWING,
            )
        )

    def test_changes_requested_moves_review_to_fixing(self):
        self.assertTrue(
            can_transition(
                TicketState.REVIEWING,
                TicketState.FIXING,
            )
        )

    def test_fixing_can_return_to_review(self):
        self.assertTrue(
            can_transition(
                TicketState.FIXING,
                TicketState.REVIEWING,
            )
        )

    def test_approved_review_can_move_to_qa(self):
        self.assertTrue(
            can_transition(
                TicketState.REVIEWING,
                TicketState.AUTOMATED_QA,
            )
        )

    def test_qa_must_precede_integration(self):
        self.assertFalse(
            can_transition(
                TicketState.REVIEWING,
                TicketState.INTEGRATING,
            )
        )

    def test_failed_qa_can_return_to_fixing(self):
        self.assertTrue(
            can_transition(
                TicketState.AUTOMATED_QA,
                TicketState.FIXING,
            )
        )

    def test_ralph_cannot_jump_directly_to_integrated(self):
        self.assertFalse(
            can_transition(
                TicketState.IMPLEMENTING,
                TicketState.INTEGRATED,
            )
        )

    def test_integrated_moves_to_human_qa(self):
        self.assertTrue(
            can_transition(
                TicketState.INTEGRATED,
                TicketState.HUMAN_QA_PENDING,
            )
        )

    def test_illegal_transition_raises(self):
        with self.assertRaises(ValueError):
            assert_transition(
                TicketState.READY,
                TicketState.INTEGRATED,
            )


if __name__ == "__main__":
    unittest.main()
