import unittest
from datetime import datetime,timezone
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from prsystem.cash import SpendCash,CashContext
    from prsystem.postgres.cash import PostgresCash
    from prsystem.common import DomainError


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class HandoverLifecycleTests(GuestFinanceCase):
    def submit(self,actual=0,receiver=None,token=None,key='submit',**extra):
        body=dict(actual=actual,receiver_id=receiver or self.replacement,reason='End of shift; receiver available',idempotency_key=key);body.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/handovers',headers=self.headers(token or self.worker_token),json=body)

    def count(self,handover,actual=0,key='count',token=None):
        return self.client.post(f'/hotels/{self.tenant}/handovers/{handover}/counts',headers=self.headers(token or self.replacement_token),json=dict(actual=actual,idempotency_key=key))

    def accept(self,handover,count=None,accept=True,token=None,key='accept'):
        return self.client.post(f'/hotels/{self.tenant}/handovers/{handover}/decision',headers=self.headers(token or self.replacement_token),json=dict(accept=accept,count_id=count,reason='Both parties completed physical recount',idempotency_key=key))

    def test_handover_blind_counts_freezes_sales_and_opens_actual_before_review(self):
        self.start();handover=self.assert_status(self.submit(60000),201)['handover_id']
        inbox=self.client.get(f'/hotels/{self.tenant}/handovers',headers=self.headers(self.replacement_token)).json()
        self.assertNotIn('expected',inbox[0]);self.assertNotIn('sender_actual',inbox[0])
        self.assertEqual(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=1,charge_id=self.stay['room_charge_id'],expected_revision=1,idempotency_key='frozen')).json()['code'],'OPEN_SHIFT_REQUIRED')
        count=self.assert_status(self.count(handover,60000),201)['count_id']
        result=self.assert_status(self.accept(handover,count),200)
        self.assertEqual(result['review_state'],'MANAGER_REQUIRED');self.assertIsNotNone(result['new_shift_id'])
        self.assertEqual(self.accept(handover,count).json(),result)
        self.assert_status(self.accept(handover,accept=False,key='return'),409)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT state FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,self.shift)).fetchone()[0],'CLOSED')
            self.assertEqual(conn.execute('SELECT opening_actual FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(self.tenant,result['new_shift_id'])).fetchone()[0],60000)

    def test_mismatch_requires_recount_and_preserves_dispute(self):
        handover=self.assert_status(self.submit(0),201)['handover_id']
        count=self.assert_status(self.count(handover,100),201)['count_id']
        self.assertEqual(self.accept(handover,count).json()['code'],'RECOUNT_REQUIRED')
        count=self.assert_status(self.count(handover,100,key='recount'),201)['count_id']
        result=self.assert_status(self.accept(handover,count),200)
        self.assertEqual((result['closing_actual'],result['variance'],result['review_state']),(100,100,'DISPUTED'))

    def test_return_before_accept_unfreezes_original_and_preserves_submission(self):
        handover=self.assert_status(self.submit(),201)['handover_id']
        self.assert_status(self.accept(handover,accept=False),200)
        self.assert_status(self.submit(key='resubmit'),201)
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.shift_handover SET sender_actual=5 WHERE tenant_id=%s AND id=%s',(self.tenant,handover))

    def test_manager_custody_does_not_grant_reception_and_can_handoff_later(self):
        handover=self.assert_status(self.submit(receiver=self.manager),201)['handover_id']
        count=self.assert_status(self.count(handover,token=self.manager_token),201)['count_id']
        closed=self.assert_status(self.accept(handover,count,token=self.manager_token),200)
        self.assertIsNone(closed['new_shift_id']);self.assertIsNotNone(closed['custody_id'])
        next_handover=self.assert_status(self.submit(receiver=self.replacement,token=self.manager_token,key='custody',custody_id=closed['custody_id']),201)['handover_id']
        count=self.assert_status(self.count(next_handover,key='next-count'),201)['count_id']
        opened=self.assert_status(self.accept(next_handover,count,key='next-accept'),200)
        self.assertIsNotNone(opened['new_shift_id'])

    def test_self_close_requires_admin_policy_and_multiple_roles(self):
        self.assert_status(self.submit(receiver=self.worker,self_close=True),403)
        self.assert_status(self.client.put(f'/hotels/{self.tenant}/shifts/policy',headers=self.headers(self.admin),json=dict(single_worker=True,expected_revision=0,idempotency_key='policy')),200)
        self.assert_status(self.submit(receiver=self.worker,self_close=True),403)
        actor,token=self.add_staff(['MANAGER','RECEPTION']);self.open_shift(token,'solo')
        result=self.assert_status(self.submit(receiver=actor,token=token,key='solo-close',self_close=True),201)
        self.assertEqual(result['review_state'],'NOT_REQUIRED');self.assertIsNotNone(result['new_shift_id'])

    def test_pending_refund_blocks_handover(self):
        self.start();self.assert_status(self.reserve(10000),201)
        self.assertEqual(self.submit(60000).json()['code'],'PENDING_SHIFT_OBLIGATIONS')

    def lifecycle(self,kind,entity,action,revision,token=None,key='lifecycle',**extra):
        path='rooms' if kind=='room' else 'room-categories'
        body=dict(action=action,expected_revision=revision,reason='Planned room retirement',idempotency_key=key);body.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/{path}/{entity}/lifecycle',headers=self.headers(token or self.manager_token),json=body)

    def room_revision(self):
        with psycopg.connect(self.owner_dsn) as conn:return conn.execute('SELECT revision FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0]

    def test_room_retirement_waits_for_stay_and_final_cleaning(self):
        self.start();result=self.assert_status(self.lifecycle('room',self.room,'DEACTIVATE',self.room_revision()),200)
        self.assertEqual(result['status'],'RETIRING');self.assertIn('ACTIVE_STAY',result['blockers'])
        self.assert_status(self.allocate(60000),201)
        self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=20000,charge_id=self.stay['room_charge_id'],expected_revision=2,idempotency_key='payment')),201)
        self.assert_status(self.command('checkout',dict(expected_revision=3,idempotency_key='checkout')),200)
        task=self.assert_status(self.command('checkout-cleaning/claim',dict(idempotency_key='claim')),201)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start',headers=self.headers(self.worker_token),json=dict(expected_revision=0,idempotency_key='start-checkout')),200)
        self.assert_status(self.post_cleaning(task,key='finish-checkout'),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT status FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0],'INACTIVE')
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.room_lifecycle_completion WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_category_retirement_blocks_checkin_and_finishes_with_last_room(self):
        result=self.assert_status(self.lifecycle('category',self.category,'DEACTIVATE',1),200)
        self.assertEqual(result['status'],'RETIRING')
        self.assertEqual(self.checkin(deposit=dict(channel='CASH',amount_mnt=60000,received=True)).json()['code'],'ROOM_NOT_READY')
        self.assert_status(self.lifecycle('room',self.room,'DEACTIVATE',self.room_revision(),key='room-off'),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT status FROM prsystem.room_category WHERE tenant_id=%s AND id=%s',(self.tenant,self.category)).fetchone()[0],'INACTIVE')

    def test_lifecycle_roles_cas_and_reactivation(self):
        revision=self.room_revision()
        for token in (self.admin,self.worker_token):self.assert_status(self.lifecycle('room',self.room,'DEACTIVATE',revision,token),403)
        self.assert_status(self.lifecycle('room',self.room,'DEACTIVATE',revision+1),409)
        off=self.assert_status(self.lifecycle('room',self.room,'DEACTIVATE',revision),200)
        self.assertEqual(off['status'],'INACTIVE')
        on=self.assert_status(self.lifecycle('room',self.room,'REACTIVATE',off['revision'],key='on'),200)
        self.assertEqual(on['status'],'ACTIVE')
