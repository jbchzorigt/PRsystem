import unittest
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class ReceptionDependencyTests(GuestFinanceCase):
    def mock(self):
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test'));self.addCleanup(self.client.close)

    def minibar(self):
        self.mock()
        with psycopg.connect(self.owner_dsn) as conn:revision=conn.execute('SELECT revision FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0]
        self.assert_status(self.client.put(f'/hotels/{self.tenant}/mock/rooms/{self.room}/minibar',headers=self.headers(self.manager_token),json=dict(items=[dict(product_id='water',name='Ус',unit_price=3000,opening_quantity=2)],expected_revision=revision,idempotency_key='minibar')),200)
        self.start()

    def report(self,used=1,revision=0,key='report'):
        return self.client.post(f'/hotels/{self.tenant}/mock/stays/{self.stay["stay_id"]}/minibar-report',headers=self.headers(self.worker_token),json=dict(used={'water':used},no_consumption=used==0,expected_revision=revision,idempotency_key=key))

    def begin(self):return self.command('checkout/initiate',dict(idempotency_key='begin'))

    def settle_room(self):
        revision=self.statement().json()['balance']['revision']
        self.assert_status(self.allocate(60000,revision=revision),201)
        self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=20000,charge_id=self.stay['room_charge_id'],expected_revision=revision+1,idempotency_key='room-payment')),201)

    def test_minibar_report_gates_checkout_and_refill_gates_clean_room(self):
        self.minibar();self.assert_status(self.begin(),200)
        self.assertEqual(self.command('checkout',dict(expected_revision=1,idempotency_key='early')).json()['code'],'MINIBAR_REPORT_REQUIRED')
        report=self.assert_status(self.report(),201)
        self.settle_room()
        revision=self.statement().json()['balance']['revision']
        self.assert_status(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=3000,charge_id=report['charge_id'],expected_revision=revision,idempotency_key='minibar-pay')),201)
        self.assert_status(self.command('checkout',dict(expected_revision=revision+1,idempotency_key='checkout')),200)
        task=self.assert_status(self.command('checkout-cleaning/claim',dict(idempotency_key='claim')),201)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start',headers=self.headers(self.worker_token),json=dict(expected_revision=0,idempotency_key='start-checkout')),200)
        result=self.assert_status(self.post_cleaning(task,key='clean-checkout'),200);self.assertEqual(result['state'],'OPEN')
        with psycopg.connect(self.owner_dsn) as conn:action=conn.execute("SELECT id FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s AND kind='REFILL'",(self.tenant,task['source_id'])).fetchone()[0]
        task['action_id']=action
        self.assertEqual(self.assert_status(self.post_cleaning(task,key='refill'),200)['state'],'DONE')

    def test_returned_report_creates_new_version_and_dispute_requires_manager(self):
        self.minibar();self.begin();self.assert_status(self.report(),201)
        self.assert_status(self.command('minibar-review',dict(action='RETURN',reason='Please recount water',idempotency_key='return')),200)
        second=self.assert_status(self.report(2,revision=1,key='second-report'),201)
        self.assertEqual(self.statement().json()['charge_total_mnt'],86000)
        self.assert_status(self.command('minibar-review',dict(action='DISPUTE',reason='Guest disputes usage',idempotency_key='dispute')),200)
        self.assertEqual(self.command('cash-receipts',dict(channel='CASH',received=True,purpose='PAYMENT',amount_mnt=6000,charge_id=second['charge_id'],expected_revision=5,idempotency_key='pay')).json()['code'],'MINIBAR_REPORT_REQUIRED')
        self.assert_status(self.command('minibar-review',dict(action='WAIVE',reason='Hotel accepts disputed charge',idempotency_key='waive'),self.admin),403)
        self.assert_status(self.command('minibar-review',dict(action='WAIVE',reason='Hotel accepts disputed charge',idempotency_key='waive'),self.manager_token),200)
        self.assertEqual(self.statement().json()['charge_total_mnt'],80000)

    def test_checkout_initiation_blocks_time_amendments(self):
        self.start();self.assert_status(self.begin(),200)
        self.assertEqual(self.command('time-amendments',dict(actual_checkin_at=self.stay['actual_checkin_at'],reason='Arrival evidence',idempotency_key='amend')).json()['code'],'WORK_NOT_OPEN')

    def test_unfinished_restaurant_requires_exact_ack_but_never_changes_hotel_cash(self):
        self.mock();self.start();self.settle_room();before=self.drawer()
        url=f'/hotels/{self.tenant}/mock/stays/{self.stay["stay_id"]}/restaurant-orders'
        order=self.assert_status(self.client.post(url,headers=self.headers(self.manager_token),json=dict(restaurant_name='Талын амт',contact_phone='99112233',state='PREPARING',reason='Mock order',idempotency_key='order')),201)['order_id']
        self.assertEqual(self.command('checkout',dict(expected_revision=3,idempotency_key='checkout')).json()['code'],'RESTAURANT_ACK_REQUIRED')
        self.assert_status(self.command('checkout',dict(expected_revision=3,idempotency_key='checkout',guest_informed=True,restaurant_choices=[dict(order_id=order,choice='RECEPTION_PICKUP')])),200)
        self.assertEqual(self.drawer(),before)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT choice FROM prsystem.restaurant_checkout_outbox WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'RECEPTION_PICKUP')
