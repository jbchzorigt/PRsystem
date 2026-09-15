import unittest
from uuid import uuid4
from threading import Barrier
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_reconciliation as rec
    import test_minibar_variance as variance
    import test_minibar_guest as guest
    import test_minibar_refill as refill
    from prsystem.minibar_shortages import MinibarShortages


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarShortageTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT INSERT ON prsystem.minibar_shortage_approval,prsystem.minibar_shortage_posting,prsystem.minibar_shortage_permit TO {}',
                'GRANT INSERT ON prsystem.minibar_count_resolution,prsystem.minibar_count_resolution_posting,prsystem.minibar_adjustment TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT INSERT ON prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_refill_request,prsystem.minibar_refill_result TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def prepare(self,*a,**k):return rec.MinibarReconciliationTests.prepare(self,*a,**k)
    def task(self,*a,**k):return rec.MinibarReconciliationTests.task(self,*a,**k)
    def count_all(self,*a,**k):return rec.MinibarReconciliationTests.count_all(self,*a,**k)
    def apply(self,*a,**k):return rec.MinibarReconciliationTests.apply(self,*a,**k)
    def stocks(self):return rec.MinibarReconciliationTests.stocks(self)
    def resolve(self,*a,**k):return variance.MinibarVarianceTests.resolve(self,*a,**k)
    def evidence(self,*a):return variance.MinibarVarianceTests.evidence(self,*a)

    def shortage(self,available=1,count=True):
        self.assert_status(self.api(f'minibar/products/{self.product}/adjustments',dict(kind='WASTE',quantity=10-available,
            expected_revision=1,expected_physical_quantity=10,reason='Агуулахын бодит хорогдол')),201)
        task=self.assert_status(self.prepare(),201)
        if count:self.count_all(task)
        return task

    def approve(self,task,token=None,**extra):
        d=self.task(task);p=d['plan']['shortage_preview']
        body=dict(expected_revision=d['request']['revision'],expected_preview=p['token'] if p else '0'*32,
            reason='Нөөц ирэхийг хүлээж, бүх барааны бодит тоог шалгасан',physical_counts_reviewed=True)
        body.update(extra)
        return self.api(f'minibar/configuration-requests/{task["request_id"]}/shortage-approvals',body,token)

    def permitted(self,available=1):
        task=self.shortage(available);approval=self.assert_status(self.approve(task),201)
        self.assert_status(self.apply(task),200);return task,approval

    def test_manager_proposal_does_not_move_stock_then_applies_short_exact_version(self):
        task=self.shortage();before=self.stocks();drawer=self.drawer()
        self.assertEqual(self.apply(task).json()['code'],'INSUFFICIENT_STOCK')
        approval=self.assert_status(self.approve(task),201);self.assertEqual(self.stocks(),before)
        self.assertEqual(self.read().json()['current']['mode'],'OFF')
        self.assertEqual(self.evidence('minibar_shortage_permit'),0)
        d=self.task(task)['plan'];self.assertTrue(d['shortage']);self.assertTrue(d['shortage_approved'])
        self.assertEqual((d['lines'][0]['target_quantity'],d['lines'][0]['approved_quantity']),(2,1))
        self.assert_status(self.apply(task),200)
        r=self.read().json();self.assertIsNone(r['pending']);self.assertEqual(r['current']['configuration']['version_id'],self.version)
        self.assertTrue(r['shortage']['ready']);self.assertEqual(r['shortage']['permit_id'],approval['approval_id'])
        self.assertEqual((self.stocks()['room_quantity'],self.stocks()['warehouse_quantity']),(1,0))
        self.assertEqual(self.drawer(),drawer);self.assertEqual(self.evidence('guest_charge'),0)

    def test_checkin_consumes_once_and_preserves_short_opening_and_full_targets(self):
        _,approval=self.permitted();before=self.stocks();key=uuid4().hex;self.start(idempotency_key=key)
        book=self.stay['snapshot']['minibar_snapshot'];self.assertEqual(book['stock_status'],'SHORT')
        self.assertEqual(book['shortage_permit_id'],approval['approval_id'])
        self.assertEqual((book['items'][0]['opening_quantity'],book['items'][0]['target_quantity'],book['items'][0]['unit_price']),(1,2,3000))
        self.assertEqual(self.stocks(),before);self.assertEqual(self.evidence('minibar_shortage_use'),1)
        self.assertEqual(self.start(idempotency_key=key)['stay_id'],self.stay['stay_id'])
        r=self.read().json()['shortage'];self.assertFalse(r['ready']);self.assertEqual(r['used_stay_id'],self.stay['stay_id'])
        with self.assertRaises(psycopg.errors.CheckViolation):
            with psycopg.connect(self.owner_dsn) as conn:conn.execute('INSERT INTO prsystem.minibar_shortage_use(tenant_id,permit_id,stay_id) VALUES(%s,%s,%s)',(self.tenant,approval['approval_id'],uuid4().hex))

    def test_zero_opening_is_not_billable_without_documented_refill(self):
        self.permitted(0);self.start();self.assertEqual(self.stay['snapshot']['minibar_snapshot']['items'][0]['opening_quantity'],0)
        self.assert_status(guest.MinibarGuestTests.begin(self),200)
        task=self.assert_status(guest.MinibarGuestTests.claim(self),201)
        r=self.assert_status(guest.MinibarGuestTests.report(self,actual=0,task=task,no_consumption=True),201)
        self.assertEqual(r['amount_mnt'],0);self.assertEqual(self.evidence('minibar_receipt'),2)

    def test_reception_cleaner_and_admin_cannot_approve(self):
        task=self.shortage()
        for token in(self.worker_token,self.admin):self.assert_status(self.approve(task,token=token),403)
        self.assertEqual(self.evidence('minibar_shortage_approval'),0)

    def test_reason_acknowledgement_and_server_only_plan_are_required(self):
        task=self.shortage()
        for extra in(dict(reason=''),dict(reason='  '),dict(physical_counts_reviewed=False),dict(opening_quantity=1),dict(unit_price=100),dict(expected_preview='not-a-token')):
            self.assert_status(self.approve(task,**extra),422)

    def test_incomplete_counts_variance_and_full_stock_cannot_be_overridden(self):
        task=self.shortage(count=False);self.assertEqual(self.approve(task).json()['code'],'SHORTAGE_APPROVAL_NOT_READY')
        self.count_all(task,actual=1);self.assertEqual(self.approve(task).json()['code'],'SHORTAGE_APPROVAL_NOT_READY')
        self.assert_status(self.resolve(task),201)
        # Resolved found stock now fills the complete target; no exception needed.
        self.assertEqual(self.approve(task).json()['code'],'SHORTAGE_APPROVAL_NOT_READY');self.assert_status(self.apply(task),200)

    def test_shortage_can_follow_resolved_variance_in_same_atomic_application(self):
        task=self.shortage(0,count=False);self.count_all(task,actual=1)
        self.assert_status(self.resolve(task,unit_cost_mnt=1200),201);self.assert_status(self.approve(task),201)
        self.assert_status(self.apply(task),200);self.assertEqual(self.evidence('minibar_count_resolution_posting'),1)
        self.assertEqual((self.stocks()['room_quantity'],self.stocks()['total_quantity']),(1,1))
        self.start();self.assertEqual(self.stay['snapshot']['minibar_snapshot']['items'][0]['opening_quantity'],1)

    def test_dirty_room_and_pending_lifecycle_block_approval(self):
        task=self.shortage()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.room SET cleaning_state='DIRTY' WHERE tenant_id=%s AND id=%s",(self.tenant,self.room))
        self.assertEqual(self.approve(task).json()['code'],'SHORTAGE_APPROVAL_NOT_READY')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.room SET cleaning_state='CLEAN',status='RETIRING' WHERE tenant_id=%s AND id=%s",(self.tenant,self.room))
        self.assertEqual(self.approve(task).json()['code'],'SHORTAGE_APPROVAL_NOT_READY')

    def test_preview_stock_change_is_conflict_before_approval(self):
        task=self.shortage(0);token=self.task(task)['plan']['shortage_preview']['token']
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=1000,expected_revision=2)),201)
        self.assertEqual(self.approve(task,expected_preview=token).json()['code'],'REVISION_CONFLICT')
        self.assert_status(self.approve(task),201)

    def test_stock_change_invalidates_approval_and_can_be_reviewed_again(self):
        task=self.shortage(0);self.assert_status(self.approve(task),201)
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=1000,expected_revision=2)),201)
        self.assertFalse(self.task(task)['plan']['shortage_approved']);self.assertEqual(self.apply(task).json()['code'],'INSUFFICIENT_STOCK')
        self.assert_status(self.approve(task),201);self.assert_status(self.apply(task),200)
        self.assertEqual(self.evidence('minibar_shortage_approval'),2)

    def test_purchase_that_fully_supplies_target_uses_normal_application(self):
        task=self.shortage();self.assert_status(self.approve(task),201)
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=1000,expected_revision=2)),201)
        result=self.assert_status(self.apply(task),200);self.assertIsNone(result['shortage_permit_id'])
        self.assertEqual(self.evidence('minibar_shortage_permit'),0);self.start()
        self.assertNotIn('stock_status',self.stay['snapshot']['minibar_snapshot'])

    def test_exact_retry_and_revision_conflict_never_duplicate_approval(self):
        task=self.shortage();rev=self.task(task)['request']['revision'];key=uuid4().hex
        first=self.assert_status(self.approve(task,idempotency_key=key,expected_revision=rev),201)
        self.assertEqual(self.assert_status(self.approve(task,idempotency_key=key,expected_revision=rev),201),first)
        self.assertEqual(self.approve(task,expected_revision=rev).json()['code'],'REVISION_CONFLICT')
        self.assertEqual(self.evidence('minibar_shortage_approval'),1)

    def test_concurrent_approval_has_one_winner(self):
        task=self.shortage();rev=self.task(task)['request']['revision'];gate=Barrier(2)
        def run():gate.wait();return self.approve(task,expected_revision=rev)
        with ThreadPoolExecutor(2) as pool:results=[f.result() for f in(pool.submit(run),pool.submit(run))]
        self.assertEqual(sorted(r.status_code for r in results),[201,409])

    def test_cancel_preserves_proposal_and_releases_no_permit_or_stock(self):
        task=self.shortage();before=self.stocks();self.assert_status(self.approve(task),201)
        self.assert_status(self.cancel(self.task(task)['request']),200)
        self.assertEqual(self.stocks(),before);self.assertEqual(self.evidence('minibar_shortage_permit'),0)
        self.assertEqual(self.evidence('minibar_shortage_approval'),1)

    def test_current_manager_authority_is_required_at_application_and_opening(self):
        task=self.shortage();self.assert_status(self.approve(task),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.staff_account SET status='SUSPENDED' WHERE id=%s",(self.manager,))
        self.assertFalse(self.task(task)['plan']['shortage_approved']);self.assertEqual(self.apply(task).json()['code'],'INSUFFICIENT_STOCK')

    def test_expired_hotel_never_admits_short_opening(self):
        self.permitted()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=%s",(self.tenant,))
            self.assertFalse(conn.execute('SELECT prsystem.minibar_shortage_permit_ready(%s,id) FROM prsystem.minibar_shortage_permit WHERE tenant_id=%s',(self.tenant,self.tenant)).fetchone()[0])

    def test_room_inventory_roundtrip_invalidates_permit_even_at_same_quantity(self):
        self.permitted();self.assert_status(self.api(f'minibar/products/{self.product}/adjustments',dict(kind='COUNT_PLUS',quantity=1,room_id=self.room,expected_stay_id=None,expected_revision=2,expected_physical_quantity=1,reason='Нэмэлт тоо')),201)
        self.assert_status(self.api(f'minibar/products/{self.product}/adjustments',dict(kind='WASTE',quantity=1,room_id=self.room,expected_stay_id=None,expected_revision=3,expected_physical_quantity=2,reason='Хорогдол')),201)
        self.assertFalse(self.read().json()['shortage']['ready']);self.assertEqual(self.checkin(deposit=dict(channel='CASH',amount_mnt=60000,received=True)).json()['code'],'ROOM_NOT_READY')

    def test_unrelated_warehouse_receipt_preserves_counted_room_permit(self):
        self.permitted();self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=5,unit_cost_mnt=2000,expected_revision=2)),201)
        self.assertTrue(self.read().json()['shortage']['ready']);self.start()
        self.assertEqual(self.stay['snapshot']['minibar_snapshot']['items'][0]['opening_quantity'],1)

    def test_booking_capacity_and_actual_opening_share_valid_permit(self):
        self.permitted()
        with psycopg.connect(self.owner_dsn) as conn:
            eligible,book=conn.execute('SELECT prsystem.minibar_booking_eligible(%s,%s),prsystem.minibar_guest_opening(%s,%s,clock_timestamp())',(self.tenant,self.room,self.tenant,self.room)).fetchone()
            self.assertTrue(eligible);self.assertEqual(book['stock_status'],'SHORT')
        self.start()
        with psycopg.connect(self.owner_dsn) as conn:self.assertIsNone(conn.execute('SELECT prsystem.minibar_guest_opening(%s,%s,clock_timestamp())',(self.tenant,self.room)).fetchone()[0])

    def test_deferred_application_failure_rolls_back_transfers_permit_and_receipt(self):
        task=self.shortage();self.assert_status(self.approve(task),201);before=self.stocks();key=uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_shortage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_shortage AFTER INSERT ON prsystem.minibar_shortage_permit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_shortage()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.apply(task,key=key),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_shortage ON prsystem.minibar_shortage_permit');conn.execute('DROP FUNCTION prsystem.fail_shortage()')
        self.assertEqual(self.stocks(),before);self.assertEqual(self.evidence('minibar_shortage_posting'),0);self.assertEqual(self.evidence('minibar_shortage_permit'),0)
        self.assert_status(self.apply(task,key=key),200)

    def test_database_rejects_tampered_approval_snapshot(self):
        task=self.shortage();original=MinibarShortages.preview
        def wrong(conn,tenant,request):
            p=original(conn,tenant,request);p['plan']['lines'][0]['approved_quantity']=2;return p
        with patch.object(MinibarShortages,'preview',staticmethod(wrong)):self.assert_status(self.approve(task),503)
        self.assertEqual(self.evidence('minibar_shortage_approval'),0)

    def test_history_is_immutable_and_tenant_scoped_without_update_delete_grants(self):
        _,approval=self.permitted()
        with psycopg.connect(self.app_dsn) as conn:
            for table in('minibar_shortage_approval','minibar_shortage_posting','minibar_shortage_permit','minibar_shortage_use'):
                self.assertEqual(conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{}').format(sql.Identifier(table))).fetchone()[0],0)
                self.assertFalse(conn.execute('SELECT has_table_privilege(current_user,%s,\'UPDATE\') OR has_table_privilege(current_user,%s,\'DELETE\')',('prsystem.'+table,'prsystem.'+table)).fetchone()[0])
        for table in('minibar_shortage_approval','minibar_shortage_posting','minibar_shortage_permit'):
            with self.assertRaises(psycopg.errors.CheckViolation):
                with psycopg.connect(self.owner_dsn) as conn:conn.execute(sql.SQL('DELETE FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,))

    def test_revoked_manager_after_application_blocks_short_opening(self):
        self.permitted()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET status='SUSPENDED' WHERE id=%s",(self.manager,))
            self.assertFalse(conn.execute('SELECT prsystem.minibar_shortage_permit_ready(%s,id) FROM prsystem.minibar_shortage_permit WHERE tenant_id=%s',(self.tenant,self.tenant)).fetchone()[0])
        self.assertEqual(self.checkin(deposit=dict(channel='CASH',amount_mnt=60000,received=True)).json()['code'],'ROOM_NOT_READY')

    def test_zero_opening_documented_refill_charges_the_original_checkin_price(self):
        self.permitted(0);self.start()
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=2,unit_cost_mnt=1500,expected_revision=2)),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=9999,revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        q=self.assert_status(refill.MinibarRefillTests.refill(self,2),201)
        q=self.assert_status(refill.MinibarRefillTests.claim_refill(self,q),201)
        self.assert_status(refill.MinibarRefillTests.complete(self,q,2),200)
        self.assert_status(guest.MinibarGuestTests.begin(self),200);task=self.assert_status(guest.MinibarGuestTests.claim(self),201)
        result=self.assert_status(guest.MinibarGuestTests.report(self,actual=1,task=task,no_consumption=False),201)
        self.assertEqual(result['amount_mnt'],3000)
        with psycopg.connect(self.owner_dsn) as conn:
            line=conn.execute('SELECT items FROM prsystem.reception_minibar_report WHERE tenant_id=%s',(self.tenant,)).fetchone()[0][0]
            self.assertEqual((line['opening_quantity'],line['refill_quantity'],line['used_quantity'],line['unit_price']),(0,2,1,3000))
