import unittest
from datetime import datetime,timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mock_providers import MockStore,MockPaymentGateway
    from prsystem.mfa import totp


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class RoutedRefundTests(GuestFinanceCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT ON prsystem.platform_account,prsystem.platform_session,prsystem.platform_receipt TO {}',
                'GRANT UPDATE(last_totp_counter) ON prsystem.platform_account TO {}',
                'GRANT UPDATE(mfa_at,revoked_at) ON prsystem.platform_session TO {}',
                'GRANT INSERT ON prsystem.platform_session,prsystem.platform_receipt,prsystem.platform_event TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.store=MockStore(Path(tmp.name)/'providers.db',environment='test');self.gateway=MockPaymentGateway(self.store,'QPAY')
        self.platform_id=uuid4().hex;self.mfa_key=b'12345678901234567890'
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways={'QPAY':self.gateway},platform_secret_resolver=lambda ref:self.mfa_key if ref==self.platform_id else None));self.addCleanup(self.client.close)
        self.start()

    def reserve_route(self,amount=30000,channel='QPAY',revision=1,key='reserve-route'):
        return self.command('refunds',dict(receipt_id=self.stay['deposit_receipt_id'],amount_mnt=amount,channel=channel,recipient='Guest confirmed refund destination',reason='Original route unavailable',expected_revision=revision,idempotency_key=key))

    def approve(self,refund,approve=True,token=None):
        return self.command('refunds/'+refund+'/approval',dict(approve=approve,reason='Verified original receipt and destination',idempotency_key='approve-route'),token or self.manager_token)

    def reconcile(self,refund,**body):return self.command('refunds/'+refund+'/reconcile',body)

    def release_route(self,refund,revision=3):
        return self.command('refunds/'+refund+'/release',dict(reason='Provider confirms refund not processed',cash_not_handed=True,expected_revision=revision,idempotency_key='release-route'),self.manager_token)

    def prepared(self,amount=30000):
        refund=self.assert_status(self.reserve_route(amount),201)['refund_id']
        self.assert_status(self.approve(refund),200);self.assert_status(self.reconcile(refund),200)
        return refund

    def platform_token(self,permission=True):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('INSERT INTO prsystem.platform_account(id,email,password_hash,permissions,mfa_key_ref) VALUES(%s,%s,%s,%s,%s)',(self.platform_id,self.platform_id+'@example.test',self.password_hash,['DEPOSIT_REFUND_RECONCILE'] if permission else [],self.platform_id))
        response=self.client.post('/platform/auth/login',json=dict(email=self.platform_id+'@example.test',password=self.password,code=totp(self.mfa_key,int(datetime.now(timezone.utc).timestamp())//30)))
        return self.assert_status(response,200)['access_token']

    def case(self,refund,token,resolve=False,key='case'):
        body=dict(idempotency_key=key)
        if resolve:body['reason']='Authoritative provider evidence reviewed'
        return self.client.post(f'/platform/hotels/{self.tenant}/refunds/{refund}/'+('resolve' if resolve else 'claim'),headers=self.headers(token),json=body)

    def test_alternate_channel_needs_manager_and_legacy_endpoint_cannot_bypass(self):
        refund=self.assert_status(self.reserve_route(),201)['refund_id']
        self.assertEqual(self.reconcile(refund).json()['code'],'REFUND_APPROVAL_REQUIRED')
        self.assert_status(self.approve(refund,token=self.admin),403)
        self.assertEqual(self.refund_finish(refund,revision=2).json()['code'],'INVALID_FINANCIAL_SOURCE')
        self.assert_status(self.approve(refund),200)
        self.assertEqual(self.statement().json()['balance']['refund_reserved'],30000)
        self.assertEqual(self.drawer(),(60000,0))

    def test_provider_success_posts_once_without_changing_cash(self):
        refund=self.prepared();self.gateway.set_refund_status(refund,'SUCCEEDED')
        self.assertEqual(self.assert_status(self.reconcile(refund),200)['state'],'COMPLETED')
        self.assertEqual(self.assert_status(self.reconcile(refund),200)['state'],'COMPLETED')
        balance=self.statement().json()['balance'];self.assertEqual((balance['refund_reserved'],balance['refunded'],balance['available']),(0,30000,30000))
        self.assertEqual(self.drawer(),(60000,0))

    def test_failed_unknown_keep_hold_and_final_failure_can_release(self):
        refund=self.prepared()
        for state in ('FAILED','UNKNOWN'):
            self.gateway.set_refund_status(refund,state);self.assert_status(self.reconcile(refund),200)
            self.assertEqual(self.release_route(refund).json()['code'],'REFUND_RELEASE_NOT_PROVEN')
            self.assertEqual(self.statement().json()['balance']['refund_reserved'],30000)
        self.gateway.set_refund_status(refund,'FINAL_FAILED');self.assert_status(self.release_route(refund),200)
        self.assertEqual(self.statement().json()['balance']['available'],60000)

    def test_rejected_alternate_releases_hold_without_external_request(self):
        refund=self.assert_status(self.reserve_route(),201)['refund_id']
        self.assertEqual(self.assert_status(self.approve(refund,False),200)['state'],'RELEASED')
        self.assertEqual(self.store.inspect('refund'),[])
        self.assertEqual(self.statement().json()['balance']['available'],60000)

    def test_cash_routed_hold_blocks_other_spending_and_completes(self):
        refund=self.assert_status(self.reserve_route(channel='CASH'),201)['refund_id']
        self.assertEqual(self.drawer(),(60000,30000))
        response=self.command('refunds/'+refund+'/complete',dict(recipient_confirmation='Guest signed cash receipt',expected_revision=2,idempotency_key='manual'))
        self.assert_status(response,200);self.assertEqual(self.drawer(),(30000,0))

    def test_late_success_freezes_then_platform_posts_shortfall_once(self):
        refund=self.prepared(60000);self.gateway.set_refund_status(refund,'FINAL_FAILED');self.assert_status(self.release_route(refund),200)
        self.assert_status(self.allocate(60000,revision=4),201)
        self.gateway.set_refund_status(refund,'SUCCEEDED');self.assertEqual(self.assert_status(self.reconcile(refund),200)['state'],'LATE_REFUND_SUCCESS')
        self.assertTrue(self.statement().json()['balance']['frozen'])
        self.assertEqual(self.reserve_route(1,revision=6,key='frozen').json()['code'],'FINANCIAL_AGGREGATE_FROZEN')
        self.assert_status(self.case(refund,self.admin),401)
        token=self.platform_token();self.assert_status(self.case(refund,token),200)
        result=self.assert_status(self.case(refund,token,True,'resolve'),200)
        self.assertEqual((result['covered_amount'],result['shortfall_amount'],result['frozen']),(0,60000,False))
        self.assertEqual(self.case(refund,token,True,'resolve').json(),result)
        self.assertEqual(self.statement().json()['balance']['available'],0)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.late_refund_posting WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_late_refund_covered_and_mfa_permission_boundary(self):
        refund=self.prepared();self.gateway.set_refund_status(refund,'FINAL_FAILED');self.assert_status(self.release_route(refund),200)
        self.gateway.set_refund_status(refund,'SUCCEEDED');self.assert_status(self.reconcile(refund),200)
        token=self.platform_token();self.assert_status(self.case(refund,token),200)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.platform_session SET mfa_at=clock_timestamp()-interval '6 minutes' WHERE account_id=%s",(self.platform_id,))
        self.assertEqual(self.case(refund,token,True).json()['code'],'MFA_REQUIRED')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.platform_session SET mfa_at=clock_timestamp() WHERE account_id=%s',(self.platform_id,))
        result=self.assert_status(self.case(refund,token,True,'resolve'),200)
        self.assertEqual((result['covered_amount'],result['shortfall_amount']),(30000,0))
        self.assertEqual(self.statement().json()['balance']['available'],30000)
