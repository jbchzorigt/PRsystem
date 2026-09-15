import unittest
from uuid import uuid4
from operation_support import OperationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.auth import StaffAuth
    from prsystem.subscription_contact import SubscriptionContact
    from prsystem.mock_providers import MockPhoneGateway,MockContactNoticeGateway


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class SubscriptionContactTests(OperationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.subscription_contact_change,prsystem.subscription_contact_challenge,prsystem.subscription_contact_verified,prsystem.subscription_contact_exception,prsystem.subscription_contact,prsystem.subscription_contact_notice,prsystem.subscription_contact_notice_result,prsystem.staff_command_receipt TO {}',
                'GRANT UPDATE(state) ON prsystem.subscription_contact_change TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();self.phone=MockPhoneGateway(self.store);self.notices=MockContactNoticeGateway(self.store)
        self.cc=TestClient(create_app(self.app_dsn,self.settings,runtime_mode='test',phone_gateway=self.phone,platform_secret_resolver=lambda ref:self.key,contact_notice_gateway=self.notices),client=(uuid4().hex,12345));self.addCleanup(self.cc.close)
        self.ct=self.token()

    def contact(self,tail='',data=None):
        path=f'/hotels/{self.tenant}/subscription/contact'+tail
        return self.cc.get(path,headers=self.headers(self.ct)) if data is None else self.cc.post(path,headers=self.headers(self.ct),json=data)

    def start_contact(self):
        return self.ok(self.contact('/changes',dict(new_phone='88112233',password=self.password,idempotency_key=uuid4().hex)),201)['request_id']

    def prove(self,request,side):
        path='/changes/'+request+'/'+side
        result=self.ok(self.contact(path+'/challenge',dict(idempotency_key=uuid4().hex)),202)
        with self.store.connect() as conn:code=conn.execute('SELECT code FROM mock_phone WHERE challenge=?',(result['challenge_id'],)).fetchone()[0]
        return self.contact(path+'/verify',dict(code=code))

    def finish_contact(self,request,key=None):
        return self.contact('/changes/'+request+'/complete',dict(reviewed=True,idempotency_key=key or uuid4().hex))

    def test_both_proofs_required_and_old_contacts_notified(self):
        request=self.start_contact();self.ok(self.prove(request,'NEW'))
        self.assertEqual(self.finish_contact(request).json()['code'],'PHONE_PROOF_REQUIRED')
        self.ok(self.prove(request,'OLD'));key=uuid4().hex
        result=self.ok(self.finish_contact(request,key));self.assertEqual(self.ok(self.finish_contact(request,key)),result)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT revision,phone FROM prsystem.subscription_contact WHERE tenant_id=%s',(self.tenant,)).fetchone(),(1,'+97688112233'))
            self.assertEqual(conn.execute('SELECT channel,recipient FROM prsystem.subscription_contact_notice WHERE tenant_id=%s ORDER BY channel',(self.tenant,)).fetchall(),[('EMAIL',self.email),('SMS','+97699112233')])
            self.assertEqual(conn.execute("SELECT original_contact->>'phone' FROM prsystem.subscription_owner WHERE id=(SELECT owner_id FROM prsystem.hotel_subscription WHERE tenant_id=%s)",(self.tenant,)).fetchone()[0],'99112233')
        worker=SubscriptionContact(StaffAuth(self.app_dsn,self.settings),None,None,self.notices)
        self.assertEqual(len(worker.notice_once(self.tenant)),2);self.assertEqual(worker.notice_once(self.tenant),[])

    def test_bad_password_cannot_start_contact_change(self):
        self.assertEqual(self.contact('/changes',dict(new_phone='88112233',password='wrong',idempotency_key=uuid4().hex)).status_code,401)

    def test_resend_limit_and_five_attempts_persist(self):
        request=self.start_contact();path='/changes/'+request+'/NEW';challenge=self.ok(self.contact(path+'/challenge',dict(idempotency_key=uuid4().hex)),202)
        self.assertEqual(self.contact(path+'/challenge',dict(idempotency_key=uuid4().hex)).json()['code'],'RATE_LIMITED')
        with self.store.connect() as conn:code=conn.execute('SELECT code FROM mock_phone WHERE challenge=?',(challenge['challenge_id'],)).fetchone()[0]
        wrong='111111' if code!='111111' else '222222'
        for _ in range(5):self.assertEqual(self.contact(path+'/verify',dict(code=wrong)).status_code,401)
        self.assertEqual(self.contact(path+'/verify',dict(code=code)).status_code,401)

    def test_operation_cannot_skip_old_phone_proof(self):
        request=self.start_contact();self.ok(self.prove(request,'NEW'))
        response=self.command(f'hotels/{self.tenant}/contact-changes/{request}/exception',dict(reason='Алдсан',reference='CASE-1'))
        self.assertEqual(response.status_code,403)
        self.assertEqual(self.finish_contact(request).json()['code'],'PHONE_PROOF_REQUIRED')

    def test_exception_still_requires_new_phone_proof(self):
        request=self.start_contact()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.platform_account SET permissions=permissions||ARRAY['SUBSCRIPTION_CONTACT_CHANGE_APPROVE'] WHERE id=%s",(self.pid,))
            # Restore session revision only for this fixture's newly granted permission.
            conn.execute('UPDATE prsystem.platform_session SET revision=(SELECT revision FROM prsystem.platform_account WHERE id=%s) WHERE account_id=%s',(self.pid,self.pid))
        self.ok(self.command(f'hotels/{self.tenant}/contact-changes/{request}/exception',dict(reason='Өмчлөгчийн баримтыг шалгасан',reference='CASE-2')))
        self.assertEqual(self.finish_contact(request).json()['code'],'PHONE_PROOF_REQUIRED')
        self.ok(self.prove(request,'NEW'));self.ok(self.finish_contact(request))

    def test_contact_commit_updates_operation_recipient_and_stales_old_draft(self):
        draft=self.preview();request=self.start_contact();self.ok(self.prove(request,'OLD'));self.ok(self.prove(request,'NEW'));self.ok(self.finish_contact(request))
        self.assertEqual(self.command('sms/'+draft['draft_id']+'/send',dict(reviewed=True)).json()['code'],'SMS_PREVIEW_STALE')
        self.assertEqual(self.preview()['quote']['recipient_count'],2)
