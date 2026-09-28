import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from unittest.mock import patch
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
    import test_minibar_guest as guest_support
    from prsystem.minibar_refill import MinibarRefill
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarRefillTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_refill_request,prsystem.minibar_refill_result,prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();guest_support.MinibarGuestTests.configured(self);self.start()

    def refill(self,quantity=2,**extra):
        return self.command('minibar-refills',dict({'product_id':self.product,'quantity':quantity,'idempotency_key':uuid4().hex},**extra))

    def claim_refill(self,q,token=None,**extra):
        return self.api(f'minibar/refills/{q["request_id"]}/claim',dict(expected_revision=0,**extra),token or self.worker_token)

    def complete(self,q,quantity=2,token=None,**extra):
        return self.api(f'minibar/refills/{q["request_id"]}/complete',dict({'expected_revision':0,'task_id':q['task_id'],'assignment_version':q['assignment_version'],'quantity':quantity},**extra),token or self.worker_token)

    def cancelled(self,q,token=None,**extra):
        return self.api(f'minibar/refills/{q["request_id"]}/cancel',dict(expected_revision=0,reason='Зочин хүсэлтээ цуцалсан',**extra),token or self.worker_token)

    def stocks(self):return guest_support.MinibarGuestTests.stocks(self)
    def begin(self):return guest_support.MinibarGuestTests.begin(self)
    def report(self,**extra):return guest_support.MinibarGuestTests.report(self,**extra)
    def review(self,*a,**kw):return guest_support.MinibarGuestTests.review(self,*a,**kw)
    def inspection(self,revision=0):self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self,revision),201)

    def test_request_has_no_movement_no_price_and_blocks_checkout(self):
        before=self.stocks();q=self.assert_status(self.refill(),201)
        self.assertEqual(self.stocks(),before);self.assertEqual(q['state'],'PENDING')
        self.assertEqual(q['product'],dict(product_id=self.product,name='Ус',unit='ш'))
        self.assertEqual(self.begin().json()['code'],'MINIBAR_REFILL_PENDING')
        with psycopg.connect(self.owner_dsn) as conn:
            snapshot=conn.execute('SELECT snapshot FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s',(self.tenant,q['source_id'])).fetchone()[0]
            self.assertNotIn('unit_price',str(snapshot));self.assertNotIn('selling_price',str(snapshot))

    def test_actual_refill_conserves_total_and_value_and_charges_locked_price(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(3),201)),201)
        before=self.stocks();self.assert_status(self.complete(q,2),200)
        after=self.stocks();self.assertEqual((after['warehouse_quantity'],after['room_quantity'],after['total_quantity']),(6,4,10))
        self.assertEqual(after['inventory_value_exact'],before['inventory_value_exact'])
        self.assertEqual(after['stock_revision'],before['stock_revision'])
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=9900,revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        self.assert_status(self.begin(),200);self.inspection()
        self.assertEqual(self.assert_status(self.report(actual=1,no_consumption=False),201)['amount_mnt'],9000)
        with psycopg.connect(self.owner_dsn) as conn:
            line=conn.execute('SELECT items FROM prsystem.reception_minibar_report WHERE tenant_id=%s',(self.tenant,)).fetchone()[0][0]
            self.assertEqual((line['opening_quantity'],line['refill_quantity'],line['available_quantity']),(2,2,4))
            self.assertEqual(line['refill_ids'],[q['request_id']]);self.assertIsNotNone(line['inventory_cutoff_at'])

    def test_repeated_request_claim_completion_replay_once(self):
        key=uuid4().hex
        q=self.assert_status(self.refill(idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.refill(idempotency_key=key),201),q)
        self.assert_status(self.refill(3,idempotency_key=key),409)
        key=uuid4().hex;task=self.assert_status(self.claim_refill(q,idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.claim_refill(q,idempotency_key=key),201),task)
        key=uuid4().hex;result=self.assert_status(self.complete(task,idempotency_key=key),200)
        self.assertEqual(self.assert_status(self.complete(task,idempotency_key=key),200),result)
        self.assert_status(self.complete(task,1,idempotency_key=key),409)
        self.assertEqual(self.stocks()['room_quantity'],4)

    def test_cancel_assigned_or_unassigned_request_unblocks_without_stock(self):
        for assigned in (False,True):
            q=self.assert_status(self.refill(),201)
            if assigned:q=self.assert_status(self.claim_refill(q),201)
            self.assertEqual(self.assert_status(self.cancelled(q),200)['state'],'CANCELLED')
            if assigned:self.assert_status(self.complete(q),409)
        self.assertEqual(self.stocks()['room_quantity'],2);self.assert_status(self.begin(),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.cleaning_task WHERE tenant_id=%s AND state='OPEN'",(self.tenant,)).fetchone()[0],0)

    def test_cleaner_unavailable_requires_reason_and_does_not_transfer(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201)
        path=f'minibar/refills/{q["request_id"]}/unavailable'
        body=dict(expected_revision=0,task_id=q['task_id'],assignment_version=0,reason='  ')
        self.assert_status(self.api(path,body,self.worker_token),422)
        body['reason']='Агуулахад бараа олдсонгүй'
        self.assertEqual(self.assert_status(self.api(path,body,self.worker_token),200)['state'],'UNAVAILABLE')
        self.assertEqual(self.stocks()['room_quantity'],2);self.assert_status(self.begin(),200)

    def test_insufficient_warehouse_and_over_request_counts_are_atomic(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(9),201)),201)
        self.assertEqual(self.complete(q,9).json()['code'],'INSUFFICIENT_STOCK')
        self.assert_status(self.complete(q,10),422)
        self.assert_status(self.complete(q,0),422)
        self.assert_status(self.complete(q,True),422)
        self.assertEqual(self.stocks()['room_quantity'],2);self.assert_status(self.complete(q,1),200)

    def test_checkout_intent_denies_new_refill_and_direct_sql_pending_intent(self):
        q=self.assert_status(self.refill(),201)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.tenant,))
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('INSERT INTO prsystem.reception_checkout_intent(tenant_id,stay_id,actor_id) VALUES(%s,%s,%s)',(self.tenant,self.stay['stay_id'],self.worker))
        self.assert_status(self.cancelled(q),200);self.assert_status(self.begin(),200)
        self.assertEqual(self.refill().json()['code'],'MINIBAR_REFILL_LOCKED')

    def test_roles_current_assignment_and_no_client_price(self):
        _,cleaner=self.add_staff(['CLEANER']);_,reception=self.add_staff(['RECEPTION'])
        self.assert_status(self.command('minibar-refills',dict(product_id=self.product,quantity=1,idempotency_key=uuid4().hex),cleaner),403)
        q=self.assert_status(self.refill(),201)
        self.assert_status(self.claim_refill(q,self.manager_token),403)
        q=self.assert_status(self.claim_refill(q,cleaner),201)
        self.assert_status(self.complete(q,token=self.worker_token),403)
        self.assert_status(self.complete(q,token=cleaner,assignment_version=99),409)
        self.assert_status(self.complete(q,token=cleaner,unit_price=1),422)
        self.assert_status(self.cancelled(q,cleaner),403)
        self.assert_status(self.cancelled(q,reception),200)

    def test_product_lifecycle_only_pre_retirement_task_can_finish(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.minibar_product SET status='RETIRING',deactivation_requested_at=clock_timestamp() WHERE tenant_id=%s AND id=%s",(self.tenant,self.product))
        self.assertEqual(self.refill().json()['code'],'PRODUCT_NOT_ACTIVE');self.assert_status(self.complete(q),200)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.minibar_product SET status='ACTIVE' WHERE tenant_id=%s AND id=%s",(self.tenant,self.product))
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.minibar_product SET status='INACTIVE' WHERE tenant_id=%s AND id=%s",(self.tenant,self.product))
        self.assertEqual(self.complete(q).json()['code'],'PRODUCT_NOT_ACTIVE')
        self.assert_status(self.cancelled(q),200)

    def test_unpaid_correction_reuses_all_refill_evidence_without_double_count(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201);self.assert_status(self.complete(q),200)
        self.assert_status(self.begin(),200);self.inspection();self.assert_status(self.report(actual=0,no_consumption=False),201)
        self.assert_status(self.review(),200);self.inspection(1)
        result=self.assert_status(self.report(actual=3,revision=1,no_consumption=False),201)
        self.assertEqual(result['amount_mnt'],3000);self.assertEqual(self.stocks()['room_quantity'],3)
        with psycopg.connect(self.owner_dsn) as conn:
            reports=conn.execute('SELECT items FROM prsystem.reception_minibar_report WHERE tenant_id=%s ORDER BY revision',(self.tenant,)).fetchall()
            self.assertEqual(reports[0][0][0]['refill_ids'],reports[1][0][0]['refill_ids'])
            self.assertEqual(reports[0][0][0]['inventory_cutoff_at'],reports[1][0][0]['inventory_cutoff_at'])

    def test_completion_remains_available_at_subscription_lock_but_new_request_does_not(self):
        q=self.assert_status(self.refill(),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours'+interval '1 millisecond' WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        self.assert_status(self.refill(),403);q=self.assert_status(self.claim_refill(q),201);self.assert_status(self.complete(q),200)
        self.assert_status(self.begin(),200)

    def test_tenant_rls_and_immutable_physical_history(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201);self.assert_status(self.complete(q),200)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id','other-hotel',true)")
            for table in('minibar_refill_request','minibar_refill_result'):
                self.assertEqual(conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{}').format(sql.Identifier(table))).fetchone()[0],0)
        for table in('minibar_refill_request','minibar_refill_result'):
            with psycopg.connect(self.owner_dsn) as conn:
                with self.assertRaises(psycopg.errors.CheckViolation):conn.execute(sql.SQL('DELETE FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,))

    def test_failure_after_physical_post_rolls_back_all(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201);before=self.stocks()
        with patch.object(MinibarRefill,'event',side_effect=DomainError('INVALID_REQUEST')):self.assert_status(self.complete(q),422)
        self.assertEqual(self.stocks(),before);self.assert_status(self.complete(q),200)

    def test_concurrent_completions_post_once(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201);gate=Barrier(2)
        def complete():gate.wait();return self.complete(q)
        with ThreadPoolExecutor(max_workers=2) as pool:responses=[r.result() for r in(pool.submit(complete),pool.submit(complete))]
        self.assertEqual(sorted(r.status_code for r in responses),[200,409]);self.assertEqual(self.stocks()['room_quantity'],4)

    def test_concurrent_checkout_and_request_have_only_one_winner(self):
        gate=Barrier(2)
        def request():gate.wait();return self.refill()
        def checkout():gate.wait();return self.begin()
        with ThreadPoolExecutor(max_workers=2) as pool:responses=[r.result() for r in(pool.submit(request),pool.submit(checkout))]
        self.assertIn([r.status_code for r in responses],([201,409],[409,200]))

    def test_generic_cleaning_cannot_post_refill(self):
        q=self.assert_status(self.claim_refill(self.assert_status(self.refill(),201)),201)
        with psycopg.connect(self.owner_dsn) as conn:action=conn.execute('SELECT id FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s',(self.tenant,q['source_id'])).fetchone()[0]
        response=self.api(f'cleaning/tasks/{q["task_id"]}/post',dict(expected_revision=0,action_id=action,quantity=1),self.worker_token)
        self.assertEqual(response.json()['code'],'CANONICAL_TASK_REQUIRED');self.assertEqual(self.stocks()['room_quantity'],2)
