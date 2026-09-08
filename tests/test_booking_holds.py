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

    def arriving_hold(self):
        import time
        self.arrival=datetime.now(timezone.utc)+timedelta(seconds=1)
        hold=self.begin();self.pay()
        self.assert_status(self.call(hold,'/reconcile'),200)
        time.sleep(max(0,(self.arrival-datetime.now(timezone.utc)).total_seconds()))
        return hold

    def apply_hold(self,hold,key='apply',token=None,**extra):
        body=dict(room_id=self.room,guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key=key)
        body.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/booking-holds/{hold["booking_id"]}/check-in',headers=self.headers(token or self.worker_token),json=body)

    def test_paid_hold_applies_snapshot_and_checks_out_without_cash(self):
        hold=self.arriving_hold()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.room SET nightly_price=999999 WHERE tenant_id=%s',(self.tenant,))
            conn.execute("UPDATE prsystem.room_hotel_settings SET nightly_price=777777,checkout_time='15:00',revision=revision+1 WHERE tenant_id=%s",(self.tenant,))
        self.stay=self.assert_status(self.apply_hold(hold),201)
        self.assertEqual(self.stay,self.assert_status(self.apply_hold(hold),201))
        self.assertEqual((self.stay['amount_mnt'],self.stay['deposit_mnt']),(160000,0))
        self.assertEqual(datetime.fromisoformat(self.stay['planned_checkout_at']),datetime.fromisoformat(hold['quote']['planned_checkout_at']))
        self.assertEqual(self.stay['snapshot']['checkout_time'],hold['quote']['checkout_time'])
        self.assertEqual(self.call(hold).json()['stay_id'],self.stay['stay_id'])
        self.assertEqual(self.drawer(),(0,0))
        self.assert_status(self.command('checkout',dict(expected_revision=1,idempotency_key='checkout')),200)
        self.assertEqual(self.drawer(),(0,0))
        self.assert_status(self.apply_hold(hold,key='twice'),409)

    def test_application_replaces_claim_instead_of_double_counting(self):
        hold=self.arriving_hold();self.assert_status(self.apply_hold(hold),201)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms',headers=self.headers(self.manager_token),json=dict(number='102',floor='1',category_id=self.category,idempotency_key='second-room')),201)
        self.arrival=datetime.now(timezone.utc)+timedelta(days=1)
        self.assert_status(self.hold(key='next-guest'),201)
        self.assert_status(self.hold(key='overbook'),409)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_hold_application WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_two_checkins_cannot_apply_same_capture_twice(self):
        hold=self.arriving_hold();barrier=Barrier(2)
        def arrive(key):barrier.wait();return self.apply_hold(hold,key=key)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(arrive,['one','two']))
        self.assertEqual(sorted(r.status_code for r in results),[201,409])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_hold_application WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_charge WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_unpaid_and_early_hold_cannot_check_in(self):
        hold=self.begin()
        self.assertEqual(self.apply_hold(hold).json()['code'],'INVALID_FINANCIAL_SOURCE')
        self.pay();self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual(self.apply_hold(hold).json()['code'],'ACTUAL_TIME_OUT_OF_RANGE')
        self.assertIsNone(self.call(hold).json()['stay_id'])

    def test_dirty_or_different_category_does_not_consume_hold(self):
        hold=self.arriving_hold()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.room SET cleaning_state='DIRTY' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.apply_hold(hold).json()['code'],'ROOM_NOT_READY')
        category=self.assert_status(self.client.post(f'/hotels/{self.tenant}/room-categories',headers=self.headers(self.manager_token),json=dict(name='Other',cleaning_buffer_minutes=30,deposit=50000,idempotency_key='other-category')),201)['category_id']
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.room SET cleaning_state='CLEAN',category_id=%s WHERE tenant_id=%s",(category,self.tenant))
        self.assertEqual(self.apply_hold(hold).json()['code'],'INVALID_FINANCIAL_SOURCE')
        self.assertIsNone(self.call(hold).json()['stay_id'])

    def test_application_rejects_guest_token_client_money_and_production(self):
        hold=self.arriving_hold()
        self.assert_status(self.apply_hold(hold,paid=True,amount_mnt=1),422)
        self.assert_status(self.apply_hold(hold,token=hold['access_token']),401)
        with TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault)) as client:
            response=client.post(f'/hotels/{self.tenant}/booking-holds/{hold["booking_id"]}/check-in',headers=self.headers(self.worker_token),json=dict(room_id=self.room,guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key='prod-apply'))
            self.assert_status(response,503)
        self.assertIsNone(self.call(hold).json()['stay_id'])

    def test_application_commit_failure_preserves_claim_then_retry_succeeds(self):
        hold=self.arriving_hold()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_application_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_application_commit AFTER INSERT ON prsystem.booking_hold_application DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_application_commit()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.apply_hold(hold),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_application_commit ON prsystem.booking_hold_application')
                conn.execute('DROP FUNCTION prsystem.fail_application_commit()')
        self.assertIsNone(self.call(hold).json()['stay_id'])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_charge WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
        self.assert_status(self.apply_hold(hold),201)

    def cancel(self,hold,key='cancel'):
        return self.call(hold,'/cancel',dict(idempotency_key=key))

    def test_guest_free_cancellation_releases_capacity_and_preserves_capture(self):
        hold=self.begin();self.pay();self.call(hold,'/reconcile')
        result=self.assert_status(self.cancel(hold),200)
        self.assertEqual((result['refund_due'],result['retained_mnt'],result['commission_mnt']),(160000,0,0))
        self.assertEqual(result,self.assert_status(self.cancel(hold),200))
        self.assertEqual(self.call(hold).json()['booking_state'],'CANCELLED_GUEST')
        self.assertEqual(self.call(hold,'/reconcile').json()['refund_required_mnt'],160000)
        self.assert_status(self.hold(key='replacement'),201)
        self.assertEqual(self.drawer(),(0,0))
        self.assertEqual(self.store.inspect('refund'),[])

    def test_late_guest_cancellation_uses_confirmation_contract(self):
        self.arrival=datetime.now(timezone.utc)+timedelta(hours=1)
        hold=self.begin();self.assert_status(self.contract(rate=1000,revision=1,key='confirm-contract'),200)
        self.pay();self.call(hold,'/reconcile')
        self.assert_status(self.contract(rate=2000,revision=2,key='later-contract'),200)
        result=self.assert_status(self.cancel(hold),200)
        self.assertEqual((result['retained_mnt'],result['refund_due'],result['commission_mnt'],result['hotel_payable_mnt']),(80000,80000,8000,72000))
        self.assertEqual(self.call(hold).json()['cancellation']['commission_mnt'],8000)

    def test_cancellation_and_checkin_serialize_to_one_terminal_outcome(self):
        hold=self.arriving_hold();barrier=Barrier(2)
        def command(kind):
            barrier.wait()
            return self.cancel(hold) if kind=='cancel' else self.apply_hold(hold)
        with ThreadPoolExecutor(max_workers=2) as pool:responses=list(pool.map(command,['cancel','apply']))
        self.assertIn([r.status_code for r in responses],([200,409],[409,201]))
        with psycopg.connect(self.owner_dsn) as conn:
            cancelled=conn.execute('SELECT count(*) FROM prsystem.booking_hold_cancellation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            applied=conn.execute('SELECT count(*) FROM prsystem.booking_hold_application WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            self.assertEqual(cancelled+applied,1)

    def test_pending_and_applied_bookings_cannot_guest_cancel(self):
        hold=self.begin();self.assert_status(self.cancel(hold),200)
        self.assertEqual(self.call(hold).json()['booking_state'],'CANCELLED_GUEST')
        self.pay();self.call(hold,'/reconcile')
        self.assertEqual(self.call(hold).json()['refund_required_mnt'],160000)
        self.assert_status(self.cancel(hold,key='again'),409)
        self.assert_status(self.apply_hold(hold),409)

    def test_checked_in_booking_rejects_cancellation(self):
        hold=self.arriving_hold();self.assert_status(self.apply_hold(hold),201)
        self.assertEqual(self.cancel(hold).json()['code'],'BOOKING_ALREADY_APPLIED')
        self.assertIsNone(self.call(hold).json()['cancellation'])

    def test_duplicate_capture_after_cancellation_adds_full_refund_without_reopening(self):
        hold=self.begin();old=self.attempt
        switched=self.assert_status(self.call(hold,'/attempts',dict(provider='KHAAN',idempotency_key='switch')),201)
        self.call(hold,'/reconcile');self.pay(switched['attempt_id'],'KHAAN');self.call(hold,'/reconcile')
        self.assert_status(self.cancel(hold),200);self.pay(old)
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual((result['booking_state'],result['refund_required_mnt']),('CANCELLED_GUEST',320000))
        self.assertEqual(result,self.assert_status(self.call(hold,'/reconcile'),200))

    def test_cancellation_scope_and_client_refund_amount_are_rejected(self):
        hold=self.begin();self.pay();self.call(hold,'/reconcile')
        self.assert_status(self.call(hold,'/cancel',dict(idempotency_key='cancel',refund_due=1)),422)
        self.assert_status(self.call(hold,'/cancel',dict(idempotency_key='cancel'),token=self.manager_token),403)
        self.assert_status(self.call(hold,'/cancel',dict(idempotency_key='cancel'),tenant='foreign'),403)
        self.assertEqual(self.call(hold).json()['booking_state'],'CONFIRMED')

    def test_cancellation_commit_rollback_and_immutable_history(self):
        hold=self.begin();self.pay();self.call(hold,'/reconcile')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_cancel_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_cancel_commit AFTER INSERT ON prsystem.booking_hold_cancellation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_cancel_commit()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.cancel(hold),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_cancel_commit ON prsystem.booking_hold_cancellation')
                conn.execute('DROP FUNCTION prsystem.fail_cancel_commit()')
        self.assertEqual(self.call(hold).json()['booking_state'],'CONFIRMED')
        self.assert_status(self.hold(key='blocked'),409)
        self.assert_status(self.cancel(hold),200)
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('UPDATE prsystem.booking_hold_cancellation SET refund_due=1 WHERE tenant_id=%s',(self.tenant,))

    def refunded_booking(self):
        hold=self.begin();self.pay();self.call(hold,'/reconcile');self.cancel(hold)
        return hold

    def refund_reconcile(self,hold):
        return self.call(hold,'/refunds/reconcile')

    def test_refund_pending_then_provider_confirmed_once(self):
        hold=self.refunded_booking()
        result=self.assert_status(self.refund_reconcile(hold),200)
        self.assertEqual((result['refund_state'],result['refunded_mnt'],result['refund_remaining_mnt']),('PENDING',0,160000))
        request=result['refunds'][0]['request_id']
        self.gateways['QPAY'].set_refund_status(request,'SUCCEEDED')
        result=self.assert_status(self.refund_reconcile(hold),200)
        self.assertEqual((result['refund_state'],result['refunded_mnt'],result['refund_remaining_mnt']),('REFUNDED',160000,0))
        with patch.object(self.gateways['QPAY'],'create_refund',side_effect=AssertionError('No resend after confirmation')):
            self.assertEqual(result,self.assert_status(self.refund_reconcile(hold),200))
        self.assertEqual(self.drawer(),(0,0))
        with psycopg.connect(self.owner_dsn) as conn:
            payment=conn.execute('SELECT payment_id FROM prsystem.booking_hold_capture WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
        self.assertEqual(self.store.inspect('refund')[0]['original'],payment)

    def test_unknown_and_failed_refund_keep_same_request_for_late_success(self):
        hold=self.refunded_booking();result=self.assert_status(self.refund_reconcile(hold),200)
        request=result['refunds'][0]['request_id']
        for state in ('UNKNOWN','FAILED','FINAL_FAILED','NOT_PROCESSED','VOIDED'):
            self.gateways['QPAY'].set_refund_status(request,state)
            result=self.assert_status(self.refund_reconcile(hold),200)
            self.assertEqual((result['refunded_mnt'],result['refund_remaining_mnt']),(0,160000))
            self.assertEqual(result['refunds'][0]['request_id'],request)
            self.assertEqual(result['refund_state'],'PENDING' if state=='UNKNOWN' else 'FAILED')
        self.assertEqual(len(self.store.inspect('refund')),1)
        self.gateways['QPAY'].set_refund_status(request,'SUCCEEDED')
        self.assertEqual(self.refund_reconcile(hold).json()['refunded_mnt'],160000)

    def test_concurrent_refund_dispatch_uses_one_persisted_request(self):
        hold=self.refunded_booking();barrier=Barrier(2)
        def dispatch(_):barrier.wait();return self.refund_reconcile(hold)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(dispatch,range(2)))
        self.assertEqual([r.status_code for r in results],[200,200])
        self.assertEqual(results[0].json(),results[1].json())
        self.assertEqual(len(self.store.inspect('refund')),1)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_refund_request WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_zero_refund_never_sends_provider_command(self):
        self.arrival=datetime.now(timezone.utc)+timedelta(hours=1)
        response=self.client.post(f'/hotels/{self.tenant}/mock/booking-holds',headers=self.headers(self.manager_token),json=dict(category_id=self.category,planned_checkin_at=self.arrival.isoformat(),nights=1,provider='QPAY',idempotency_key='single-night'))
        hold=self.assert_status(response,201);result=self.call(hold,'/reconcile').json()
        self.pay(result['attempts'][0]['attempt_id']);self.call(hold,'/reconcile');self.cancel(hold)
        result=self.assert_status(self.refund_reconcile(hold),200)
        self.assertEqual((result['refund_state'],result['refund_required_mnt'],result['refunds']),('NONE',0,[]))
        self.assertEqual(self.store.inspect('refund'),[])

    def test_invalid_refund_evidence_does_not_complete_obligation(self):
        hold=self.refunded_booking();result=self.refund_reconcile(hold).json();request=result['refunds'][0]['request_id']
        gateway=self.gateways['QPAY'];gateway.set_refund_status(request,'SUCCEEDED');original=gateway.refund
        for bad in (dict(amount=1),dict(original='other-payment'),dict(merchant_id='other-merchant'),dict(currency='USD'),dict(confirmed_at=datetime.now(timezone.utc)+timedelta(days=1))):
            with patch.object(gateway,'refund',side_effect=lambda r,b=bad:dict(original(r),**b)):
                self.assert_status(self.refund_reconcile(hold),503)
        self.assertEqual(self.call(hold).json()['refunded_mnt'],0)
        self.assertEqual(self.refund_reconcile(hold).json()['refunded_mnt'],160000)

    def test_multiple_capture_refunds_track_remaining_amount_independently(self):
        hold=self.begin();old=self.attempt
        switched=self.call(hold,'/attempts',dict(provider='KHAAN',idempotency_key='switch')).json()
        self.call(hold,'/reconcile');self.pay(switched['attempt_id'],'KHAAN');self.call(hold,'/reconcile')
        self.cancel(hold);self.pay(old);self.call(hold,'/reconcile')
        result=self.assert_status(self.refund_reconcile(hold),200)
        self.assertEqual(len(result['refunds']),2)
        qpay=next(r for r in result['refunds'] if r['attempt_id']==old)
        self.gateways['QPAY'].set_refund_status(qpay['request_id'],'SUCCEEDED')
        result=self.assert_status(self.refund_reconcile(hold),200)
        self.assertEqual((result['refunded_mnt'],result['refund_remaining_mnt']),(160000,160000))
        self.assertEqual(result['refund_state'],'PARTIALLY_REFUNDED')
        self.assertEqual(result['booking_state'],'CANCELLED_GUEST')

    def test_refund_scope_production_and_client_evidence_rejected(self):
        hold=self.refunded_booking()
        self.assert_status(self.call(hold,'/refunds/reconcile',dict(paid=True,amount=1)),422)
        self.assert_status(self.call(hold,'/refunds/reconcile',token=self.manager_token),403)
        self.assert_status(self.call(hold,'/refunds/reconcile',tenant='foreign'),403)
        with TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault)) as client:
            self.assert_status(client.post(f'/guest/booking-holds/{self.tenant}/{hold["booking_id"]}/refunds/reconcile',headers=self.headers(hold['access_token']),json={}),503)
        self.assertEqual(self.store.inspect('refund'),[])

    def test_refund_confirmation_commit_rollback_reuses_durable_request(self):
        hold=self.refunded_booking();request=self.refund_reconcile(hold).json()['refunds'][0]['request_id']
        self.gateways['QPAY'].set_refund_status(request,'SUCCEEDED')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_booking_refund_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_booking_refund_commit AFTER INSERT ON prsystem.booking_refund_confirmation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_booking_refund_commit()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.refund_reconcile(hold),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_booking_refund_commit ON prsystem.booking_refund_confirmation')
                conn.execute('DROP FUNCTION prsystem.fail_booking_refund_commit()')
        result=self.call(hold).json()
        self.assertEqual((result['refunded_mnt'],result['refunds'][0]['request_id']),(0,request))
        self.assertEqual(self.refund_reconcile(hold).json()['refunded_mnt'],160000)
        self.assertEqual(len(self.store.inspect('refund')),1)

    def test_refund_request_must_commit_before_provider_dispatch(self):
        hold=self.refunded_booking()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_refund_request_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_refund_request_commit AFTER INSERT ON prsystem.booking_refund_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_refund_request_commit()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.refund_reconcile(hold),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_refund_request_commit ON prsystem.booking_refund_request')
                conn.execute('DROP FUNCTION prsystem.fail_refund_request_commit()')
        self.assertEqual(self.store.inspect('refund'),[])
        self.assertEqual(self.call(hold).json()['refunds'],[])
        self.assert_status(self.refund_reconcile(hold),200)

    def terminal(self,hold,outcome,token=None,key='terminal'):
        return self.client.post(f'/hotels/{self.tenant}/booking-holds/{hold["booking_id"]}/terminal',headers=self.headers(token or self.worker_token),json=dict(outcome=outcome,reason='Guest did not arrive / no room available',idempotency_key=key))

    def test_no_show_cutoff_and_manager_reception_permissions(self):
        from psycopg.types.json import Jsonb
        hold=self.begin();self.pay();self.call(hold,'/reconcile')
        self.assertEqual(self.terminal(hold,'NO_SHOW').json()['code'],'NO_SHOW_CUTOFF_NOT_PASSED')
        with psycopg.connect(self.owner_dsn) as conn:
            snapshot=conn.execute('SELECT snapshot FROM prsystem.booking_hold WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            snapshot['no_show_cutoff']=(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()
            conn.execute('ALTER TABLE prsystem.booking_hold DISABLE TRIGGER preserve_booking_hold')
            conn.execute('UPDATE prsystem.booking_hold SET snapshot=%s WHERE tenant_id=%s',(Jsonb(snapshot),self.tenant))
            conn.execute('ALTER TABLE prsystem.booking_hold ENABLE TRIGGER preserve_booking_hold')
        result=self.assert_status(self.terminal(hold,'NO_SHOW'),200)
        self.assertEqual((result['booking_state'],result['retained_mnt'],result['refund_due']),('NO_SHOW',80000,80000))
        self.assertEqual(result,self.assert_status(self.terminal(hold,'NO_SHOW'),200))
        self.assert_status(self.apply_hold(hold),409)
        self.assert_status(self.hold(key='replacement'),201)

    def test_hotel_cancellation_checks_rooms_and_requires_manager(self):
        hold=self.arriving_hold()
        self.assert_status(self.terminal(hold,'CANCELLED_HOTEL'),403)
        self.assertEqual(self.terminal(hold,'CANCELLED_HOTEL',self.manager_token).json()['code'],'BOOKING_ROOM_AVAILABLE')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.room SET cleaning_state='DIRTY' WHERE tenant_id=%s",(self.tenant,))
        result=self.assert_status(self.terminal(hold,'CANCELLED_HOTEL',self.manager_token),200)
        self.assertEqual((result['refund_due'],result['commission_mnt'],result['hotel_payable_mnt']),(160000,0,0))
        self.assertEqual(self.refund_reconcile(hold).json()['refund_remaining_mnt'],160000)

    def test_unpaid_cancellation_suppresses_unsent_invoice(self):
        hold=self.assert_status(self.hold(),201)
        self.assert_status(self.cancel(hold),200)
        result=self.assert_status(self.call(hold,'/reconcile'),200)
        self.assertEqual((result['booking_state'],result['refund_required_mnt']),('CANCELLED_GUEST',0))
        self.assertEqual(self.store.inspect('invoice'),[])

    def test_booking_status_uses_actual_checkin_and_checkout(self):
        hold=self.arriving_hold();self.stay=self.assert_status(self.apply_hold(hold),201)
        self.assertEqual(self.call(hold).json()['booking_state'],'CHECKED_IN')
        self.assert_status(self.command('checkout',dict(expected_revision=1,idempotency_key='out')),200)
        self.assertEqual(self.call(hold).json()['booking_state'],'COMPLETED')
        inbox=self.client.get(f'/hotels/{self.tenant}/booking-holds',headers=self.headers(self.worker_token))
        self.assertEqual(self.assert_status(inbox,200)[0]['booking_state'],'COMPLETED')

    def test_manager_upgrade_preserves_paid_price_and_no_deposit(self):
        hold=self.arriving_hold();original=self.room
        category=self.assert_status(self.client.post(f'/hotels/{self.tenant}/room-categories',headers=self.headers(self.manager_token),json=dict(name='Suite',cleaning_buffer_minutes=30,deposit=60000,idempotency_key='suite')),201)['category_id']
        for cat,rank in ((self.category,1),(category,2)):
            self.assert_status(self.client.put(f'/hotels/{self.tenant}/room-categories/{cat}/booking-rank',headers=self.headers(self.manager_token),json=dict(rank=rank,expected_revision=0,idempotency_key='rank-'+cat)),200)
        room=self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms',headers=self.headers(self.manager_token),json=dict(number='201',floor='2',category_id=category,nightly_price=900000,idempotency_key='suite-room')),201)['room_id']
        self.room=room
        task=self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms/{room}/cleaning-requests',headers=self.headers(self.manager_token),json=dict(assignee_id=self.worker,expected_revision=1,idempotency_key='suite-clean')),201)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start',headers=self.headers(self.worker_token),json=dict(expected_revision=task['assignment_version'],idempotency_key='suite-start')),200)
        self.assert_status(self.post_cleaning(task,key='suite-post'),200)
        body=dict(room_id=room,reason='Same category unavailable',idempotency_key='upgrade')
        path=f'/hotels/{self.tenant}/booking-holds/{hold["booking_id"]}/upgrade'
        self.assert_status(self.client.post(path,headers=self.headers(self.worker_token),json=body),403)
        self.assertEqual(self.client.post(path,headers=self.headers(self.manager_token),json=body).json()['code'],'BOOKING_ROOM_AVAILABLE')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.room SET cleaning_state='DIRTY' WHERE tenant_id=%s AND id=%s",(self.tenant,original))
        self.assertEqual(self.terminal(hold,'CANCELLED_HOTEL',self.manager_token).json()['code'],'BOOKING_ROOM_AVAILABLE')
        self.assert_status(self.client.post(path,headers=self.headers(self.manager_token),json=body),200)
        result=self.assert_status(self.apply_hold(hold),201)
        self.assertEqual((result['room_id'],result['amount_mnt'],result['deposit_mnt']),(room,160000,0))

    def finance_setup(self):
        from uuid import uuid4
        from prsystem.mock_bank import MockBankGateway
        from prsystem.mfa import totp
        self.bank=MockBankGateway(self.store);self.platform_id=uuid4().hex;self.mfa_key=b'12345678901234567890'
        self.client.close()
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways=self.gateways,bank_gateway=self.bank,platform_secret_resolver=lambda ref:self.mfa_key if ref==self.platform_id else None),client=(self.peer,12345))
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.platform_account(id,email,password_hash,permissions,mfa_key_ref) VALUES(%s,%s,%s,ARRAY['BOOKING_FINANCE','PAYOUT_EXECUTE'],%s)",(self.platform_id,self.platform_id+'@example.com',self.password_hash,self.platform_id))
        self.finance_token=self.assert_status(self.client.post('/platform/auth/login',json=dict(email=self.platform_id+'@example.com',password=self.password,code=totp(self.mfa_key,int(datetime.now(timezone.utc).timestamp())//30))),200)['access_token']
        self.bank.set_beneficiary(self.tenant,'verified')
        self.assert_status(self.finance('/booking-beneficiary',dict(reference='verified',expected_revision=0,idempotency_key='beneficiary:'+self.tenant),method='put'),200)

    def finance(self,path,body=None,method='post',token=None):
        kwargs=dict(headers=self.headers(token or self.finance_token))
        if method!='get':kwargs['json']=body or {}
        return getattr(self.client,method)(f'/platform/hotels/{self.tenant}'+path,**kwargs)

    def payable(self):
        self.finance_setup();self.arrival=datetime.now(timezone.utc)+timedelta(hours=2)
        hold=self.begin();self.pay();self.assert_status(self.call(hold,'/reconcile'),200)
        self.assert_status(self.call(hold,'/cancel',dict(idempotency_key='cancel')),200)
        self.assert_status(self.call(hold,'/refunds/reconcile'),200)
        result=self.call(hold).json()
        for refund in result['refunds']:self.gateways['QPAY'].set_refund_status(refund['request_id'],'SUCCEEDED')
        self.assert_status(self.call(hold,'/refunds/reconcile'),200)
        e=self.gateways['QPAY'].payment('booking:'+self.attempt,None)
        self.bank.record_credit(self.tenant,'QPAY',e['merchant_id'],e['payment_id'],e['amount'],100)
        self.capture=e['payment_id']
        return hold

    def mature(self,hold):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('ALTER TABLE prsystem.booking_settlement DISABLE TRIGGER finance_immutable')
            conn.execute("UPDATE prsystem.booking_settlement SET eligible_at=eligible_at-interval '2 days',batch_after=batch_after-interval '2 days' WHERE tenant_id=%s AND hold_id=%s",(self.tenant,hold['booking_id']))
            conn.execute('ALTER TABLE prsystem.booking_settlement ENABLE TRIGGER finance_immutable')

    def assess_booking(self,hold):return self.finance('/booking-holds/'+hold['booking_id']+'/settlement')
    def make_batch(self,key='batch'):return self.finance('/booking-payouts',dict(idempotency_key=self.tenant+key))
    def execute_batch(self,batch,key='execute'):return self.finance('/booking-payouts/'+batch['batch_id']+'/execute',dict(idempotency_key=self.tenant+key))
    def reconcile_batch(self,batch,attempt):return self.finance('/booking-payouts/'+batch['batch_id']+'/attempts/'+attempt['attempt_id']+'/reconcile')

    def test_settlement_requires_bank_refunds_then_preserves_first_eligibility(self):
        hold=self.payable()
        self.bank.dispute(self.tenant,self.capture,opened=True,chargeback=0)
        self.assertEqual(self.assess_booking(hold).json()['state'],'HELD')
        self.bank.dispute(self.tenant,self.capture,opened=False,chargeback=0)
        first=self.assert_status(self.assess_booking(hold),200)
        self.assertEqual((first['retained_mnt'],first['commission_mnt'],first['net_mnt']),(80000,3000,77000))
        self.assertEqual(self.assess_booking(hold).json()['eligible_at'],first['eligible_at'])
        self.assertEqual(self.make_batch('before-maturity').json()['state'],'NO_PAYABLE')
        self.mature(hold);batch=self.assert_status(self.make_batch(),200);self.assertEqual(batch['amount_mnt'],77000)
        self.assertEqual(self.make_batch().json(),batch)
        self.assertEqual(self.make_batch('other').json()['state'],'NO_PAYABLE')

    def test_payout_unknown_failed_retry_and_once_success(self):
        hold=self.payable();self.assess_booking(hold);self.mature(hold);batch=self.make_batch().json()
        first=self.assert_status(self.execute_batch(batch),200);self.assertEqual(first['state'],'PENDING')
        self.bank.set_payout_status(first['attempt_id'],'UNKNOWN')
        self.assertEqual(self.reconcile_batch(batch,first).json()['state'],'UNKNOWN')
        self.assertEqual(self.execute_batch(batch,'retry').json()['code'],'PAYOUT_PENDING')
        self.bank.set_payout_status(first['attempt_id'],'FAILED');self.assertEqual(self.reconcile_batch(batch,first).json()['state'],'FAILED')
        second=self.assert_status(self.execute_batch(batch,'retry'),200);self.assertNotEqual(first['attempt_id'],second['attempt_id'])
        self.bank.set_payout_status(second['attempt_id'],'SUCCEEDED');self.assertEqual(self.reconcile_batch(batch,second).json()['state'],'SUCCEEDED')
        self.assertEqual(self.execute_batch(batch,'third').json()['code'],'PAYOUT_TERMINAL')
        self.assertEqual(self.reconcile_batch(batch,second).json()['state'],'SUCCEEDED')

    def test_stale_batch_void_releases_sources_and_preserves_history(self):
        hold=self.payable();self.assess_booking(hold);self.mature(hold);batch=self.make_batch().json()
        self.bank.dispute(self.tenant,self.capture,opened=False,chargeback=10000)
        self.assertEqual(self.execute_batch(batch).json()['code'],'SETTLEMENT_REFRESH_REQUIRED')
        self.assert_status(self.finance('/booking-payouts/'+batch['batch_id']+'/void',dict(reason='Bank correction',idempotency_key=self.tenant+'void')),200)
        self.assert_status(self.assess_booking(hold),200)
        replacement=self.assert_status(self.make_batch('replacement'),200);self.assertEqual(replacement['amount_mnt'],67375)
        self.assertEqual(self.execute_batch(batch).json()['code'],'PAYOUT_TERMINAL')
        self.assert_status(self.execute_batch(replacement,'new'),200)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_payout_batch WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],2)

    def test_post_payout_chargeback_creates_receivable_without_reopening_paid_source(self):
        hold=self.payable();self.assess_booking(hold);self.mature(hold);batch=self.make_batch().json();attempt=self.execute_batch(batch).json()
        self.bank.set_payout_status(attempt['attempt_id'],'SUCCEEDED');self.reconcile_batch(batch,attempt)
        self.bank.dispute(self.tenant,self.capture,opened=False,chargeback=10000);self.assess_booking(hold)
        self.assertEqual(self.make_batch('next').json()['receivable_mnt'],9625)
        self.assertEqual(self.execute_batch(batch,'again').json()['code'],'PAYOUT_TERMINAL')

    def test_finance_realms_current_permissions_and_fresh_mfa(self):
        self.finance_setup()
        self.assertEqual(self.finance('/booking-finance',method='get',token=self.manager_token).status_code,401)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.platform_session SET mfa_at=now()-interval '5 minutes' WHERE account_id=%s",(self.platform_id,))
        self.assertEqual(self.finance('/booking-finance',method='get').json()['code'],'MFA_REQUIRED')

    def booker_setup(self):
        from prsystem.mock_providers import MockPhoneGateway
        self.phone_gateway=MockPhoneGateway(self.store)
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',payment_gateways=self.gateways,phone_gateway=self.phone_gateway),client=(self.peer,12345))
        self.booker_phone='+97699112233';self.booker_password='booker-password-2026'
        self.register_booker(self.booker_phone)
        self.booker_token=self.assert_status(self.client.post('/booker/auth/login',json=dict(phone=self.booker_phone,password=self.booker_password)),200)['access_token']
        self.photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZtYAAAAASUVORK5CYII='
        self.assert_status(self.client.put(f'/hotels/{self.tenant}/booking-profile',headers=self.headers(self.manager_token),json=dict(name='Test hotel',address='Ulaanbaatar',phone=self.booker_phone,description='Hotel description',latitude=47.9,longitude=106.9,photos=[self.photo],published=True,accepting=True,expected_revision=0,idempotency_key='profile')),200)
        self.assert_status(self.client.put(f'/hotels/{self.tenant}/room-categories/{self.category}/publication',headers=self.headers(self.manager_token),json=dict(photos=[self.photo],published=True,expected_revision=0,idempotency_key='category-public')),200)
        with psycopg.connect(self.owner_dsn) as conn:
            identity='publisher'+self.tenant
            conn.execute("INSERT INTO prsystem.platform_account(id,email,password_hash,permissions,mfa_key_ref) VALUES(%s,%s,%s,'{}',%s)",(identity,identity+'@example.com',self.password_hash,identity))
            conn.execute('INSERT INTO prsystem.booking_publication VALUES(%s,true,1,%s)',(self.tenant,identity))
    def register_booker(self,phone,purpose='REGISTER',password=None):
        challenge=self.assert_status(self.client.post('/booker/auth/challenge',json=dict(phone=phone,purpose=purpose,device='device:'+phone+':testing')),200)
        otp=next(r['code'] for r in self.store.inspect('phone') if r['challenge']==challenge['challenge_id'])
        response=self.client.post('/booker/auth/complete',json=dict(challenge_id=challenge['challenge_id'],code=otp,password=password or self.booker_password))
        self.assert_status(response,200);return challenge
    def public_search(self):return self.client.get('/public/booking-hotels',params=dict(planned_checkin_at=self.arrival.isoformat(),nights=2))
    def customer_hold(self,token=None,key='customer'):
        return self.client.post(f'/booker/hotels/{self.tenant}/bookings',headers=self.headers(token or self.booker_token),json=dict(category_id=self.category,planned_checkin_at=self.arrival.isoformat(),nights=2,provider='QPAY',idempotency_key=key))
    def test_customer_booking_uses_separate_account_and_existing_inventory_guard(self):
        self.booker_setup();before=self.assert_status(self.public_search(),200)
        self.assertEqual(before['items'][0]['categories'][0]['available'],1)
        hold=self.assert_status(self.customer_hold(),201);self.assertEqual(self.customer_hold().json(),hold)
        self.assertEqual(self.hold().json()['code'],'BOOKING_CAPACITY_UNAVAILABLE')
        own=self.assert_status(self.client.get('/booker/bookings',headers=self.headers(self.booker_token)),200);self.assertEqual(own[0]['booking_id'],hold['booking_id'])
        with psycopg.connect(self.owner_dsn) as conn:
            actor,booker=conn.execute('SELECT actor_id,booker_id FROM prsystem.booking_hold WHERE tenant_id=%s',(self.tenant,)).fetchone();self.assertIsNone(actor);self.assertIsNotNone(booker)
            stored=conn.execute('SELECT phone_hash,phone_envelope FROM prsystem.booker_account WHERE id=%s',(booker,)).fetchone();self.assertNotIn(self.booker_phone,str(stored))
    def test_customer_realms_and_password_reset_revoke_sessions(self):
        self.booker_setup();self.customer_hold()
        self.assertEqual(self.customer_hold(self.manager_token,'other').status_code,401)
        self.assertEqual(self.client.get('/auth/me',headers=self.headers(self.booker_token)).status_code,401)
        self.register_booker(self.booker_phone,'RESET','new-booker-password')
        self.assertEqual(self.client.get('/booker/bookings',headers=self.headers(self.booker_token)).status_code,401)
        self.assertEqual(self.client.post('/booker/auth/login',json=dict(phone=self.booker_phone,password=self.booker_password)).status_code,401)
    def test_unpublished_and_expired_hotels_cannot_accept_new_customer_holds(self):
        self.booker_setup()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.booking_publication SET allowed=false WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.public_search().json()['items'],[]);self.assertEqual(self.customer_hold().status_code,404)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.booking_publication SET allowed=true WHERE tenant_id=%s',(self.tenant,));conn.execute("UPDATE prsystem.hotel_access SET expires_at=now()-interval '1 hour' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.public_search().json()['items'],[]);self.assertEqual(self.customer_hold().status_code,404)
    def test_another_customer_cannot_list_owned_booking(self):
        self.booker_setup();self.customer_hold();self.register_booker('+97688112233')
        other=self.assert_status(self.client.post('/booker/auth/login',json=dict(phone='+97688112233',password=self.booker_password)),200)['access_token']
        self.assertEqual(self.client.get('/booker/bookings',headers=self.headers(other)).json(),[])

    def test_cancellation_preview_change_rolls_back_terminal_mutation(self):
        hold=self.begin();self.pay();self.call(hold,'/reconcile')
        url=f'/guest/booking-holds/{self.tenant}/{hold["booking_id"]}/cancellation-preview'
        preview=self.assert_status(self.client.get(url,headers=self.headers(hold['access_token'])),200)
        self.assertEqual(preview['refund_due'],160000)
        result=self.call(hold,'/cancel',dict(idempotency_key='preview-cancel',expected_refund_mnt=0))
        self.assertEqual(result.json()['code'],'REVISION_CONFLICT');self.assertEqual(self.call(hold).json()['booking_state'],'CONFIRMED')
        self.assert_status(self.call(hold,'/cancel',dict(idempotency_key='preview-cancel',expected_refund_mnt=preview['refund_due'])),200)

    def test_payout_request_commit_precedes_bank_dispatch(self):
        hold=self.payable();self.assess_booking(hold);self.mature(hold);batch=self.make_batch().json()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_payout_attempt_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_payout_attempt_commit AFTER INSERT ON prsystem.booking_payout_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_payout_attempt_commit()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.execute_batch(batch),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_payout_attempt_commit ON prsystem.booking_payout_attempt');conn.execute('DROP FUNCTION prsystem.fail_payout_attempt_commit()')
        with self.store.connect() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM mock_bank_payout').fetchone()[0],0)
        self.assert_status(self.execute_batch(batch),200)

    def test_payout_success_rollback_and_concurrent_retry_claim_source_once(self):
        hold=self.payable();self.assess_booking(hold);self.mature(hold);batch=self.make_batch().json();attempt=self.execute_batch(batch).json()
        self.bank.set_payout_status(attempt['attempt_id'],'SUCCEEDED')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_payout_result_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_payout_result_commit AFTER INSERT ON prsystem.booking_payout_result DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_payout_result_commit()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.reconcile_batch(batch,attempt),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_payout_result_commit ON prsystem.booking_payout_result');conn.execute('DROP FUNCTION prsystem.fail_payout_result_commit()')
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_paid_source WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
        barrier=Barrier(2)
        def reconcile(_):barrier.wait();return self.reconcile_batch(batch,attempt)
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(reconcile,range(2)))
        self.assertEqual([r.status_code for r in responses],[200,200]);self.assertEqual(responses[0].json(),responses[1].json())
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.booking_paid_source WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
