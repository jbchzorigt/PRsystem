import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarReconciliationTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def prepare(self,request=None,assignee=None,token=None):
        request=request or self.assert_status(self.request(),201)
        return self.api(f'minibar/configuration-requests/{request["request_id"]}/prepare',dict(expected_revision=request['revision'],assignee_id=assignee or self.worker),token)

    def task(self,task,token=None):
        result=self.assert_status(self.api('minibar/reconciliation/tasks',token=token or self.worker_token,method='get'),200)
        return next(t for t in result['items'] if t['task_id']==task['task_id'])

    def count_all(self,task,actual=None,token=None):
        detail=self.task(task,token)
        for line in detail['plan']['lines']:
            if line['actual_count'] is not None:continue
            self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/count',dict(assignment_version=task['assignment_version'],action_id=line['action_id'],actual_count=line['baseline_quantity'] if actual is None else actual),token or self.worker_token),200)
        return self.task(task,token)

    def apply(self,task,token=None,key=None,revision=None):
        revision=revision if revision is not None else self.task(task,token)['request']['revision']
        return self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/apply',dict(assignment_version=task['assignment_version'],expected_revision=revision,physical_transfers_confirmed=True,idempotency_key=key or uuid4().hex),token or self.worker_token)

    def stocks(self):
        return self.assert_status(self.api('minibar/products',method='get'),200)['items'][0]

    def test_counts_transfers_apply_preserve_total_cost_and_cleanliness(self):
        task=self.assert_status(self.prepare(),201)
        self.assertEqual(self.apply(task).json()['code'],'COUNT_REQUIRED')
        self.count_all(task)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.room SET cleaning_state='DIRTY' WHERE tenant_id=%s",(self.tenant,))
        result=self.assert_status(self.apply(task),200)
        self.assertEqual(result['state'],'APPLIED')
        stock=self.stocks();self.assertEqual((stock['warehouse_quantity'],stock['room_quantity'],stock['total_quantity']),(8,2,10))
        self.assertEqual(stock['average_cost'],dict(numerator='1000',denominator='1'))
        data=self.read().json();self.assertIsNone(data['pending']);self.assertEqual(data['current']['configuration']['version_id'],self.version)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT cleaning_state,minibar_mode FROM prsystem.room WHERE tenant_id=%s',(self.tenant,)).fetchone(),('DIRTY','ON'))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_charge WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
        self.assert_status(self.cancel(dict(request_id=result['request_id'],revision=result['revision'])),409)

    def test_purchase_after_room_transfer_uses_total_owned_quantity(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task);self.assert_status(self.apply(task),200)
        purchase=self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=5,unit_cost_mnt=2000,expected_revision=1,reference='restock')),201)
        self.assertEqual((purchase['warehouse_quantity'],purchase['room_quantity'],purchase['total_quantity']),(13,2,15))
        self.assertEqual(purchase['average_cost'],dict(numerator='4000',denominator='3'))
        ledger=self.assert_status(self.api(f'minibar/products/{self.product}/ledger',method='get'),200)['items']
        self.assertEqual((ledger[-1]['warehouse_quantity'],ledger[-1]['total_quantity']),(13,15))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT cost_value,cost_quantity FROM prsystem.minibar_transfer WHERE tenant_id=%s',(self.tenant,)).fetchone(),(10000,10))

    def test_exact_new_version_returns_excess_then_off_returns_everything(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task);self.assert_status(self.apply(task),200)
        draft=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=4,source_version_id=self.version)),201)
        self.version=draft['version']['version_id']
        self.assert_status(self.api(self.version_path(),dict(expected_revision=5,items=[dict(product_id=self.product,target_quantity=1)]),method='put'),200)
        self.assert_status(self.api(self.version_path()+'/publish',dict(expected_revision=6)),200)
        task=self.assert_status(self.prepare(),201);self.count_all(task);self.assert_status(self.apply(task),200)
        self.assertEqual(self.stocks()['room_quantity'],1)
        request=self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),201)
        task=self.assert_status(self.prepare(request),201);self.count_all(task);self.assert_status(self.apply(task),200)
        self.assertEqual(self.stocks()['warehouse_quantity'],10);self.assertEqual(self.read().json()['current']['mode'],'OFF')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_transfer WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],3)

    def test_shortage_never_posts_partial_plan_and_receipt_unblocks(self):
        second=self.assert_status(self.api('minibar/products',dict(name='Жүүс',category='Ундаа',unit='ш',selling_price_mnt=4000,unit_cost_mnt=2000,opening_quantity=0)),201)['product_id']
        draft=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=4)),201);self.version=draft['version']['version_id']
        self.assert_status(self.api(self.version_path(),dict(expected_revision=5,items=[dict(product_id=self.product,target_quantity=2),dict(product_id=second,target_quantity=1)]),method='put'),200)
        self.assert_status(self.api(self.version_path()+'/publish',dict(expected_revision=6)),200)
        task=self.assert_status(self.prepare(),201);detail=self.count_all(task)
        self.assertEqual(detail['request']['state'],'BLOCKED_STOCK')
        self.assertEqual(self.apply(task).json()['code'],'INSUFFICIENT_STOCK')
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_transfer WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
        self.assert_status(self.api(f'minibar/products/{second}/receipts',dict(quantity=1,unit_cost_mnt=2000,expected_revision=1,reference='fill')),201)
        self.assert_status(self.apply(task),200)

    def test_count_variance_blocks_apply_without_inventory_adjustment(self):
        task=self.assert_status(self.prepare(),201);detail=self.count_all(task,actual=1)
        self.assertEqual(detail['request']['state'],'BLOCKED_VARIANCE')
        self.assertEqual(self.apply(task).json()['code'],'COUNT_VARIANCE')
        self.assertEqual(self.stocks()['warehouse_quantity'],10)
        self.assertEqual(self.read().json()['current']['mode'],'OFF')

    def test_cancel_closes_task_and_new_request_can_prepare(self):
        task=self.assert_status(self.prepare(),201)
        request=self.read().json()['pending'];self.assert_status(self.cancel(request),200)
        self.assertEqual(self.api('minibar/reconciliation/tasks',method='get',token=self.worker_token).json()['items'],[])
        self.assert_status(self.prepare(),201)
        self.assert_status(self.apply(task,revision=request['revision']),409)

    def test_current_cleaner_authority_and_generic_post_cannot_bypass(self):
        request=self.assert_status(self.request(),201)
        self.assert_status(self.prepare(request,token=self.worker_token),403)
        task=self.assert_status(self.prepare(request),201);line=self.task(task)['plan']['lines'][0]
        self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/count',dict(assignment_version=0,action_id=line['action_id'],actual_count=0),self.replacement_token),403)
        generic=self.api(f'cleaning/tasks/{task["task_id"]}/post',dict(expected_revision=0,action_id=line['action_id'],quantity=1,actual_count=0),self.worker_token)
        self.assertEqual(generic.json()['code'],'CANONICAL_TASK_REQUIRED')
        self.assert_status(self.api('minibar/reconciliation/tasks',method='get',token=self.manager_token),403)

    def test_active_stay_safe_point_requires_persisted_checkout(self):
        self.start();request=self.assert_status(self.request(),201)
        self.assertEqual(self.prepare(request).json()['code'],'RECONCILIATION_NOT_READY')
        self.assert_status(self.allocate(60000),201)
        self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=20000,charge_id=self.stay['room_charge_id'],expected_revision=2,idempotency_key='payment')),201)
        self.assert_status(self.command('checkout',dict(expected_revision=3,idempotency_key='checkout')),200)
        task=self.assert_status(self.prepare(request),201);self.count_all(task);self.assert_status(self.apply(task),200)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT cleaning_state FROM prsystem.room WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'DIRTY')

    def test_reassignment_keeps_counts_and_uses_current_task_version(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task)
        self.suspend()
        # The worker owns both a shift and a cleaning task. Suspension returns
        # sorted random exception IDs, not an ordering by work kind.
        with psycopg.connect(self.owner_dsn) as conn:
            exception=conn.execute("""SELECT e.id FROM prsystem.staff_work_exception e
                JOIN prsystem.staff_open_work w ON(w.tenant_id,w.id)=(e.tenant_id,e.work_id)
                WHERE e.tenant_id=%s AND w.kind='CLEANING_TASK' AND w.source_id=%s""",
                (self.tenant,task['task_id'])).fetchone()[0]
        revision=self.claim(exception)
        result=self.assert_status(self.api(f'staff-work/exceptions/{exception}/cleaning/reassign',dict(expected_revision=revision,replacement_id=self.replacement,reason='Үргэлжлүүлэх')),200)
        next_task=dict(task_id=result['task_id'],assignment_version=result['assignment_version'])
        self.assertTrue(self.task(next_task,self.replacement_token)['plan']['counts_match'])
        self.assert_status(self.apply(next_task,self.replacement_token),200)

    def test_applied_retry_and_concurrent_duplicate_do_not_repeat_transfer(self):
        task=self.assert_status(self.prepare(),201);detail=self.count_all(task);revision=detail['request']['revision'];barrier=Barrier(2)
        def go(_):barrier.wait();return self.apply(task,key='apply-once',revision=revision)
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(go,range(2)))
        self.assert_status(results[0],200);self.assertEqual(results[0].json(),results[1].json())
        self.assertEqual(self.stocks()['room_quantity'],2)

    def test_product_deactivation_between_count_and_apply_is_rechecked(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.minibar_product SET status='INACTIVE' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.apply(task).json()['code'],'PRODUCT_NOT_ACTIVE')
        self.assertEqual(self.stocks()['room_quantity'],0)

    def test_commit_failure_rolls_back_transfers_application_pointer_work_and_audit(self):
        task=self.assert_status(self.prepare(),201);detail=self.count_all(task);revision=detail['request']['revision']
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_minibar_apply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_minibar_apply AFTER INSERT ON prsystem.minibar_configuration_application DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_minibar_apply()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.apply(task,key='apply',revision=revision),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_minibar_apply ON prsystem.minibar_configuration_application');conn.execute('DROP FUNCTION prsystem.fail_minibar_apply()')
        self.assertEqual(self.task(task)['request']['revision'],revision);self.assertEqual(self.stocks()['room_quantity'],0)
        with psycopg.connect(self.owner_dsn) as conn:
            for table in ('minibar_transfer','minibar_configuration_application'):
                self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.'+table+' WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.operational_event WHERE tenant_id=%s AND kind='MINIBAR_CONFIGURATION_APPLIED'",(self.tenant,)).fetchone()[0],0)
        self.assert_status(self.apply(task,key='apply',revision=revision),200)

    def test_database_partial_transfer_cannot_commit(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task)
        with self.assertRaisesRegex(psycopg.errors.CheckViolation,'Partial configuration transfers'),psycopg.connect(self.owner_dsn) as conn:
            conn.execute('''INSERT INTO prsystem.minibar_transfer(tenant_id,id,request_id,source_id,task_id,product_id,room_id,actor_id,direction,quantity,warehouse_after,room_after,cost_value,cost_quantity)
                VALUES(%s,'partial',%s,%s,%s,%s,%s,%s,'REFILL',2,8,2,10000,10)''',(self.tenant,task['request_id'],task['source_id'],task['task_id'],self.product,self.room,self.worker))
        self.assertEqual(self.stocks()['room_quantity'],0)

    def test_application_transfer_and_current_pointer_are_immutable(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task);self.assert_status(self.apply(task),200)
        for query in ("DELETE FROM prsystem.minibar_transfer WHERE tenant_id=%s", "DELETE FROM prsystem.minibar_configuration_application WHERE tenant_id=%s", "UPDATE prsystem.room SET minibar_mode='OFF' WHERE tenant_id=%s"):
            with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:conn.execute(query,(self.tenant,))
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.other,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_transfer').fetchone()[0],0)

    def test_two_cleaners_compete_for_same_warehouse_stock_without_negative_balance(self):
        draft=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=4)),201);self.version=draft['version']['version_id']
        self.assert_status(self.api(self.version_path(),dict(expected_revision=5,items=[dict(product_id=self.product,target_quantity=8)]),method='put'),200)
        self.assert_status(self.api(self.version_path()+'/publish',dict(expected_revision=6)),200)
        first=self.assert_status(self.prepare(),201);a=self.count_all(first)
        self.room=self.assert_status(self.api('rooms',dict(number='102',floor='1',category_id=self.category)),201)['room_id']
        second=self.assert_status(self.prepare(assignee=self.replacement),201);b=self.count_all(second,token=self.replacement_token)
        barrier=Barrier(2)
        def go(args):
            task,token,revision=args;barrier.wait();return self.apply(task,token,revision=revision)
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(go,[(first,self.worker_token,a['request']['revision']),(second,self.replacement_token,b['request']['revision'])]))
        self.assertEqual(sorted(r.status_code for r in responses),[200,409])
        self.assertEqual((self.stocks()['warehouse_quantity'],self.stocks()['room_quantity']),(2,8))

    def test_task_payloads_cannot_supply_targets_or_skip_physical_confirmation(self):
        task=self.assert_status(self.prepare(),201);line=self.task(task)['plan']['lines'][0]
        for extra in (dict(actual_count=True),dict(actual_count=-1),dict(target_quantity=99),dict(product_id='foreign')):
            body=dict(assignment_version=0,action_id=line['action_id'],actual_count=0);body.update(extra)
            self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/count',body,self.worker_token),422)
        self.count_all(task)
        self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/apply',dict(assignment_version=0,expected_revision=self.task(task)['request']['revision'],physical_transfers_confirmed=False),self.worker_token),422)
