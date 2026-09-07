import unittest
from prsystem.common import DomainError
from prsystem.deposit_policy import available,require_available,deposit_setting


class DepositPolicyTests(unittest.TestCase):
    def test_reservations_and_reversals_are_not_available(self):
        self.assertEqual(available(100000,10000,30000,20000,15000),25000)
        require_available(25000,25000)
        with self.assertRaises(DomainError):require_available(25001,25000)

    def test_integer_currency_conservation_and_overflow(self):
        for args in ((1,0,0,2,0),(True,),(1.5,),(-1,),(2**63,)):
            with self.subTest(args=args),self.assertRaises(DomainError):available(*args)

    def test_setting_range_and_explicit_unset(self):
        for amount in (50000,75000,100000):deposit_setting(amount)
        deposit_setting(None,nullable=True)
        for amount in (None,0,49999,100001,True,50000.0):
            with self.assertRaises(DomainError):deposit_setting(amount)

    def test_allocating_does_not_change_total_custody(self):
        received=100000
        self.assertEqual(available(received,allocated=30000,reserved=20000)+30000+20000,received)
        self.assertEqual(available(received,allocated=30000,refunded=20000),50000)
