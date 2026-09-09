import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from uuid import uuid4

from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.booking_inventory import room_intervals


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarConfigurationTests(GuestFinanceCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_product,prsystem.minibar_receipt,prsystem.minibar_template,prsystem.minibar_template_version,prsystem.minibar_template_item,prsystem.minibar_configuration_request TO {}',
                'GRANT UPDATE(revision) ON prsystem.minibar_product TO {}',
                'GRANT UPDATE(revision,default_version_id) ON prsystem.minibar_template TO {}',
                'GRANT UPDATE(state) ON prsystem.minibar_template_version TO {}',
                'GRANT DELETE ON prsystem.minibar_template_item TO {}',
                'GRANT UPDATE(state,revision,cancelled_by,cancel_reason,cancelled_at) ON prsystem.minibar_configuration_request TO {}',
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.product = self.assert_status(self.api('minibar/products', dict(name='Ус',category='Ундаа',unit='ш',selling_price_mnt=3000,unit_cost_mnt=1000,opening_quantity=10)),201)['product_id']
        t = self.assert_status(self.api('minibar/templates',dict(name='Стандарт')),201)
        self.template = t['template_id']
        d = self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=1)),201)
        self.version = d['version']['version_id']
        self.assert_status(self.api(self.version_path(),dict(expected_revision=2,items=[dict(product_id=self.product,target_quantity=2)]),method='put'),200)
        self.assert_status(self.api(self.version_path()+'/publish',dict(expected_revision=3)),200)

    def api(self, tail, data=None, token=None, method='post', tenant=None):
        kw = dict(headers=self.headers(token or self.manager_token))
        if data is not None:
            kw['json'] = {'idempotency_key':uuid4().hex,**data}
        return getattr(self.client,method)(f'/hotels/{tenant or self.tenant}/'+tail,**kw)

    def version_path(self):
        return f'minibar/templates/{self.template}/versions/{self.version}'

    def revision(self):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute('SELECT revision FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0]

    def request(self, token=None, **extra):
        body = dict(target_mode='ON',target_template_id=self.template,target_version_id=self.version,expected_room_revision=self.revision(),reason='Бүрдлийг шинэчлэх')
        body.update(extra)
        return self.api(f'rooms/{self.room}/minibar-configuration/requests',body,token)

    def cancel(self, request, **extra):
        return self.api(f'minibar/configuration-requests/{request["request_id"]}/cancel',dict(expected_revision=request['revision'],reason='Төлөвлөгөө өөрчлөгдсөн',**extra))

    def read(self, token=None, query=''):
        return self.api(f'rooms/{self.room}/minibar-configuration'+query,token=token,method='get')

    def test_request_pins_snapshot_and_blocks_off_walkin_without_stock_effect(self):
        with psycopg.connect(self.owner_dsn) as conn:
            before = conn.execute('SELECT count(*),sum(warehouse_after) FROM prsystem.minibar_receipt WHERE tenant_id=%s',(self.tenant,)).fetchone()
        req = self.assert_status(self.request(),201)
        self.assertEqual(req['state'],'READY_FOR_RECONCILIATION')
        self.assertEqual(req['source_snapshot']['mode'],'OFF')
        self.assertEqual(req['target_snapshot']['items'][0]['target_quantity'],2)
        self.assertEqual(self.checkin().json()['code'],'CONFIGURATION_PENDING')
        self.assertEqual(self.checkin(actual_checkin_at=req['recorded_at'],backdate_reason='Өмнө ирсэн').json()['code'],'CONFIGURATION_PENDING')
        data = self.assert_status(self.read(self.worker_token),200)
        self.assertEqual(data['current']['mode'],'OFF')
        self.assertEqual(data['pending'],req)
        self.assertTrue(self.assert_status(self.api('rooms',method='get',token=self.worker_token),200)[0]['pending_minibar_change'])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*),sum(warehouse_after) FROM prsystem.minibar_receipt WHERE tenant_id=%s',(self.tenant,)).fetchone(),before)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_pending_request_retains_exact_version_when_default_changes(self):
        req = self.assert_status(self.request(),201)
        d = self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=4,source_version_id=self.version)),201)
        path = f'minibar/templates/{self.template}/versions/{d["version"]["version_id"]}'
        self.assert_status(self.api(path+'/publish',dict(expected_revision=5)),200)
        self.assert_status(self.api(path+'/default',dict(expected_revision=6)),200)
        self.assertEqual(self.read().json()['pending'],req)

    def test_cancel_clears_blocker_preserves_cleanliness_and_retry_never_reopens(self):
        revision=self.revision()
        req=self.assert_status(self.request(expected_room_revision=revision,idempotency_key='request'),201)
        cancelled=self.assert_status(self.cancel(req,idempotency_key='cancel'),200)
        self.assertEqual(cancelled['state'],'CANCELLED')
        self.assertEqual(self.cancel(req,idempotency_key='cancel').json(),cancelled)
        self.assertEqual(self.request(expected_room_revision=revision,idempotency_key='request').json(),req)
        self.assertIsNone(self.read().json()['pending'])
        self.start()

    def test_active_stay_is_scheduled_and_not_modified(self):
        stay=self.start()
        with psycopg.connect(self.owner_dsn) as conn:
            before=conn.execute('SELECT to_jsonb(s) FROM prsystem.stay s WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
        req=self.assert_status(self.request(),201)
        self.assertEqual((req['state'],req['active_stay_id']),('SCHEDULED_AFTER_STAY',stay['stay_id']))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT to_jsonb(s) FROM prsystem.stay s WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],before)
        self.assert_status(self.allocate(60000),201)
        self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=20000,charge_id=stay['room_charge_id'],expected_revision=2,idempotency_key='payment')),201)
        self.assert_status(self.command('checkout',dict(expected_revision=3,idempotency_key='checkout')),200)
        self.assertEqual(self.read().json()['pending'],req)
        self.assert_status(self.cancel(req),200)

    def test_off_request_retains_mock_stock_and_blocks_configuration_bypass(self):
        self.client.close()
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test'))
        self.addCleanup(self.client.close)
        self.assert_status(self.api(f'mock/rooms/{self.room}/minibar',dict(expected_revision=self.revision(),items=[dict(product_id='water',name='Ус',unit_price=3000,opening_quantity=2)]),method='put'),200)
        with psycopg.connect(self.owner_dsn) as conn:
            before=conn.execute('SELECT product_id,location_id,quantity FROM prsystem.cleaning_stock WHERE tenant_id=%s ORDER BY product_id,location_id',(self.tenant,)).fetchall()
        req=self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),201)
        self.assertEqual(req['source_snapshot']['mode'],'MOCK_ON')
        self.assertEqual(self.api(f'mock/rooms/{self.room}/minibar',dict(expected_revision=self.revision(),items=[]),method='put').json()['code'],'CONFIGURATION_PENDING')
        self.assert_status(self.cancel(req),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT product_id,location_id,quantity FROM prsystem.cleaning_stock WHERE tenant_id=%s ORDER BY product_id,location_id',(self.tenant,)).fetchall(),before)

    def test_revoked_manager_cannot_cancel_or_replay_request(self):
        revision=self.revision()
        req=self.assert_status(self.request(expected_room_revision=revision,idempotency_key='request'),201)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_membership SET roles=ARRAY['RECEPTION'] WHERE tenant_id=%s AND account_id=%s",(self.tenant,self.manager))
        self.assert_status(self.request(expected_room_revision=revision,idempotency_key='request'),403)
        self.assert_status(self.cancel(req),403)
        self.assert_status(self.read(),200)

    def test_current_authority_checked_before_idempotent_replay(self):
        revision=self.revision()
        self.assert_status(self.request(expected_room_revision=revision,idempotency_key='request'),201)
        for token in (self.worker_token,self.admin):
            self.assert_status(self.request(token),403)
            self.assert_status(self.read(token),200)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt=20000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.request(expected_room_revision=revision,idempotency_key='request'),403)
        self.assert_status(self.read(),403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt=30000,security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.read().json()['code'],'SECURITY_SUSPENDED')

    def test_draft_foreign_inactive_and_forged_targets_fail(self):
        d=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=4)),201)
        self.assertEqual(self.request(target_version_id=d['version']['version_id']).json()['code'],'TEMPLATE_NOT_PUBLISHED')
        self.assert_status(self.request(target_version_id=uuid4().hex),404)
        self.assert_status(self.request(target_mode='OFF'),422)
        self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),409)
        for extra in (dict(expected_room_revision=True),dict(active_stay_id='fake'),dict(state='APPLIED'),dict(reason='')):
            self.assert_status(self.request(**extra),422)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_product SET status='INACTIVE',revision=revision+1 WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.request().json()['code'],'PRODUCT_NOT_ACTIVE')

    def test_concurrent_request_has_one_pending_and_stale_revision(self):
        revision=self.revision();barrier=Barrier(2)
        def go(_):
            barrier.wait()
            return self.request(expected_room_revision=revision).status_code
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(go,range(2))),[201,409])
        self.assertEqual(self.request().json()['code'],'CONFIGURATION_PENDING')
        self.assertEqual(len(self.read().json()['items']),1)

    def test_concurrent_checkin_and_request_are_serialized(self):
        revision=self.revision();barrier=Barrier(2)
        def go(which):
            barrier.wait()
            return self.request(expected_room_revision=revision) if which else self.checkin(deposit=dict(channel='CASH',amount_mnt=60000,received=True))
        with ThreadPoolExecutor(2) as pool:
            checkin,request=list(pool.map(go,[0,1]))
        self.assert_status(request,201)
        if checkin.status_code==201:
            self.assertEqual(request.json()['active_stay_id'],checkin.json()['stay_id'])
            self.assertEqual(request.json()['state'],'SCHEDULED_AFTER_STAY')
        else:
            self.assertEqual(checkin.json()['code'],'CONFIGURATION_PENDING')

    def test_capacity_excludes_pending_and_cancel_restores_room(self):
        def available():
            with psycopg.connect(self.owner_dsn) as conn:
                return room_intervals(conn,self.tenant,self.category)
        self.assertIn(self.room,available())
        req=self.assert_status(self.request(),201)
        self.assertNotIn(self.room,available())
        self.assert_status(self.cancel(req),200)
        self.assertIn(self.room,available())

    def test_existing_booking_retained_new_booking_and_arrival_blocked(self):
        self.client.close()
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test'))
        self.addCleanup(self.client.close)
        body=dict(room_id=self.room,kind='NIGHTLY',duration_units=1,planned_checkin_at=datetime.now(timezone.utc).isoformat())
        booking=self.assert_status(self.api('mock/bookings',body),201)
        self.assert_status(self.request(),201)
        self.assertEqual(self.api('mock/bookings',body).json()['code'],'CONFIGURATION_PENDING')
        guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211')
        self.assertEqual(self.api(f'bookings/{booking["booking_id"]}/check-in',dict(guest=guest),self.worker_token).json()['code'],'CONFIGURATION_PENDING')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.room_reservation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'CONFIRMED')

    def test_database_source_and_blocker_cannot_be_rewritten(self):
        self.assert_status(self.request(),201)
        queries=("UPDATE prsystem.minibar_configuration_request SET target_mode='OFF' WHERE tenant_id=%s",
                 "DELETE FROM prsystem.minibar_configuration_request WHERE tenant_id=%s",
                 "UPDATE prsystem.reception_dependency_blocker SET state='DONE' WHERE tenant_id=%s AND source_kind='MINIBAR_CONFIGURATION'",
                 "DELETE FROM prsystem.reception_dependency_blocker WHERE tenant_id=%s AND source_kind='MINIBAR_CONFIGURATION'",
                 "UPDATE prsystem.room SET minibar_mode='MOCK_ON' WHERE tenant_id=%s")
        for query in queries:
            with self.subTest(query=query),self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
                conn.execute(query,(self.tenant,))
        with self.assertRaisesRegex(psycopg.errors.CheckViolation,'Configuration change pending'),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("""INSERT INTO prsystem.room_reservation(tenant_id,id,room_id,planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes,source_reference,state)
                SELECT tenant_id,'blocked',id,now(),now()+interval '1 day',30,'blocked','CONFIRMED' FROM prsystem.room WHERE tenant_id=%s""",(self.tenant,))
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("""INSERT INTO prsystem.room_reservation(tenant_id,id,room_id,planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes,source_reference,state)
                SELECT tenant_id,'cancelled',id,now(),now()+interval '1 day',30,'cancelled','CANCELLED' FROM prsystem.room WHERE tenant_id=%s""",(self.tenant,))
        with self.assertRaisesRegex(psycopg.errors.CheckViolation,'Configuration change pending'),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.room_reservation SET state='CONFIRMED' WHERE tenant_id=%s AND id='cancelled'",(self.tenant,))
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.other,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_configuration_request').fetchone()[0],0)

    def test_retirement_waits_for_request_and_cancel_completes_it(self):
        req=self.assert_status(self.request(),201)
        retired=self.assert_status(self.api(f'rooms/{self.room}/lifecycle',dict(action='DEACTIVATE',expected_revision=self.revision(),reason='Хаах')),200)
        self.assertEqual(retired['status'],'RETIRING')
        self.assert_status(self.cancel(req),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT status FROM prsystem.room WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'INACTIVE')

    def test_commit_failure_rolls_back_request_blocker_revision_audit_receipt(self):
        revision=self.revision()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_configuration_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_configuration_commit AFTER INSERT ON prsystem.minibar_configuration_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_configuration_commit()').format(sql.Literal(self.tenant)))
        try:
            self.assert_status(self.request(idempotency_key='atomic'),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_configuration_commit ON prsystem.minibar_configuration_request')
                conn.execute('DROP FUNCTION prsystem.fail_configuration_commit()')
        self.assertEqual(self.revision(),revision)
        self.assertIsNone(self.read().json()['pending'])
        with psycopg.connect(self.owner_dsn) as conn:
            for table,where in (('minibar_configuration_request','true'),('reception_dependency_blocker',"source_kind='MINIBAR_CONFIGURATION'"),('operational_event',"kind='MINIBAR_CONFIGURATION_REQUESTED'"),('staff_command_receipt',"key='atomic'")):
                self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.'+table+' WHERE tenant_id=%s AND '+where,(self.tenant,)).fetchone()[0],0)
        self.assert_status(self.request(idempotency_key='atomic'),201)

    def test_bounded_history_and_cancel_cas(self):
        req=self.assert_status(self.request(),201)
        self.assert_status(self.api(f'minibar/configuration-requests/{req["request_id"]}/cancel',dict(expected_revision=2,reason='stale')),409)
        self.assert_status(self.cancel(req),200)
        self.assert_status(self.request(),201)
        first=self.assert_status(self.read(query='?limit=1'),200)
        second=self.assert_status(self.read(query='?limit=1&after='+first['next_after']),200)
        self.assertEqual(len({r['request_id'] for r in first['items']+second['items']}),2)
        self.assertIsNone(second['next_after'])
        self.assert_status(self.read(query='?limit=101'),422)
