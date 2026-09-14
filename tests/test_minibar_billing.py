import unittest
from uuid import uuid4
from datetime import datetime,timezone
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_guest as guest
    from prsystem.minibar_billing import MinibarBilling


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarBillingTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_billing_correction,prsystem.minibar_billing_release,prsystem.minibar_billing_reallocation TO {}',
                'GRANT SELECT ON prsystem.minibar_paid_reallocation TO {}',
                'GRANT INSERT ON prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp();guest.MinibarGuestTests.configured(self);self.start()
        self.assert_status(guest.MinibarGuestTests.begin(self),200)
        self.task=self.assert_status(guest.MinibarGuestTests.claim(self),201)
        self.original=self.assert_status(guest.MinibarGuestTests.report(self,actual=0,no_consumption=False),201)

    def cash_payment(self,charge,amount):
        return self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=amount,charge_id=charge,expected_revision=self.statement().json()['balance']['revision'],idempotency_key=uuid4().hex))

    def close(self,deposit_minibar=0):
        finance=self.statement().json();mini_amount=next(c['amount_mnt'] for c in finance['charges'] if c['id']==self.original['charge_id'])
        rev=finance['balance']['revision']
        self.assert_status(self.allocate(60000-deposit_minibar,revision=rev),201)
        if deposit_minibar:self.assert_status(self.allocate(deposit_minibar,revision=self.statement().json()['balance']['revision'],key=uuid4().hex,charge_id=self.original['charge_id']),201)
        self.assert_status(self.cash_payment(self.stay['room_charge_id'],20000+deposit_minibar),201)
        if deposit_minibar<mini_amount:self.assert_status(self.cash_payment(self.original['charge_id'],mini_amount-deposit_minibar),201)
        self.closed=self.assert_status(self.command('checkout',dict(expected_revision=self.statement().json()['balance']['revision'],idempotency_key=uuid4().hex)),200)

    def billing(self,query='',token=None):
        return self.client.get(f'/hotels/{self.tenant}/stays/{self.stay["stay_id"]}/minibar-billing'+query,headers=self.headers(token or self.manager_token))

    def correct(self,quantity=1,token=None,**extra):
        data=self.billing().json();basis=data.get('basis',{})
        body=dict(quantities={self.product:quantity},expected_revision=basis.get('billing_revision',0),expected_report_revision=1,
            expected_finance_revision=self.statement().json()['balance']['revision'],reason='Өмнөх төлбөрийн тоог баримтаар залруулсан',financial_only_reviewed=True,idempotency_key=uuid4().hex)
        body.update(extra);return self.command('minibar-billing-corrections',body,token or self.manager_token)

    def physical(self):
        with psycopg.connect(self.owner_dsn) as conn:
            result={}
            for table in('minibar_receipt','minibar_adjustment','minibar_transfer','reception_minibar_report','minibar_guest_report','stay_checkout','cleaning_posting','room','stay'):
                result[table]=conn.execute(sql.SQL('SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),\'[]\') FROM prsystem.{} x WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,)).fetchone()[0]
            return result

    def test_closed_overcharge_releases_credit_and_preserves_all_physical_history(self):
        self.close();before=self.physical();cash=self.drawer();r=self.assert_status(self.correct(),201)
        self.assertEqual((r['amount_mnt'],r['reallocated_mnt'],r['new_receivable_mnt']),(3000,3000,0))
        self.assertEqual((r['balance']['service_credit'],sum(x['amount_mnt'] for x in r['refundable_credits'])),(3000,3000))
        self.assertEqual(self.physical(),before);self.assertEqual(self.drawer(),cash)
        self.assertEqual(self.billing().json()['basis']['original_revision'],1)
        preview=self.client.get(f'/hotels/{self.tenant}/stays/{self.stay["stay_id"]}/checkout/preview',headers=self.headers(self.worker_token))
        self.assertEqual(self.assert_status(preview,200)['stay_state'],'CLOSED')
        self.assertIsNone(preview.json()['availability'])

    def test_expired_subscription_lists_and_settles_only_eligible_historical_stays(self):
        self.close()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours'+interval '1 millisecond' WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        path=f'/hotels/{self.tenant}/minibar/billing-stays'
        for token in (self.manager_token,self.worker_token):
            page=self.assert_status(self.client.get(path,headers=self.headers(token)),200)
            self.assertEqual([x['stay_id'] for x in page['items']],[self.stay['stay_id']])
        self.assert_status(self.correct(),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours' WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        self.assertEqual(self.assert_status(self.client.get(path,headers=self.headers(self.manager_token)),200)['items'],[])
        self.assertEqual(self.billing().json()['code'],'SUBSCRIPTION_EXPIRED')

    def test_expired_list_never_bypasses_security_suspension(self):
        self.close()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours'+interval '1 millisecond',security_suspended=true WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        response=self.client.get(f'/hotels/{self.tenant}/minibar/billing-stays',headers=self.headers(self.manager_token))
        self.assertEqual(response.json()['code'],'SECURITY_SUSPENDED')

    def test_credit_uses_existing_cash_refund_completion(self):
        self.close();r=self.assert_status(self.correct(),201);receipt=r['refundable_credits'][0]['receipt_id']
        q=self.assert_status(self.command('cash-refunds',dict(receipt_id=receipt,amount_mnt=3000,expected_revision=r['balance']['revision'],idempotency_key=uuid4().hex)),201)
        self.assert_status(self.refund_finish(q['refund_id'],revision=q['balance']['revision']),200)
        self.assertEqual(self.statement().json()['balance']['available'],0)

    def test_zero_replacement_and_later_receivable_are_linked_at_original_price(self):
        self.close();first=self.assert_status(self.correct(0),201);self.assertIsNone(first['charge_id'])
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.minibar_product SET selling_price_mnt=9999,revision=revision+1 WHERE tenant_id=%s AND id=%s',(self.tenant,self.product))
        r=self.assert_status(self.correct(1),201);self.assertEqual((r['amount_mnt'],r['new_receivable_mnt']),(3000,3000))
        self.assert_status(self.cash_payment(r['charge_id'],3000),201)
        self.assertEqual(self.billing().json()['history'][1]['previous_id'],first['correction_id'])
        self.assertEqual(self.billing().json()['basis']['items'][0]['unit_price'],3000)

    def test_manual_pos_can_settle_only_current_historical_correction_charge(self):
        self.close();self.assert_status(self.correct(0),201);r=self.assert_status(self.correct(1),201);cash=self.drawer()
        self.assert_status(self.command('pos-payments',dict(charge_id=r['charge_id'],amount_mnt=3000,reference='HISTORY-POS',terminal_id='FRONT',transacted_at=datetime.now(timezone.utc).isoformat(),expected_revision=r['balance']['revision'],idempotency_key=uuid4().hex)),201)
        self.assertEqual(self.drawer(),cash)
        self.assertEqual(self.cash_payment(self.stay['room_charge_id'],1).json()['code'],'WORK_NOT_OPEN')

    def test_active_stay_is_not_a_historical_billing_source(self):
        self.assertEqual(self.correct().json()['code'],'MINIBAR_BILLING_NOT_READY')
        self.assert_status(self.billing(),409)

    def test_reception_cleaner_and_admin_cannot_correct(self):
        self.close()
        for token in(self.worker_token,self.admin):self.assert_status(self.correct(token=token),403)
        self.assert_status(self.billing(token=self.worker_token),200)

    def test_reason_ack_and_server_owned_prices_and_counts_are_validated(self):
        self.close()
        for extra in(dict(reason=' '),dict(financial_only_reviewed=False),dict(unit_price=1),dict(quantities={self.product:3}),dict(quantities={'other':1}),dict(quantities={self.product:True}),dict(quantities={self.product:1.5})):
            self.assert_status(self.correct(**extra),422)
        self.assertEqual(self.correct(2).json()['code'],'CORRECTION_HAS_NO_CHANGE')

    def test_cross_tenant_ids_never_create_a_correction(self):
        self.close()
        response=self.client.get(f'/hotels/{self.other}/stays/{self.stay["stay_id"]}/minibar-billing',headers=self.headers(self.manager_token))
        self.assert_status(response,403)

    def test_stale_report_billing_and_finance_revisions_reject(self):
        self.close();rev=self.statement().json()['balance']['revision'];self.assert_status(self.correct(),201)
        for extra in(dict(expected_revision=0),dict(expected_report_revision=2),dict(expected_finance_revision=rev)):
            self.assertEqual(self.correct(0,**extra).json()['code'],'REVISION_CONFLICT')

    def test_exact_retry_never_releases_or_reallocates_twice(self):
        self.close();rev=self.statement().json()['balance']['revision'];key=uuid4().hex
        r=self.assert_status(self.correct(expected_revision=0,expected_finance_revision=rev,idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.correct(expected_revision=0,expected_finance_revision=rev,idempotency_key=key),201),r)
        self.assertEqual(len(self.billing().json()['history']),1)

    def test_concurrent_commands_have_one_winner(self):
        self.close();rev=self.statement().json()['balance']['revision'];gate=Barrier(2)
        def run():gate.wait();return self.correct(expected_revision=0,expected_finance_revision=rev)
        with ThreadPoolExecutor(2) as pool:results=[f.result() for f in(pool.submit(run),pool.submit(run))]
        self.assertEqual(sorted(r.status_code for r in results),[201,409])

    def test_frozen_finance_rejects_without_changing_history(self):
        self.close();before=self.physical()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.guest_finance SET frozen=true WHERE tenant_id=%s AND stay_id=%s',(self.tenant,self.stay['stay_id']))
        self.assertEqual(self.correct().json()['code'],'FINANCIAL_AGGREGATE_FROZEN');self.assertEqual(self.physical(),before)
        self.assertTrue(self.billing().json()['blocked'])

    def test_revoked_manager_cannot_correct_or_replay(self):
        self.close();key=uuid4().hex;self.assert_status(self.correct(idempotency_key=key),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.staff_account SET status='SUSPENDED' WHERE id=%s",(self.manager,))
        response=self.assert_status(self.correct(idempotency_key=key),401)
        self.assertEqual(response['code'],'UNAUTHENTICATED')
        self.assertEqual(len(self.billing(token=self.worker_token).json()['history']),1)

    def test_tampered_server_snapshot_is_rejected_by_database(self):
        self.close();original=MinibarBilling.basis
        def wrong(conn,tenant,stay):
            b=original(conn,tenant,stay);b['items'][0]['unit_price']=1;return b
        with patch.object(MinibarBilling,'basis',staticmethod(wrong)):self.assert_status(self.correct(),503)
        self.assertEqual(self.billing().json()['history'],[])

    def test_deferred_failure_rolls_back_receipts_charge_credit_and_history(self):
        self.close();before=self.statement().json();physical=self.physical();key=uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_billing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_billing AFTER INSERT ON prsystem.minibar_billing_correction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_billing()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.correct(idempotency_key=key),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:conn.execute('DROP TRIGGER fail_billing ON prsystem.minibar_billing_correction');conn.execute('DROP FUNCTION prsystem.fail_billing()')
        self.assertEqual(self.statement().json(),before);self.assertEqual(self.physical(),physical);self.assertEqual(self.billing().json()['history'],[])
        self.assert_status(self.correct(idempotency_key=key),201)

    def test_history_rls_and_no_update_delete_privileges(self):
        self.close();self.assert_status(self.correct(),201)
        for table in('minibar_billing_correction','minibar_billing_release','minibar_billing_reallocation'):
            with psycopg.connect(self.app_dsn) as conn:
                self.assertEqual(conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{}').format(sql.Identifier(table))).fetchone()[0],0)
                self.assertFalse(conn.execute("SELECT has_table_privilege(current_user,%s,'UPDATE') OR has_table_privilege(current_user,%s,'DELETE')",('prsystem.'+table,'prsystem.'+table)).fetchone()[0])
            with self.assertRaises(psycopg.errors.CheckViolation):
                with psycopg.connect(self.owner_dsn) as conn:conn.execute(sql.SQL('DELETE FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,))

    def test_deposit_funding_releases_allocated_counter_not_service_credit(self):
        self.close(deposit_minibar=6000);r=self.assert_status(self.correct(),201)
        self.assertEqual((r['balance']['allocated'],r['balance']['service_credit'],r['balance']['available']),(57000,0,3000))
        self.assertEqual(r['refundable_credits'][0]['receipt_id'],self.stay['deposit_receipt_id'])

    def test_mixed_funding_never_invents_or_loses_available_credit(self):
        self.close(deposit_minibar=3000);r=self.assert_status(self.correct(0),201)
        self.assertEqual((r['balance']['allocated'],r['balance']['service_credit'],r['balance']['available']),(57000,3000,6000))
        self.assertEqual(sum(x['amount_mnt'] for x in r['refundable_credits']),6000)

    def test_receipt_correction_cannot_rewrite_reallocated_history(self):
        self.close();r=self.assert_status(self.correct(),201);receipt=r['refundable_credits'][0]['receipt_id']
        self.assertEqual(self.command('cash-corrections',dict(receipt_id=receipt,replacement_amount_mnt=6000,reason='Буруу баримт',expected_revision=r['balance']['revision'],idempotency_key=uuid4().hex)).json()['code'],'CORRECTION_SOURCE_IN_USE')

    def test_bounded_history_and_closed_stay_list_keep_original_snapshots(self):
        self.close();self.assert_status(self.correct(),201);self.assert_status(self.correct(0),201)
        first=self.billing('?limit=1').json();second=self.billing('?after=1&limit=1').json()
        self.assertEqual((len(first['history']),first['next_after'],len(second['history']),second['next_after']),(1,1,1,None))
        rows=self.assert_status(self.api('minibar/billing-stays?limit=1',method='get'),200)
        self.assertEqual(rows['items'][0]['room_number'],'101');self.assertNotIn('guest',rows['items'][0])

    def test_later_room_replenishment_is_not_reversed_by_historical_correction(self):
        self.close();guest.MinibarGuestTests.configured(self);before=self.physical()
        self.assert_status(self.correct(0),201);self.assertEqual(self.physical(),before)
        self.assertEqual(guest.MinibarGuestTests.stocks(self)['room_quantity'],2)

    def test_precheckout_waiver_remains_zero_until_explicit_historical_rebill(self):
        self.assert_status(guest.MinibarGuestTests.review(self,'DISPUTE'),200)
        self.assert_status(guest.MinibarGuestTests.review(self,'WAIVE',self.manager_token),200)
        self.close();before=self.physical();basis=self.billing().json()['basis']
        self.assertEqual((basis['amount_mnt'],basis['items'][0]['quantity']),(0,0))
        r=self.assert_status(self.correct(1),201);self.assertEqual(r['new_receivable_mnt'],3000)
        self.assertEqual(self.physical(),before)
