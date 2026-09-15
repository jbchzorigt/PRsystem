import tempfile
import unittest
from datetime import datetime,timezone
from pathlib import Path
from uuid import uuid4
from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.auth import StaffAuth
    from prsystem.platform import PlatformService
    from prsystem.operation_dashboard import OperationDashboard
    from prsystem.mock_providers import MockStore,MockSMSGateway,MockEbarimtGateway
    from prsystem.mfa import totp


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class OperationCase(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT ON prsystem.subscription_contact TO {}',
                'GRANT SELECT,INSERT ON prsystem.platform_session,prsystem.platform_receipt,prsystem.platform_event TO {}',
                'GRANT SELECT,UPDATE(last_totp_counter) ON prsystem.platform_account TO {}',
                'GRANT UPDATE(mfa_at,revoked_at) ON prsystem.platform_session TO {}',
                'GRANT SELECT ON prsystem.hotel_subscription,prsystem.subscription_owner,prsystem.onboarding_application,prsystem.onboarding_attempt,prsystem.onboarding_payment,prsystem.subscription_renewal,prsystem.renewal_payment TO {}',
                'GRANT INSERT ON prsystem.password_reset_request TO {}',
                'GRANT SELECT,INSERT ON prsystem.operation_sms_draft,prsystem.operation_sms_job,prsystem.operation_sms_recipient,prsystem.operation_sms_event,prsystem.operation_billing_job,prsystem.operation_billing_result,prsystem.operation_billing_retry TO {}',
                'GRANT SELECT,INSERT,UPDATE ON prsystem.operation_sms_delivery TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();self.pid=uuid4().hex;self.key=b'12345678901234567890'
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.store=MockStore(Path(temp.name)/'providers.sqlite3',environment='test');self.sms=MockSMSGateway(self.store);self.ebarimt=MockEbarimtGateway(self.store)
        self.oc=TestClient(create_app(self.app_dsn,self.settings,runtime_mode='test',platform_secret_resolver=lambda ref:self.key,sms_gateway=self.sms,ebarimt_gateway=self.ebarimt),client=(uuid4().hex,12345));self.addCleanup(self.oc.close)
        auth=StaffAuth(self.app_dsn,self.settings);self.service=OperationDashboard(auth,PlatformService(auth,lambda ref:self.key),sms=self.sms,ebarimt=self.ebarimt)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.platform_account(id,email,password_hash,permissions,mfa_key_ref) VALUES(%s,%s,%s,ARRAY['OPERATION_READ','SUBSCRIPTION_REMINDER_SEND','SUBSCRIPTION_PASSWORD_RESET_INITIATE','SUBSCRIPTION_EBARIMT_RETRY','SUBSCRIPTION_PAYMENT_RECONCILE'],%s)",(self.pid,self.pid+'@example.test',self.password_hash,self.pid))
            for tenant in [self.tenant,self.other]:
                app,owner,attempt=[uuid4().hex for _ in range(3)]
                conn.execute("INSERT INTO prsystem.onboarding_application(id,access_hash,payload,email,owner_identifier,owner_kind,package_mnt,months,state,tenant_id) VALUES(%s,%s,%s,%s,%s,'INDIVIDUAL',30000,1,'PROVISIONED',%s)",(app,uuid4().hex,Jsonb(dict(hotel_name='Operation '+tenant,address='Улаанбаатар')),self.email,uuid4().hex,tenant))
                conn.execute("INSERT INTO prsystem.subscription_owner VALUES(%s,'INDIVIDUAL',%s,%s,%s)",(owner,uuid4().hex,self.account,Jsonb(dict(phone='99112233',email=self.email))))
                conn.execute("INSERT INTO prsystem.hotel_subscription(tenant_id,owner_id,application_id,starts_at,expires_at,package_floor) VALUES(%s,%s,%s,now(),now()+interval '30 days',30000)",(tenant,owner,app))
                conn.execute("INSERT INTO prsystem.onboarding_attempt(id,application_id,provider,merchant_id,invoice_id,amount,state) VALUES(%s,%s,'QPAY','mock',%s,30000,'PAID')",(attempt,app,uuid4().hex))
                conn.execute("INSERT INTO prsystem.onboarding_payment VALUES('QPAY','mock',%s,%s,30000,clock_timestamp(),clock_timestamp())",(uuid4().hex,attempt))
                conn.execute('UPDATE prsystem.onboarding_application SET paid_attempt_id=%s WHERE id=%s',(attempt,app))
                if tenant==self.tenant:self.attempt=attempt
        r=self.oc.post('/platform/auth/login',json=dict(email=self.pid+'@example.test',password=self.password,code=totp(self.key,int(datetime.now(timezone.utc).timestamp())//30)))
        self.assertEqual(r.status_code,200,r.text);self.ot=r.json()['access_token']

    def command(self,path,data=None,key=None,token=None):
        return self.oc.post('/platform/operation/'+path,headers=self.headers(token or self.ot),json={**(data or {}),'idempotency_key':key or uuid4().hex})

    def ok(self,r,status=200):
        self.assertEqual(r.status_code,status,r.text);return r.json()

    def preview(self):
        return self.ok(self.command('sms/preview',dict(filters=dict(tenant_ids=[self.tenant,self.other]),message='Хугацаагаа шалгана уу.')))

    def queued(self):
        draft=self.preview();job=self.ok(self.command('sms/'+draft['draft_id']+'/send',dict(reviewed=True)),202)
        with psycopg.connect(self.owner_dsn) as conn:rid=conn.execute('SELECT id FROM prsystem.operation_sms_recipient WHERE job_id=%s',(job['job_id'],)).fetchone()[0]
        return job,rid
