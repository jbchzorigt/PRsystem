import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from prsystem.common import DomainError
from prsystem.mock_providers import MockStore, MockPhoneGateway, MockPaymentGateway, MockMailTransport


class MockProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.now = 1000.0
        self.path = Path(self.tmp.name) / 'providers.sqlite3'
        self.store = MockStore(self.path, environment='test', clock=lambda: self.now)

    def test_production_mode_is_rejected(self):
        with self.assertRaises(ValueError): MockStore(self.path, environment='production')
        with self.assertRaises(ValueError): MockMailTransport(self.store, 'https://example.com')

    def test_pending_invoice_survives_restart_and_never_auto_pays(self):
        gateway = MockPaymentGateway(self.store, 'QPAY')
        invoice = gateway.create_invoice('one', 20000, 'MNT')
        restarted = MockPaymentGateway(MockStore(self.path, environment='test'), 'QPAY')
        self.assertEqual(restarted.create_invoice('one', 20000, 'MNT'), invoice)
        self.assertEqual(restarted.payment('one', None)['status'], 'PENDING')
        with self.assertRaises(DomainError): restarted.create_invoice('one', 30000, 'MNT')
        with self.assertRaises(DomainError): restarted.payment('one', 'wrong-invoice')

    def test_late_success_has_stable_capture_time_and_no_paid_reversal(self):
        gateway = MockPaymentGateway(self.store, 'KHAAN'); gateway.create_invoice('one', 1, 'MNT')
        gateway.set_status('one', 'EXPIRED'); gateway.set_status('one', 'SUCCEEDED')
        original = gateway.payment('one', None)
        self.now += 500; gateway.set_status('one', 'SUCCEEDED')
        self.assertEqual(gateway.payment('one', None), original)
        with self.assertRaises(DomainError): gateway.set_status('one', 'PENDING')

    def test_provider_namespaces_do_not_share_captures(self):
        evidence = []
        for name in ('QPAY', 'KHAAN'):
            gateway = MockPaymentGateway(self.store, name); gateway.create_invoice('one', 1, 'MNT')
            gateway.set_status('one', 'SUCCEEDED'); evidence.append(gateway.payment('one', None))
        self.assertNotEqual(evidence[0]['payment_id'], evidence[1]['payment_id'])
        self.assertNotEqual(evidence[0]['merchant_id'], evidence[1]['merchant_id'])

    def test_phone_dedupe_binding_attempt_limit_and_expiry(self):
        phone = MockPhoneGateway(self.store); phone.request('+97699112233', 'one')
        code = self.store.inspect('phone')[0]['code']; phone.request('+97699112233', 'one')
        self.assertEqual(self.store.inspect('phone')[0]['code'], code)
        with self.assertRaises(DomainError): phone.request('+97688112233', 'one')
        for _ in range(5): self.assertFalse(phone.verify('one', 'invalid'))
        self.assertFalse(phone.verify('one', code))
        phone.request('+97699112233', 'two'); code = self.store.inspect('phone')[0]['code']
        self.now += 300; self.assertFalse(phone.verify('two', code))

    def test_concurrent_otp_can_only_be_consumed_once(self):
        phone = MockPhoneGateway(self.store); phone.request('+97699112233', 'one')
        code = self.store.inspect('phone')[0]['code']
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: phone.verify('one', code), range(2)))
        self.assertEqual(sorted(results), [False, True])

    def test_mail_is_only_a_local_deduplicated_fragment_link(self):
        mail = MockMailTransport(self.store)
        envelope = SimpleNamespace(link_id='a'*32, recipient='staff@example.test', purpose='ADMIN_ACTIVATION', token='secret')
        mail(envelope); mail(envelope)
        rows = self.store.inspect('mail')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['url'], 'http://127.0.0.1:8000/staff/activate#token=secret')
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
