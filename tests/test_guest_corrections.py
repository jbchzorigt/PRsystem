import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from prsystem.shifts import ShiftService
    from prsystem.postgres.connection import transaction


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class GuestCorrectionTests(GuestFinanceCase):
    def request(self, amount=50000, revision=1, receipt=None, key='correction', token=None, **extra):
        body=dict(receipt_id=receipt or self.stay['deposit_receipt_id'],replacement_amount_mnt=amount,
                  reason='Incorrect cash amount recorded',expected_revision=revision,idempotency_key=key)
        body.update(extra)
        return self.command('cash-corrections',body,token)

    def decide(self, correction, approve=True, revision=2, key='decision', token=None, **extra):
        body=dict(approve=approve,reason='Verified physical receipt and count',expected_revision=revision,idempotency_key=key)
        body.update(extra)
        return self.command('cash-corrections/'+correction+'/decision',body,token or self.manager_token)

    def payment(self, amount=20000):
        return self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=amount,
            charge_id=self.stay['room_charge_id'],expected_revision=1,idempotency_key='payment')),201)['receipt_id']

    def test_deposit_correction_preserves_original_and_posts_only_net_cash(self):
        self.start();requested=self.assert_status(self.request(),201)
        self.assertEqual(self.drawer(),(60000,0))
        self.assertEqual(self.request().json(),requested)
        result=self.assert_status(self.decide(requested['correction_id']),200)
        self.assertEqual(self.decide(requested['correction_id']).json(),result)
        self.assertEqual(self.drawer(),(50000,0))
        self.assertEqual((result['balance']['received'],result['balance']['reversed'],result['balance']['available']),(110000,60000,50000))
        with psycopg.connect(self.owner_dsn) as conn:
            rows=conn.execute('SELECT amount_mnt,reversed FROM prsystem.guest_receipt WHERE tenant_id=%s ORDER BY amount_mnt',(self.tenant,)).fetchall()
            self.assertEqual(rows,[(50000,0),(60000,60000)])
            self.assertEqual(conn.execute('SELECT receipt_id,replacement_receipt_id FROM prsystem.guest_receipt_reversal WHERE tenant_id=%s',(self.tenant,)).fetchone(),(self.stay['deposit_receipt_id'],result['replacement_receipt_id']))
            self.assertEqual(conn.execute("SELECT posted_delta,reserved_delta FROM prsystem.cash_event WHERE tenant_id=%s AND kind='GUEST_CASH_CORRECTED'",(self.tenant,)).fetchall(),[(-10000,0)])
            self.assertEqual(conn.execute('SELECT state FROM prsystem.shift_obligation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'SUCCEEDED')

    def test_payment_correction_reverses_allocation_without_touching_deposit(self):
        self.start();receipt=self.payment()
        correction=self.assert_status(self.request(10000,revision=2,receipt=receipt),201)['correction_id']
        self.assert_status(self.decide(correction,revision=3),200)
        report=self.statement().json()
        self.assertEqual(report['balance']['available'],60000)
        self.assertEqual(report['charge_paid_mnt'],10000)
        self.assertEqual(self.drawer(),(70000,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT amount_mnt,allocated,reversed FROM prsystem.guest_receipt WHERE tenant_id=%s AND id=%s',(self.tenant,receipt)).fetchone(),(20000,0,20000))
            self.assertEqual(conn.execute('SELECT sum(amount_mnt) FROM prsystem.guest_allocation_reversal WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],20000)
            self.assertEqual(conn.execute('SELECT sum(amount_mnt) FROM prsystem.guest_allocation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],30000)

    def test_duplicate_receipt_removal_has_no_zero_value_receipt(self):
        self.start();receipt=self.payment()
        correction=self.assert_status(self.request(0,revision=2,receipt=receipt),201)['correction_id']
        result=self.assert_status(self.decide(correction,revision=3),200)
        self.assertIsNone(result['replacement_receipt_id'])
        self.assertEqual(self.statement().json()['charge_paid_mnt'],0)
        self.assertEqual(self.drawer(),(60000,0))

    def test_only_current_manager_can_decide_and_reason_is_required(self):
        self.start()
        self.assert_status(self.request(token=self.admin),403)
        self.assert_status(self.request(reason='   '),422)
        self.assert_status(self.request(60000),409)
        correction=self.assert_status(self.request(),201)['correction_id']
        for token in (self.admin,self.worker_token):self.assert_status(self.decide(correction,token=token),403)
        self.assert_status(self.decide(correction,reason=''),422)
        self.assert_status(self.decide(correction,approve=1),422)
        self.assert_status(self.decide(correction),200)

    def test_pending_correction_blocks_source_spending_and_shift_closure(self):
        self.start();self.assert_status(self.request(),201)
        for response in (self.allocate(1,revision=2),self.reserve(1,revision=2),self.request(40000,revision=2,key='second')):
            self.assertEqual(response.json()['code'],'CORRECTION_PENDING')
        with transaction(self.app_dsn) as conn:
            ShiftService._book(conn,self.tenant)
            drawer=conn.execute('SELECT drawer_id FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone()[0]
            self.assertTrue(ShiftService._pending(conn,self.tenant,(self.shift,None,None,drawer)))
        self.assertEqual(self.drawer(),(60000,0))

    def test_rejection_retains_history_unblocks_source_and_allows_new_request(self):
        self.start();correction=self.assert_status(self.request(),201)['correction_id']
        self.assert_status(self.decide(correction,approve=False),200)
        self.assertEqual(self.drawer(),(60000,0))
        self.assertEqual(self.decide(correction,revision=3,key='late').json()['code'],'CORRECTION_TERMINAL')
        self.assert_status(self.request(70000,revision=3,key='new'),201)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_correction WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],2)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_receipt_reversal WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_allocated_or_refund_reserved_deposit_cannot_be_reversed(self):
        self.start();self.assert_status(self.allocate(10000),201)
        self.assertEqual(self.request(revision=2).json()['code'],'CORRECTION_SOURCE_IN_USE')
        self.assert_status(self.reserve(10000,revision=2),201)
        self.assertEqual(self.request(revision=3).json()['code'],'CORRECTION_SOURCE_IN_USE')
        self.assertEqual(self.drawer(),(60000,10000))

    def test_payment_overcorrection_rolls_back_original_and_history(self):
        self.start();receipt=self.payment()
        correction=self.assert_status(self.request(80001,revision=2,receipt=receipt),201)['correction_id']
        self.assertEqual(self.decide(correction,revision=3).json()['code'],'CHARGE_OVERPAYMENT')
        self.assertEqual(self.statement().json()['charge_paid_mnt'],20000)
        self.assertEqual(self.drawer(),(80000,0))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_allocation_reversal WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT state FROM prsystem.guest_correction WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'PENDING')

    def test_cash_shortage_cannot_be_hidden_by_a_correction(self):
        self.start();correction=self.assert_status(self.request(0),201)['correction_id']
        with transaction(self.app_dsn) as conn:
            ShiftService._book(conn,self.tenant)
            drawer=conn.execute('SELECT drawer_id FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone()[0]
        # A lower posted projection is enough here: cash-source behaviour has
        # separate integration tests; this assertion targets atomic correction.
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.tenant,))
            conn.execute('UPDATE prsystem.cash_drawer SET posted=50000 WHERE tenant_id=%s AND id=%s',(self.tenant,drawer))
        self.assertEqual(self.decide(correction).json()['code'],'INSUFFICIENT_CASH')
        self.assertEqual(self.drawer(),(50000,0))
        self.assertEqual(self.statement().json()['balance']['reversed'],0)

    def test_simultaneous_duplicate_approval_posts_once(self):
        self.start();correction=self.assert_status(self.request(),201)['correction_id'];barrier=Barrier(2)
        def approve():
            barrier.wait();return self.decide(correction)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(lambda _:approve(),range(2)))
        self.assertEqual([r.status_code for r in responses],[200,200])
        self.assertEqual(responses[0].json(),responses[1].json())
        self.assertEqual(self.drawer(),(50000,0))

    def test_request_race_has_one_nonterminal_correction(self):
        self.start();barrier=Barrier(2)
        def request(key):
            barrier.wait();return self.request(key=key)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(request,['one','two']))
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_correction WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_deferred_commit_failure_rolls_back_every_financial_effect(self):
        self.start();correction=self.assert_status(self.request(),201)['correction_id']
        trigger='fail_correction_'+uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute(sql.SQL("CREATE FUNCTION prsystem.{}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit rejected'; END; $$").format(sql.Identifier(trigger)))
            conn.execute(sql.SQL("CREATE CONSTRAINT TRIGGER {} AFTER INSERT ON prsystem.guest_receipt_reversal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.{}()").format(sql.Identifier(trigger),sql.Literal(self.tenant),sql.Identifier(trigger)))
        try:
            with self.assertRaises(psycopg.Error):self.decide(correction)
            self.assertEqual(self.drawer(),(60000,0))
            self.assertEqual(self.statement().json()['balance']['revision'],2)
            with psycopg.connect(self.owner_dsn) as conn:
                self.assertEqual(conn.execute('SELECT state FROM prsystem.guest_correction WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'PENDING')
                self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.guest_receipt WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute(sql.SQL('DROP TRIGGER {} ON prsystem.guest_receipt_reversal').format(sql.Identifier(trigger)))
                conn.execute(sql.SQL('DROP FUNCTION prsystem.{}()').format(sql.Identifier(trigger)))
        self.assert_status(self.decide(correction),200)

    def test_database_rejects_original_history_edits_and_cross_tenant_links(self):
        self.start();correction=self.assert_status(self.request(),201)['correction_id']
        result=self.assert_status(self.decide(correction),200)
        for query in ("UPDATE prsystem.guest_correction SET reason='rewritten' WHERE tenant_id=%s",
                      "UPDATE prsystem.guest_correction SET state='REJECTED' WHERE tenant_id=%s",
                      'DELETE FROM prsystem.guest_receipt_reversal WHERE tenant_id=%s',
                      'UPDATE prsystem.guest_receipt SET amount_mnt=1 WHERE tenant_id=%s'):
            with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
                conn.execute(query,(self.tenant,))
        with self.assertRaises(psycopg.errors.ForeignKeyViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute('''INSERT INTO prsystem.guest_receipt_reversal VALUES (%s,%s,%s,%s,%s,%s,60000,clock_timestamp())''',
                         (self.other,self.stay['stay_id'],uuid4().hex,correction,self.stay['deposit_receipt_id'],result['replacement_receipt_id']))

    def test_suspended_requester_cannot_be_used_for_approval_but_rejection_works(self):
        self.start();correction=self.assert_status(self.request(),201)['correction_id']
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_membership SET status='SUSPENDED',revision=revision+1 WHERE tenant_id=%s AND account_id=%s",(self.tenant,self.worker))
        self.assert_status(self.decide(correction),403)
        self.assert_status(self.decide(correction,approve=False,key='reject'),200)
        self.assertEqual(self.drawer(),(60000,0))
