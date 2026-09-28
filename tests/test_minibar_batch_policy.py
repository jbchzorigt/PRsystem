import unittest
from prsystem.minibar_batch_policy import progress


class BatchProgressTests(unittest.TestCase):
    def data(self,*states):
        return progress([dict(room_id=str(i),state=s,revision=1) for i,s in enumerate(states)])

    def test_all_accepted_applied_is_completed(self):
        self.assertEqual(self.data('APPLIED','APPLIED')['state'],'COMPLETED')

    def test_skipped_plus_applied_is_partial(self):
        p=self.data('APPLIED','SKIPPED')
        self.assertEqual(p['state'],'PARTIALLY_COMPLETED')
        self.assertEqual((p['counts']['selected'],p['counts']['accepted']),(2,1))

    def test_zero_accepted_is_failed_not_cancelled(self):
        self.assertEqual(self.data('SKIPPED','SKIPPED')['state'],'FAILED_VALIDATION')

    def test_all_accepted_cancelled_is_cancelled_even_with_skips(self):
        self.assertEqual(self.data('CANCELLED','SKIPPED')['state'],'CANCELLED')

    def test_any_nonterminal_keeps_batch_open(self):
        for state in ('READY_FOR_RECONCILIATION','SCHEDULED_AFTER_STAY','IN_PROGRESS','BLOCKED_STOCK','BLOCKED_VARIANCE','ROLLBACK_REQUIRED'):
            with self.subTest(state=state):self.assertEqual(self.data('APPLIED',state)['state'],'IN_PROGRESS')

    def test_mixed_terminal_and_rollback_are_partial(self):
        self.assertEqual(self.data('APPLIED','CANCELLED')['state'],'PARTIALLY_COMPLETED')
        self.assertEqual(self.data('ROLLED_BACK','ROLLED_BACK')['state'],'PARTIALLY_COMPLETED')
