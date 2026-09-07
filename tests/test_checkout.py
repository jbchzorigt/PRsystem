import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from prsystem.checkout import CheckoutService
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class CheckoutTests(GuestFinanceCase):
    def settle(self):
        self.assert_status(self.allocate(60000),201)
        return self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=20000,
            charge_id=self.stay['room_charge_id'],expected_revision=2,idempotency_key='payment')),201)

    def close(self,revision=3,key='checkout',token=None,**extra):
        body=dict(expected_revision=revision,idempotency_key=key);body.update(extra)
        return self.command('checkout',body,token)

    def claim(self,token=None,key='claim'):
        return self.command('checkout-cleaning/claim',dict(idempotency_key=key),token)

    def test_settled_checkout_preserves_price_end_and_cash_and_revokes_codes(self):
        self.start();self.settle();before=self.drawer();result=self.assert_status(self.close(),200)
        self.assertEqual(self.close().json(),result)
        self.assertEqual(result['planned_checkout_at'],self.stay['planned_checkout_at'])
        self.assertEqual(self.drawer(),before)
        self.assertEqual(result['cleaning_state'],'DIRTY')
        self.assertEqual(datetime.fromisoformat(result['earliest_ready_at'])-datetime.fromisoformat(result['actual_checkout_at']),timedelta(minutes=30))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state,amount_mnt FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(self.tenant,self.stay['stay_id'])).fetchone(),('CLOSED',80000))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay_guest_code WHERE tenant_id=%s AND revoked_at IS NULL',(self.tenant,)).fetchone()[0],0)
            row=conn.execute('SELECT retention_policy_version,retention_days,retention_expires_at-recorded_at FROM prsystem.stay_checkout WHERE tenant_id=%s',(self.tenant,)).fetchone()
            self.assertEqual(row,('MVP-365-v1',365,timedelta(days=365)))
        self.assertEqual(self.close(revision=4,key='again').json()['code'],'WORK_NOT_OPEN')

    def test_unpaid_charge_unused_deposit_pending_refund_and_correction_block_checkout(self):
        self.start();self.assertEqual(self.close(revision=1).json()['code'],'CHECKOUT_FINANCE_PENDING')
        correction=self.assert_status(self.command('cash-corrections',dict(receipt_id=self.stay['deposit_receipt_id'],replacement_amount_mnt=50000,
            reason='Verify amount',expected_revision=1,idempotency_key='correction')),201)['correction_id']
        self.assertEqual(self.close(revision=2).json()['code'],'CHECKOUT_FINANCE_PENDING')
        self.assert_status(self.command('cash-corrections/'+correction+'/decision',dict(approve=False,reason='Original correct',expected_revision=2,idempotency_key='reject'),self.manager_token),200)
        refund=self.assert_status(self.reserve(60000,revision=3),201)['refund_id']
        self.assertEqual(self.close(revision=4).json()['code'],'CHECKOUT_FINANCE_PENDING')
        self.assert_status(self.refund_finish(refund,revision=4),200)
        self.assertEqual(self.close(revision=5).json()['code'],'CHECKOUT_FINANCE_PENDING')
        self.assertEqual(self.drawer(),(0,0))

    def test_cleaner_claim_is_atomic_and_completion_keeps_buffer_gate(self):
        self.start();self.settle();closed=self.assert_status(self.close(),200)
        task=self.assert_status(self.claim(),201);self.assertEqual(self.claim().json(),task)
        self.assertEqual(task['source_id'],closed['cleaning_source_id'])
        self.assert_status(self.claim(self.replacement_token,key='other'),409)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start',headers=self.headers(self.worker_token),json=dict(expected_revision=0,idempotency_key='checkout-clean-start')),200)
        self.assert_status(self.post_cleaning(task,key='checkout-clean-post'),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT cleaning_state FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0],'CLEAN')
        # The actual checkout's original 30-minute buffer still prevents reuse.
        response=self.checkin(idempotency_key='next',deposit=dict(channel='CASH',amount_mnt=60000,received=True))
        self.assertEqual(response.json()['code'],'ROOM_OCCUPIED')
        self.assertEqual(self.drawer(),(80000,0))

    def test_concurrent_cleaner_claim_has_one_owner(self):
        self.start();self.settle();self.close();barrier=Barrier(2)
        def claim(token):
            barrier.wait();return self.claim(token,key='claim-'+token[:8])
        with ThreadPoolExecutor(max_workers=2) as pool:responses=list(pool.map(claim,[self.worker_token,self.replacement_token]))
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('''SELECT count(*) FROM prsystem.cleaning_task t JOIN prsystem.stay_checkout c
                ON (c.tenant_id,c.cleaning_source_id)=(t.tenant_id,t.source_id) WHERE c.tenant_id=%s''',(self.tenant,)).fetchone()[0],1)

    def test_checkout_and_cleaning_complete_prelock_stay_after_subscription_lock(self):
        self.start();self.settle()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at=%s::timestamptz-interval '48 hours'+interval '1 millisecond' WHERE tenant_id=%s",(self.stay['check_in_recorded_at'],self.tenant))
        self.assert_status(self.close(),200)
        task=self.assert_status(self.claim(),201)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start',headers=self.headers(self.worker_token),json=dict(expected_revision=0,idempotency_key='expired-start')),200)
        self.assert_status(self.post_cleaning(task,key='expired-post'),200)
        self.assertEqual(self.drawer(),(80000,0))

    def test_checkout_failure_rolls_back_room_finance_source_retention_and_access(self):
        self.start();self.settle()
        with patch.object(CheckoutService,'save',side_effect=DomainError('INVALID_REQUEST')):
            self.assert_status(self.close(),422)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(self.tenant,self.stay['stay_id'])).fetchone()[0],'ACTIVE')
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay_checkout WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.cleaning_source WHERE tenant_id=%s AND source_kind='CHECKOUT'",(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay_guest_code WHERE tenant_id=%s AND revoked_at IS NULL',(self.tenant,)).fetchone()[0],1)
        self.assert_status(self.close(),200)

    def test_checkout_authorization_and_client_time_cannot_override_sources(self):
        self.start();self.settle()
        for token in (self.admin,self.manager_token):self.assert_status(self.close(token=token),403)
        self.assert_status(self.close(actual_checkout_at=datetime.now(timezone.utc).isoformat()),422)
        self.assert_status(self.close(expected_revision=2),409)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.close().json()['code'],'SECURITY_SUSPENDED')

    def test_checkout_and_original_stay_history_are_immutable(self):
        self.start();self.settle();self.close()
        for query in ('UPDATE prsystem.stay_checkout SET retention_days=1 WHERE tenant_id=%s',
                      'DELETE FROM prsystem.stay_checkout WHERE tenant_id=%s',
                      "UPDATE prsystem.stay SET state='ACTIVE',actual_checkout_at=NULL WHERE tenant_id=%s"):
            with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:conn.execute(query,(self.tenant,))

    def test_cleaner_queue_exposes_only_unclaimed_or_own_checkout_work(self):
        self.start();self.settle();closed=self.assert_status(self.close(),200)
        url=f'/hotels/{self.tenant}/cleaning/checkouts'
        rows=self.assert_status(self.client.get(url,headers=self.headers(self.worker_token)),200)
        self.assertEqual(rows[0]['source_id'],closed['cleaning_source_id'])
        self.assertIsNone(rows[0]['task_id'])
        task=self.assert_status(self.claim(),201)
        own=self.assert_status(self.client.get(url,headers=self.headers(self.worker_token)),200)
        self.assertEqual(own[0]['task_id'],task['task_id'])
        self.assertEqual(self.client.get(url,headers=self.headers(self.replacement_token)).json(),[])
        self.assert_status(self.client.get(url,headers=self.headers(self.admin)),403)
