import unittest
from uuid import uuid4
from datetime import timedelta,datetime,timezone
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase
from test_onboarding import FakeGateway
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from prsystem.auth import StaffAuth
    from prsystem.renewal import RenewalService
    from prsystem.common import DomainError

@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class RenewalTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT,INSERT ON prsystem.subscription_renewal,prsystem.renewal_payment,prsystem.package_entitlement,prsystem.billing_event,prsystem.staff_command_receipt TO {}',
                'GRANT SELECT ON prsystem.hotel_subscription,prsystem.onboarding_payment TO {}',
                'GRANT INSERT ON prsystem.billing_capture TO {}',
                'GRANT UPDATE (expires_at,package_mnt) ON prsystem.hotel_access TO {}',
                'GRANT UPDATE (expires_at,package_floor) ON prsystem.hotel_subscription TO {}',
                'GRANT UPDATE (invoice_id,state) ON prsystem.subscription_renewal TO {}',
                'GRANT UPDATE (applied_at) ON prsystem.package_entitlement TO {}',
            ):conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();self.gateway=FakeGateway();self.flow=RenewalService(StaffAuth(self.app_dsn,self.settings),{'QPAY':self.gateway})
        self.admin=self.token()
        self.expiry=datetime.now(timezone.utc)+timedelta(days=30)
        with psycopg.connect(self.owner_dsn) as conn:
            app,owner=uuid4().hex,uuid4().hex
            conn.execute("INSERT INTO prsystem.onboarding_application (id,access_hash,payload,email,owner_identifier,owner_kind,package_mnt,months) VALUES (%s,%s,'{}',%s,%s,'INDIVIDUAL',25000,1)",(app,app,self.email,owner))
            conn.execute("INSERT INTO prsystem.subscription_owner VALUES (%s,'INDIVIDUAL',%s,%s,'{}')",(owner,owner,self.account))
            conn.execute('INSERT INTO prsystem.hotel_subscription (tenant_id,owner_id,application_id,starts_at,expires_at,package_floor) VALUES (%s,%s,%s,now(),%s,25000)',(self.tenant,owner,app,self.expiry))
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt=25000,expires_at=%s WHERE tenant_id=%s',(self.expiry,self.tenant))

    def invoice(self,package=25000,key='invoice'):
        return self.flow.invoice(self.admin,self.tenant,package,1,'QPAY',key)

    def test_active_higher_renewal_commits_floor_but_defers_entitlement(self):
        invoice=self.invoice(30000);result=self.flow.reconcile(invoice['renewal_id']);self.assertEqual(result['state'],'APPLIED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],25000)
            self.assertEqual(conn.execute('SELECT package_floor FROM prsystem.hotel_subscription WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],30000)
        with self.assertRaisesRegex(DomainError,'PACKAGE_DOWNGRADE_FORBIDDEN'):self.invoice(25000,'lower')
        self.assertEqual(self.flow.apply_due(),0)

    def test_locked_subscription_renewal_reopens_time_but_never_security(self):
        expiry=datetime.now(timezone.utc)-timedelta(days=4)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_subscription SET expires_at=%s WHERE tenant_id=%s',(expiry,self.tenant))
            conn.execute('UPDATE prsystem.hotel_access SET expires_at=%s,security_suspended=true WHERE tenant_id=%s',(expiry,self.tenant))
        invoice=self.invoice(30000);self.assertEqual(self.flow.reconcile(invoice['renewal_id'])['state'],'APPLIED')
        with psycopg.connect(self.owner_dsn) as conn:
            row=conn.execute('SELECT expires_at>now(),security_suspended,package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(self.tenant,)).fetchone()
            self.assertEqual(row,(True,True,30000))

    def test_invoice_replay_and_pending_invoice_prevent_duplicate_provider_calls(self):
        first=self.invoice();self.assertEqual(self.invoice(),first)
        with self.assertRaisesRegex(DomainError,'PAYMENT_ALREADY_PENDING'):self.invoice(key='other')
        self.assertEqual(len(self.gateway.invoices),1)

    def test_duplicate_capture_cannot_extend_twice(self):
        renewal=self.invoice()['renewal_id'];self.flow.reconcile(renewal)
        with psycopg.connect(self.owner_dsn) as conn:before=conn.execute('SELECT expires_at FROM prsystem.hotel_access WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
        self.assertEqual(self.flow.reconcile(renewal)['state'],'APPLIED')
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT expires_at FROM prsystem.hotel_access WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],before)

    def test_stale_paid_invoice_is_reconciliation_not_free_time(self):
        renewal=self.invoice()['renewal_id']
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_subscription SET expires_at=expires_at+interval '1 month' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.flow.reconcile(renewal)['state'],'RECONCILE')

    def test_provider_tampered_amount_rejected(self):
        renewal=self.invoice()['renewal_id'];self.gateway.overrides={'amount':1}
        with self.assertRaisesRegex(DomainError,'PROVIDER_EVIDENCE_INVALID'):self.flow.reconcile(renewal)

    def test_cross_hotel_and_operational_roles_cannot_renew(self):
        with self.assertRaisesRegex(DomainError,'FORBIDDEN'):self.flow.invoice(self.admin,self.other,25000,1,'QPAY','wrong')
        self.update_membership(roles=['MANAGER']);token=self.token()
        with self.assertRaisesRegex(DomainError,'FORBIDDEN'):self.flow.invoice(token,self.tenant,25000,1,'QPAY','manager')

    def test_due_entitlement_only_applies_once_and_never_downgrades(self):
        renewal=self.invoice(30000)['renewal_id'];self.flow.reconcile(renewal)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.package_entitlement SET effective_at=now()-interval '1 second' WHERE renewal_id=%s",(renewal,))
        self.assertEqual(self.flow.apply_due(),1);self.assertEqual(self.flow.apply_due(),0)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],30000)
