import unittest
from uuid import uuid4
from datetime import datetime,timezone
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from prsystem.auth import StaffAuth
    from prsystem.onboarding import OnboardingService
    from prsystem.staff_lifecycle import StaffLifecycle
    from prsystem.common import DomainError
    from fastapi.testclient import TestClient
    from prsystem.api import create_app

class FakePhone:
    def request(self,phone,challenge):self.challenge=challenge;self.destination=phone
    def verify(self,challenge,code):return challenge==self.challenge and code=='123456'

class FakeGateway:
    merchant_id='test-merchant'
    def __init__(self):self.invoices={};self.states={};self.overrides={}
    def create_invoice(self,attempt,amount,currency):
        self.invoices[attempt]=amount
        return 'invoice-'+attempt
    def payment(self,attempt,invoice):
        return dict(status=self.states.get(attempt,'SUCCEEDED'),merchant_id=self.merchant_id,currency='MNT',amount=self.invoices[attempt],invoice_id='invoice-'+attempt,payment_id='paid-'+attempt,confirmed_at=datetime.now(timezone.utc),**self.overrides) if not self.overrides else {**dict(status='SUCCEEDED',merchant_id=self.merchant_id,currency='MNT',amount=self.invoices[attempt],invoice_id='invoice-'+attempt,payment_id='paid-'+attempt,confirmed_at=datetime.now(timezone.utc)),**self.overrides}

