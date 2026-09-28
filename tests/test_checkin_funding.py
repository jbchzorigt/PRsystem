import unittest
from datetime import datetime,timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    from prsystem.common import DomainError
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mock_providers import MockStore,MockPaymentGateway


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class CheckinFundingTests(GuestFinanceCase):
    def funding(self,channel='MANUAL_POS',**extra):
        body=dict(room_id=self.room,channel=channel,idempotency_key='funding')
        if channel=='MANUAL_POS':body.update(reference='POS-DEPOSIT-001',terminal_id='FRONT-1',transacted_at=datetime.now(timezone.utc).isoformat())
        body.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/check-in-funding',headers=self.headers(self.worker_token),json=body)

    def reconcile(self,funding,**body):
        return self.client.post(f'/hotels/{self.tenant}/check-in-funding/{funding}/reconcile',headers=self.headers(self.worker_token),json=body)

    def test_pos_deposit_checkin_posts_liability_without_cash(self):
        funding=self.assert_status(self.funding(),201)['funding_id'];before=self.drawer()
        self.stay=self.assert_status(self.checkin(kind='NIGHTLY',duration_units=1,funding_id=funding),201)
        self.assertEqual(self.drawer(),before)
        statement=self.assert_status(self.statement(),200)
        self.assertEqual(statement['balance']['received'],60000)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT channel FROM prsystem.guest_receipt WHERE tenant_id=%s AND id=%s',(self.tenant,self.stay['deposit_receipt_id'])).fetchone()[0],'MANUAL_POS')
            self.assertEqual(conn.execute('SELECT state FROM prsystem.checkin_funding WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'APPLIED')

    def test_mock_qpay_requires_server_confirmation_then_one_use(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup)
        store=MockStore(Path(tmp.name)/'providers.db',environment='test');gateway=MockPaymentGateway(store,'QPAY')
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways={'QPAY':gateway}));self.addCleanup(self.client.close)
        funding=self.assert_status(self.funding('QPAY'),201)['funding_id']
        self.assertEqual(self.checkin(funding_id=funding).json()['code'],'DEPOSIT_REQUIREMENT_NOT_MET')
        self.assert_status(self.reconcile(funding,status='SUCCEEDED'),422)
        self.assertEqual(self.assert_status(self.reconcile(funding),200)['state'],'PENDING')
        gateway.set_status(funding,'SUCCEEDED')
        self.assertEqual(self.assert_status(self.reconcile(funding),200)['state'],'CONFIRMED')
        self.stay=self.assert_status(self.checkin(funding_id=funding),201)
        self.assertEqual(self.drawer(),(0,0))
        self.assert_status(self.checkin(funding_id=funding,idempotency_key='duplicate'),409)

    def test_funding_cannot_bypass_original_shift_or_mix_cash(self):
        funding=self.assert_status(self.funding(),201)['funding_id']
        self.open_shift(self.replacement_token,'other')
        self.assertEqual(self.checkin(token=self.replacement_token,funding_id=funding).json()['code'],'DEPOSIT_REQUIREMENT_NOT_MET')
        self.assert_status(self.checkin(funding_id=funding,deposit=dict(channel='CASH',amount_mnt=60000,received=True)),422)

    def test_production_provider_gate_and_current_deposit_setting(self):
        self.assert_status(self.funding('QPAY'),503)
        funding=self.assert_status(self.funding(),201)['funding_id']
        self.assert_status(self.configure(70000,revision=1),200)
        self.assertEqual(self.checkin(funding_id=funding).json()['code'],'DEPOSIT_REQUIREMENT_NOT_MET')

    def test_pending_funding_can_be_voided_without_creating_a_stay(self):
        directory=TemporaryDirectory();self.addCleanup(directory.cleanup)
        store=MockStore(directory.name+'/providers.sqlite3',environment='test');gateway=MockPaymentGateway(store,'QPAY')
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways={'QPAY':gateway}));self.addCleanup(self.client.close)
        funding=self.assert_status(self.funding(channel='QPAY'),201)['funding_id']
        response=self.client.post(f'/hotels/{self.tenant}/check-in-funding/{funding}/cancel',headers=self.headers(self.worker_token),json=dict(idempotency_key='cancel',reason='Guest leaves before payment'))
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.reconcile(funding).json()['state'],'CANCELLED')
        with self.assertRaises(DomainError):gateway.set_status(funding,'SUCCEEDED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s AND id=%s',(self.tenant,funding)).fetchone()[0],'FAILED')

    def test_unapplied_pos_return_blocks_checkin_and_releases_only_after_proof(self):
        funding=self.assert_status(self.funding(),201)['funding_id']
        def post(suffix,body):return self.client.post(f'/hotels/{self.tenant}/check-in-funding/{funding}/'+suffix,headers=self.headers(self.worker_token),json=body)
        self.assert_status(post('return',dict(idempotency_key='return',reason='Guest decides not to stay')),200)
        self.assert_status(self.checkin(funding_id=funding),409)
        self.assert_status(post('return/complete',dict(idempotency_key='empty')),422)
        result=self.assert_status(post('return/complete',dict(idempotency_key='complete',reference='POS-RETURN-001',confirmation='Card reversal receipt signed')),200)
        self.assertTrue(result['returned']);self.assertEqual(self.drawer(),(0,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s AND id=%s',(self.tenant,funding)).fetchone()[0],'FAILED')

    def test_unapplied_provider_return_uses_exact_server_evidence(self):
        directory=TemporaryDirectory();self.addCleanup(directory.cleanup)
        store=MockStore(directory.name+'/providers.sqlite3',environment='test');gateway=MockPaymentGateway(store,'QPAY')
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways={'QPAY':gateway}));self.addCleanup(self.client.close)
        funding=self.assert_status(self.funding(channel='QPAY'),201)['funding_id'];self.reconcile(funding);gateway.set_status(funding,'SUCCEEDED');self.reconcile(funding)
        def post(suffix,body):return self.client.post(f'/hotels/{self.tenant}/check-in-funding/{funding}/'+suffix,headers=self.headers(self.worker_token),json=body)
        self.assert_status(post('return',dict(idempotency_key='return',reason='Guest leaves')),200)
        self.assertEqual(self.assert_status(post('return/complete',dict(idempotency_key='finish')),200)['state'],'REFUNDING')
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s AND id=%s',(self.tenant,funding)).fetchone()[0],'PENDING')
        gateway.set_refund_status('funding-return:'+funding,'SUCCEEDED')
        self.assertTrue(self.assert_status(post('return/complete',dict(idempotency_key='finish')),200)['returned'])
        self.assert_status(self.checkin(funding_id=funding),409)

    def test_confirmed_funding_capture_cannot_be_reused_as_a_guest_payment(self):
        self.assert_status(self.funding(),201)
        self.start()
        response=self.command('pos-payments',dict(charge_id=self.stay['room_charge_id'],amount_mnt=1000,reference='POS-DEPOSIT-001',terminal_id='FRONT-1',transacted_at=datetime.now(timezone.utc).isoformat(),expected_revision=1,idempotency_key='duplicate-payment'))
        self.assertEqual(response.json()['code'],'PAYMENT_REFERENCE_USED')
        self.assertEqual(self.statement().json()['charge_paid_mnt'],0)
