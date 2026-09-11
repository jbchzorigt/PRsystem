import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from postgres_support import ADMIN_DSN
from reception_support import ReceptionCase
if ADMIN_DSN:
    import psycopg


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class InitialOpeningTests(ReceptionCase):
    def config(self,drawer=None,token=None,**extra):
        body=dict(code='front',name='Үндсэн касс',physical_location='Reception',expected_float=200000,status='ACTIVE',expected_revision=0,idempotency_key='configure')
        body.update(extra)
        path=f'/hotels/{self.tenant}/cash/drawers'+(f'/{drawer}/configure' if drawer else '')
        return self.client.post(path,headers=self.headers(token or self.admin),json=body)

    def opening(self,drawer,actual=190000,key='open',token=None,**extra):
        return self.client.post(f'/hotels/{self.tenant}/cash/drawers/{drawer}/open',headers=self.headers(token or self.worker_token),json=dict(actual=actual,idempotency_key=key,**extra))

    def test_physical_float_opens_shift_once_and_variance_is_separate_review(self):
        configured=self.config();self.assertEqual(configured.status_code,201,configured.text)
        drawer=configured.json()['drawer_id'];opened=self.opening(drawer)
        self.assertEqual(opened.status_code,201,opened.text)
        self.assertEqual(opened.json()['variance'],-10000);self.assertEqual(opened.json()['review_state'],'ADMIN_REQUIRED')
        self.assertEqual(self.opening(drawer).json(),opened.json())
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT posted,reserved FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s',(self.tenant,drawer)).fetchone(),(190000,0))
            self.assertEqual(conn.execute('SELECT owner_id,opening_actual,state FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,opened.json()['shift_id'])).fetchone(),(self.worker,190000,'OPEN'))
            self.assertEqual(conn.execute('SELECT kind,posted_delta FROM prsystem.cash_event WHERE tenant_id=%s',(self.tenant,)).fetchall(),[('INITIAL_FLOAT',190000)])
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cash_outbox WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
        body=dict(expected_revision=0,idempotency_key='review',reason='Initial variance checked')
        path=f'/hotels/{self.tenant}/cash/drawers/{drawer}/opening-review/approve'
        self.assertEqual(self.client.post(path,headers=self.headers(self.manager_token),json=body).status_code,403)
        self.assertEqual(self.client.post(path,headers=self.headers(self.admin),json=body).json()['review_state'],'APPROVED')

    def test_zero_opening_has_snapshot_but_no_zero_money_movement(self):
        drawer=self.config(expected_float=0).json()['drawer_id']
        result=self.opening(drawer,0);self.assertEqual(result.status_code,201,result.text)
        self.assertEqual(result.json()['review_state'],'NOT_REQUIRED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT actual FROM prsystem.cash_initial_opening WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cash_event WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_admin_and_reception_responsibilities_are_separate(self):
        self.assertEqual(self.config(token=self.manager_token).status_code,403)
        self.assertEqual(self.config(token=self.worker_token).status_code,403)
        drawer=self.config().json()['drawer_id']
        self.assertEqual(self.opening(drawer,token=self.admin).status_code,403)
        self.assertEqual(self.opening(drawer,expected_float=1).status_code,422)
        self.assertEqual(self.opening(drawer,actual=True).status_code,422)

    def test_existing_projection_cannot_be_reinitialized(self):
        self.assertEqual(self.config(drawer='a').json()['code'],'DRAWER_ALREADY_USED')
        drawer=self.config().json()['drawer_id'];self.assertEqual(self.opening(drawer).status_code,201)
        self.assertEqual(self.config(drawer=drawer,expected_revision=1,idempotency_key='overwrite').json()['code'],'DRAWER_ALREADY_USED')
        self.assertEqual(self.opening(drawer,key='another').json()['code'],'DRAWER_ALREADY_USED')

    def test_configuration_revision_and_case_insensitive_code_guard(self):
        original=self.config();drawer=original.json()['drawer_id']
        self.assertEqual(self.config().json(),original.json())
        self.assertEqual(self.config(code='FRONT',idempotency_key='duplicate').json()['code'],'LOCATION_CODE_EXISTS')
        self.assertEqual(self.config(drawer=drawer,idempotency_key='stale').json()['code'],'REVISION_CONFLICT')
        updated=self.config(drawer=drawer,expected_float=150000,expected_revision=1,idempotency_key='edit')
        self.assertEqual(updated.json()['revision'],2)
        self.assertEqual(self.opening(drawer,150000).json()['variance'],0)

    def test_inactive_expired_and_security_suspended_drawer_do_not_open(self):
        drawer=self.config(status='INACTIVE').json()['drawer_id']
        self.assertEqual(self.opening(drawer).json()['code'],'DRAWER_NOT_CONFIGURED')
        self.config(drawer=drawer,expected_revision=1,idempotency_key='activate')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=now()-interval '3 days' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.opening(drawer).json()['code'],'SUBSCRIPTION_EXPIRED')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.opening(drawer).json()['code'],'SECURITY_SUSPENDED')

    def test_two_receptionists_cannot_open_the_same_drawer(self):
        drawer=self.config().json()['drawer_id'];barrier=Barrier(2)
        def go(token):barrier.wait();return self.opening(drawer,token=token,key=uuid4().hex).status_code
        with ThreadPoolExecutor(2) as pool:statuses=list(pool.map(go,[self.worker_token,self.replacement_token]))
        self.assertEqual(sorted(statuses),[201,409])
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cash_initial_opening WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_one_receptionist_cannot_open_two_drawers(self):
        first=self.config().json()['drawer_id'];second=self.config(code='other',idempotency_key='other').json()['drawer_id']
        self.assertEqual(self.opening(first).status_code,201)
        self.assertEqual(self.opening(second,key='second').json()['code'],'REPLACEMENT_HAS_OPEN_SHIFT')

    def test_commit_failure_rolls_back_float_shift_history_and_receipt(self):
        drawer=self.config().json()['drawer_id']
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_initial_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected opening commit failure'; END; $$")
            conn.execute('CREATE CONSTRAINT TRIGGER fail_initial_commit AFTER INSERT ON prsystem.cash_initial_opening DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.fail_initial_commit()')
        def cleanup():
            with psycopg.connect(self.owner_dsn) as conn:conn.execute('DROP TRIGGER fail_initial_commit ON prsystem.cash_initial_opening');conn.execute('DROP FUNCTION prsystem.fail_initial_commit()')
        self.addCleanup(cleanup)
        result=self.opening(drawer);self.assertEqual(result.status_code,503,result.text)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT posted FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s',(self.tenant,drawer)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.reception_shift WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cash_event WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertIsNone(conn.execute("SELECT key FROM prsystem.staff_command_receipt WHERE tenant_id=%s AND key='open'",(self.tenant,)).fetchone())
