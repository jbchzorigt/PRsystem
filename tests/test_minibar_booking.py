import unittest
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from minibar_configuration_support import MinibarConfigurationCase
from guest_finance_support import GuestFinanceCase
from tempfile import TemporaryDirectory
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mock_providers import MockStore, MockPaymentGateway
    from psycopg import sql
    import test_booking_holds as booking_support
    import test_minibar_guest as guest_support
    from prsystem.booking_inventory import room_intervals


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarBookingTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT,INSERT ON prsystem.booking_category_rank,prsystem.booking_upgrade,prsystem.booking_refund_request,prsystem.booking_refund_confirmation,prsystem.booking_hold_cancellation,prsystem.booking_hold_application,prsystem.booking_contract,prsystem.booking_hold,prsystem.booking_hold_attempt,prsystem.booking_hold_capture,prsystem.booking_hold_event,prsystem.booking_hold_command TO {}',
                'GRANT SELECT,INSERT ON prsystem.booking_paid_source,prsystem.booking_beneficiary,prsystem.booking_settlement,prsystem.booking_settlement_adjustment,prsystem.booking_finance_event,prsystem.booking_payout_batch,prsystem.booking_payout_line,prsystem.booking_payout_void,prsystem.booking_payout_attempt,prsystem.booking_payout_result TO {}',
                'GRANT SELECT,INSERT,UPDATE ON prsystem.booker_account,prsystem.booker_session,prsystem.booker_challenge,prsystem.booking_listing,prsystem.booking_publication,prsystem.booking_category_listing TO {}',
                'GRANT SELECT,INSERT ON prsystem.booker_receipt,prsystem.booker_event TO {}',
                'GRANT SELECT ON prsystem.platform_account,prsystem.platform_session,prsystem.platform_receipt TO {}',
                'GRANT UPDATE(last_totp_counter) ON prsystem.platform_account TO {}',
                'GRANT UPDATE(mfa_at,revoked_at) ON prsystem.platform_session TO {}',
                'GRANT INSERT ON prsystem.platform_session,prsystem.platform_receipt,prsystem.platform_event TO {}',
                'GRANT UPDATE(rank,revision) ON prsystem.booking_category_rank TO {}',
                'GRANT UPDATE(last_provider_state) ON prsystem.booking_refund_request TO {}',
                'GRANT UPDATE(booking_state,hold_state,applied_attempt_id,confirmation_snapshot) ON prsystem.booking_hold TO {}',
                'GRANT UPDATE(state,invoice_id) ON prsystem.booking_hold_attempt TO {}',
            ):conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))
            for grant in (
                'GRANT INSERT ON prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setup_booking(self):
        GuestFinanceCase.setUp(self)
        directory=TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.store=MockStore(directory.name+'/booking.sqlite3',environment='test')
        self.gateways={p:MockPaymentGateway(self.store,p) for p in ('QPAY','KHAAN')}
        self.client.close()
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways=self.gateways),client=(self.peer,12345))
        self.addCleanup(self.client.close)
        self.arrival=datetime.now(timezone.utc)+timedelta(days=2)
        self.assert_status(self.contract(),200)

    def setUp(self):
        # Booking's setup delegates to GuestFinanceCase; initialize the minibar
        # catalog separately against that same hotel, database and API client.
        self.setup_booking()
        self.product=self.assert_status(self.api('minibar/products',dict(name='Ус',category='Ундаа',unit='ш',selling_price_mnt=3000,unit_cost_mnt=1000,opening_quantity=10)),201)['product_id']
        self.template=self.assert_status(self.api('minibar/templates',dict(name='Стандарт')),201)['template_id']
        self.version=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=1)),201)['version']['version_id']
        self.assert_status(self.api(self.version_path(),dict(expected_revision=2,items=[dict(product_id=self.product,target_quantity=2)]),method='put'),200)
        self.assert_status(self.api(self.version_path()+'/publish',dict(expected_revision=3)),200)
        guest_support.MinibarGuestTests.configured(self)

    def contract(self,*a,**kw):return booking_support.BookingHoldTests.contract(self,*a,**kw)
    def hold(self,*a,**kw):return booking_support.BookingHoldTests.hold(self,*a,**kw)
    def call(self,*a,**kw):return booking_support.BookingHoldTests.call(self,*a,**kw)
    def begin(self):return booking_support.BookingHoldTests.begin(self)
    def pay(self,*a,**kw):return booking_support.BookingHoldTests.pay(self,*a,**kw)
    def arriving_hold(self):return booking_support.BookingHoldTests.arriving_hold(self)
    def apply_hold(self,*a,**kw):return booking_support.BookingHoldTests.apply_hold(self,*a,**kw)
    def capacity_rooms(self, tenant=None):
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant or self.tenant,))
            return room_intervals(conn,tenant or self.tenant,self.category)

    def test_future_hold_does_not_pin_minibar_or_change_stock(self):
        before=guest_support.MinibarGuestTests.stocks(self)
        hold=self.assert_status(self.hold(),201)
        self.assertIn(self.room,self.capacity_rooms())
        self.assertNotIn('minibar_snapshot',hold['quote'])
        self.assertNotIn('room_id',hold)
        self.assertEqual(guest_support.MinibarGuestTests.stocks(self),before)
        self.assert_status(self.hold(key='overbook'),409)

    def test_paid_arrival_pins_current_price_and_version_without_repricing_booking(self):
        hold=self.arriving_hold()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=4500,revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        self.stay=self.assert_status(self.apply_hold(hold),201)
        self.assertEqual(self.assert_status(self.apply_hold(hold),201),self.stay)
        book=self.stay['snapshot']['minibar_snapshot']
        self.assertEqual((book['version_id'],book['items'][0]['unit_price'],book['items'][0]['opening_quantity']),(self.version,4500,2))
        self.assertEqual((self.stay['amount_mnt'],self.stay['deposit_mnt']),(hold['quote']['amount_mnt'],0))
        self.assertEqual(self.drawer(),(0,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_hold_application WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_existing_hold_blocks_overlapping_walkin_without_money_effect(self):
        self.arrival=datetime.now(timezone.utc)+timedelta(minutes=1)
        self.assert_status(self.hold(),201)
        result=self.checkin(kind='NIGHTLY',duration_units=2,deposit=dict(channel='CASH',amount_mnt=60000,received=True))
        self.assertEqual(result.json()['code'],'BOOKING_CAPACITY_UNAVAILABLE')
        self.assertEqual(self.drawer(),(0,0))

    def test_pending_configuration_blocks_new_hold_and_paid_arrival_preserves_booking(self):
        hold=self.arriving_hold()
        q=self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),201)
        self.assertEqual(self.capacity_rooms(),{})
        self.assertEqual(self.apply_hold(hold).json()['code'],'CONFIGURATION_PENDING')
        self.assertEqual(self.call(hold).json()['booking_state'],'CONFIRMED')
        self.assert_status(self.cancel(q),200)
        self.assert_status(self.apply_hold(hold),201)

    def test_retiring_product_blocks_capacity_and_arrival_without_cancelling_paid_hold(self):
        hold=self.arriving_hold()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_product SET status='RETIRING',deactivation_requested_at=clock_timestamp() WHERE tenant_id=%s AND id=%s",(self.tenant,self.product))
        self.assertEqual(self.capacity_rooms(),{})
        self.assertEqual(self.apply_hold(hold).json()['code'],'ROOM_NOT_READY')
        self.assertEqual(self.call(hold).json()['booking_state'],'CONFIRMED')

    def test_retiring_template_and_package_gate_exclude_future_capacity(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_template SET status='RETIRING' WHERE tenant_id=%s AND id=%s",(self.tenant,self.template))
        self.assertEqual(self.capacity_rooms(),{})
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_template SET status='ACTIVE' WHERE tenant_id=%s AND id=%s",(self.tenant,self.template))
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt=20000 WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.capacity_rooms(),{})

    def test_unrelated_blocker_is_not_ignored_and_tenant_scope_is_preserved(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.reception_dependency_blocker VALUES(%s,%s,'BOOKING','manual-proof','OPEN')",(self.tenant,self.room))
        self.assertEqual(self.capacity_rooms(),{})
        self.assertEqual(self.capacity_rooms('other-hotel'),{})

    def test_last_canonical_room_concurrent_holds_have_one_winner(self):
        gate=Barrier(2)
        def hold(key):gate.wait();return self.hold(key=key)
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(hold,['one','two']))
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])

    def test_paid_arrival_concurrency_creates_one_opening(self):
        hold=self.arriving_hold();gate=Barrier(2)
        def arrive(key):gate.wait();return self.apply_hold(hold,key=key)
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(arrive,['one','two']))
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_canonical_candidate_prevents_false_hotel_cancellation(self):
        hold=self.arriving_hold()
        response=self.api(f'booking-holds/{hold["booking_id"]}/terminal',dict(outcome='CANCELLED_HOTEL',reason='No available room'))
        self.assertEqual(response.json()['code'],'BOOKING_ROOM_AVAILABLE')

    def test_booking_canonical_consumption_uses_guest_ledger_and_checkout_adapter(self):
        hold=self.arriving_hold();self.stay=self.assert_status(self.apply_hold(hold),201)
        self.assert_status(guest_support.MinibarGuestTests.begin(self),200)
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201)
        report=self.assert_status(guest_support.MinibarGuestTests.report(self),201)
        self.assertEqual(report['amount_mnt'],3000)
        receipt=self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=3000,charge_id=report['charge_id'],expected_revision=report['balance']['revision'],idempotency_key=uuid4().hex)),201)
        revision=self.statement().json()['balance']['revision']
        self.assert_status(self.command('checkout',dict(expected_revision=revision,idempotency_key=uuid4().hex)),200)
        self.assertEqual(self.drawer(),(3000,0))
        self.assertEqual(self.read().json()['pending']['request_kind'],'NEXT_STAY')

    def test_dirty_room_retains_future_capacity_but_cannot_accept_actual_arrival(self):
        hold=self.arriving_hold()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.room SET cleaning_state='DIRTY',revision=revision+1 WHERE tenant_id=%s AND id=%s",(self.tenant,self.room))
        self.assertIn(self.room,self.capacity_rooms())
        self.assertEqual(self.apply_hold(hold).json()['code'],'ROOM_NOT_READY')
        self.assertEqual(self.call(hold).json()['booking_state'],'CONFIRMED')

    def test_failed_application_rolls_back_opening_capture_claim_and_retry(self):
        hold=self.arriving_hold()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_canonical_booking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_canonical_booking AFTER INSERT ON prsystem.booking_hold_application DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_canonical_booking()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.apply_hold(hold),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_canonical_booking ON prsystem.booking_hold_application')
                conn.execute('DROP FUNCTION prsystem.fail_canonical_booking()')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
        self.assertIsNone(self.call(hold).json()['stay_id'])
        self.assert_status(self.apply_hold(hold),201)
