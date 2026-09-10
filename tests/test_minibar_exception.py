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
    import test_minibar_guest as guest_support
    from prsystem.minibar_guest import MinibarGuest
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarExceptionTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_manager_exception,prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();guest_support.MinibarGuestTests.configured(self);self.start();self.assert_status(guest_support.MinibarGuestTests.begin(self),200)

    def exceptional(self,actual=1,revision=0,token=None,**extra):
        body=dict({'counts':{self.product:actual},'no_consumption':actual==2,'reason':'Cleaner боломжгүй тул өрөөг биечлэн шалгасан','expected_revision':revision,'idempotency_key':uuid4().hex},**extra)
        return self.command('minibar-exception-report',body,token or self.manager_token)
    def stocks(self):return guest_support.MinibarGuestTests.stocks(self)
    def review(self,*a,**kw):return guest_support.MinibarGuestTests.review(self,*a,**kw)

    def test_manager_without_cleaner_posts_physical_report_and_reason_proof(self):
        result=self.assert_status(self.exceptional(),201);self.assertTrue(result['exception']);self.assertEqual(result['amount_mnt'],3000)
        self.assertEqual(self.stocks()['room_quantity'],1)
        with psycopg.connect(self.owner_dsn) as conn:
            reason,roles,package,task=conn.execute('SELECT reason,actor_roles,package_mnt,task_id FROM prsystem.minibar_manager_exception WHERE tenant_id=%s',(self.tenant,)).fetchone()
            self.assertTrue(reason);self.assertIn('MANAGER',roles);self.assertNotIn('CLEANER',roles);self.assertEqual(package,25000)
            self.assertEqual(conn.execute('SELECT state FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s',(self.tenant,task)).fetchone()[0],'DONE')
            self.assertEqual(conn.execute("SELECT state FROM prsystem.staff_open_work WHERE tenant_id=%s AND source_id=%s AND kind='CLEANING_TASK'",(self.tenant,task)).fetchone()[0],'CLOSED')
        preview=self.command('checkout/preview',None,self.manager_token,method='get').json()
        self.assertEqual(preview['report']['exception_reason'],reason)

    def test_existing_cleaner_task_is_superseded_atomically(self):
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201)
        self.assert_status(self.exceptional(),201)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s',(self.tenant,self.task['task_id'])).fetchone()[0],'CONTINUED')
            self.assertEqual(conn.execute('SELECT parent_id FROM prsystem.cleaning_task WHERE tenant_id=%s AND parent_id=%s',(self.tenant,self.task['task_id'])).fetchone()[0],self.task['task_id'])
        self.assert_status(guest_support.MinibarGuestTests.report(self),409)

    def test_reason_ack_counts_and_client_prices_fail_without_side_effect(self):
        before=self.stocks()
        for extra in(dict(reason=' '),dict(reason=None),dict(counts={}),dict(counts={self.product:3}),dict(unit_price=1),dict(no_consumption=True)):
            self.assert_status(self.exceptional(**extra),422)
        self.assertEqual(self.stocks(),before)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_manager_exception WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_reception_cleaner_and_admin_do_not_inherit_manager_exception(self):
        for token in(self.worker_token,self.admin):self.assert_status(self.exceptional(token=token),403)
        _,cleaner=self.add_staff(['CLEANER']);self.assert_status(self.exceptional(token=cleaner),403)

    def test_manager_plus_requires_thirty_thousand_package(self):
        _,plus=self.add_staff(['MANAGER_PLUS']);self.assert_status(self.exceptional(token=plus),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=30000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.exceptional(token=plus),201)

    def test_idempotency_preserves_single_physical_report(self):
        key=uuid4().hex;first=self.assert_status(self.exceptional(idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.exceptional(idempotency_key=key),201),first)
        self.assert_status(self.exceptional(actual=0,idempotency_key=key),409)
        self.assertEqual(self.stocks()['total_quantity'],9)

    def test_unpaid_exception_correction_preserves_locked_price(self):
        first=self.assert_status(self.exceptional(actual=0),201);self.assert_status(self.review(),200)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=9000,revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        second=self.assert_status(self.exceptional(revision=1),201)
        self.assertEqual(second['amount_mnt'],3000);self.assertEqual(self.stocks()['room_quantity'],1)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT amount_mnt FROM prsystem.guest_charge_adjustment WHERE tenant_id=%s AND charge_id=%s',(self.tenant,first['charge_id'])).fetchone()[0],-6000)

    def test_no_consumption_exception_creates_no_charge_or_movement(self):
        before=self.stocks();result=self.assert_status(self.exceptional(actual=2),201)
        self.assertIsNone(result['charge_id']);self.assertEqual(result['movement_ids'],[]);self.assertEqual(self.stocks(),before)

    def test_paid_exception_cannot_be_rewritten_and_checkout_still_settles(self):
        result=self.assert_status(self.exceptional(),201)
        guest_support.MinibarGuestTests.settle_and_close(self,result)
        self.assert_status(self.exceptional(revision=1),409)

    def test_failed_post_rolls_back_replacement_and_leaves_cleaner_assignment(self):
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201);before=self.stocks()
        with patch.object(MinibarGuest,'save',side_effect=DomainError('INVALID_REQUEST')):self.assert_status(self.exceptional(),422)
        self.assertEqual(before,self.stocks())
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT state FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s',(self.tenant,self.task['task_id'])).fetchone()[0],'OPEN')
        self.assert_status(guest_support.MinibarGuestTests.report(self),201)

    def test_expired_eligible_stay_allows_documented_manager_completion(self):
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours'+interval '1 millisecond' WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        self.assert_status(self.exceptional(),201)

    def test_competing_manager_and_cleaner_reports_commit_once(self):
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201);gate=Barrier(2)
        def manager():gate.wait();return self.exceptional()
        def cleaner():gate.wait();return guest_support.MinibarGuestTests.report(self)
        with ThreadPoolExecutor(max_workers=2) as pool:responses=[r.result() for r in(pool.submit(manager),pool.submit(cleaner))]
        self.assertEqual(sorted(r.status_code for r in responses),[201,409]);self.assertEqual(self.stocks()['room_quantity'],1)

    def test_exception_history_is_immutable_and_tenant_scoped(self):
        self.assert_status(self.exceptional(),201)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id','other-hotel',true)")
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_manager_exception').fetchone()[0],0)
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):conn.execute("UPDATE prsystem.minibar_manager_exception SET reason='Changed' WHERE tenant_id=%s",(self.tenant,))
