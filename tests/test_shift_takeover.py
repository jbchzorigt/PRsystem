import unittest
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from postgres_support import ADMIN_DSN
from operational_support import OperationalCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from prsystem.auth import StaffAuth
    from prsystem.shifts import ShiftService
    from prsystem.postgres.connection import transaction
    from prsystem.postgres.cash import PostgresCash
    from prsystem.cash import SpendCash,CashContext
    from prsystem.common import DomainError
    from datetime import datetime,timezone

@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class ShiftTakeoverTests(OperationalCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT,INSERT ON prsystem.cash_shift_reference,prsystem.reception_shift,prsystem.shift_takeover,prsystem.shift_cash_count,prsystem.shift_reconcile_intent,prsystem.transfer_cancel_request TO {}',
                'GRANT SELECT ON prsystem.shift_obligation TO {}',
                'GRANT UPDATE (state) ON prsystem.shift_obligation TO {}',
                'GRANT UPDATE (state,closed_at,review_state) ON prsystem.reception_shift TO {}',
                'GRANT UPDATE (completed_at,new_shift_id,replacement_id) ON prsystem.shift_takeover TO {}',
                'GRANT UPDATE (shift_id,posted,reserved) ON prsystem.cash_drawer TO {}',
                'GRANT UPDATE (revision) ON prsystem.cash_book TO {}',
                'GRANT UPDATE (state) ON prsystem.cash_transfer TO {}',
                'GRANT INSERT ON prsystem.cash_event,prsystem.cash_receipt,prsystem.cash_outbox TO {}',
            ): conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.flow=ShiftService(StaffAuth(self.app_dsn,self.settings))
        with transaction(self.app_dsn) as conn: self.shift=self.flow.register_shift(conn,self.tenant,self.worker,'a')

    def prepare(self,token=None,replacement=None):
        self.exception=self.suspend(); self.claim(self.exception)
        r=self.client.post(f'/hotels/{self.tenant}/staff-work/exceptions/{self.exception}/takeover',headers=self.headers(token or self.manager_token),
            json=dict(expected_revision=1,replacement_id=replacement or self.replacement,idempotency_key='prepare',reason='Staff unavailable'))
        if r.status_code==200: self.takeover=r.json()['takeover_id']
        return r

    def count(self,actual=98000,key='count',token=None):
        return self.client.post(f'/hotels/{self.tenant}/takeovers/{self.takeover}/count',headers=self.headers(token or self.replacement_token),json=dict(actual=actual,idempotency_key=key))

    def close(self,count,key='close',token=None):
        return self.client.post(f'/hotels/{self.tenant}/takeovers/{self.takeover}/close',headers=self.headers(token or self.replacement_token),json=dict(count_id=count,idempotency_key=key))

    def test_close_preserves_history_opens_actual_and_review_is_separate(self):
        p=self.prepare(); self.assertEqual(p.status_code,200,p.text)
        c=self.count(); self.assertEqual(c.status_code,200,c.text)
        self.assertEqual(c.json()['variance'],-2000)
        r=self.close(c.json()['count_id']); self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['opening_actual'],98000)
        self.assertEqual(r.json()['review_state'],'MANAGER_REQUIRED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT owner_id,state,opening_actual FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone(),(self.worker,'CLOSED',100000))
            self.assertEqual(conn.execute('SELECT posted,shift_id FROM prsystem.cash_drawer WHERE tenant_id=%s',(self.tenant,)).fetchone(),(98000,r.json()['new_shift_id']))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cash_event WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT owner_id,state FROM prsystem.staff_open_work WHERE tenant_id=%s AND source_id=%s',(self.tenant,self.shift)).fetchone(),(self.worker,'CLOSED'))
        self.assertEqual(self.close(c.json()['count_id']).json(),r.json())
        review=self.flow.review(self.manager_token,self.tenant,self.shift,'APPROVE','review','Count variance reviewed')
        self.assertEqual(review['review_state'],'APPROVED')

    def test_manager_cannot_physically_count_without_reception(self):
        self.assertEqual(self.prepare().status_code,200)
        self.assertEqual(self.count(token=self.manager_token).status_code,403)
        self.assertEqual(self.count(token=self.worker_token).status_code,401)

    def test_admin_cannot_prepare_without_manager_role(self):
        self.assertEqual(self.prepare(token=self.admin).status_code,403)

    def test_pending_payment_blocks_count_and_only_reconciliation_is_enqueued(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.shift_obligation (tenant_id,id,shift_id,provider_reference) VALUES (%s,'payment',%s,'canonical-provider')",(self.tenant,self.shift))
        self.assertEqual(self.prepare().status_code,200)
        self.assertEqual(self.count().json()['code'],'PENDING_SHIFT_OBLIGATIONS')
        r=self.flow.reconcile(self.replacement_token,self.tenant,self.takeover,'payment','query')
        self.assertEqual(r['status'],'QUEUED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'PENDING')
            conn.execute("UPDATE prsystem.shift_obligation SET state='FAILED' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.count().status_code,200)

    def test_new_obligation_after_suspension_cannot_use_takeover(self):
        self.assertEqual(self.prepare().status_code,200)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.shift_obligation (tenant_id,id,shift_id,provider_reference) VALUES (%s,'late',%s,'late-provider')",(self.tenant,self.shift))
        with self.assertRaisesRegex(DomainError,'OBLIGATION_NOT_ELIGIBLE'):
            self.flow.reconcile(self.replacement_token,self.tenant,self.takeover,'late','late')

    def test_stale_count_revision_cannot_close(self):
        self.prepare(); c=self.count().json()['count_id']
        with psycopg.connect(self.owner_dsn) as conn: conn.execute('UPDATE prsystem.cash_book SET revision=revision+1 WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.close(c).json()['code'],'STALE_CASH_COUNT')
        self.assertEqual(self.close(self.count(key='fresh').json()['count_id']).status_code,200)

    def test_latest_count_required_and_exact_duplicate_returns_same_count(self):
        self.prepare(); c=self.count(); self.assertEqual(self.count().json(),c.json())
        newer=self.count(99000,key='new')
        self.assertEqual(self.close(c.json()['count_id']).status_code,409)
        self.assertEqual(self.close(newer.json()['count_id']).status_code,200)

    def test_concurrent_close_opens_exactly_one_shift(self):
        self.prepare(); count=self.count().json()['count_id']; barrier=Barrier(2)
        def go(_): barrier.wait(); return self.close(count).json()
        with ThreadPoolExecutor(2) as pool: results=list(pool.map(go,range(2)))
        self.assertEqual(results[0],results[1])
        with psycopg.connect(self.owner_dsn) as conn: self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.reception_shift WHERE tenant_id=%s AND state='OPEN'",(self.tenant,)).fetchone()[0],1)

    def test_suspended_old_shift_rejects_new_cash_even_trusted_authorizer(self):
        self.prepare()
        cash=PostgresCash(self.app_dsn,authorize=lambda *_:True)
        with self.assertRaisesRegex(DomainError,'WORK_NOT_OPEN'):
            cash.execute(SpendCash('a',100,'payment','expense'),CashContext(self.tenant,self.worker,'debit',0,datetime.now(timezone.utc),True,self.shift))

    def seed_transfer(self,direction):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.cash_drawer VALUES (%s,'b','sb',50000,0)",(self.tenant,))
            source,destination,ss,ds=('a','b',self.shift,'sb') if direction=='RETURN' else ('b','a','sb',self.shift)
            conn.execute("INSERT INTO prsystem.cash_transfer VALUES (%s,'transfer',%s,%s,%s,%s,10000,'PENDING')",(self.tenant,source,destination,ss,ds))
            conn.execute('UPDATE prsystem.cash_drawer SET reserved=10000 WHERE tenant_id=%s AND id=%s',(self.tenant,source))
            conn.execute("INSERT INTO prsystem.cash_event VALUES (%s,1,0,'TRANSFER_RESERVED','transfer',%s,%s,0,10000,%s,clock_timestamp())",(self.tenant,source,ss,self.manager))
            conn.execute('UPDATE prsystem.cash_book SET revision=1 WHERE tenant_id=%s',(self.tenant,))

    def test_pending_transfer_receive_requires_exact_count_and_original_destination(self):
        self.seed_transfer('RECEIVE'); self.prepare()
        self.assertEqual(self.count().json()['code'],'PENDING_SHIFT_OBLIGATIONS')
        with self.assertRaises(DomainError): self.flow.transfer(self.replacement_token,self.tenant,self.takeover,'transfer','RECEIVE',9000,'receive')
        result=self.flow.transfer(self.replacement_token,self.tenant,self.takeover,'transfer','RECEIVE',10000,'receive')
        self.assertEqual(result['status'],'COMPLETED')
        self.assertEqual(self.count().json()['expected'],110000)

    def test_return_requires_initiator_manager_cancel_then_full_physical_return(self):
        self.seed_transfer('RETURN'); self.prepare()
        with self.assertRaisesRegex(DomainError,'MANAGER_CANCEL_REQUIRED'):
            self.flow.transfer(self.replacement_token,self.tenant,self.takeover,'transfer','RETURN',10000,'return')
        self.flow.cancel_request(self.manager_token,self.tenant,'transfer','cancel','Return to original drawer')
        with self.assertRaises(DomainError): self.flow.transfer(self.replacement_token,self.tenant,self.takeover,'transfer','RETURN',9999,'return')
        result=self.flow.transfer(self.replacement_token,self.tenant,self.takeover,'transfer','RETURN',10000,'return')
        self.assertEqual(result['status'],'CANCELLED')
        self.assertEqual(self.count().json()['expected'],100000)

    def test_ineligible_replacement_recovery_requires_fresh_actor_count(self):
        self.prepare();old_count=self.count().json()['count_id']
        candidate,token=self.add_staff(['RECEPTION'])
        with self.assertRaisesRegex(DomainError,'REPLACEMENT_STILL_ELIGIBLE'):
            self.flow.recover_replacement(self.manager_token,self.tenant,self.takeover,candidate,1,'recover','Replacement unavailable')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.staff_membership SET status='SUSPENDED' WHERE tenant_id=%s AND account_id=%s",(self.tenant,self.replacement))
        result=self.flow.recover_replacement(self.manager_token,self.tenant,self.takeover,candidate,1,'recover','Replacement unavailable')
        self.assertEqual(result['revision'],2)
        self.assertEqual(self.close(old_count,token=token).json()['code'],'STALE_CASH_COUNT')
        new=self.count(key='new',token=token).json()['count_id'];self.assertEqual(self.close(new,token=token).status_code,200)

    def expire(self, boundary=None):
        with psycopg.connect(self.owner_dsn) as conn:
            if boundary == 'shift':
                lock=conn.execute('SELECT opened_at FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone()[0]
            elif boundary == 'transfer':
                lock=conn.execute("SELECT recorded_at FROM prsystem.cash_event WHERE tenant_id=%s AND kind='TRANSFER_RESERVED'",(self.tenant,)).fetchone()[0]
            else:
                lock=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours' WHERE tenant_id=%s",(lock,self.tenant))

    def test_expired_queue_claim_takeover_closes_without_new_shift_or_income(self):
        self.exception=self.suspend();self.expire()
        queue=self.client.get(f'/hotels/{self.tenant}/staff-work/exceptions',headers=self.headers(self.manager_token))
        self.assertEqual(queue.status_code,200,queue.text)
        self.assertEqual([r['id'] for r in queue.json()],[self.exception])
        self.claim(self.exception)
        prepared=self.flow.prepare(self.manager_token,self.tenant,self.exception,1,self.replacement,'prepare','Close existing work')
        self.takeover=prepared['takeover_id']
        counted=self.count();self.assertEqual(counted.status_code,200,counted.text)
        result=self.close(counted.json()['count_id']);self.assertEqual(result.status_code,200,result.text)
        self.assertIsNone(result.json()['new_shift_id']);self.assertIsNone(result.json()['opening_actual'])
        self.assertEqual(result.json()['closing_actual'],98000)
        self.assertEqual(self.close(counted.json()['count_id']).json(),result.json())
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.reception_shift WHERE tenant_id=%s AND state='OPEN'",(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT shift_id,posted FROM prsystem.cash_drawer WHERE tenant_id=%s',(self.tenant,)).fetchone(),(self.shift,98000))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cash_event WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
        self.assertEqual(self.flow.review(self.manager_token,self.tenant,self.shift,'APPROVE','review','Variance investigated')['review_state'],'APPROVED')
        with self.assertRaisesRegex(DomainError,'SUBSCRIPTION_EXPIRED'):
            with transaction(self.app_dsn) as conn:self.flow.register_shift(conn,self.tenant,self.replacement,'a')
        with self.assertRaisesRegex(DomainError,'WORK_NOT_OPEN'):
            PostgresCash(self.app_dsn,authorize=lambda *_:True).execute(SpendCash('a',1,'late','expense'),CashContext(self.tenant,self.replacement,'late',1,datetime.now(timezone.utc),True,self.shift))

    def test_exact_lock_timestamp_is_not_an_existing_shift(self):
        self.prepare();self.expire('shift')
        self.assertEqual(self.count().json()['code'],'SUBSCRIPTION_EXPIRED')
        queue=self.client.get(f'/hotels/{self.tenant}/staff-work/exceptions',headers=self.headers(self.manager_token))
        self.assertEqual(queue.status_code,200,queue.text);self.assertEqual(queue.json(),[])
        with self.assertRaisesRegex(DomainError,'SUBSCRIPTION_EXPIRED'):
            self.flow.prepare(self.manager_token,self.tenant,self.exception,1,self.replacement,'prepare','Staff unavailable')

    def test_expiry_completion_does_not_bypass_hotel_security_or_reception_role(self):
        self.prepare();self.expire()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.count().json()['code'],'SECURITY_SUSPENDED')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=false WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.count(token=self.manager_token).status_code,403)
        self.assertEqual(self.count().status_code,200)

    def test_expired_original_transfer_can_be_returned_then_closed(self):
        self.seed_transfer('RETURN');self.prepare();self.expire()
        self.assertEqual(self.count().json()['code'],'PENDING_SHIFT_OBLIGATIONS')
        self.flow.cancel_request(self.manager_token,self.tenant,'transfer','cancel','Return existing transfer')
        self.assertEqual(self.flow.transfer(self.replacement_token,self.tenant,self.takeover,'transfer','RETURN',10000,'return')['status'],'CANCELLED')
        result=self.close(self.count().json()['count_id'])
        self.assertEqual(result.status_code,200,result.text);self.assertIsNone(result.json()['new_shift_id'])

    def test_old_shift_cannot_authorize_transfer_created_at_lock(self):
        self.seed_transfer('RECEIVE');self.prepare();self.expire('transfer')
        with self.assertRaisesRegex(DomainError,'SUBSCRIPTION_EXPIRED'):
            self.flow.transfer(self.replacement_token,self.tenant,self.takeover,'transfer','RECEIVE',10000,'receive')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.cash_transfer WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'PENDING')

    def test_expiry_reconciliation_requires_original_payment_root(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.shift_obligation (tenant_id,id,shift_id,provider_reference) VALUES (%s,'old',%s,'old-provider')",(self.tenant,self.shift))
            lock=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute("INSERT INTO prsystem.shift_obligation (tenant_id,id,shift_id,provider_reference) VALUES (%s,'new',%s,'new-provider')",(self.tenant,self.shift))
        self.prepare()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours' WHERE tenant_id=%s",(lock,self.tenant))
        self.assertEqual(self.flow.reconcile(self.replacement_token,self.tenant,self.takeover,'old','old')['status'],'QUEUED')
        with self.assertRaisesRegex(DomainError,'SUBSCRIPTION_EXPIRED'):
            self.flow.reconcile(self.replacement_token,self.tenant,self.takeover,'new','new')

    def test_expired_replacement_recovery_still_requires_new_count(self):
        self.prepare();old_count=self.count().json()['count_id'];candidate,token=self.add_staff(['RECEPTION'])
        self.expire()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.staff_membership SET status='SUSPENDED' WHERE tenant_id=%s AND account_id=%s",(self.tenant,self.replacement))
        self.flow.recover_replacement(self.manager_token,self.tenant,self.takeover,candidate,1,'recover','Unavailable replacement')
        self.assertEqual(self.close(old_count,token=token).json()['code'],'STALE_CASH_COUNT')
        result=self.close(self.count(key='fresh',token=token).json()['count_id'],token=token)
        self.assertEqual(result.status_code,200,result.text);self.assertIsNone(result.json()['new_shift_id'])

    def test_recorded_shift_time_and_terminal_close_cannot_be_rewritten(self):
        with self.assertRaises(psycopg.Error):
            with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.reception_shift SET opened_at=opened_at-interval '1 day' WHERE tenant_id=%s",(self.tenant,))
        self.prepare();self.expire();result=self.close(self.count().json()['count_id'])
        self.assertEqual(result.status_code,200,result.text)
        with self.assertRaises(psycopg.Error):
            with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.reception_shift SET state='OPEN',closed_at=NULL WHERE tenant_id=%s AND id=%s",(self.tenant,self.shift))

    def test_disputed_manager_shift_retains_admin_review_requirement(self):
        self.worker,self.worker_token=self.add_staff(['MANAGER','RECEPTION'])
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.cash_drawer VALUES (%s,'managed','manager-shift',200,0)",(self.tenant,))
        with transaction(self.app_dsn) as conn:self.shift=self.flow.register_shift(conn,self.tenant,self.worker,'managed')
        self.prepare();self.expire()
        closed=self.close(self.count(actual=200).json()['count_id'])
        self.assertEqual(closed.status_code,200,closed.text)
        self.assertEqual(closed.json()['review_state'],'ADMIN_REQUIRED')
        self.assertEqual(self.flow.review(self.admin,self.tenant,self.shift,'DISPUTE','dispute','Further evidence needed')['review_state'],'DISPUTED')
        with self.assertRaisesRegex(DomainError,'FORBIDDEN'):
            self.flow.review(self.manager_token,self.tenant,self.shift,'APPROVE','manager-review','Manager reviewed')
        self.assertEqual(self.flow.review(self.admin,self.tenant,self.shift,'APPROVE','admin-review','Evidence resolved')['review_state'],'APPROVED')
