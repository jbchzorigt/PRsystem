import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mock_providers import MockStore, MockPaymentGateway
    from prsystem.guest_payments import GuestPayments
    from prsystem.shifts import ShiftService
    from prsystem.postgres.connection import transaction


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class GuestPaymentTests(GuestFinanceCase):
    def pos(self, amount=20000, revision=1, reference='POS-ABC123', key='pos', token=None, **extra):
        body=dict(charge_id=self.stay['room_charge_id'],amount_mnt=amount,reference=reference,terminal_id='front-pos-1',
                  transacted_at=datetime.now(timezone.utc).isoformat(),expected_revision=revision,idempotency_key=key)
        body.update(extra)
        return self.command('pos-payments',body,token)

    def mocked(self):
        directory=TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.store=MockStore(directory.name+'/providers.sqlite3',environment='test')
        self.gateways={name:MockPaymentGateway(self.store,name) for name in ('QPAY','KHAAN')}
        self.client.close()
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways=self.gateways))
        self.addCleanup(self.client.close)

    def intent(self,amount=20000,revision=1,provider='QPAY',key='intent',**extra):
        body=dict(charge_id=self.stay['room_charge_id'],amount_mnt=amount,provider=provider,expected_revision=revision,idempotency_key=key)
        body.update(extra)
        return self.command('payment-intents',body)

    def reconcile(self,intent,body=None,token=None):
        return self.command('payment-intents/'+intent+'/reconcile',body or {},token)

    def test_pos_proof_is_immutable_and_does_not_change_cash_or_deposit(self):
        self.start();transacted=datetime.now(timezone.utc).isoformat()
        result=self.assert_status(self.pos(transacted_at=transacted),201)
        self.assertEqual(self.pos(transacted_at=transacted).json(),result)
        self.assertEqual(self.drawer(),(60000,0))
        report=self.statement().json()
        self.assertEqual(report['balance']['available'],60000)
        self.assertEqual(report['charge_paid_mnt'],20000)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT provider,merchant_id,payment_id,terminal_id FROM prsystem.guest_payment_evidence WHERE tenant_id=%s',(self.tenant,)).fetchone(),('MANUAL_POS','POS:'+self.tenant,'POS-ABC123','FRONT-POS-1'))
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.guest_payment_evidence SET payment_id='different' WHERE tenant_id=%s",(self.tenant,))

    def test_pos_reference_reuse_and_forged_success_are_rejected(self):
        self.start();self.assert_status(self.pos(),201)
        self.assertEqual(self.pos(revision=2,reference=' pos-abc123 ',key='duplicate',terminal_id='another').json()['code'],'PAYMENT_REFERENCE_USED')
        self.assert_status(self.pos(revision=2,key='forged',provider_success=True),422)
        self.assertEqual(self.statement().json()['charge_paid_mnt'],20000)
        self.assertEqual(self.drawer(),(60000,0))

    def test_pos_requires_current_reception_and_valid_timestamp(self):
        self.start()
        for token in (self.admin,self.manager_token):self.assert_status(self.pos(token=token),403)
        for date in ('2000-01-01T12:00:00+08:00','2026-09-07T00:00:00', (datetime.now(timezone.utc)+timedelta(days=1)).isoformat()):
            self.assert_status(self.pos(transacted_at=date),422)
        self.assert_status(self.pos(terminal_id=' '),422)
        self.assert_status(self.pos(charge_id='invented'),404)
        self.assertEqual(self.statement().json()['charge_paid_mnt'],0)

    def test_production_provider_port_is_explicitly_unavailable(self):
        self.start();self.assert_status(self.intent(),503)
        self.assertEqual(self.drawer(),(60000,0))

    def test_mock_intent_success_is_source_bound_and_exactly_once_after_restart(self):
        self.mocked();self.start()
        created=self.assert_status(self.intent(),201);intent=created['intent_id']
        self.assertEqual(self.intent().json(),created)
        self.assertEqual(self.store.inspect('invoice'),[])
        pending=self.assert_status(self.reconcile(intent),200)
        self.assertEqual(pending['provider_state'],'PENDING')
        self.assertEqual(self.reconcile(intent).headers['X-PRsystem-Mode'],'MOCK_ONLY')
        # A new gateway instance reads the same durable external simulation.
        restarted=MockPaymentGateway(MockStore(self.store.path,environment='test'),'QPAY')
        restarted.set_status(intent,'SUCCEEDED')
        applied=self.assert_status(self.reconcile(intent),200)
        self.assertEqual(self.reconcile(intent).json(),applied)
        self.assertEqual(applied['state'],'APPLIED')
        self.assertEqual(self.statement().json()['charge_paid_mnt'],20000)
        self.assertEqual(self.drawer(),(60000,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_payment_evidence WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'SUCCEEDED')

    def test_pending_failed_and_expired_provider_keep_charge_and_shift_reserved(self):
        self.mocked();self.start();intent=self.assert_status(self.intent(50000),201)['intent_id']
        self.assert_status(self.reconcile(intent),200)
        for status in ('FAILED','EXPIRED','PENDING'):
            self.gateways['QPAY'].set_status(intent,status)
            self.assertEqual(self.reconcile(intent).json()['state'],'PENDING')
            self.assertEqual(self.allocate(30001,revision=2).json()['code'],'CHARGE_OVERPAYMENT')
            self.assertEqual(self.intent(1000,revision=2,key='second').json()['code'],'PAYMENT_ALREADY_PENDING')
        self.assert_status(self.allocate(30000,revision=2),201)
        with transaction(self.app_dsn) as conn:
            ShiftService._book(conn,self.tenant)
            drawer=conn.execute('SELECT drawer_id FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone()[0]
            self.assertTrue(ShiftService._pending(conn,self.tenant,(self.shift,None,None,drawer)))
        self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        self.assert_status(self.reconcile(intent),200)
        self.assertEqual(self.statement().json()['charge_paid_mnt'],80000)
        self.assertEqual(self.drawer(),(60000,0))

    def test_lost_invoice_response_reuses_persisted_intent_and_cannot_double_pay(self):
        self.mocked();self.start();intent=self.assert_status(self.intent(),201)['intent_id']
        original=self.gateways['QPAY'].create_invoice
        def lost(*args):
            original(*args);raise TimeoutError('lost response')
        with patch.object(self.gateways['QPAY'],'create_invoice',side_effect=lost):
            self.assertEqual(self.reconcile(intent).json()['provider_state'],'UNKNOWN')
        self.assertEqual(len(self.store.inspect('invoice')),1)
        self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        self.assertEqual(self.reconcile(intent).json()['state'],'APPLIED')
        self.assertEqual(len(self.store.inspect('invoice')),1)
        self.assertEqual(self.statement().json()['charge_paid_mnt'],20000)

    def test_client_status_and_wrong_server_evidence_never_pay_charge(self):
        self.mocked();self.start();intent=self.assert_status(self.intent(),201)['intent_id']
        self.assert_status(self.reconcile(intent,dict(status='SUCCEEDED')),422)
        self.assert_status(self.reconcile(intent),200)
        self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        good=self.gateways['QPAY'].payment(intent,None)
        for evidence in (dict(good,merchant_id='foreign'),dict(good,amount=True),dict(good,currency='USD'),dict(good,invoice_id='foreign'),dict(good,confirmed_at=None)):
            with patch.object(self.gateways['QPAY'],'payment',return_value=evidence):
                self.assert_status(self.reconcile(intent),503)
        self.assertEqual(self.statement().json()['charge_paid_mnt'],0)
        self.assertEqual(self.drawer(),(60000,0))
        self.assertEqual(self.reconcile(intent).json()['state'],'APPLIED')

    def test_duplicate_reconcile_race_has_one_capture_and_one_allocation(self):
        self.mocked();self.start();intent=self.assert_status(self.intent(provider='KHAAN'),201)['intent_id']
        self.reconcile(intent);self.gateways['KHAAN'].set_status(intent,'SUCCEEDED');barrier=Barrier(2)
        def reconcile(_):
            barrier.wait();return self.reconcile(intent)
        with ThreadPoolExecutor(max_workers=2) as pool:responses=list(pool.map(reconcile,range(2)))
        self.assertEqual([r.status_code for r in responses],[200,200])
        self.assertEqual(responses[0].json(),responses[1].json())
        self.assertEqual(self.statement().json()['charge_paid_mnt'],20000)

    def test_provider_success_db_failure_retries_original_capture(self):
        self.mocked();self.start();intent=self.assert_status(self.intent(),201)['intent_id']
        self.reconcile(intent);self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        from prsystem.common import DomainError
        with patch.object(GuestPayments,'save',side_effect=DomainError('INVALID_REQUEST')):
            self.assert_status(self.reconcile(intent),422)
        self.assertEqual(self.statement().json()['charge_paid_mnt'],0)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_payment_evidence WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'PENDING')
        self.assertEqual(self.reconcile(intent).json()['state'],'APPLIED')

    def test_shared_billing_capture_prevents_cross_product_payment_reuse(self):
        self.mocked();self.start();intent=self.assert_status(self.intent(),201)['intent_id']
        self.reconcile(intent);self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        evidence=self.gateways['QPAY'].payment(intent,None)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.billing_capture VALUES ('QPAY',%s,%s,'RENEWAL','existing-renewal')",(evidence['merchant_id'],evidence['payment_id']))
        self.assertEqual(self.reconcile(intent).json()['code'],'PAYMENT_REFERENCE_USED')
        self.assertEqual(self.statement().json()['charge_paid_mnt'],0)
        self.assertEqual(self.drawer(),(60000,0))

    def test_security_suspension_blocks_reconcile_and_cross_tenant_reads(self):
        self.mocked();self.start();intent=self.assert_status(self.intent(),201)['intent_id']
        self.reconcile(intent);self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        self.assert_status(self.client.post(f'/hotels/{self.other}/stays/{self.stay["stay_id"]}/payment-intents/{intent}/reconcile',headers=self.headers(self.worker_token),json={}),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.reconcile(intent).json()['code'],'SECURITY_SUSPENDED')
        self.assertEqual(self.drawer(),(60000,0))

    def test_pending_cancellation_voids_provider_releases_capacity_and_cannot_capture_later(self):
        self.mocked();self.start()
        intent=self.assert_status(self.intent(),201)['intent_id']
        revision=self.statement().json()['balance']['revision']
        body=dict(expected_revision=revision,idempotency_key='void',reason='Guest chooses cash instead')
        result=self.assert_status(self.command(f'payment-intents/{intent}/cancel',body),200)
        self.assertEqual(result['state'],'CANCELLED')
        self.assertEqual(self.command(f'payment-intents/{intent}/cancel',body).json(),result)
        self.assertEqual(self.reconcile(intent).json()['state'],'CANCELLED')
        with self.assertRaises(Exception):self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        self.assertEqual(self.statement().json()['pending_payment_mnt'],0)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s AND id=%s',(self.tenant,intent)).fetchone()[0],'FAILED')
        self.assert_status(self.intent(revision=result['balance']['revision'],key='new'),201)

    def test_captured_provider_invoice_cannot_be_cancelled_before_reconcile(self):
        self.mocked();self.start()
        intent=self.assert_status(self.intent(),201)['intent_id']
        self.reconcile(intent);self.gateways['QPAY'].set_status(intent,'SUCCEEDED')
        revision=self.statement().json()['balance']['revision']
        response=self.command(f'payment-intents/{intent}/cancel',dict(expected_revision=revision,idempotency_key='void',reason='Guest changes mind'))
        self.assertEqual(response.json()['code'],'PAYMENT_ALREADY_PAID')
        self.assertEqual(self.reconcile(intent).json()['state'],'APPLIED')
