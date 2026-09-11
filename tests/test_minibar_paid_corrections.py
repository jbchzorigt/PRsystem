import unittest
from uuid import uuid4
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_guest as guest_support
    from prsystem.minibar_paid_corrections import MinibarPaidCorrections
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarPaidCorrectionTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_paid_correction,prsystem.minibar_paid_release,prsystem.minibar_paid_reallocation TO {}',
                'GRANT SELECT,INSERT ON prsystem.minibar_manager_exception,prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();guest_support.MinibarGuestTests.configured(self);self.start()
        self.assert_status(guest_support.MinibarGuestTests.begin(self),200)
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201)
        self.original=self.assert_status(guest_support.MinibarGuestTests.report(self,actual=0,no_consumption=False),201)

    def pay(self,amount=6000):
        revision=self.statement().json()['balance']['revision']
        return self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=amount,charge_id=self.original['charge_id'],expected_revision=revision,idempotency_key=uuid4().hex)),201)

    def correct(self,actual=1,revision=1,token=None,**extra):
        body=dict(counts={self.product:actual},reason='Төлсөн тайлангийн бодит тоог дахин шалгасан',expected_revision=revision,expected_finance_revision=self.statement().json()['balance']['revision'],idempotency_key=uuid4().hex)
        body.update(extra)
        return self.command('minibar-paid-corrections',body,token or self.manager_token)

    def test_overcharge_reallocates_payment_and_cash_refund_completes(self):
        payment=self.pay();r=self.assert_status(self.correct(),201)
        self.assertEqual((r['amount_mnt'],r['reallocated_mnt'],r['new_receivable_mnt']),(3000,3000,0))
        self.assertEqual(sum(x['amount_mnt'] for x in r['refundable_credits']),3000)
        self.assertEqual((r['balance']['received'],r['balance']['allocated'],r['balance']['service_credit']),(60000,0,3000))
        receipt=r['refundable_credits'][0]['receipt_id'];finance=self.statement().json()
        self.assertTrue(next(x for x in finance['receipts'] if x['id']==receipt)['refund_eligible'])
        reserved=self.assert_status(self.command('cash-refunds',dict(receipt_id=receipt,amount_mnt=3000,expected_revision=finance['balance']['revision'],idempotency_key=uuid4().hex)),201)
        self.assert_status(self.refund_finish(reserved['refund_id'],revision=reserved['balance']['revision']),200)
        self.assertEqual(guest_support.MinibarGuestTests.stocks(self)['room_quantity'],1)

    def test_all_consumption_reversed_leaves_no_charge_and_full_credit(self):
        self.pay();r=self.assert_status(self.correct(actual=2),201)
        self.assertIsNone(r['charge_id']);self.assertEqual(r['reallocated_mnt'],0)
        self.assertEqual(sum(x['amount_mnt'] for x in r['refundable_credits']),6000)

    def test_partial_payment_reapplies_only_paid_amount_and_retains_receivable(self):
        self.pay(1000);r=self.assert_status(self.correct(),201)
        self.assertEqual((r['reallocated_mnt'],r['new_receivable_mnt'],r['refundable_credits']),(1000,2000,[]))

    def test_chain_can_increase_consumption_without_collecting_money(self):
        self.pay();first=self.assert_status(self.correct(),201)
        before=self.drawer();r=self.assert_status(self.correct(actual=0,revision=2),201)
        self.assertEqual((r['amount_mnt'],r['reallocated_mnt'],r['new_receivable_mnt']),(6000,3000,3000))
        self.assertEqual(self.drawer(),before)

    def test_exact_retry_and_stale_finance_have_no_duplicate_effect(self):
        self.pay();revision=self.statement().json()['balance']['revision'];key=uuid4().hex
        result=self.assert_status(self.correct(expected_finance_revision=revision,idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.correct(expected_finance_revision=revision,idempotency_key=key),201),result)
        self.assertEqual(self.correct(actual=0,revision=2,expected_finance_revision=revision).json()['code'],'REVISION_CONFLICT')

    def test_permission_counts_and_no_change_validation(self):
        self.pay()
        self.assert_status(self.correct(token=self.worker_token),403)
        self.assert_status(self.correct(token=self.admin),403)
        self.assertEqual(self.correct(actual=0).json()['code'],'CORRECTION_HAS_NO_CHANGE')
        self.assert_status(self.correct(actual=3),422)
        self.assert_status(self.correct(counts={'foreign':1}),422)
        self.assert_status(self.correct(unit_price=1),422)

    def test_unpaid_report_requires_existing_unpaid_review_workflow(self):
        self.assertEqual(self.correct().json()['code'],'INVALID_FINANCIAL_SOURCE')

    def test_report_failure_rolls_back_release_source_finance_and_inventory(self):
        self.pay();before=self.statement().json();stocks=guest_support.MinibarGuestTests.stocks(self)
        with patch.object(MinibarPaidCorrections,'report',side_effect=DomainError('COUNT_VARIANCE')):
            self.assertEqual(self.correct().json()['code'],'COUNT_VARIANCE')
        self.assertEqual(self.statement().json(),before);self.assertEqual(guest_support.MinibarGuestTests.stocks(self),stocks)
        self.assert_status(self.correct(),201)

    def test_original_reports_prices_payments_and_release_history_remain(self):
        self.pay()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=9000 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        self.assertEqual(self.assert_status(self.correct(),201)['amount_mnt'],3000)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT amount_mnt FROM prsystem.reception_minibar_report WHERE tenant_id=%s ORDER BY revision',(self.tenant,)).fetchall(),[(6000,),(3000,)])
            with self.assertRaises(psycopg.errors.CheckViolation):conn.execute('DELETE FROM prsystem.minibar_paid_release WHERE tenant_id=%s',(self.tenant,))
        with psycopg.connect(self.app_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_paid_release').fetchone()[0],0)

    def test_concurrent_corrections_have_one_winner(self):
        self.pay();revision=self.statement().json()['balance']['revision'];gate=Barrier(2)
        def send():
            gate.wait();return self.correct(expected_finance_revision=revision)
        with ThreadPoolExecutor(2) as pool:r=[f.result() for f in(pool.submit(send),pool.submit(send))]
        self.assertEqual(sorted(x.status_code for x in r),[201,409])

    def test_released_service_payment_uses_routed_refund_without_extra_approval(self):
        self.pay();r=self.assert_status(self.correct(),201)
        refund=self.assert_status(self.command('refunds',dict(receipt_id=r['refundable_credits'][0]['receipt_id'],amount_mnt=3000,channel='CASH',recipient='Зочин',reason='Залруулгын илүү төлөлт',expected_revision=r['balance']['revision'],idempotency_key=uuid4().hex)),201)
        self.assertEqual(refund['approval'],'APPROVED')
        self.assert_status(self.command('refunds/'+refund['refund_id']+'/complete',dict(recipient_confirmation='Зочин хүлээн авсан',reference=None,expected_revision=refund['balance']['revision'],idempotency_key=uuid4().hex)),200)

    def test_pending_payment_blocks_correction_and_preserves_finance(self):
        self.pay(1000)
        with psycopg.connect(self.owner_dsn) as conn:
            drawer=conn.execute('SELECT id FROM prsystem.cash_drawer WHERE tenant_id=%s AND shift_id=%s',(self.tenant,self.shift)).fetchone()[0]
            conn.execute("INSERT INTO prsystem.guest_payment_intent(tenant_id,stay_id,id,charge_id,provider,merchant_id,amount_mnt,actor_id,shift_id,drawer_id,recorded_at) VALUES(%s,%s,%s,%s,'QPAY','fixture',5000,%s,%s,%s,clock_timestamp())",(self.tenant,self.stay['stay_id'],uuid4().hex,self.original['charge_id'],self.worker,self.shift,drawer))
        before=self.statement().json();self.assertEqual(self.correct().json()['code'],'MINIBAR_REPORT_LOCKED');self.assertEqual(self.statement().json(),before)

    def test_deferred_failure_rolls_back_every_side_effect_for_exact_retry(self):
        self.pay();before=self.statement().json();key=uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_paid_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_paid_correction AFTER INSERT ON prsystem.minibar_paid_correction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_paid_correction()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.correct(idempotency_key=key),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_paid_correction ON prsystem.minibar_paid_correction');conn.execute('DROP FUNCTION prsystem.fail_paid_correction()')
        self.assertEqual(self.statement().json(),before)
        self.assert_status(self.correct(idempotency_key=key),201)

    def test_deposit_funded_report_retains_deposit_projection(self):
        finance=self.statement().json()['balance']['revision']
        self.assert_status(self.command('deposit-allocations',dict(receipt_id=self.stay['deposit_receipt_id'],charge_id=self.original['charge_id'],amount_mnt=6000,expected_revision=finance,idempotency_key=uuid4().hex)),201)
        r=self.assert_status(self.correct(),201)
        self.assertEqual((r['balance']['received'],r['balance']['allocated'],r['balance']['service_credit']),(60000,3000,0))

    def test_mixed_payment_and_deposit_keep_receipt_liabilities_conserved(self):
        self.pay(2000);finance=self.statement().json()['balance']['revision']
        self.assert_status(self.command('deposit-allocations',dict(receipt_id=self.stay['deposit_receipt_id'],charge_id=self.original['charge_id'],amount_mnt=4000,expected_revision=finance,idempotency_key=uuid4().hex)),201)
        r=self.assert_status(self.correct(),201);b=r['balance']
        self.assertEqual(b['service_credit']+4000-b['allocated'],3000)
        self.assertEqual(sum(x['amount_mnt'] for x in r['refundable_credits']),3000)
