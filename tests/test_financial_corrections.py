import unittest
from datetime import datetime,timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mock_providers import MockStore,MockPaymentGateway
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class FinancialCorrectionTests(GuestFinanceCase):
    def request(self,channel='MANUAL_POS',amount=60000,revision=1,key='correction'):
        body=dict(receipt_id=self.stay['deposit_receipt_id'],replacement_amount_mnt=amount,replacement_channel=channel,reason='Correct source channel and recorded amount',expected_revision=revision,idempotency_key=key)
        if channel=='MANUAL_POS':body['proof']=dict(reference='POS-CORRECTED-001',terminal_id='FRONT-1',transacted_at=datetime.now(timezone.utc).isoformat())
        return self.command('financial-corrections',body)

    def decide(self,correction,revision=2,approve=True,key='decide'):
        return self.command('financial-corrections/'+correction+'/decision',dict(approve=approve,reason='Physical records and proof verified',expected_revision=revision,idempotency_key=key),self.manager_token)

    def test_cash_to_pos_reversal_moves_only_cash_projection_and_preserves_liability(self):
        self.start();correction=self.assert_status(self.request(),201)['correction_id']
        result=self.assert_status(self.decide(correction),200)
        self.assertEqual(self.decide(correction).json(),result);self.assertEqual(self.drawer(),(0,0))
        self.assertEqual(result['balance']['available'],60000)
        with psycopg.connect(self.owner_dsn) as conn:
            rows=conn.execute('SELECT channel,amount_mnt,reversed FROM prsystem.guest_receipt WHERE tenant_id=%s ORDER BY recorded_at,id',(self.tenant,)).fetchall()
            self.assertEqual(rows,[('CASH',60000,60000),('MANUAL_POS',60000,0)])

    def test_allocated_deposit_correction_reverses_and_reallocates_without_repricing(self):
        self.start();self.assert_status(self.allocate(60000),201)
        correction=self.assert_status(self.request(channel='CASH',amount=50000,revision=2),201)['correction_id']
        result=self.assert_status(self.decide(correction,revision=3),200)
        self.assertEqual((result['balance']['allocated'],result['balance']['available']),(50000,0))
        statement=self.statement().json();self.assertEqual((statement['charge_total_mnt'],statement['charge_paid_mnt']),(80000,50000))
        self.assertEqual(self.drawer(),(50000,0))

    def mock(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup);self.gateway=MockPaymentGateway(MockStore(Path(tmp.name)/'providers.db',environment='test'),'QPAY')
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways={'QPAY':self.gateway}));self.addCleanup(self.client.close)

    def test_provider_correction_requires_exact_server_evidence(self):
        self.mock();self.start();requested=self.assert_status(self.request(channel='QPAY',amount=10000),201);correction=requested['correction_id']
        self.assert_status(self.command('financial-corrections/'+correction+'/invoice',{}),200)
        self.assertEqual(self.decide(correction).json()['code'],'PAYMENT_REQUIRED')
        self.gateway.set_status(requested['provider_attempt_id'],'SUCCEEDED')
        result=self.assert_status(self.decide(correction),200)
        self.assertEqual(result['balance']['available'],10000);self.assertEqual(self.drawer(),(0,0))

    def test_rejection_voids_mock_invoice_and_cannot_later_capture(self):
        self.mock();self.start();requested=self.assert_status(self.request(channel='QPAY'),201);correction=requested['correction_id']
        self.assert_status(self.command('financial-corrections/'+correction+'/invoice',{}),200)
        self.assert_status(self.decide(correction,approve=False),200)
        with self.assertRaises(DomainError):self.gateway.set_status(requested['provider_attempt_id'],'SUCCEEDED')
        self.assertEqual(self.statement().json()['balance']['available'],60000)
