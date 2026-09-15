import unittest
from uuid import uuid4
from datetime import datetime,timezone
from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mfa import totp

@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class PlatformRecoveryTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT ON prsystem.platform_account,prsystem.platform_session,prsystem.platform_receipt TO {}',
                'GRANT UPDATE (last_totp_counter) ON prsystem.platform_account TO {}',
                'GRANT UPDATE (mfa_at,revoked_at) ON prsystem.platform_session TO {}',
                'GRANT INSERT ON prsystem.platform_session,prsystem.platform_receipt,prsystem.platform_event TO {}',
            ):conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.platform_id=uuid4().hex; self.mfa_key=b'12345678901234567890'
        self.platform_client=TestClient(create_app(self.app_dsn,self.settings,platform_secret_resolver=lambda ref:self.mfa_key if ref==self.platform_id else None),client=(uuid4().hex,12345))
        self.addCleanup(self.platform_client.close)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.platform_account (id,email,password_hash,permissions,mfa_key_ref) VALUES (%s,%s,%s,ARRAY['SUBSCRIPTION_SUSPEND'],%s)",(self.platform_id,self.platform_id+'@example.com',self.password_hash,self.platform_id))

    def platform_login(self,code=None):
        return self.platform_client.post('/platform/auth/login',json=dict(email=self.platform_id+'@example.com',password=self.password,code=code or totp(self.mfa_key,int(datetime.now(timezone.utc).timestamp())//30)))

    def security(self,token,action='resume',key='recover'):
        return self.platform_client.post(f'/platform/hotels/{self.tenant}/security/{action}',headers=self.headers(token),json=dict(reason='Offline incident review completed',reference='CASE-2026-1',idempotency_key=self.platform_id+key))

    def test_resume_only_clears_security_not_billing_or_membership(self):
        with psycopg.connect(self.owner_dsn) as conn: conn.execute("UPDATE prsystem.hotel_access SET security_suspended=true,expires_at=now()-interval '3 days' WHERE tenant_id=%s",(self.tenant,))
        login=self.platform_login();self.assertEqual(login.status_code,200,login.text)
        token=login.json()['access_token'];r=self.security(token);self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(self.security(token).json(),r.json())
        self.assertEqual(self.cash(self.token()).json()['code'],'SUBSCRIPTION_EXPIRED')

    def test_realms_cannot_use_each_others_sessions(self):
        staff=self.token();self.assertEqual(self.security(staff).status_code,401)
        platform=self.platform_login().json()['access_token'];self.assertEqual(self.me(platform).status_code,401)

    def test_mfa_counter_cannot_replay_even_new_login(self):
        code=totp(self.mfa_key,int(datetime.now(timezone.utc).timestamp())//30)
        self.assertEqual(self.platform_login(code).status_code,200)
        self.assertEqual(self.platform_login(code).status_code,401)

    def test_recent_stepup_required(self):
        token=self.platform_login().json()['access_token']
        with psycopg.connect(self.owner_dsn) as conn: conn.execute("UPDATE prsystem.platform_session SET mfa_at=now()-interval '5 minutes' WHERE account_id=%s",(self.platform_id,))
        r=self.security(token);self.assertEqual(r.json()['code'],'MFA_REQUIRED')

    def test_permission_removal_revokes_session(self):
        token=self.platform_login().json()['access_token']
        with psycopg.connect(self.owner_dsn) as conn: conn.execute("UPDATE prsystem.platform_account SET permissions='{}' WHERE id=%s",(self.platform_id,))
        self.assertEqual(self.security(token).status_code,401)

    def test_account_without_permission_cannot_resume(self):
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.platform_account SET permissions='{}' WHERE id=%s",(self.platform_id,))
        token=self.platform_login().json()['access_token'];self.assertEqual(self.security(token).status_code,403)

    def test_missing_platform_configuration_fails_closed(self):
        self.assertEqual(self.client.post('/platform/auth/login',json=dict(email='a@example.com',password='x',code='123456')).status_code,503)

    def test_audit_retains_platform_actor_and_denial_without_secret(self):
        token=self.platform_login().json()['access_token'];self.assertEqual(self.security(token,'suspend').status_code,200)
        with psycopg.connect(self.owner_dsn) as conn:
            row=conn.execute("SELECT actor_id,details FROM prsystem.platform_event WHERE actor_id=%s AND action='HOTEL_SECURITY_CHANGED'",(self.platform_id,)).fetchone()
            self.assertEqual(row[0],self.platform_id);self.assertNotIn(token,str(row[1]));self.assertEqual(row[1]['reference'],'CASE-2026-1')

    def test_logout_revokes_platform_session_without_fresh_mfa(self):
        token=self.platform_login().json()['access_token']
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.platform_session SET mfa_at=now()-interval '6 minutes' WHERE account_id=%s",(self.platform_id,))
        response=self.platform_client.post('/platform/auth/logout',headers=self.headers(token),json={})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.security(token).status_code,401)
