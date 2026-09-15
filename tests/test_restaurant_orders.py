"""Restaurant API, tenant/realm boundaries and transactional PostgreSQL evidence."""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.auth import StaffAuth
    from prsystem.common import DomainError
    from prsystem.mock_providers import MockStore, MockPaymentGateway
    from prsystem.postgres.connection import transaction
    from prsystem.restaurant_identity import RestaurantIdentity
    from prsystem.restaurant_orders import RestaurantOrders
    from prsystem.restaurant_policy import ZONE


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class RestaurantOrderTests(GuestFinanceCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT ON prsystem.restaurant,prsystem.hotel_restaurant,prsystem.restaurant_menu_item,prsystem.restaurant_schedule_exception,prsystem.restaurant_command_receipt TO {}',
                'GRANT INSERT ON prsystem.restaurant_menu_item,prsystem.restaurant_command_receipt,prsystem.restaurant_order_record TO {}',
                'GRANT UPDATE(revision) ON prsystem.restaurant TO {}',
                'GRANT UPDATE(revision) ON prsystem.restaurant_membership TO {}',
                'GRANT UPDATE(name,category,description,address,latitude,longitude,phone,weekly_hours) ON prsystem.restaurant TO {}',
                'GRANT INSERT,DELETE ON prsystem.restaurant_schedule_exception TO {}',
                'GRANT INSERT ON prsystem.restaurant_configuration_event TO {}',
                'GRANT UPDATE(image_data) ON prsystem.restaurant_menu_item TO {}',
                'GRANT SELECT ON prsystem.restaurant_notification,prsystem.restaurant_worker_cursor TO {}',
                'GRANT INSERT ON prsystem.restaurant_worker_cursor TO {}',
                'GRANT UPDATE(checked_at) ON prsystem.restaurant_worker_cursor TO {}',
                'GRANT UPDATE(active,revision) ON prsystem.hotel_restaurant TO {}',
                'GRANT UPDATE(category,name,description,price_mnt,active,available,revision) ON prsystem.restaurant_menu_item TO {}',
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        qr = self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms/{self.room}/guest-qr', headers=self.headers(self.manager_token),
            json=dict(expected_revision=0,idempotency_key='restaurant-qr',reason='Guest restaurant access')),200)['qr_token']
        self.start()
        self.guest_token = self.assert_status(self.client.post('/guest/access',json=dict(qr_token=qr,code=self.stay['guest_access_code'])),200)['access_token']
        self.restaurant, self.restaurant_account = uuid4().hex, uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0].astimezone(ZONE)
            self.clock = now.replace(hour=12,minute=0,second=0,microsecond=0)
            # Always-open test interval around the trusted test clock.
            hours = [dict(day=d,closed=False,opens='00:00',closes='23:59') for d in range(7)]
            conn.execute('''INSERT INTO prsystem.restaurant(id,created_by,name,category,description,address,latitude,longitude,phone,weekly_hours)
                VALUES(%s,%s,'Restaurant','Food','','Ulaanbaatar',47,106,'99112233',%s)''', (self.restaurant,self.account,Jsonb(hours)))
            conn.execute('INSERT INTO prsystem.hotel_restaurant(tenant_id,restaurant_id,created_by,active) VALUES(%s,%s,%s,true)',(self.tenant,self.restaurant,self.account))
            conn.execute('INSERT INTO prsystem.staff_account(id,email,password_hash,verified_at) VALUES(%s,%s,%s,now())',
                         (self.restaurant_account,self.restaurant_account+'@example.test',self.password_hash))
            conn.execute("INSERT INTO prsystem.restaurant_membership VALUES(%s,%s,'ACTIVE',0)",(self.restaurant,self.restaurant_account))
            conn.execute("UPDATE prsystem.staff_membership SET roles=ARRAY['HOTEL_ADMIN','MANAGER_PLUS'] WHERE tenant_id=%s AND account_id=%s",(self.tenant,self.account))
        self.owner_token = self.token()
        self.restaurant_token = self.assert_status(self.client.post('/auth/restaurants/login',json=dict(restaurant_id=self.restaurant,
            email=self.restaurant_account+'@example.test',password=self.password)),200)['access_token']
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.gateway = MockPaymentGateway(MockStore(temporary.name+'/provider.sqlite3',environment='test'), 'QPAY')
        self.gateway.merchant_id = 'MOCK_ONLY_RESTAURANT_' + self.restaurant
        self.auth = StaffAuth(self.app_dsn,self.settings)
        self.flow = RestaurantOrders(self.auth,RestaurantIdentity(self.auth),{self.restaurant:self.gateway},'test')
        self.client.close()
        self.client = TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',restaurant_gateways={self.restaurant:self.gateway}))
        self.addCleanup(self.client.close)
        self.time_patch = patch.object(RestaurantOrders,'now',staticmethod(lambda conn:self.clock))
        self.time_patch.start(); self.addCleanup(self.time_patch.stop)
        self.item = dict(category='Meals',name='Soup',description='Hot soup',price_mnt=4000,active=True,available=True)
        self.flow.menu_item(self.restaurant_token,self.restaurant,'soup',self.item,0,'menu')

    def create_order(self, key='order'):
        created = self.flow.create(self.guest_token,self.restaurant,{'soup':3},key)
        return self.flow.invoice(self.guest_token,created['order_id'])

    def act(self, order, action, data=None, guest=False, key=None):
        return self.flow.command(self.guest_token if guest else self.restaurant_token,self.tenant,order['order_id'],action,
            order['revision'],key or uuid4().hex,data,restaurant=None if guest else self.restaurant)

    def paid_order(self):
        order = self.create_order()
        self.gateway.set_status(order['order_id'],'SUCCEEDED')
        return self.act(order,'RECONCILE_PAYMENT',guest=True)

    def test_durable_intent_invoice_retry_and_pinned_menu_price(self):
        created = self.flow.create(self.guest_token,self.restaurant,{'soup':3},'create')
        self.flow.menu_item(self.restaurant_token,self.restaurant,'soup',dict(self.item,price_mnt=9000),1,'edit')
        self.assertEqual(self.flow.create(self.guest_token,self.restaurant,{'soup':3},'create'),created)
        invoice = self.flow.invoice(self.guest_token,created['order_id'])
        self.assertEqual((invoice['amount_mnt'],invoice['items'][0]['unit_price_mnt']),(12000,4000))
        self.assertEqual(self.flow.invoice(self.guest_token,created['order_id'])['invoice_id'],invoice['invoice_id'])
        self.assertEqual(self.gateway.payment(created['order_id'],invoice['invoice_id'])['amount'],12000)

    def test_private_phone_and_guest_hotel_realm_denied(self):
        menu = self.flow.menu(self.guest_token,self.restaurant)
        self.assertNotIn('99112233',str(menu))
        with self.assertRaises(DomainError):
            self.flow.menu(self.worker_token,self.restaurant)
        with self.assertRaises(DomainError):
            self.flow.menu_item(self.owner_token,self.restaurant,'x',self.item,0,'bad')
        order = self.create_order()
        self.assertEqual(order['contact_phone'],'99112233')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.restaurant SET phone=%s WHERE id=%s',('99223344',self.restaurant))
        detail = self.flow.guest_detail(self.guest_token,order['order_id'])
        self.assertEqual((detail['contact_phone'],detail['contact_phone_snapshot']),('99223344','99112233'))

    def test_invoice_crash_preserves_intent_and_provider_idempotency(self):
        created = self.flow.create(self.guest_token,self.restaurant,{'soup':3},'create')
        with patch.object(RestaurantOrders,'save',side_effect=RuntimeError('commit interruption')):
            with self.assertRaises(RuntimeError):
                self.flow.invoice(self.guest_token,created['order_id'])
        recovered = self.flow.invoice(self.guest_token,created['order_id'])
        self.assertEqual(recovered['amount_mnt'],12000)
        with self.gateway.store.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM mock_invoice').fetchone()[0],1)

    def test_unpaid_queue_hidden_capture_once_and_hotel_finance_unchanged(self):
        order = self.create_order()
        before = self.statement().json(); drawer = self.drawer()
        self.assertEqual(self.flow.restaurant_queue(self.restaurant_token,self.restaurant)['orders'],[])
        self.gateway.set_status(order['order_id'],'SUCCEEDED')
        paid = self.act(order,'RECONCILE_PAYMENT',guest=True)
        replay = self.act(paid,'RECONCILE_PAYMENT',guest=True)
        self.assertEqual(replay['revision'],paid['revision'])
        self.assertEqual(len(self.flow.restaurant_queue(self.restaurant_token,self.restaurant)['orders']),1)
        self.assertEqual(self.statement().json(),before)
        self.assertEqual(self.drawer(),drawer)

    def test_inactive_link_cancels_pending_but_capture_requires_refund(self):
        order = self.create_order()
        self.flow.set_link(self.owner_token,self.tenant,self.restaurant,False,0,'disable')
        current = self.flow.guest_detail(self.guest_token,order['order_id'])
        self.assertEqual(current['state']['payment'],'EXPIRED')
        self.gateway.set_status(order['order_id'],'SUCCEEDED')
        paid = self.act(current,'RECONCILE_PAYMENT',guest=True)
        self.assertEqual((paid['state']['order'],paid['state']['refund_policy']),('CANCELLED','MANDATORY'))
        with self.assertRaises(DomainError):
            self.flow.create(self.guest_token,self.restaurant,{'soup':1},'blocked')

    def test_accept_refund_race_has_one_commit(self):
        paid = self.paid_order(); self.clock += timedelta(minutes=10)
        barrier = Barrier(2)
        def run(action):
            barrier.wait()
            try:
                return self.act(paid,action,dict(eta_minutes=15) if action=='ACCEPT' else None,guest=action=='REQUEST_REFUND')
            except DomainError as exc:
                return str(exc)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run,['ACCEPT','REQUEST_REFUND']))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertIn('REVISION_CONFLICT',results)

    def test_mandatory_refund_provider_result_and_sla_pause(self):
        paid = self.paid_order(); self.clock += timedelta(minutes=10)
        approved = self.act(paid,'REQUEST_REFUND',guest=True)
        self.clock += timedelta(minutes=30)
        self.assertFalse(self.flow.menu(self.guest_token,self.restaurant)['ordering_available'])
        pending = self.act(approved,'BEGIN_REFUND')
        sent = self.act(pending,'RECONCILE_REFUND')
        self.assertEqual(sent['state']['refund'],'PENDING')
        self.gateway.set_refund_status(pending['state']['refund_attempt_id'],'SUCCEEDED')
        done = self.act(sent,'RECONCILE_REFUND')
        self.assertEqual((done['state']['refund'],done['state']['payment']),('REFUNDED','PAID'))
        self.assertFalse(self.flow.guest_detail(self.guest_token,paid['order_id'])['alerts']['link_paused'])

    def test_provider_mismatch_rolls_back_without_paid_event(self):
        order = self.create_order(); self.gateway.set_status(order['order_id'],'SUCCEEDED')
        evidence = self.gateway.payment(order['order_id'],order['invoice_id'])
        with patch.object(self.gateway,'payment',return_value=dict(evidence,merchant_id='other')):
            with self.assertRaisesRegex(DomainError,'PAYMENT_MISMATCH'):
                self.act(order,'RECONCILE_PAYMENT',guest=True)
        current = self.flow.guest_detail(self.guest_token,order['order_id'])
        self.assertEqual((current['revision'],current['state']['payment']),(order['revision'],'PENDING'))

    def test_forced_rls_and_append_only_evidence(self):
        order = self.create_order()
        with transaction(self.app_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.restaurant_order_record').fetchone()[0],0)
            RestaurantOrders.scope(conn,tenant=self.other)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.restaurant_order_record').fetchone()[0],0)
        with self.assertRaises(psycopg.Error), psycopg.connect(self.owner_dsn) as conn:
            conn.execute('DELETE FROM prsystem.restaurant_order_event WHERE tenant_id=%s',(self.tenant,))
        with self.assertRaises(psycopg.Error), transaction(self.app_dsn) as conn:
            RestaurantOrders.scope(conn,tenant=self.tenant)
            conn.execute('UPDATE prsystem.restaurant_order_record SET revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,order['order_id']))

    def test_checkout_requires_each_handoff_and_preserves_restaurant_money(self):
        paid = self.paid_order()
        accepted = self.act(paid,'ACCEPT',dict(eta_minutes=15))
        from prsystem.reception_dependencies import ReceptionDependencies
        with self.assertRaisesRegex(DomainError,'RESTAURANT_ACK_REQUIRED'), transaction(self.app_dsn) as conn:
            ReceptionDependencies.final(conn,self.tenant,self.stay['stay_id'],self.worker,[],False,'production')
        with transaction(self.app_dsn) as conn:
            ReceptionDependencies.final(conn,self.tenant,self.stay['stay_id'],self.worker,
                [dict(order_id=paid['order_id'],choice='RECEPTION_PICKUP')],True,'production')
        detail = self.flow.guest_detail(self.guest_token,paid['order_id'])
        self.assertEqual((detail['state']['handoff'],detail['state']['fulfillment']),('RECEPTION','ACCEPTED'))

    def test_api_forbids_price_and_payment_flags_and_validates_menu(self):
        path = f'/guest/restaurants/{self.restaurant}/orders'
        response = self.client.post(path,headers=self.headers(self.guest_token),json=dict(quantities={'soup':1},idempotency_key='api',amount_mnt=1))
        self.assertEqual(response.status_code,422)
        response = self.client.put(f'/restaurants/{self.restaurant}/menu/soup',headers=self.headers(self.restaurant_token),
            json=dict(self.item,expected_revision=1,idempotency_key='boolean',price_mnt=True))
        self.assertEqual(response.status_code,422)
        response = self.client.post(path,headers=self.headers(self.guest_token),json=dict(quantities={'soup':2},idempotency_key='api'))
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(response.json()['amount_mnt'],8000)

    def test_menu_and_owned_order_discovery_are_scoped_and_paginated(self):
        self.assertEqual(self.flow.guest_restaurants(self.guest_token),[dict(restaurant_id=self.restaurant,name='Restaurant',active=True)])
        self.assertEqual(self.flow.guest_orders(self.guest_token)['orders'],[])
        order=self.create_order()
        self.assertEqual(self.flow.guest_orders(self.guest_token)['orders'][0]['order_id'],order['order_id'])
        self.assertEqual(self.flow.guest_orders(self.guest_token,order['order_id'])['orders'],[])
        own=self.flow.own_menu(self.restaurant_token,self.restaurant)
        self.assertEqual(own['items'][0]['item_id'],'soup')
        with self.assertRaises(DomainError):
            self.flow.own_menu(self.guest_token,self.restaurant)

    def test_guest_logout_revokes_server_session_and_order_access(self):
        order=self.create_order()
        self.assertEqual(self.flow.guest_logout(self.guest_token)['status'],'SIGNED_OUT')
        with self.assertRaisesRegex(DomainError,'INVALID_GUEST_ACCESS'):
            self.flow.guest_detail(self.guest_token,order['order_id'])

    def test_manager_profile_special_closure_and_immutable_audit(self):
        data=self.flow.profile(self.owner_token,self.tenant,self.restaurant)
        data['expected_revision']=data.pop('revision')
        data.update(reason='Closed for maintenance',closed_dates=[self.clock.date().isoformat()])
        with self.assertRaisesRegex(DomainError,'INVALID_REQUEST'):
            self.flow.profile(self.owner_token,self.tenant,self.restaurant,{**data,'reason':'   '},'blank-profile')
        result=self.flow.profile(self.owner_token,self.tenant,self.restaurant,data,'profile')
        self.assertEqual(result['revision'],1)
        self.assertFalse(self.flow.menu(self.guest_token,self.restaurant)['ordering_available'])
        with self.assertRaisesRegex(DomainError,'RESTAURANT_CLOSED'):
            self.flow.create(self.guest_token,self.restaurant,{'soup':1},'closed')
        self.assertEqual(self.flow.profile(self.owner_token,self.tenant,self.restaurant,data,'profile'),result)
        with self.assertRaises(DomainError):
            self.flow.profile(self.restaurant_token,self.tenant,self.restaurant,data,'denied')
        with self.assertRaises(psycopg.Error),psycopg.connect(self.owner_dsn) as conn:
            conn.execute('DELETE FROM prsystem.restaurant_configuration_event WHERE restaurant_id=%s',(self.restaurant,))

    def test_menu_image_reencoding_revision_and_clear(self):
        from test_image_assets import MenuImageTests
        result=self.flow.image(self.restaurant_token,self.restaurant,'soup',MenuImageTests().image(),1,'image')
        self.assertEqual(result['revision'],2)
        self.assertTrue(self.flow.menu(self.guest_token,self.restaurant)['items'][0]['image_data'].startswith('data:image/jpeg;base64,'))
        with self.assertRaisesRegex(DomainError,'REVISION_CONFLICT'):
            self.flow.image(self.restaurant_token,self.restaurant,'soup',None,1,'stale')
        self.flow.image(self.restaurant_token,self.restaurant,'soup',None,2,'clear')
        self.assertIsNone(self.flow.own_menu(self.restaurant_token,self.restaurant)['items'][0]['image_data'])

    def test_worker_recovers_orphan_invoice_and_deduplicates_notices(self):
        created=self.flow.create(self.guest_token,self.restaurant,{'soup':3},'orphan')
        with patch.object(RestaurantOrders,'save',side_effect=RuntimeError('crash')):
            with self.assertRaises(RuntimeError):self.flow.invoice(self.guest_token,created['order_id'])
        self.gateway.set_status(created['order_id'],'SUCCEEDED')
        self.assertEqual(self.flow.tick()[0]['status'],'CHECKED')
        self.clock+=timedelta(minutes=10)
        self.flow.tick();self.flow.tick()
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.restaurant_notification WHERE tenant_id=%s AND code='ORDER_PAID'",(self.tenant,)).fetchone()[0],1)
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.restaurant_notification WHERE tenant_id=%s AND code='ACCEPTANCE_LATE' AND audience='RECEPTION'",(self.tenant,)).fetchone()[0],1)
        notices=self.flow.notifications(self.worker_token,tenant=self.tenant)
        self.assertIn('ACCEPTANCE_LATE',[n['code'] for n in notices['items']])

    def test_worker_does_not_create_invoice_and_round_robin_checks(self):
        first=self.flow.create(self.guest_token,self.restaurant,{'soup':1},'unrequested')
        second=self.flow.create(self.guest_token,self.restaurant,{'soup':2},'second')
        one=self.flow.tick(1);two=self.flow.tick(1)
        self.assertNotEqual(one[0]['order_id'],two[0]['order_id'])
        with self.gateway.store.connect() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM mock_invoice').fetchone()[0],0)

    def test_reception_can_request_but_cannot_send_refund(self):
        paid=self.paid_order();self.clock+=timedelta(minutes=10)
        result=self.flow.command(self.worker_token,self.tenant,paid['order_id'],'REQUEST_REFUND',paid['revision'],'reception-refund',hotel_staff=True)
        self.assertEqual(result['state']['refund_policy'],'MANDATORY')
        with self.assertRaisesRegex(DomainError,'FORBIDDEN'):
            self.flow.command(self.worker_token,self.tenant,paid['order_id'],'BEGIN_REFUND',result['revision'],'forbidden-refund',hotel_staff=True)
