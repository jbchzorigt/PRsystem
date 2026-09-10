import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from fractions import Fraction
from threading import Barrier
from uuid import uuid4
from unittest.mock import patch
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_reconciliation as reconciliation_support
    from prsystem.minibar_guest import MinibarGuest
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarGuestTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def configured(self):
        task=self.assert_status(reconciliation_support.MinibarReconciliationTests.prepare(self),201)
        detail=self.assert_status(self.api('minibar/reconciliation/tasks',token=self.worker_token,method='get'),200)['items'][0]
        for line in detail['plan']['lines']:
            self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/count',dict(assignment_version=0,action_id=line['action_id'],actual_count=line['baseline_quantity']),self.worker_token),200)
        detail=self.assert_status(self.api('minibar/reconciliation/tasks',token=self.worker_token,method='get'),200)['items'][0]
        self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/apply',dict(assignment_version=0,expected_revision=detail['request']['revision'],physical_transfers_confirmed=True),self.worker_token),200)

    def begin(self):
        return self.command('checkout/initiate',dict(idempotency_key=uuid4().hex))

    def claim(self,revision=0,token=None,key=None):
        return self.command('minibar-inspection/claim',dict(expected_revision=revision,idempotency_key=key or uuid4().hex),token)

    def report(self,actual=1,revision=0,task=None,token=None,**extra):
        task=task or self.task
        body=dict(task_id=task['task_id'],assignment_version=task['assignment_version'],counts={self.product:actual},no_consumption=actual==2,expected_revision=revision,idempotency_key=uuid4().hex)
        body.update(extra)
        return self.command('minibar-report',body,token)

    def open_report(self):
        self.configured();self.start();self.assert_status(self.begin(),200);self.task=self.assert_status(self.claim(),201)

    def stocks(self):
        return self.assert_status(self.api('minibar/products',method='get'),200)['items'][0]

    def review(self,action='RETURN',token=None):
        return self.command('minibar-review',dict(action=action,reason='Бодит тоог дахин шалгах',idempotency_key=uuid4().hex),token)

    def test_checkin_locks_exact_current_price_book_without_stock_movement(self):
        self.configured();before=self.stocks();self.start()
        book=self.stay['snapshot']['minibar_snapshot']
        self.assertEqual((book['mode'],book['template_id'],book['version_id']),('CANONICAL',self.template,self.version))
        self.assertEqual((book['items'][0]['opening_quantity'],book['items'][0]['unit_price']),(2,3000))
        self.assertEqual(datetime.fromisoformat(book['recorded_at']),datetime.fromisoformat(self.stay['check_in_recorded_at']))
        self.assertEqual(self.stocks(),before)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT minibar_application_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(self.tenant,self.stay['stay_id'])).fetchone()[0],book['application_id'])
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute("UPDATE prsystem.stay SET snapshot=jsonb_set(snapshot,'{minibar_snapshot,items,0,unit_price}','9999') WHERE tenant_id=%s AND id=%s",(self.tenant,self.stay['stay_id']))

    def test_physical_report_posts_consumption_guest_charge_and_exact_cost(self):
        self.open_report();report=self.assert_status(self.report(),201)
        self.assertEqual((report['amount_mnt'],report['mode']),(3000,'CANONICAL'))
        stock=self.stocks();self.assertEqual((stock['warehouse_quantity'],stock['room_quantity'],stock['total_quantity'],stock['inventory_value_mnt']),(8,1,9,'9000'))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT state FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s",(self.tenant,self.task['task_id'])).fetchone()[0],'DONE')
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.cleaning_stock WHERE tenant_id=%s AND product_id LIKE 'mock:%%'",(self.tenant,)).fetchone()[0],0)

    def test_purchase_then_consumption_preserves_fractional_value(self):
        self.open_report()
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=5,unit_cost_mnt=2000,expected_revision=1,reference='Өртгийн багц')),201)
        self.assert_status(self.report(),201)
        stock=self.stocks();self.assertEqual(stock['inventory_value_exact'],dict(numerator='56000',denominator='3'))
        self.assertEqual(stock['average_cost'],dict(numerator='4000',denominator='3'))
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=2000,expected_revision=3)),201)
        stock=self.stocks();self.assertEqual(stock['inventory_value_exact'],dict(numerator='62000',denominator='3'))
        self.assertEqual((stock['warehouse_quantity'],stock['room_quantity'],stock['total_quantity']),(14,1,15))
        ledger=self.api(f'minibar/products/{self.product}/ledger',method='get').json()['items']
        self.assertEqual(ledger[-2]['cost'],dict(numerator='4000',denominator='3'))
        self.assertEqual(ledger[-1]['inventory_value_exact'],stock['inventory_value_exact'])

    def test_unpaid_correction_reverses_original_cost_then_reposts(self):
        self.open_report();first=self.assert_status(self.report(actual=0),201)
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=2000,expected_revision=2)),201)
        self.assert_status(self.review(),200);self.task=self.assert_status(self.claim(1),201)
        second=self.assert_status(self.report(revision=1),201)
        self.assertEqual(second['amount_mnt'],3000)
        stock=self.stocks();self.assertEqual(stock['inventory_value_exact'],dict(numerator='120000',denominator='11'))
        self.assertEqual((stock['warehouse_quantity'],stock['room_quantity'],stock['total_quantity']),(9,1,10))
        with psycopg.connect(self.owner_dsn) as conn:
            reversal=conn.execute("SELECT quantity,cost_numerator,cost_denominator,original_receipt_id FROM prsystem.minibar_receipt WHERE tenant_id=%s AND kind='CONSUMPTION_REVERSAL'",(self.tenant,)).fetchone()
            self.assertEqual(reversal,(2,1000,1,first['movement_ids'][0]))
            self.assertEqual(conn.execute('SELECT amount_mnt FROM prsystem.guest_charge_adjustment WHERE tenant_id=%s AND charge_id=%s',(self.tenant,first['charge_id'])).fetchone()[0],-6000)

    def test_no_consumption_requires_ack_and_does_not_move_inventory(self):
        self.open_report();before=self.stocks()
        self.assert_status(self.report(actual=2,no_consumption=False),422)
        report=self.assert_status(self.report(actual=2),201)
        self.assertIsNone(report['charge_id']);self.assertEqual(report['movement_ids'],[]);self.assertEqual(self.stocks(),before)

    def test_invalid_counts_and_client_price_are_atomic(self):
        self.open_report();before=self.stocks()
        for counts in ({},{self.product:-1},{self.product:3},{'foreign':1},{self.product:True},{self.product:1.5}):
            self.assert_status(self.report(counts=counts),422)
        self.assert_status(self.report(unit_price=1),422)
        self.assertEqual(self.stocks(),before)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_guest_report WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_assigned_cleaner_only_and_idempotency_after_completion(self):
        self.open_report();self.assert_status(self.report(token=self.manager_token),403)
        key=uuid4().hex;first=self.assert_status(self.report(idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.report(idempotency_key=key),201),first)
        self.assert_status(self.report(actual=0,idempotency_key=key),409)
        self.assert_status(self.report(),409)
        self.assertEqual(self.stocks()['total_quantity'],9)

    def test_stale_assignment_and_report_revisions_do_not_post(self):
        self.open_report();self.assert_status(self.report(assignment_version=99),409)
        self.assert_status(self.report(revision=1),404)
        self.assertEqual(self.stocks()['total_quantity'],10)

    def test_checkout_requires_report_then_settlement_completes_production_stay(self):
        self.open_report()
        self.assert_status(self.command('checkout',dict(expected_revision=1,idempotency_key=uuid4().hex)),409)
        report=self.assert_status(self.report(),201)
        self.settle_and_close(report)
        self.assertEqual(self.stocks()['room_quantity'],1)

    def settle_and_close(self,report):
        revision=report['balance']['revision']
        self.assert_status(self.allocate(60000,revision=revision),201)
        for charge,amount in ((self.stay['room_charge_id'],20000),(report['charge_id'],3000)):
            revision=self.statement().json()['balance']['revision']
            self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=amount,charge_id=charge,expected_revision=revision,idempotency_key=uuid4().hex)),201)
        self.assertEqual(self.review().json()['code'],'MINIBAR_REPORT_LOCKED')
        revision=self.statement().json()['balance']['revision']
        result=self.assert_status(self.command('checkout',dict(expected_revision=revision,idempotency_key=uuid4().hex)),200)
        self.assertEqual(result['state'],'CLOSED')

    def test_waiver_is_financial_only_and_keeps_consumption(self):
        self.open_report();report=self.assert_status(self.report(),201)
        self.assert_status(self.review('DISPUTE'),200)
        self.assert_status(self.review('WAIVE',self.manager_token),200)
        self.assertEqual(self.stocks()['room_quantity'],1)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT amount_mnt FROM prsystem.guest_charge_adjustment WHERE tenant_id=%s AND charge_id=%s',(self.tenant,report['charge_id'])).fetchone()[0],-3000)

    def test_pending_configuration_does_not_change_active_price_or_block_report(self):
        self.open_report();self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),201)
        self.assertEqual(self.assert_status(self.report(),201)['amount_mnt'],3000)
        self.assertEqual(self.read().json()['pending']['state'],'SCHEDULED_AFTER_STAY')

    def test_duplicate_claim_is_single_source_and_single_assignment(self):
        self.configured();self.start();self.assert_status(self.begin(),200);self.assert_status(self.begin(),200)
        gate=Barrier(2)
        def claim():gate.wait();return self.claim()
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=[r.result() for r in (pool.submit(claim),pool.submit(claim))]
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])

    def test_database_rejects_forged_report_without_physical_proof(self):
        self.open_report()
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.tenant,))
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute("INSERT INTO prsystem.reception_minibar_report(tenant_id,stay_id,revision,actor_id,items,amount_mnt) VALUES(%s,%s,1,%s,'[]',0)",(self.tenant,self.stay['stay_id'],self.worker))
                conn.execute('SET CONSTRAINTS ALL IMMEDIATE')

    def test_queue_is_tenant_scoped_and_exposes_locked_price_book(self):
        self.open_report()
        result=self.assert_status(self.api('minibar/guest-inspections',token=self.worker_token,method='get'),200)
        self.assertEqual(result['items'][0]['price_book'],self.stay['snapshot']['minibar_snapshot'])
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id','other-hotel',true)")
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_guest_inspection').fetchone()[0],0)

    def test_backdated_arrival_uses_recorded_checkin_prices(self):
        with psycopg.connect(self.owner_dsn) as conn:arrival=conn.execute('SELECT clock_timestamp()').fetchone()[0].isoformat()
        self.configured()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=4500,revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        self.start(actual_checkin_at=arrival,backdate_reason='Зочин өмнө ирсэн')
        self.assertEqual(self.stay['snapshot']['minibar_snapshot']['items'][0]['unit_price'],4500)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=9000,revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        self.assert_status(self.begin(),200);self.task=self.assert_status(self.claim(),201)
        self.assertEqual(self.assert_status(self.report(),201)['amount_mnt'],4500)

    def test_cleaner_only_account_can_claim_count_and_view_queue(self):
        self.configured();self.start();self.assert_status(self.begin(),200)
        _,cleaner=self.add_staff(['CLEANER'])
        self.assertEqual(len(self.api('minibar/guest-inspections',token=cleaner,method='get').json()['items']),1)
        self.task=self.assert_status(self.claim(token=cleaner),201)
        self.assert_status(self.report(token=cleaner),201)

    def test_eligible_stay_completion_remains_available_after_subscription_lock(self):
        self.configured();self.start()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours'+interval '1 millisecond' WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        self.assert_status(self.begin(),200);self.task=self.assert_status(self.claim(),201)
        self.assertEqual(len(self.api('minibar/guest-inspections',token=self.worker_token,method='get').json()['items']),1)
        self.assert_status(self.report(),201)
        self.assertEqual(self.api('minibar/guest-inspections',token=self.worker_token,method='get').json()['items'],[])

    def test_failure_after_postings_rolls_back_stock_report_charge_and_task(self):
        self.open_report();before=self.stocks()
        with patch.object(MinibarGuest,'save',side_effect=DomainError('INVALID_REQUEST')):
            self.assert_status(self.report(),422)
        self.assertEqual(self.stocks(),before)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.reception_minibar_report WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute("SELECT state FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s",(self.tenant,self.task['task_id'])).fetchone()[0],'OPEN')
        self.assert_status(self.report(),201)

    def test_generic_cleaning_endpoint_cannot_post_canonical_guest_count(self):
        self.open_report()
        with psycopg.connect(self.owner_dsn) as conn:
            action=conn.execute('SELECT id FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s',(self.tenant,self.task['source_id'])).fetchone()[0]
        response=self.api(f'cleaning/tasks/{self.task["task_id"]}/post',dict(expected_revision=0,action_id=action,quantity=1,actual_count=1),self.worker_token)
        self.assertEqual(response.json()['code'],'CANONICAL_TASK_REQUIRED')
        self.assertEqual(self.stocks()['room_quantity'],2)

    def test_simultaneous_reports_consume_once(self):
        self.open_report();gate=Barrier(2)
        def report():gate.wait();return self.report()
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=[r.result() for r in (pool.submit(report),pool.submit(report))]
        self.assertEqual(sorted(r.status_code for r in responses),[201,409]);self.assertEqual(self.stocks()['total_quantity'],9)

    def test_next_opening_requires_restock_and_transfers_keep_fractional_value(self):
        self.open_report()
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=5,unit_cost_mnt=2000,expected_revision=1)),201)
        report=self.assert_status(self.report(),201);self.settle_and_close(report)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertIsNone(conn.execute('SELECT prsystem.minibar_guest_opening(%s,%s,clock_timestamp())',(self.tenant,self.room)).fetchone()[0])
        before=self.stocks();self.configured();after=self.stocks()
        self.assertEqual((after['warehouse_quantity'],after['room_quantity'],after['total_quantity']),(12,2,14))
        self.assertEqual(after['inventory_value_exact'],before['inventory_value_exact'])
        with psycopg.connect(self.owner_dsn) as conn:
            book=conn.execute('SELECT prsystem.minibar_guest_opening(%s,%s,clock_timestamp())',(self.tenant,self.room)).fetchone()[0]
            self.assertEqual(book['items'][0]['opening_quantity'],2)
            self.assertEqual(conn.execute('SELECT cost_value,cost_denominator,cost_quantity FROM prsystem.minibar_transfer WHERE tenant_id=%s ORDER BY recorded_at DESC LIMIT 1',(self.tenant,)).fetchone(),(56000,3,14))