@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class OnboardingTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.token_key=b'key-for-onboarding-tests-only-123456'
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT,INSERT ON prsystem.onboarding_application,prsystem.onboarding_attempt,prsystem.onboarding_payment,prsystem.subscription_owner,prsystem.hotel_subscription,prsystem.onboarding_job,prsystem.onboarding_event TO {}',
                'GRANT INSERT ON prsystem.billing_capture TO {}',
                'GRANT SELECT,INSERT ON prsystem.onboarding_owner_proof TO {}',
                'GRANT UPDATE (challenge_id,verified_at) ON prsystem.onboarding_owner_proof TO {}',
                'GRANT UPDATE (phone_challenge,phone_verified_at,proof_account_id,state,paid_attempt_id,tenant_id) ON prsystem.onboarding_application TO {}',
                'GRANT UPDATE (invoice_id,state) ON prsystem.onboarding_attempt TO {}',
                'GRANT UPDATE (attempts,next_attempt_at,completed_at,last_error_code,lease_token,lease_until) ON prsystem.onboarding_job TO {}',
                'GRANT INSERT (id,email,password_hash,display_name) ON prsystem.staff_account TO {}',
                'GRANT UPDATE (verified_at) ON prsystem.staff_account TO {}',
                'GRANT INSERT ON prsystem.hotel_access,prsystem.staff_membership,prsystem.cash_book,prsystem.cash_drawer,prsystem.cash_shift_reference TO {}',
                'GRANT UPDATE (status) ON prsystem.staff_membership TO {}',
                'GRANT SELECT,INSERT ON prsystem.staff_link,prsystem.staff_mail_intent TO {}',
                'GRANT UPDATE (state) ON prsystem.staff_link TO {}',
            ):conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.auth=StaffAuth(self.app_dsn,self.settings)
        self.links=StaffLifecycle(self.auth,self.token_key)
        self.phone=FakePhone();self.gateway=FakeGateway()
        self.flow=OnboardingService(self.auth,self.links,phone_gateway=self.phone,payment_gateways={'QPAY':self.gateway,'KHAAN':self.gateway})
        self.data=dict(owner_kind='INDIVIDUAL',owner_identifier=uuid4().hex[:12],first_name='Нэр',last_name='Овог',phone='+97699112233',email=uuid4().hex+'@example.com',contact_phone='+97699112233',hotel_name='Test hotel',hotel_phone='+97677112233',district='District',ward='Ward',address='Address',latitude=47.9,longitude=106.9,package_mnt=25000,months=3)
        result=self.flow.create(self.data,self.peer)
        self.app,self.access=result['application_id'],result['access_token']

    def verified(self):
        self.flow.request_phone(self.app,self.access,self.peer)
        self.flow.verify_phone(self.app,self.access,'123456',self.peer)

    def paid(self):
        self.verified();result=self.flow.invoice(self.app,self.access,'QPAY');attempt=result['attempt_id']
        self.assertEqual(self.flow.reconcile(attempt),'PAID');return attempt

    def test_unpaid_and_unverified_cannot_provision(self):
        with self.assertRaisesRegex(DomainError,'PHONE_PROOF_REQUIRED'):self.flow.invoice(self.app,self.access,'QPAY')
        with self.assertRaisesRegex(DomainError,'PAYMENT_REQUIRED'):self.flow.provision(self.app)
        with psycopg.connect(self.owner_dsn) as conn:self.assertIsNone(conn.execute('SELECT id FROM prsystem.staff_account WHERE email=%s',(self.data['email'],)).fetchone())

    def test_payment_then_atomic_provision_pending_primary_activation(self):
        attempt=self.paid();result=self.flow.provision(self.app);self.assertEqual(result['state'],'PROVISIONED')
        self.assertEqual(self.flow.provision(self.app),result)
        with psycopg.connect(self.owner_dsn) as conn:
            member=conn.execute('SELECT account_id,status,roles,is_primary FROM prsystem.staff_membership WHERE tenant_id=%s',(result['tenant_id'],)).fetchone()
            self.assertEqual(member[1:],('PENDING',['HOTEL_ADMIN'],True))
            link=conn.execute("SELECT id FROM prsystem.staff_link WHERE tenant_id=%s AND purpose='ADMIN_ACTIVATION'",(result['tenant_id'],)).fetchone()[0]
            self.assertEqual(conn.execute('SELECT listing_state FROM prsystem.hotel_subscription WHERE tenant_id=%s',(result['tenant_id'],)).fetchone()[0],'UNPUBLISHED')
        envelope=self.links.prepare_delivery(link);self.assertIsNotNone(envelope)
        self.assertEqual(self.flow.accept(envelope.token,self.password,self.peer)['state'],'ACTIVE')
        with self.assertRaisesRegex(DomainError,'INVALID_LINK'):self.flow.accept(envelope.token,self.password,self.peer)
        self.assertEqual(self.auth.login(self.data['email'],self.password,result['tenant_id'],self.peer)['token_type'],'bearer')

    def test_client_cannot_supply_verified_paid_or_price(self):
        for field in ['paid','phone_verified','total_amount','proof_account_id']:
            with self.assertRaisesRegex(DomainError,'INVALID_REQUEST'):self.flow.create(dict(self.data,**{field:True}),self.peer)

    def test_unknown_access_and_wrong_otp_denied(self):
        with self.assertRaisesRegex(DomainError,'UNAUTHENTICATED'):self.flow.request_phone(self.app,'wrong',self.peer)
        self.flow.request_phone(self.app,self.access,self.peer)
        with self.assertRaisesRegex(DomainError,'INVALID_CREDENTIALS'):self.flow.verify_phone(self.app,self.access,'654321',self.peer)

    def test_active_invoice_replay_does_not_create_second_provider_invoice(self):
        self.verified();first=self.flow.invoice(self.app,self.access,'QPAY');second=self.flow.invoice(self.app,self.access,'KHAAN')
        self.assertEqual(first['attempt_id'],second['attempt_id']);self.assertEqual(len(self.gateway.invoices),1)

    def test_wrong_provider_merchant_amount_currency_cannot_mark_paid(self):
        self.verified();attempt=self.flow.invoice(self.app,self.access,'QPAY')['attempt_id']
        for override in [dict(merchant_id='other'),dict(amount=1),dict(currency='USD')]:
            self.gateway.overrides=override
            with self.assertRaisesRegex(DomainError,'PROVIDER_EVIDENCE_INVALID'):self.flow.reconcile(attempt)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.onboarding_payment WHERE attempt_id=%s',(attempt,)).fetchone()[0],0)

    def test_failed_attempt_retry_and_late_second_success_reconciliation(self):
        self.verified();old=self.flow.invoice(self.app,self.access,'QPAY')['attempt_id']
        self.gateway.states[old]='EXPIRED';self.assertEqual(self.flow.reconcile(old),'EXPIRED')
        new=self.flow.invoice(self.app,self.access,'KHAAN')['attempt_id'];self.assertNotEqual(new,old)
        self.gateway.states[old]='SUCCEEDED';self.assertEqual(self.flow.reconcile(old),'PAID')
        self.assertEqual(self.flow.reconcile(new),'RECONCILE')
        first=self.flow.provision(self.app);self.assertEqual(self.flow.provision(self.app),first)

    def test_existing_email_needs_authenticated_proof_before_invoice(self):
        data=dict(self.data,email=self.email.replace('@example.test','@example.com'))
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.staff_account SET email=%s WHERE id=%s',(data['email'],self.account))
        self.email=data['email'];self.app_data=self.flow.create(data,self.peer)
        self.app,self.access=self.app_data['application_id'],self.app_data['access_token'];self.verified()
        self.assertEqual(self.flow.invoice(self.app,self.access,'QPAY')['state'],'OWNER_VERIFICATION_REQUIRED')
        self.flow.prove_account(self.app,self.access,self.token())
        attempt=self.flow.invoice(self.app,self.access,'QPAY')['attempt_id'];self.flow.reconcile(attempt)
        result=self.flow.provision(self.app)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT account_id,status FROM prsystem.staff_membership WHERE tenant_id=%s',(result['tenant_id'],)).fetchone(),(self.account,'ACTIVE'))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.staff_link WHERE tenant_id=%s',(result['tenant_id'],)).fetchone()[0],0)

    def test_existing_account_race_after_payment_requires_proof_without_partial_hotel(self):
        self.paid()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('INSERT INTO prsystem.staff_account (id,email,password_hash,verified_at) VALUES (%s,%s,%s,now())',(uuid4().hex,self.data['email'],self.password_hash))
        self.assertEqual(self.flow.provision(self.app)['state'],'PAID_OWNER_VERIFICATION_REQUIRED')
        with psycopg.connect(self.owner_dsn) as conn:self.assertIsNone(conn.execute('SELECT tenant_id FROM prsystem.onboarding_application WHERE id=%s',(self.app,)).fetchone()[0])

    def test_concurrent_provisioning_one_tenant(self):
        self.paid();barrier=Barrier(2)
        def go(_):barrier.wait();return self.flow.provision(self.app)
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(go,range(2)))
        self.assertEqual(results[0],results[1])

    def test_snapshot_and_payment_are_immutable(self):
        attempt=self.paid()
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.Error):conn.execute('UPDATE prsystem.onboarding_application SET package_mnt=30000 WHERE id=%s',(self.app,))
            conn.rollback()
            with self.assertRaises(psycopg.Error):conn.execute('DELETE FROM prsystem.onboarding_payment WHERE attempt_id=%s',(attempt,))
            conn.rollback()

    def test_provisioning_failure_rolls_back_and_records_retry(self):
        self.paid()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.test_provision_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected failure'; END; $$")
            conn.execute('CREATE CONSTRAINT TRIGGER test_provision_fail AFTER INSERT ON prsystem.hotel_subscription DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.test_provision_fail()')
        try:
            self.assertEqual(self.flow.run_job(self.app)['state'],'PROVISIONING_FAILED')
            with psycopg.connect(self.owner_dsn) as conn:
                self.assertIsNone(conn.execute('SELECT id FROM prsystem.staff_account WHERE email=%s',(self.data['email'],)).fetchone())
                self.assertEqual(conn.execute('SELECT attempts FROM prsystem.onboarding_job WHERE application_id=%s',(self.app,)).fetchone()[0],1)
                conn.execute('DROP TRIGGER test_provision_fail ON prsystem.hotel_subscription')
                conn.execute('UPDATE prsystem.onboarding_job SET next_attempt_at=now() WHERE application_id=%s',(self.app,))
            self.assertEqual(self.flow.run_job(self.app)['state'],'PROVISIONED')
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER IF EXISTS test_provision_fail ON prsystem.hotel_subscription');conn.execute('DROP FUNCTION prsystem.test_provision_fail()')

    def test_missing_provider_configuration_does_not_activate(self):
        flow=OnboardingService(self.auth,self.links)
        with self.assertRaisesRegex(DomainError,'ONBOARDING_UNAVAILABLE'):flow.request_phone(self.app,self.access,self.peer)
        with self.assertRaisesRegex(DomainError,'ONBOARDING_UNAVAILABLE'):flow.invoice(self.app,self.access,'QPAY')

    def test_worker_lease_prevents_parallel_provision_and_exhausted_crash_retry(self):
        self.paid()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.onboarding_job SET lease_token='other-worker',lease_until=now()+interval '1 minute',attempts=1 WHERE application_id=%s",(self.app,))
        self.assertEqual(self.flow.run_job(self.app)['state'],'WAITING')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.onboarding_job SET lease_until=now()-interval '1 second',attempts=5 WHERE application_id=%s",(self.app,))
            conn.execute("UPDATE prsystem.onboarding_application SET state='PROVISIONING' WHERE id=%s",(self.app,))
        self.flow.once()
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.onboarding_application WHERE id=%s',(self.app,)).fetchone()[0],'PROVISIONING_FAILED')
            self.assertIsNone(conn.execute('SELECT id FROM prsystem.staff_account WHERE email=%s',(self.data['email'],)).fetchone())

    def test_owner_challenge_uses_stored_contact_and_preserves_owner_account(self):
        self.paid();self.flow.provision(self.app)
        old_phone=self.data['phone']
        data=dict(self.data,email=uuid4().hex+'@example.com',phone='+97688112233')
        other=self.flow.create(data,self.peer);app,access=other['application_id'],other['access_token']
        self.flow.request_phone(app,access,self.peer);self.flow.verify_phone(app,access,'123456',self.peer)
        self.assertEqual(self.flow.invoice(app,access,'QPAY')['state'],'OWNER_VERIFICATION_REQUIRED')
        self.flow.request_owner(app,access,self.peer);self.assertEqual(self.phone.destination,old_phone)
        self.flow.verify_owner(app,access,'123456',self.peer)
        attempt=self.flow.invoice(app,access,'QPAY')['attempt_id'];self.flow.reconcile(attempt)
        self.assertEqual(self.flow.provision(app)['state'],'PROVISIONED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.subscription_owner WHERE identifier=%s',(self.data['owner_identifier'].upper(),)).fetchone()[0],1)

    def test_http_onboarding_challenge_invoice_status_and_no_forged_evidence(self):
        with TestClient(create_app(self.app_dsn,self.settings,token_key=self.token_key,phone_gateway=self.phone,payment_gateways={'QPAY':self.gateway}),client=(uuid4().hex,12345)) as client:
            r=client.post('/onboarding/applications',json=dict(self.data,paid=True));self.assertEqual(r.status_code,422);self.assertEqual(r.json(),{'code':'INVALID_REQUEST'})
            r=client.post('/onboarding/applications',json=self.data);self.assertEqual(r.status_code,201,r.text)
            app=r.json()['application_id'];headers=self.headers(r.json()['access_token'])
            self.assertEqual(client.post(f'/onboarding/{app}/phone/request',headers=headers).status_code,202)
            self.assertEqual(client.post(f'/onboarding/{app}/phone/verify',headers=headers,json={'code':'123456'}).status_code,200)
            invoice=client.post(f'/onboarding/{app}/invoice/QPAY',headers=headers);self.assertEqual(invoice.status_code,200,invoice.text)
            self.assertEqual(client.get(f'/onboarding/{app}',headers=headers).json()['state'],'PENDING_PAYMENT')
            self.assertEqual(client.get(f'/onboarding/{app}',headers=self.headers(self.access)).status_code,401)

    def test_html_pages_are_packaged_private_and_script_restricted(self):
        for route in ['/staff/accept','/staff/reset','/staff/restaurant-accept','/staff/activate']:
            response=self.client.get(route)
            self.assertEqual(response.status_code,200,response.text)
            self.assertIn('text/html',response.headers['content-type'])
            self.assertEqual(response.headers['cache-control'],'no-store')
            self.assertIn("frame-ancestors 'none'",response.headers['content-security-policy'])
            self.assertIn('lang="mn"',response.text)
        self.assertEqual(self.client.get('/staff/assets/staff.js').status_code,200)
        self.assertEqual(self.client.get('/staff/assets/unexpected.js').status_code,422)

    def test_activation_http_is_purpose_isolated_from_staff_invitation(self):
        self.paid();tenant=self.flow.provision(self.app)['tenant_id']
        with psycopg.connect(self.owner_dsn) as conn:link=conn.execute("SELECT id FROM prsystem.staff_link WHERE tenant_id=%s AND purpose='ADMIN_ACTIVATION'",(tenant,)).fetchone()[0]
        token=self.links.prepare_delivery(link).token
        payload=dict(token=token,password=self.password)
        self.assertEqual(self.client.post('/auth/invitations/accept',json=payload).status_code,400)
        self.assertEqual(self.client.post('/auth/admin/activate',json=payload).status_code,200)
        self.assertEqual(self.client.post('/auth/admin/activate',json=payload).status_code,400)
