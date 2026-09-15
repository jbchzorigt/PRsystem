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
class MinibarPartialTests(MinibarConfigurationCase):
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

    def move(self,task,quantity=1,rollback=False,**extra):
        current=self.task(task);line=current['plan']['lines'][0]
        body=dict(assignment_version=task['assignment_version'],expected_revision=current['request']['revision'],
            expected_stock_revision=line['stock_revision'],product_id=self.product,quantity=quantity,physical_transfers_confirmed=True)
        if rollback:body['actual_count']=line['current_quantity']
        body.update(extra)
        return self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/'+('rollback-transfer' if rollback else 'transfer'),body,self.worker_token)

    def finish(self,task,**extra):
        current=self.task(task)
        body=dict(assignment_version=task['assignment_version'],expected_revision=current['request']['revision'],
            observed_counts={i['product_id']:i['baseline_quantity'] for i in current['plan']['lines']},physical_transfers_confirmed=True)
        body.update(extra)
        return self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/complete-rollback',body,self.worker_token)

    def partial(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task)
        self.assert_status(self.move(task),200)
        return task

    def test_partial_then_apply_moves_only_remaining_stock(self):
        task=self.partial()
        stock=self.stocks();self.assertEqual((stock['warehouse_quantity'],stock['room_quantity']),(9,1))
        self.assertEqual(self.read().json()['current']['mode'],'OFF')
        self.assertEqual(self.task(task)['plan']['lines'][0]['quantity'],1)
        self.assert_status(self.apply(task),200)
        self.assertEqual(self.stocks()['room_quantity'],2)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT phase,quantity FROM prsystem.minibar_transfer WHERE tenant_id=%s ORDER BY recorded_at',(self.tenant,)).fetchall(),[('PARTIAL',1),('APPLY',1)])

    def test_cancel_keeps_blocker_until_compensating_count_complete(self):
        task=self.partial();cancelled=self.assert_status(self.cancel(self.task(task)['request']),200)
        self.assertEqual(cancelled['state'],'ROLLBACK_REQUIRED')
        self.assertEqual(self.read().json()['pending']['state'],'ROLLBACK_REQUIRED')
        self.assertEqual(self.apply(task).json()['code'],'ROLLBACK_REQUIRED')
        self.assertEqual(self.finish(task).json()['code'],'COUNT_VARIANCE')
        self.assert_status(self.move(task,rollback=True),200)
        self.assertIsNotNone(self.read().json()['pending'])
        self.assertEqual(self.finish(task,observed_counts={self.product:1}).json()['code'],'COUNT_VARIANCE')
        result=self.assert_status(self.finish(task),200);self.assertEqual(result['state'],'ROLLED_BACK')
        self.assertIsNone(self.read().json()['pending']);self.assertEqual(self.read().json()['current']['mode'],'OFF')
        self.assertEqual((self.stocks()['warehouse_quantity'],self.stocks()['room_quantity']),(10,0))
        self.assert_status(self.request(),201)

    def test_no_movement_cancel_is_terminal_without_rollback(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task)
        self.assertEqual(self.assert_status(self.cancel(self.task(task)['request']),200)['state'],'CANCELLED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_rollback_request WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_stale_or_excess_movement_leaves_inventory_unchanged(self):
        task=self.partial()
        for extra,code in [({'expected_revision':1},'REVISION_CONFLICT'),({'expected_stock_revision':999},'REVISION_CONFLICT'),({'assignment_version':99},'REVISION_CONFLICT')]:
            self.assertEqual(self.move(task,**extra).json()['code'],code)
        self.assertEqual(self.move(task,quantity=2).json()['code'],'REMAINING_ACTION_EXCEEDED')
        self.assertEqual(self.stocks()['room_quantity'],1)

    def test_idempotent_retry_does_not_move_twice(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task)
        revision=self.task(task)['request']['revision'];key=uuid4().hex
        a=self.assert_status(self.move(task,idempotency_key=key,expected_revision=revision),200)
        b=self.assert_status(self.move(task,idempotency_key=key,expected_revision=revision),200)
        self.assertEqual(a,b);self.assertEqual(self.stocks()['room_quantity'],1)
        self.assertEqual(self.move(task,quantity=2,idempotency_key=key,expected_revision=revision).json()['code'],'IDEMPOTENCY_CONFLICT')

    def test_rollback_count_variance_requires_reasoned_manager_adjustment(self):
        task=self.partial();self.assert_status(self.cancel(self.task(task)['request']),200)
        self.assertEqual(self.move(task,rollback=True,actual_count=0).json()['code'],'COUNT_VARIANCE')
        self.assertEqual(self.stocks()['room_quantity'],1)
        # The rollback endpoint cannot invent stock or a waste accounting entry.
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.minibar_transfer WHERE tenant_id=%s AND phase='ROLLBACK'",(self.tenant,)).fetchone()[0],0)

    def test_manager_cannot_execute_cleaner_physical_work(self):
        task=self.partial();t=self.task(task)
        result=self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/transfer',dict(assignment_version=0,expected_revision=t['request']['revision'],expected_stock_revision=1,product_id=self.product,quantity=1,physical_transfers_confirmed=True))
        self.assertEqual(result.status_code,403)

    def test_forged_terminal_transition_and_history_mutation_rejected(self):
        task=self.partial();request=self.task(task)['request']['request_id']
        for statement in ["UPDATE prsystem.minibar_configuration_request SET state='ROLLED_BACK',revision=revision+1 WHERE tenant_id=%s",
                          "DELETE FROM prsystem.minibar_transfer WHERE tenant_id=%s",
                          "UPDATE prsystem.minibar_execution_step SET observed_counts='{}' WHERE tenant_id=%s"]:
            with self.assertRaises(psycopg.Error),psycopg.connect(self.owner_dsn) as conn:conn.execute(statement,(self.tenant,))

    def test_partial_without_count_is_blocked(self):
        task=self.assert_status(self.prepare(),201)
        self.assertEqual(self.move(task).json()['code'],'COUNT_REQUIRED')

    def test_physical_confirmation_is_required(self):
        task=self.partial();self.assertEqual(self.move(task,physical_transfers_confirmed=False).status_code,422)
