import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from prsystem.mock_providers import MockStore,MockPaymentGateway
from prsystem.mock_bank import MockBankGateway
from prsystem.common import DomainError

class MockBankTests(unittest.TestCase):
    def setUp(self):
        d=tempfile.TemporaryDirectory();self.addCleanup(d.cleanup)
        self.store=MockStore(d.name+'/bank.sqlite3',environment='test')
        self.bank=MockBankGateway(self.store)
        self.bank.record_credit('hotel','QPAY','merchant','capture',1000,10)
        self.bank.set_beneficiary('hotel','verified')
    def create(self,key='one',amount=900):self.bank.create_payout(key,'hotel','verified',amount)
    def test_exact_retry_and_verified_recipient(self):
        self.create();self.create();self.assertEqual(self.bank.payout('one')['state'],'PENDING')
        with self.assertRaisesRegex(DomainError,'IDEMPOTENCY_CONFLICT'):self.create(amount=901)
        with self.assertRaisesRegex(DomainError,'BANK_BENEFICIARY_UNVERIFIED'):self.bank.create_payout('x','other','verified',1)
    def test_terminal_evidence_does_not_reverse(self):
        self.create();self.bank.set_payout_status('one','SUCCEEDED');first=self.bank.payout('one')
        self.bank.set_payout_status('one','SUCCEEDED');self.assertEqual(first,self.bank.payout('one'))
        with self.assertRaisesRegex(DomainError,'PAYOUT_TERMINAL'):self.bank.cancel_payout('one')
        with self.assertRaisesRegex(DomainError,'PAYOUT_TERMINAL'):self.bank.set_payout_status('one','FAILED')
    def test_concurrent_bank_success_cannot_overdraw(self):
        self.create('one',600);self.create('two',600)
        def pay(key):
            try:self.bank.set_payout_status(key,'SUCCEEDED');return 'PAID'
            except DomainError as e:return str(e)
        with ThreadPoolExecutor(2) as p:result=list(p.map(pay,['one','two']))
        self.assertEqual(sorted(result),['BANK_FUNDS_INSUFFICIENT','PAID'])
    def test_fee_refund_and_chargeback_reduce_available_bank_funds(self):
        gateway=MockPaymentGateway(self.store,'QPAY');gateway.create_refund('refund','capture',100);gateway.set_refund_status('refund','SUCCEEDED')
        self.bank.dispute('hotel','capture',opened=False,chargeback=100)
        self.create(amount=791)
        with self.assertRaisesRegex(DomainError,'BANK_FUNDS_INSUFFICIENT'):self.bank.set_payout_status('one','SUCCEEDED')
        self.bank.cancel_payout('one');self.create('two',790);self.bank.set_payout_status('two','SUCCEEDED')
    def test_unknown_is_not_failure_and_cancel_proves_no_late_success(self):
        self.create();self.bank.set_payout_status('one','UNKNOWN');self.assertEqual(self.bank.payout('one')['state'],'UNKNOWN')
        self.bank.cancel_payout('one');self.assertEqual(self.bank.payout('one')['state'],'FAILED')
        with self.assertRaisesRegex(DomainError,'PAYOUT_TERMINAL'):self.bank.set_payout_status('one','SUCCEEDED')
    def test_credit_correction_cannot_overwrite_original(self):
        with self.assertRaisesRegex(DomainError,'IDEMPOTENCY_CONFLICT'):self.bank.record_credit('hotel','QPAY','merchant','capture',2000,10)
        self.assertEqual(self.bank.credit('hotel','QPAY','merchant','capture')['amount'],1000)
