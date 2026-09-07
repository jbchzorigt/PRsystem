import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4
from postgres_support import ADMIN_DSN
from walkin_support import WalkInCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.common import DomainError
    from prsystem.guest_finance import GuestFinance
    from prsystem.shifts import ShiftService
    from prsystem.auth import StaffAuth
    from prsystem.postgres.connection import transaction


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class GuestFinanceTests(WalkInCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.deposit_hotel_settings,prsystem.deposit_category_settings,prsystem.guest_finance,prsystem.guest_charge,prsystem.guest_receipt,prsystem.guest_allocation,prsystem.guest_refund,prsystem.guest_finance_event,prsystem.shift_obligation TO {}',
                'GRANT UPDATE (amount_mnt,revision) ON prsystem.deposit_hotel_settings,prsystem.deposit_category_settings TO {}',
                'GRANT UPDATE (revision,received,reversed,allocated,refund_reserved,refunded) ON prsystem.guest_finance TO {}',
                'GRANT UPDATE (allocated,refund_reserved,refunded,reversed) ON prsystem.guest_receipt TO {}',
                'GRANT UPDATE (paid_mnt) ON prsystem.guest_charge TO {}',
                'GRANT UPDATE (state,completed_at,released_at,confirmation_envelope) ON prsystem.guest_refund TO {}',
                'GRANT UPDATE (state) ON prsystem.shift_obligation TO {}',
                'GRANT UPDATE (reserved) ON prsystem.cash_drawer TO {}',
                'GRANT UPDATE (snapshot) ON prsystem.stay TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.client.close()
        # Exercise the production CASH path against disposable test databases.
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault),client=(self.peer,12345))
        self.addCleanup(self.client.close)
        self.ready()
        self.configure(60000)

    def configure(self,amount,revision=0,category=None,token=None,key=None):
        path=f'/hotels/{self.tenant}/'+(f'room-categories/{category}/deposit-settings' if category else 'deposit-settings')
        return self.client.put(path,headers=self.headers(token or self.manager_token),json=dict(amount_mnt=amount,expected_revision=revision,idempotency_key=key or uuid4().hex))

    def start(self,amount=60000,**extra):
        response=self.checkin(kind='NIGHTLY',duration_units=1,deposit=dict(channel='CASH',amount_mnt=amount,received=True),**extra)
        self.stay=self.assert_status(response,201)
        return self.stay

    def command(self,path,body,token=None,method='post'):
        return getattr(self.client,method)(f'/hotels/{self.tenant}/stays/{self.stay["stay_id"]}/'+path,headers=self.headers(token or self.worker_token),json=body)

    def statement(self,token=None):
        return self.client.get(f'/hotels/{self.tenant}/stays/{self.stay["stay_id"]}/finance',headers=self.headers(token or self.worker_token))

    def allocate(self,amount,revision=1,key='allocate',token=None,**extra):
        body=dict(receipt_id=self.stay['deposit_receipt_id'],charge_id=self.stay['room_charge_id'],amount_mnt=amount,expected_revision=revision,idempotency_key=key);body.update(extra)
        return self.command('deposit-allocations',body,token)

    def reserve(self,amount,revision=1,key='reserve',token=None):
        return self.command('cash-refunds',dict(receipt_id=self.stay['deposit_receipt_id'],amount_mnt=amount,expected_revision=revision,idempotency_key=key),token)

    def refund_finish(self,refund,revision=2,release=False,token=None,key='finish',**extra):
        body=dict(expected_revision=revision,idempotency_key=key)
        body.update(dict(reason='Cash never handed to guest',cash_not_handed=True) if release else dict(recipient_confirmation='Guest signed cash receipt'))
        body.update(extra)
        return self.command('cash-refunds/'+refund+('/release' if release else '/complete'),body,token)

    def drawer(self):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute('SELECT posted,reserved FROM prsystem.cash_drawer WHERE tenant_id=%s AND shift_id=%s',(self.tenant,self.shift)).fetchone()

    def test_cash_checkin_posts_deposit_room_charge_and_cash_once(self):
        stay=self.start();self.assertEqual(stay['deposit_mnt'],60000)
        self.assertEqual(stay['snapshot']['deposit_configuration']['source'],'HOTEL')
        self.assertEqual(stay['snapshot']['financial_integration'],'CASH_LEDGER')
        self.assertEqual(self.drawer(),(60000,0))
        self.assertEqual(self.checkin(kind='NIGHTLY',duration_units=1,deposit=dict(channel='CASH',amount_mnt=60000,received=True)).json(),stay)
        report=self.assert_status(self.statement(),200)
        self.assertEqual(report['balance']['available'],60000)
        self.assertEqual((report['charge_total_mnt'],report['charge_paid_mnt']),(80000,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.cash_event WHERE tenant_id=%s AND kind='GUEST_DEPOSIT_RECEIVED'",(self.tenant,)).fetchone()[0],1)

    def test_deposit_configuration_precedence_unset_and_permissions(self):
        for token in (self.admin,self.worker_token):self.assert_status(self.configure(70000,revision=1,token=token),403)
        self.assert_status(self.configure(70000,category=self.category),200)
        self.assert_status(self.configure(None,revision=1,category=self.category),200)
        self.assert_status(self.configure(80000,revision=1),200)
        self.assert_status(self.configure(90000,revision=1),409)
        self.assert_status(self.configure(None,revision=2),422)
        self.assertEqual(self.start(80000)['snapshot']['deposit_configuration']['category_override_revision'],2)

    def test_checkin_rejects_missing_wrong_or_unconfirmed_deposit(self):
        self.assert_status(self.checkin(),503)
        self.assertEqual(self.checkin(deposit=dict(channel='CASH',amount_mnt=50000,received=True)).json()['code'],'DEPOSIT_REQUIREMENT_NOT_MET')
        for bad in (dict(channel='QPAY',amount_mnt=60000,received=True),dict(channel='CASH',amount_mnt=60000,received=False),dict(channel='CASH',amount_mnt=60000,received=1)):
            self.assert_status(self.checkin(deposit=bad),422)
        self.assertEqual(self.drawer(),(0,0))
        self.start()

    def test_legacy_category_deposit_cannot_substitute_for_authoritative_settings(self):
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('DELETE FROM prsystem.deposit_hotel_settings WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.checkin(deposit=dict(channel='CASH',amount_mnt=50000,received=True)).json()['code'],'STAY_DEPOSIT_SETTINGS_REQUIRED')
        self.assertEqual(self.drawer(),(0,0))

    def test_allocation_reduces_deposit_and_charge_without_new_cash(self):
        self.start();response=self.allocate(30000);self.assert_status(response,201)
        self.assertEqual(self.allocate(30000).json(),response.json())
        self.assertEqual(self.drawer(),(60000,0))
        report=self.assert_status(self.statement(),200)
        self.assertEqual(report['balance']['available'],30000);self.assertEqual(report['charge_unpaid_mnt'],50000)
        self.assertEqual(self.allocate(30001,revision=2,key='too-much').json()['code'],'INSUFFICIENT_DEPOSIT')

    def test_cash_topup_pays_charge_without_inflating_deposit_liability(self):
        self.start()
        payment=dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=20000,charge_id=self.stay['room_charge_id'],expected_revision=1,idempotency_key='payment')
        self.assert_status(self.command('cash-receipts',payment),201)
        topup=dict(channel='CASH',received=True,purpose='PAYMENT',charge_id=self.stay['room_charge_id'],amount_mnt=10000,expected_revision=2,idempotency_key='topup')
        self.assert_status(self.command('cash-receipts',topup),201)
        report=self.assert_status(self.statement(),200)
        self.assertEqual(report['balance']['received'],60000);self.assertEqual(report['balance']['available'],60000)
        self.assertEqual(report['charge_paid_mnt'],30000);self.assertEqual(self.drawer(),(90000,0))
        self.assertEqual(self.command('cash-receipts',dict(payment,amount_mnt=60001,expected_revision=3,idempotency_key='overpay')).json()['code'],'CHARGE_OVERPAYMENT')
        self.assertEqual(self.drawer(),(90000,0))

    def test_refund_reserves_both_deposit_and_cash_and_blocks_shift_close(self):
        self.start();result=self.assert_status(self.reserve(20000),201)
        self.assertEqual(self.drawer(),(60000,20000))
        self.assertEqual(result['balance']['available'],40000)
        self.assertEqual(self.reserve(20000).json(),result)
        with transaction(self.app_dsn) as conn:
            ShiftService._book(conn,self.tenant)
            drawer=conn.execute('SELECT drawer_id FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone()[0]
            self.assertTrue(ShiftService._pending(conn,self.tenant,(self.shift,None,None,drawer)))
        self.assertEqual(self.allocate(40001,revision=2).json()['code'],'INSUFFICIENT_DEPOSIT')

    def test_refund_complete_requires_recipient_and_is_exactly_once(self):
        self.start();refund=self.assert_status(self.reserve(20000),201)['refund_id']
        self.assert_status(self.refund_finish(refund,recipient_confirmation=''),422)
        completed=self.assert_status(self.refund_finish(refund),200)
        self.assertEqual(self.refund_finish(refund).json(),completed)
        self.assertEqual(self.drawer(),(40000,0))
        self.assertEqual(completed['balance']['refunded'],20000)
        self.assertEqual(self.refund_finish(refund,revision=3,key='again').json()['code'],'REFUND_TERMINAL')
        with psycopg.connect(self.owner_dsn) as conn:
            envelope=conn.execute('SELECT confirmation_envelope FROM prsystem.guest_refund WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            self.assertEqual(self.vault.open(envelope,self.tenant,self.stay['stay_id'],'cash-refund:'+refund)['confirmation'],'Guest signed cash receipt')
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'SUCCEEDED')

    def test_only_manager_releases_unhanded_cash_and_original_history_survives(self):
        self.start();refund=self.assert_status(self.reserve(20000),201)['refund_id']
        for token in (self.worker_token,self.admin):self.assert_status(self.refund_finish(refund,release=True,token=token),403)
        self.assert_status(self.refund_finish(refund,release=True,token=self.manager_token,cash_not_handed=False),422)
        result=self.assert_status(self.refund_finish(refund,release=True,token=self.manager_token),200)
        self.assertEqual(self.drawer(),(60000,0));self.assertEqual(result['balance']['available'],60000)
        self.assertEqual(self.refund_finish(refund,revision=3,key='late-cash').json()['code'],'REFUND_TERMINAL')

    def test_concurrent_allocation_and_refund_cannot_double_spend(self):
        self.start();barrier=Barrier(2)
        def go(kind):
            barrier.wait()
            return self.allocate(50000) if kind=='allocation' else self.reserve(50000)
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(go,['allocation','refund']))
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])
        report=self.assert_status(self.statement(),200)
        self.assertEqual(report['balance']['available'],10000)
        self.assertEqual(report['balance']['allocated']+report['balance']['refund_reserved'],50000)

    def test_simultaneous_duplicate_refund_is_one_reservation(self):
        self.start();barrier=Barrier(2)
        def go(_):barrier.wait();return self.reserve(20000)
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(go,range(2)))
        self.assertEqual(responses[0].json(),responses[1].json())
        self.assertEqual(self.drawer(),(60000,20000))

    def test_current_open_shift_and_original_drawer_are_mandatory(self):
        self.start()
        self.assertEqual(self.allocate(10000,token=self.replacement_token).json()['code'],'OPEN_SHIFT_REQUIRED')
        self.open_shift(self.replacement_token,'second')
        self.assertEqual(self.reserve(10000,token=self.replacement_token).json()['code'],'ORIGINAL_CASH_DRAWER_REQUIRED')
        self.assert_status(self.allocate(10000,token=self.replacement_token),201)

    def test_cross_tenant_forged_sources_and_non_operational_roles_rejected(self):
        self.start()
        for token in (self.admin,self.manager_token):self.assert_status(self.allocate(10000,token=token),403)
        self.assertEqual(self.allocate(10000,receipt_id=uuid4().hex).json()['code'],'WORK_SOURCE_NOT_FOUND')
        self.assertEqual(self.allocate(10000,charge_id=uuid4().hex).json()['code'],'WORK_SOURCE_NOT_FOUND')
        response=self.client.get(f'/hotels/{self.other}/stays/{self.stay["stay_id"]}/finance',headers=self.headers(self.worker_token))
        self.assert_status(response,403)
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.ForeignKeyViolation):
                conn.execute('INSERT INTO prsystem.guest_allocation VALUES (%s,%s,%s,%s,%s,1,%s,clock_timestamp())',(self.other,self.stay['stay_id'],uuid4().hex,self.stay['deposit_receipt_id'],self.stay['room_charge_id'],self.account))

    def test_post_lock_settlement_uses_original_stay_root_and_security_still_denies(self):
        self.start()
        with psycopg.connect(self.owner_dsn) as conn:
            # Old obligation fixture: move expiration so its lock is just after check-in.
            conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours'+interval '1 millisecond' WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        self.assert_status(self.allocate(10000),201)
        self.assert_status(self.statement(),200)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.allocate(10000,revision=2,key='security').json()['code'],'SECURITY_SUSPENDED')

    def test_financial_failure_rolls_back_checkin_identity_cash_and_outboxes(self):
        with patch.object(GuestFinance,'audit',side_effect=DomainError('INVALID_REQUEST')):
            self.assert_status(self.checkin(deposit=dict(channel='CASH',amount_mnt=60000,received=True)),422)
        self.assertEqual(self.drawer(),(0,0))
        with psycopg.connect(self.owner_dsn) as conn:
            for table in ('stay','guest_finance','guest_charge','guest_receipt','guest_finance_event','identity_match_outbox','stay_guest_code'):
                self.assertEqual(conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,)).fetchone()[0],0)
        self.start()

    def test_failed_refund_posting_keeps_both_reservations(self):
        self.start();refund=self.assert_status(self.reserve(20000),201)['refund_id']
        with patch.object(GuestFinance,'audit',side_effect=DomainError('INVALID_REQUEST')):self.assert_status(self.refund_finish(refund),422)
        self.assertEqual(self.drawer(),(60000,20000))
        self.assertEqual(self.statement().json()['balance']['refund_reserved'],20000)
        self.assert_status(self.refund_finish(refund),200)

    def test_immutable_history_and_database_conservation(self):
        self.start()
        with psycopg.connect(self.owner_dsn) as conn:
            for statement in ("UPDATE prsystem.guest_receipt SET amount_mnt=1 WHERE tenant_id=%s", "UPDATE prsystem.guest_charge SET amount_mnt=1 WHERE tenant_id=%s", "DELETE FROM prsystem.guest_finance_event WHERE tenant_id=%s", "UPDATE prsystem.guest_finance SET allocated=received+1 WHERE tenant_id=%s"):
                with self.assertRaises(psycopg.errors.CheckViolation),conn.transaction():conn.execute(statement,(self.tenant,))
        self.assertEqual(self.drawer(),(60000,0))

    def test_suspended_reception_cannot_replay_receipt(self):
        self.start();self.assert_status(self.allocate(10000),201)
        self.suspend();self.assert_status(self.allocate(10000),401)

    def test_deferred_mock_stay_cannot_be_promoted_to_real_finance(self):
        with TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',mock_stay_finance=True)) as client:
            old=self.client;self.client=client
            try:self.stay=self.assert_status(self.checkin(),201)
            finally:self.client=old
        self.assertEqual(self.statement().json()['code'],'FINANCIAL_SOURCE_NOT_READY')
        self.assertEqual(self.drawer(),(0,0))

    def test_existing_cash_spend_cannot_consume_refund_reservation(self):
        from datetime import datetime,timezone
        from prsystem.cash import SpendCash,CashContext
        from prsystem.postgres.cash import PostgresCash
        self.start();refund=self.assert_status(self.reserve(20000),201)['refund_id']
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute(sql.SQL('GRANT INSERT ON prsystem.cash_receipt TO {}').format(sql.Identifier(self.role)))
            revision=conn.execute('SELECT revision FROM prsystem.cash_book WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            drawer=conn.execute('SELECT drawer_id FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone()[0]
        # Internal cash adapter's authorization fixture; public finance APIs still authenticate.
        cash=PostgresCash(self.app_dsn,authorize=lambda conn,cmd,ctx:ctx.actor_id==self.worker and ctx.tenant_id==self.tenant)
        context=CashContext(self.tenant,self.worker,'expense',revision,datetime.now(timezone.utc),False,self.shift)
        with self.assertRaises(DomainError):cash.execute(SpendCash(drawer,40001,'approved-expense','Fixture expense'),context)
        cash.execute(SpendCash(drawer,40000,'approved-expense','Fixture expense'),context)
        self.assertEqual(self.drawer(),(20000,20000))
        self.assert_status(self.refund_finish(refund),200)
        self.assertEqual(self.drawer(),(0,0))

    def test_deferred_commit_failure_never_reports_received_cash(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_guest_finance_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'guest finance commit fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_guest_finance_commit AFTER INSERT ON prsystem.guest_finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_guest_finance_commit()').format(sql.Literal(self.tenant)))
        self.assert_status(self.checkin(deposit=dict(channel='CASH',amount_mnt=60000,received=True)),503)
        self.assertEqual(self.drawer(),(0,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_receipt WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            conn.execute('DROP TRIGGER fail_guest_finance_commit ON prsystem.guest_finance_event')
            conn.execute('DROP FUNCTION prsystem.fail_guest_finance_commit()')
        self.start()

    def test_development_cash_ledger_is_marked_and_cannot_enter_live_finance(self):
        with self.assertRaises(ValueError):
            create_app('postgresql://unused/prsystem_live',self.settings,identity_vault=self.vault,runtime_mode='development')
        with TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='development')) as client:
            old=self.client;self.client=client
            try:
                response=self.checkin(kind='NIGHTLY',duration_units=1,deposit=dict(channel='CASH',amount_mnt=60000,received=True))
                self.stay=self.assert_status(response,201)
                self.assertEqual(response.headers['X-PRsystem-Mode'],'MOCK_ONLY')
                self.assertEqual(self.stay['snapshot']['financial_integration'],'MOCK_CASH_LEDGER')
                self.assert_status(self.statement(),200)
            finally:self.client=old
        self.assertEqual(self.statement().json()['code'],'FINANCIAL_SOURCE_NOT_READY')
