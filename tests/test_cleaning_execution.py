import unittest
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from postgres_support import ADMIN_DSN
from operational_support import OperationalCase
if ADMIN_DSN:
    import psycopg
    from prsystem.auth import StaffAuth
    from prsystem.cleaning import CleaningService
    from prsystem.postgres.connection import transaction
    from prsystem.common import DomainError

@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class CleaningExecutionTests(OperationalCase):
    def setUp(self):
        super().setUp()
        self.source=uuid4().hex
        self.flow=CleaningService(StaffAuth(self.app_dsn,self.settings))
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("""INSERT INTO prsystem.cleaning_source
                (tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                VALUES (%s,%s,'201','config-1',7,'CONFIGURATION',%s,'{"product":"water","target":5}')""",(self.tenant,self.source,self.source))
            conn.execute("INSERT INTO prsystem.cleaning_action (tenant_id,source_id,id,kind,product_id,quantity) VALUES (%s,%s,'refill','REFILL','water',5)",(self.tenant,self.source))
            conn.execute("INSERT INTO prsystem.cleaning_stock VALUES (%s,'water','warehouse',20),(%s,'water','room:201',0)",(self.tenant,self.tenant))
        with transaction(self.app_dsn) as conn:
            self.task=self.flow.assign_source(conn,self.tenant,self.source,self.worker)

    def post(self,quantity=2,task=None,token=None,revision=0,key=None,**extra):
        return self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task or self.task}/post',headers=self.headers(token or self.worker_token),
            json=dict(expected_revision=revision,idempotency_key=key or uuid4().hex,action_id='refill',quantity=quantity,**extra))

    def reassign(self,exception,revision=1,token=None,replacement=None,key='reassign'):
        return self.client.post(f'/hotels/{self.tenant}/staff-work/exceptions/{exception}/cleaning/reassign',headers=self.headers(token or self.manager_token),
            json=dict(expected_revision=revision,idempotency_key=key,reason='Replacement shift',replacement_id=replacement or self.replacement))

    def blocked(self):
        e=self.suspend(); self.claim(e); return e

    def test_untouched_task_reassigned_same_id_and_revision_increment(self):
        result=self.reassign(self.blocked())
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual((result.json()['task_id'],result.json()['assignment_version'],result.json()['mode']),(self.task,1,'REASSIGNED'))
        self.assertEqual(self.post().status_code,401)
        self.assertEqual(self.post(token=self.replacement_token).status_code,409)
        self.assertEqual(self.post(5,token=self.replacement_token,revision=1).json()['state'],'DONE')

    def test_partial_movement_creates_continuation_and_retains_original_actor(self):
        first=self.post(key='first'); self.assertEqual(first.status_code,200,first.text)
        result=self.reassign(self.blocked()); self.assertEqual(result.status_code,200,result.text)
        child=result.json()['task_id']; self.assertNotEqual(child,self.task)
        self.assertEqual(result.json()['mode'],'CONTINUATION')
        self.assertEqual(self.post(4,task=child,token=self.replacement_token).json()['code'],'REMAINING_ACTION_EXCEEDED')
        last=self.post(3,task=child,token=self.replacement_token); self.assertEqual(last.json()['state'],'DONE')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT assignee_id,state FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s',(self.tenant,self.task)).fetchone(),(self.worker,'CONTINUED'))
            self.assertEqual(conn.execute('SELECT actor_id,quantity FROM prsystem.cleaning_posting WHERE id=%s',(first.json()['posting_id'],)).fetchone(),(self.worker,2))
            self.assertEqual(conn.execute('SELECT location_id,quantity FROM prsystem.cleaning_stock WHERE tenant_id=%s ORDER BY location_id',(self.tenant,)).fetchall(),[('room:201',5),('warehouse',15)])

    def test_duplicate_post_has_one_movement(self):
        a=self.post(key='same'); b=self.post(key='same')
        self.assertEqual(a.json(),b.json())
        self.assertEqual(self.post(3,key='same').json()['code'],'IDEMPOTENCY_CONFLICT')

    def test_reassignment_replay_and_second_suspension_reuses_queue_safely(self):
        e=self.blocked(); first=self.reassign(e)
        self.assertEqual(self.reassign(e).json(),first.json())
        second=self.suspend(self.replacement)
        self.assertEqual(second,e)
        self.assertEqual(self.claim(second,3),4)

    def test_concurrent_posts_cannot_exceed_remaining(self):
        barrier=Barrier(2)
        def go(_): barrier.wait(); return self.post(3).status_code
        with ThreadPoolExecutor(2) as pool: self.assertEqual(sorted(pool.map(go,range(2))),[200,409])

    def test_concurrent_reassignment_one_continuation(self):
        self.assertEqual(self.post().status_code,200)
        e=self.blocked(); barrier=Barrier(2)
        def go(_): barrier.wait(); return self.reassign(e).json()
        with ThreadPoolExecutor(2) as pool:
            result=list(pool.map(go,range(2)))
        self.assertEqual(result[0],result[1])

    def test_insufficient_stock_rolls_back_post_and_task(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.cleaning_stock SET quantity=1 WHERE tenant_id=%s AND location_id='warehouse'",(self.tenant,))
        self.assertEqual(self.post().json()['code'],'INSUFFICIENT_STOCK')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT completed FROM prsystem.cleaning_action WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cleaning_posting WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_admin_not_manager_and_wrong_claimant_denied(self):
        e=self.suspend()
        self.assertEqual(self.reassign(e,revision=0).json()['code'],'EXCEPTION_NOT_CLAIMED')
        self.claim(e)
        self.assertEqual(self.reassign(e,token=self.admin).status_code,403)

    def test_replacement_needs_same_hotel_active_cleaner(self):
        e=self.blocked()
        self.assertEqual(self.reassign(e,replacement=self.manager).status_code,403)
        other,_=self.add_staff(['CLEANER'],self.other)
        self.assertEqual(self.reassign(e,replacement=other).status_code,403)

    def test_untrusted_action_and_counts_rejected(self):
        self.assertEqual(self.post(actual_count=3).status_code,422)
        self.assertEqual(self.post(quantity=True).status_code,422)
        self.assertEqual(self.post(quantity=6).status_code,409)

    def test_actual_count_forces_continuation_even_without_stock_movement(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.cleaning_action (tenant_id,source_id,id,kind,product_id,quantity) VALUES (%s,%s,'count','COUNT','water',1)",(self.tenant,self.source))
        r=self.flow.post(self.worker_token,self.tenant,self.task,0,'count',1,'count',actual_count=0)
        self.assertEqual(r['state'],'OPEN')
        self.assertEqual(self.reassign(self.blocked()).json()['mode'],'CONTINUATION')

    def test_immutable_source_and_posting_even_owner_cannot_overwrite(self):
        r=self.post(); self.assertEqual(r.status_code,200,r.text)
        for statement,args in [('UPDATE prsystem.cleaning_source SET configuration_version=8 WHERE tenant_id=%s',(self.tenant,)),
                               ('DELETE FROM prsystem.cleaning_posting WHERE id=%s',(r.json()['posting_id'],))]:
            with psycopg.connect(self.owner_dsn) as conn:
                with self.assertRaises(psycopg.errors.CheckViolation): conn.execute(statement,args)
                conn.rollback()

    def test_unknown_source_not_assigned(self):
        with transaction(self.app_dsn) as conn:
            with self.assertRaisesRegex(DomainError,'WORK_SOURCE_NOT_FOUND'):
                self.flow.assign_source(conn,self.tenant,'missing',self.worker)
