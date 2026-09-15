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

    def test_cash_refund_hold_preserves_spendable_cash_and_prevents_close(self):
        from dataclasses import replace
        from datetime import datetime,timezone
        from prsystem.cash import CashBook,Drawer,RefundHold,SpendCash,CashContext,execute
        book=CashBook('hotel',(Drawer('front','shift',60000,20000),),refund_holds=(RefundHold('refund','front','shift',20000),))
        book.validate();self.assertFalse(book.can_close_shift('shift'))
        context=CashContext('hotel','actor','spend',0,datetime.now(timezone.utc),True,'shift')
        with self.assertRaisesRegex(DomainError,'INSUFFICIENT_AVAILABLE_CASH'):
            execute(book,SpendCash('front',40001,'expense','Approved'),context)
        result=execute(book,SpendCash('front',40000,'expense','Approved'),context)
        self.assertEqual(result.drawer('front').available,0)
        self.assertEqual(result.refund_holds,book.refund_holds)
        result.validate()

    def test_cash_reservations_require_exact_sources_and_shift_binding(self):
        from dataclasses import replace
        from prsystem.cash import CashBook,Drawer,RefundHold,Transfer
        book=CashBook('hotel',(Drawer('front','shift',60000,30000),Drawer('other','s2',0)),
                      transfers=(Transfer('transfer','front','other','shift','s2',10000),),
                      refund_holds=(RefundHold('refund','front','shift',20000),))
        book.validate()
        for holds in ((),(RefundHold('refund','front','wrong',20000),),(RefundHold('refund','front','shift',19999),),book.refund_holds*2):
            with self.assertRaises(DomainError):replace(book,refund_holds=holds).validate()
