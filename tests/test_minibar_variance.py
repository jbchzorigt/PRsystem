import unittest
from uuid import uuid4
from fractions import Fraction
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_reconciliation as reconciliation_support
    from prsystem.minibar_adjustments import MinibarAdjustments
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarVarianceTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT INSERT ON prsystem.minibar_count_resolution,prsystem.minibar_count_resolution_posting,prsystem.minibar_adjustment TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def prepare(self,*args,**kwargs):return reconciliation_support.MinibarReconciliationTests.prepare(self,*args,**kwargs)
    def task(self,*args,**kwargs):return reconciliation_support.MinibarReconciliationTests.task(self,*args,**kwargs)
    def count_all(self,*args,**kwargs):return reconciliation_support.MinibarReconciliationTests.count_all(self,*args,**kwargs)
    def apply(self,*args,**kwargs):return reconciliation_support.MinibarReconciliationTests.apply(self,*args,**kwargs)
    def stocks(self):return reconciliation_support.MinibarReconciliationTests.stocks(self)

    def configured(self):
        task=self.assert_status(self.prepare(),201);self.count_all(task);self.assert_status(self.apply(task),200)

    def variance(self,actual=1,off=False,configured=True):
        if configured:self.configured()
        request=self.assert_status(self.request(**(dict(target_mode='OFF',target_template_id=None,target_version_id=None) if off else {})),201)
        task=self.assert_status(self.prepare(request),201);self.count_all(task,actual=actual);return task

    def resolve(self,task,token=None,product=None,**extra):
        detail=self.task(task);line=detail['plan']['lines'][0]
        data=dict(expected_revision=detail['request']['revision'],expected_stock_revision=line['stock_revision'],
                  expected_physical_quantity=line['current_quantity'],kind='COUNT',reason='Бодит тооллогыг шалгасан')
        data.update(extra)
        return self.api(f'minibar/configuration-requests/{task["request_id"]}/count-resolutions/{product or self.product}',data,token)

    def evidence(self,table):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,)).fetchone()[0]

    def test_negative_count_is_proposed_then_posts_with_full_application(self):
        task=self.variance();before=self.stocks();drawer=self.drawer()
        self.assertEqual(self.apply(task).json()['code'],'COUNT_VARIANCE')
        decision=self.assert_status(self.resolve(task),201)
        self.assertEqual(decision['quantity_delta'],-1);self.assertEqual(self.stocks(),before)
        self.assertEqual(self.evidence('minibar_adjustment'),0)
        self.assertTrue(self.task(task)['plan']['counts_match'])
        result=self.assert_status(self.apply(task),200)
        self.assertEqual(len(result['count_resolutions']),1)
        after=self.stocks();self.assertEqual((after['total_quantity'],after['room_quantity'],after['warehouse_quantity']),(9,2,7))
        self.assertEqual(self.drawer(),drawer);self.assertEqual(self.evidence('guest_charge'),0)
        with psycopg.connect(self.owner_dsn) as conn:
            row=conn.execute('SELECT kind,quantity,actor_id,stay_id,billable_delta FROM prsystem.minibar_adjustment WHERE tenant_id=%s',(self.tenant,)).fetchone()
            self.assertEqual(row,('COUNT_MINUS',1,self.manager,None,0))
            self.assertEqual(conn.execute('SELECT actual_count FROM prsystem.cleaning_posting WHERE tenant_id=%s AND source_id=%s',(self.tenant,task['source_id'])).fetchone()[0],1)

    def test_waste_resolution_and_off_return_preserve_real_inventory(self):
        task=self.variance(off=True);self.assert_status(self.resolve(task,kind='WASTE'),201);self.assert_status(self.apply(task),200)
        after=self.stocks();self.assertEqual((after['total_quantity'],after['room_quantity'],after['warehouse_quantity']),(9,0,9))
        self.assertEqual(self.read().json()['current']['mode'],'OFF')

    def test_positive_count_uses_existing_average_and_does_not_bill_guest(self):
        task=self.variance(actual=1,configured=False);self.assert_status(self.resolve(task),201);self.assert_status(self.apply(task),200)
        self.assertEqual(self.stocks()['total_quantity'],11);self.assertEqual(self.stocks()['room_quantity'],2)
        self.assertEqual(self.stocks()['average_cost'],dict(numerator='1000',denominator='1'))
        self.assertEqual(self.evidence('guest_charge'),0)

    def test_fractional_cost_is_preserved_exactly(self):
        self.configured();self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=5,unit_cost_mnt=2000,expected_revision=1,reference='cost')),201)
        task=self.variance(configured=False);self.assert_status(self.resolve(task),201);self.assert_status(self.apply(task),200)
        value=self.stocks()['inventory_value_exact'];self.assertEqual(Fraction(int(value['numerator']),int(value['denominator'])),Fraction(56000,3))

    def test_cancel_after_decision_keeps_stock_and_durable_decision_history(self):
        task=self.variance();before=self.stocks();r=self.assert_status(self.resolve(task),201)
        self.assert_status(self.cancel(r),200);self.assertEqual(self.stocks(),before)
        self.assertEqual(self.evidence('minibar_count_resolution'),1);self.assertEqual(self.evidence('minibar_count_resolution_posting'),0)
        self.assertEqual(self.evidence('minibar_adjustment'),0)

    def test_stock_revision_change_requires_new_manager_decision(self):
        task=self.variance();first=self.assert_status(self.resolve(task),201)
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=1000,expected_revision=1,reference='new stock')),201)
        self.assertFalse(self.task(task)['plan']['counts_match']);self.assertEqual(self.apply(task).json()['code'],'COUNT_VARIANCE')
        second=self.assert_status(self.resolve(task),201);self.assertNotEqual(first['resolution_id'],second['resolution_id'])
        self.assert_status(self.apply(task),200);self.assertEqual(self.evidence('minibar_count_resolution'),2)

    def test_manager_permission_change_invalidates_decision(self):
        task=self.variance();self.assert_status(self.resolve(task),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.staff_membership SET roles=ARRAY['RECEPTION'] WHERE tenant_id=%s AND account_id=%s",(self.tenant,self.manager))
        self.assertFalse(self.task(task)['plan']['counts_match']);self.assertEqual(self.apply(task).json()['code'],'COUNT_VARIANCE')
        self.assert_status(self.resolve(task),401)
        login=self.client.post('/auth/login',json=dict(email=self.manager+'@example.test',password=self.password,tenant_id=self.tenant))
        self.manager_token=self.assert_status(login,200)['access_token']
        self.assert_status(self.resolve(task),403);self.assertEqual(self.evidence('minibar_adjustment'),0)

    def test_role_package_product_and_payload_guards(self):
        task=self.variance()
        self.assert_status(self.resolve(task,token=self.worker_token),403)
        self.assert_status(self.resolve(task,token=self.admin),403)
        self.assert_status(self.resolve(task,product='foreign'),404)
        self.assert_status(self.resolve(task,actual_count=2),422)
        self.assert_status(self.resolve(task,unit_cost_mnt=500),422)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=20000 WHERE tenant_id=%s',(self.tenant,))
        # Build the command directly because Cleaner task access is also gated.
        self.assert_status(self.api(f'minibar/configuration-requests/{task["request_id"]}/count-resolutions/{self.product}',dict(expected_revision=3,expected_stock_revision=1,expected_physical_quantity=2,kind='COUNT',reason='Denied')),403)

    def test_exact_retry_and_stale_request_or_stock_have_no_duplicate_decisions(self):
        task=self.variance();d=self.task(task);key=uuid4().hex;rev=d['request']['revision']
        first=self.assert_status(self.resolve(task,idempotency_key=key,expected_revision=rev),201)
        self.assertEqual(self.assert_status(self.resolve(task,idempotency_key=key,expected_revision=rev),201),first)
        self.assertEqual(self.resolve(task,expected_revision=rev).json()['code'],'REVISION_CONFLICT')
        self.assertEqual(self.resolve(task,expected_physical_quantity=0).json()['code'],'REVISION_CONFLICT')
        self.assertEqual(self.evidence('minibar_count_resolution'),1)

    def test_concurrent_decisions_have_one_winner(self):
        task=self.variance();rev=self.task(task)['request']['revision'];gate=Barrier(2)
        def send():gate.wait();return self.resolve(task,expected_revision=rev)
        with ThreadPoolExecutor(2) as pool:results=[f.result() for f in(pool.submit(send),pool.submit(send))]
        self.assertEqual(sorted(r.status_code for r in results),[201,409])

    def test_incomplete_counts_and_matching_counts_have_no_variance_decision(self):
        task=self.assert_status(self.prepare(),201);self.assertEqual(self.resolve(task).json()['code'],'COUNT_REQUIRED')
        self.count_all(task);self.assertEqual(self.resolve(task).json()['code'],'COUNT_VARIANCE_NOT_FOUND')

    def test_waste_cannot_add_stock(self):
        task=self.variance(configured=False);self.assert_status(self.resolve(task,kind='WASTE'),422)

    def test_application_failure_rolls_back_adjustment_and_resolution_posting(self):
        task=self.variance();self.assert_status(self.resolve(task),201);before=self.stocks()
        with patch.object(MinibarAdjustments,'post',side_effect=DomainError('INSUFFICIENT_STOCK')):
            self.assertEqual(self.assert_status(self.apply(task),409)['code'],'INSUFFICIENT_STOCK')
        self.assertEqual(self.stocks(),before);self.assertEqual(self.evidence('minibar_count_resolution_posting'),0)
        self.assert_status(self.apply(task),200)

    def test_deferred_failure_rolls_back_every_effect_and_retry_is_safe(self):
        task=self.variance();self.assert_status(self.resolve(task),201);before=self.stocks();key=uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_count_application() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_count_application AFTER INSERT ON prsystem.minibar_count_resolution_posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_count_application()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.apply(task,key=key),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_count_application ON prsystem.minibar_count_resolution_posting');conn.execute('DROP FUNCTION prsystem.fail_count_application()')
        self.assertEqual(self.stocks(),before);self.assertEqual(self.evidence('minibar_count_resolution_posting'),0)
        self.assert_status(self.apply(task,key=key),200)

    def test_resolution_history_is_immutable_scoped_and_omits_cost_from_cleaner(self):
        task=self.variance();self.assert_status(self.resolve(task),201)
        self.assertNotIn('unit_cost_mnt',self.task(task)['plan']['lines'][0]['resolution'])
        with psycopg.connect(self.app_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_count_resolution').fetchone()[0],0)
        with self.assertRaises(psycopg.errors.CheckViolation):
            with psycopg.connect(self.owner_dsn) as conn:conn.execute('DELETE FROM prsystem.minibar_count_resolution WHERE tenant_id=%s',(self.tenant,))
        with psycopg.connect(self.app_dsn) as conn:
            self.assertFalse(conn.execute("SELECT has_table_privilege(current_user,'prsystem.minibar_count_resolution','UPDATE') OR has_table_privilege(current_user,'prsystem.minibar_count_resolution','DELETE')").fetchone()[0])

    def test_zero_delta_acknowledges_existing_stock_correction_without_duplicate_movement(self):
        task=self.variance()
        self.assert_status(self.api(f'minibar/products/{self.product}/adjustments',dict(kind='COUNT_MINUS',quantity=1,room_id=self.room,expected_stay_id=None,expected_revision=1,expected_physical_quantity=2,reason='Earlier count correction')),201)
        result=self.assert_status(self.resolve(task),201);self.assertEqual(result['quantity_delta'],0)
        self.assert_status(self.apply(task),200);self.assertEqual(self.evidence('minibar_adjustment'),1)

    def test_zero_stock_positive_count_requires_manager_cost(self):
        self.assert_status(self.api(f'minibar/products/{self.product}/adjustments',dict(kind='WASTE',quantity=10,expected_revision=1,expected_physical_quantity=10,reason='Warehouse count')),201)
        task=self.variance(actual=2,configured=False)
        self.assert_status(self.resolve(task),422)
        self.assert_status(self.resolve(task,unit_cost_mnt=1500),201);self.assert_status(self.apply(task),200)
        self.assertEqual((self.stocks()['total_quantity'],self.stocks()['room_quantity']),(2,2))
        self.assertEqual(self.stocks()['average_cost'],dict(numerator='1500',denominator='1'))

    def test_database_rejects_adjustment_that_disagrees_with_manager_decision(self):
        task=self.variance();self.assert_status(self.resolve(task),201);before=self.stocks()
        original=MinibarAdjustments.post
        def wrong_reason(service,conn,tenant,product,data,*args,**kwargs):
            return original(service,conn,tenant,product,dict(data,reason='Unapproved replacement'),*args,**kwargs)
        with patch.object(MinibarAdjustments,'post',wrong_reason):self.assert_status(self.apply(task),503)
        self.assertEqual(self.stocks(),before);self.assertEqual(self.evidence('minibar_count_resolution_posting'),0)
        self.assert_status(self.apply(task),200)
