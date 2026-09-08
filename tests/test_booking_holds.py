import unittest
from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.auth import digest
    from prsystem.mock_providers import MockStore, MockPaymentGateway


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class BookingHoldTests(GuestFinanceCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT,INSERT ON prsystem.booking_contract,prsystem.booking_hold,prsystem.booking_hold_attempt,prsystem.booking_hold_capture,prsystem.booking_hold_event,prsystem.booking_hold_command TO {}',
                'GRANT UPDATE(booking_state,hold_state,applied_attempt_id,confirmation_snapshot) ON prsystem.booking_hold TO {}',
                'GRANT UPDATE(state,invoice_id) ON prsystem.booking_hold_attempt TO {}',
            ):conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        directory=TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.store=MockStore(directory.name+'/booking.sqlite3',environment='test')
        self.gateways={p:MockPaymentGateway(self.store,p) for p in ('QPAY','KHAAN')}
        self.client.close()
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways=self.gateways),client=(self.peer,12345))
        self.addCleanup(self.client.close)
        self.arrival=datetime.now(timezone.utc)+timedelta(days=2)
        self.assert_status(self.contract(),200)

    def contract(self,rate=375,revision=0,key='contract',token=None):
        now=datetime.now(timezone.utc)
        return self.client.put(f'/hotels/{self.tenant}/mock/booking-contract',headers=self.headers(token or self.manager_token),json=dict(
            contract_id='contract',rate_bps=rate,valid_from=(now-timedelta(days=1)).isoformat(),valid_until=(now+timedelta(days=365)).isoformat(),
            expected_revision=revision,idempotency_key=key))

    def hold(self,key='hold',provider='QPAY',token=None,**extra):
        return self.client.post(f'/hotels/{self.tenant}/mock/booking-holds',headers=self.headers(token or self.manager_token),json=dict(
            category_id=self.category,planned_checkin_at=self.arrival.isoformat(),nights=2,provider=provider,idempotency_key=key,**extra))

    def call(self,hold,suffix='',body=None,token=None,tenant=None):
        path=f'/guest/booking-holds/{tenant or self.tenant}/{hold["booking_id"]}'+suffix
        headers=self.headers(token or hold['access_token'])
        return self.client.get(path,headers=headers) if not suffix else self.client.post(path,headers=headers,json=body or {})

    def begin(self):
        hold=self.assert_status(self.hold(),201)
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.attempt=result['attempts'][0]['attempt_id']
        return hold

    def pay(self,attempt=None,provider='QPAY'):
        self.gateways[provider].set_status('booking:'+(attempt or self.attempt),'SUCCEEDED')

    def age(self,hold):
        # Owner-only fixture ages all immutable source times together. The
        # application role cannot alter these columns or disable the trigger.
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('ALTER TABLE prsystem.booking_hold DISABLE TRIGGER preserve_booking_hold')
            conn.execute("UPDATE prsystem.booking_hold SET created_at=created_at-interval '11 minutes',expires_at=expires_at-interval '11 minutes' WHERE tenant_id=%s AND id=%s",(self.tenant,hold['booking_id']))
            conn.execute('ALTER TABLE prsystem.booking_hold ENABLE TRIGGER preserve_booking_hold')

    def test_hold_is_category_scoped_pending_and_retry_reuses_token(self):
        hold=self.assert_status(self.hold(),201)
        again=self.assert_status(self.hold(),201)
        self.assertEqual(hold,again)
        self.assertEqual((hold['booking_state'],hold['hold_state']),('HOLDING','ACTIVE'))
        self.assertNotIn('room_id',hold)
        self.assertEqual(hold['quote']['amount_mnt'],160000)
        self.assertEqual(datetime.fromisoformat(hold['expires_at'])-datetime.fromisoformat(hold['created_at']),timedelta(minutes=10))
        with psycopg.connect(self.owner_dsn) as conn:
            stored=conn.execute('SELECT token_hash FROM prsystem.booking_hold WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            self.assertEqual(stored,digest(hold['access_token']))
            history=str(conn.execute('SELECT details FROM prsystem.booking_hold_event WHERE tenant_id=%s',(self.tenant,)).fetchall())
            self.assertNotIn(hold['access_token'],history)

    def test_no_capacity_and_last_unit_concurrency(self):
        barrier=Barrier(2)
        def create(key):barrier.wait();return self.hold(key=key)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(create,['first','second']))
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])
        self.assertEqual(next(r for r in responses if r.status_code==409).json()['code'],'BOOKING_CAPACITY_UNAVAILABLE')

    def test_holds_block_walkin_using_the_reserved_capacity(self):
        self.arrival=datetime.now(timezone.utc)+timedelta(minutes=1)
        self.assert_status(self.hold(),201)
        response=self.checkin(kind='NIGHTLY',duration_units=2,deposit=dict(channel='CASH',amount_mnt=60000,received=True))
        self.assertEqual(response.json()['code'],'BOOKING_CAPACITY_UNAVAILABLE')
        self.assertEqual(self.drawer(),(0,0))

    def test_pending_is_not_paid_then_authoritative_capture_posts_once(self):
        hold=self.begin()
        self.assertEqual(self.call(hold).json()['booking_state'],'HOLDING')
        self.pay()
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual((result['booking_state'],result['hold_state']),('CONFIRMED','CONSUMED'))
        self.assertEqual(result,self.assert_status(self.call(hold,'/reconcile'),200))
        self.assertEqual(self.drawer(),(0,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_hold_capture WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.billing_capture WHERE kind='BOOKING' AND reference_id=%s",(self.tenant+':'+self.attempt,)).fetchone()[0],1)

    def test_expiry_queries_paid_before_releasing_inventory(self):
        hold=self.begin();self.age(hold);self.pay()
        response=self.client.post(f'/hotels/{self.tenant}/mock/booking-holds/expire',headers=self.headers(self.manager_token))
        self.assertEqual(self.assert_status(response,200)['results'][0]['booking_state'],'CONFIRMED')
        self.assert_status(self.hold(key='another'),409)

    def test_unpaid_expiry_releases_and_late_payment_creates_full_refund(self):
        hold=self.begin();self.age(hold)
        self.assertEqual(self.call(hold,'/reconcile').json()['booking_state'],'EXPIRED')
        self.assert_status(self.hold(key='replacement'),201)
        self.pay()
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual(result['booking_state'],'EXPIRED')
        self.assertEqual(result['refund_required_mnt'],160000)
        self.assertEqual(result,self.assert_status(self.call(hold,'/reconcile'),200))

    def test_unsent_expired_hold_does_not_create_an_invoice(self):
        hold=self.assert_status(self.hold(),201);self.age(hold)
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual(result['booking_state'],'EXPIRED')
        self.assertEqual(self.store.inspect('invoice'),[])

    def test_provider_switch_preserves_deadline_and_duplicate_capture_is_refundable(self):
        hold=self.begin();old=self.attempt
        body=dict(provider='KHAAN',idempotency_key='switch')
        switched=self.assert_status(self.call(hold,'/attempts',body),201)
        self.assertEqual(switched,self.assert_status(self.call(hold,'/attempts',body),201))
        self.assertEqual(datetime.fromisoformat(switched['expires_at']),datetime.fromisoformat(hold['expires_at']))
        self.assert_status(self.call(hold,'/reconcile'),200)
        self.pay(switched['attempt_id'],'KHAAN');self.call(hold,'/reconcile')
        self.pay(old)
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual((result['booking_state'],result['refund_required_mnt']),('CONFIRMED',160000))
        self.assertEqual(result['applied_attempt_id'],switched['attempt_id'])

    def test_switch_after_expiry_and_changed_retry_rejected(self):
        hold=self.begin()
        self.assert_status(self.call(hold,'/attempts',dict(provider='KHAAN',idempotency_key='switch')),201)
        self.assertEqual(self.call(hold,'/attempts',dict(provider='QPAY',idempotency_key='switch')).json()['code'],'IDEMPOTENCY_CONFLICT')
        self.age(hold)
        self.assertEqual(self.call(hold,'/attempts',dict(provider='QPAY',idempotency_key='new')).json()['code'],'HOLD_EXPIRED')

    def test_client_money_paid_flags_and_wrong_scope_rejected(self):
        self.assert_status(self.hold(amount_mnt=1,paid=True),422)
        self.assert_status(self.hold(token=self.worker_token),403)
        hold=self.begin()
        for token in (self.worker_token,'x'*43):self.assert_status(self.call(hold,token=token),403)
        self.assert_status(self.call(hold,tenant='foreign'),403)
        self.assert_status(self.client.get(f'/hotels/{self.tenant}/operations',headers=self.headers(hold['access_token'])),401)

    def test_security_suspension_blocks_guest_reconciliation(self):
        hold=self.begin()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.call(hold,'/reconcile'),403)

    def test_production_disables_mock_hold_and_guest_capability(self):
        hold=self.begin()
        with TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault)) as client:
            r=client.get(f'/guest/booking-holds/{self.tenant}/{hold["booking_id"]}',headers=self.headers(hold['access_token']))
            self.assertEqual(r.status_code,503)
            r=client.post(f'/hotels/{self.tenant}/mock/booking-holds',headers=self.headers(self.manager_token),json=dict(category_id=self.category,planned_checkin_at=self.arrival.isoformat(),nights=2,provider='QPAY',idempotency_key='prod'))
            self.assertEqual(r.status_code,503)

    def test_confirmation_snapshots_current_contract_without_repricing_hold(self):
        hold=self.begin();self.assert_status(self.contract(rate=1000,revision=1,key='update'),200);self.pay()
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual(result['confirmation']['rate_bps'],1000)
        self.assertEqual((result['quote']['amount_mnt'],result['quote']['commission_rate_bps']),(160000,375))

    def test_mismatched_provider_evidence_does_not_release_hold(self):
        hold=self.begin();self.age(hold)
        gateway=self.gateways['QPAY'];original=gateway.payment
        with patch.object(gateway,'payment',side_effect=lambda *a:dict(original(*a),amount=1)):
            self.assert_status(self.call(hold,'/reconcile'),503)
        self.assertEqual(self.call(hold).json()['hold_state'],'ACTIVE')

    def test_rls_and_immutable_hold_snapshot(self):
        hold=self.begin()
        with psycopg.connect(self.app_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_hold').fetchone()[0],0)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.tenant,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_hold').fetchone()[0],1)
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('UPDATE prsystem.booking_hold SET amount_mnt=1 WHERE tenant_id=%s',(self.tenant,))

    def test_commit_failure_rolls_back_capture_and_retry_applies_once(self):
        hold=self.begin();self.pay()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_booking_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_booking_commit AFTER INSERT ON prsystem.booking_hold_capture DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_booking_commit()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.call(hold,'/reconcile'),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_booking_commit ON prsystem.booking_hold_capture')
                conn.execute('DROP FUNCTION prsystem.fail_booking_commit()')
        self.assertEqual(self.call(hold).json()['booking_state'],'HOLDING')
        self.assertEqual(self.call(hold,'/reconcile').json()['booking_state'],'CONFIRMED')

    def test_concurrent_reconciliation_claims_capture_once(self):
        hold=self.begin();self.pay();barrier=Barrier(2)
        def reconcile(_):barrier.wait();return self.call(hold,'/reconcile')
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(reconcile,range(2)))
        self.assertEqual([r.status_code for r in results],[200,200])
        self.assertEqual(results[0].json(),results[1].json())
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_hold_capture WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_expired_contract_preserves_capture_as_full_refund_due(self):
        hold=self.begin();now=datetime.now(timezone.utc)
        result=self.client.put(f'/hotels/{self.tenant}/mock/booking-contract',headers=self.headers(self.manager_token),json=dict(
            contract_id='ended',rate_bps=375,valid_from=(now-timedelta(days=2)).isoformat(),valid_until=(now-timedelta(days=1)).isoformat(),
            expected_revision=1,idempotency_key='ended'))
        self.assert_status(result,200);self.pay()
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual((result['booking_state'],result['refund_required_mnt']),('EXPIRED',160000))
        self.assertEqual(result,self.assert_status(self.call(hold,'/reconcile'),200))
