import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_guest as guest_support


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarNextStayTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();guest_support.MinibarGuestTests.configured(self);self.start()
        self.assert_status(guest_support.MinibarGuestTests.begin(self),200)
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201)
        self.report=self.assert_status(guest_support.MinibarGuestTests.report(self),201)

    def settle(self):guest_support.MinibarGuestTests.settle_and_close(self,self.report)
    def review(self,*a,**kw):return guest_support.MinibarGuestTests.review(self,*a,**kw)
    def stocks(self):return guest_support.MinibarGuestTests.stocks(self)
    def tasks(self):return self.assert_status(self.api('minibar/reconciliation/tasks',token=self.worker_token,method='get'),200)['items']
    def claim(self,task,token=None,**extra):return self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/claim-next-stay',dict({'expected_revision':task['request']['revision']},**extra),token or self.worker_token)

    def apply(self):
        task=self.tasks()[0]
        for line in task['plan']['lines']:
            self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/count',dict(assignment_version=0,action_id=line['action_id'],actual_count=line['baseline_quantity']),self.worker_token),200)
        task=self.tasks()[0]
        return self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/apply',dict(assignment_version=0,expected_revision=task['request']['revision'],physical_transfers_confirmed=True),self.worker_token)

    def test_checkout_automatically_creates_exact_current_version_task_without_stock_effect(self):
        before=self.stocks();self.settle();q=self.read().json()['pending'];task=self.tasks()[0]
        self.assertEqual((q['request_kind'],q['target_version_id'],q['state']),('NEXT_STAY',self.version,'READY_FOR_RECONCILIATION'))
        self.assertTrue(task['claimable']);self.assertIsNone(task['work_state']);self.assertEqual(task['plan']['lines'][0]['quantity'],1)
        self.assertEqual(before,self.stocks())
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT next_stay_checkout_id FROM prsystem.minibar_configuration_request WHERE tenant_id=%s AND id=%s',(self.tenant,q['request_id'])).fetchone()[0],self.stay['stay_id'])

    def test_cleaner_claim_count_and_apply_restock_but_cleaning_remains_required(self):
        self.settle();task=self.tasks()[0];self.assert_status(self.claim(task),201);self.assert_status(self.apply(),200)
        stock=self.stocks();self.assertEqual((stock['warehouse_quantity'],stock['room_quantity'],stock['total_quantity']),(7,2,9))
        self.assertIsNone(self.read().json()['pending']);self.assertEqual(self.tasks(),[])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT cleaning_state FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0],'DIRTY')
            self.assertEqual(conn.execute('SELECT prsystem.minibar_guest_opening(%s,%s,clock_timestamp())',(self.tenant,self.room)).fetchone()[0]['items'][0]['opening_quantity'],2)

    def test_pending_user_configuration_takes_precedence(self):
        pending=self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),201)
        self.settle();self.assertEqual(self.read().json()['pending']['request_id'],pending['request_id'])
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.minibar_configuration_request WHERE tenant_id=%s AND request_kind='NEXT_STAY'",(self.tenant,)).fetchone()[0],0)

    def test_new_publish_does_not_change_the_automatic_target(self):
        # A newly published version is not selected for the already configured room.
        d=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=4,source_version_id=self.version)),201)
        version=d['version']['version_id']
        self.assert_status(self.api(f'minibar/templates/{self.template}/versions/{version}/publish',dict(expected_revision=5)),200)
        self.settle();self.assertEqual(self.read().json()['pending']['target_version_id'],self.version)

    def test_product_retirement_does_not_obstruct_checkout_or_create_new_refill(self):
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.minibar_product SET status='RETIRING',deactivation_requested_at=clock_timestamp() WHERE tenant_id=%s AND id=%s",(self.tenant,self.product))
        self.settle();self.assertEqual(self.tasks(),[]);self.assertIsNone(self.read().json()['pending'])

    def test_missing_physical_count_cannot_post_stock(self):
        self.settle();self.assert_status(self.claim(self.tasks()[0]),201)
        # A missing physical count alone cannot be interpreted as a completed refill.
        t=self.tasks()[0];before=self.stocks()
        result=self.api(f'minibar/reconciliation/tasks/{t["task_id"]}/apply',dict(assignment_version=0,expected_revision=t['request']['revision'],physical_transfers_confirmed=True),self.worker_token)
        self.assertEqual(result.json()['code'],'COUNT_REQUIRED');self.assertEqual(self.stocks(),before)

    def test_claim_replay_and_competing_cleaner_do_not_duplicate_work(self):
        self.settle();task=self.tasks()[0];key=uuid4().hex
        first=self.assert_status(self.claim(task,idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.claim(task,idempotency_key=key),201),first)
        _,cleaner=self.add_staff(['CLEANER']);self.assert_status(self.claim(task,cleaner),403)
        self.assert_status(self.claim(task,expected_revision=999),409)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_open_work WHERE tenant_id=%s AND source_id=%s AND kind='CLEANING_TASK'",(self.tenant,task['task_id'])).fetchone()[0],1)

    def test_manager_without_cleaner_cannot_claim(self):
        self.settle();self.assert_status(self.claim(self.tasks()[0],self.manager_token),403)

    def test_concurrent_claims_have_single_winner(self):
        self.settle();task=self.tasks()[0];gate=Barrier(2)
        def claim():gate.wait();return self.claim(task)
        with ThreadPoolExecutor(max_workers=2) as pool:responses=[r.result() for r in(pool.submit(claim),pool.submit(claim))]
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])

    def test_full_room_after_corrected_no_consumption_creates_no_refill_task(self):
        self.assert_status(self.review(),200);self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self,1),201)
        self.report=self.assert_status(guest_support.MinibarGuestTests.report(self,actual=2,revision=1),201)
        self.assert_status(self.allocate(60000,revision=self.report['balance']['revision']),201)
        revision=self.statement().json()['balance']['revision']
        self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=20000,charge_id=self.stay['room_charge_id'],expected_revision=revision,idempotency_key=uuid4().hex)),201)
        revision=self.statement().json()['balance']['revision']
        self.assert_status(self.command('checkout',dict(expected_revision=revision,idempotency_key=uuid4().hex)),200)
        self.assertEqual(self.tasks(),[]);self.assertIsNone(self.read().json()['pending'])

    def test_database_next_stay_request_requires_checkout_lineage(self):
        self.settle();q=self.read().json()['pending']
        self.assert_status(self.cancel(q),200)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.tenant,))
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute("""INSERT INTO prsystem.minibar_configuration_request(tenant_id,id,room_id,target_mode,target_template_id,target_version_id,
                    source_snapshot,target_snapshot,state,requested_by,reason,request_kind) VALUES(%s,%s,%s,'ON',%s,%s,'{}','{}','READY_FOR_RECONCILIATION',%s,'Invalid lineage','NEXT_STAY')""",
                    (self.tenant,uuid4().hex,self.room,self.template,self.version,self.worker))
