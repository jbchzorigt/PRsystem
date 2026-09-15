import unittest
from datetime import datetime,timedelta,timezone
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class ReceptionBookingTests(GuestFinanceCase):
    def mock_app(self):
        self.client.close();self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test'))
        self.addCleanup(self.client.close)

    def booking(self,arrival=None):
        return self.client.post(f'/hotels/{self.tenant}/mock/bookings',headers=self.headers(self.manager_token),json=dict(room_id=self.room,kind='NIGHTLY',duration_units=1,planned_checkin_at=arrival or datetime.now(timezone.utc).isoformat(),idempotency_key='booking'))

    def arrive(self,booking,**extra):
        body=dict(guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key='arrive');body.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/bookings/{booking}/check-in',headers=self.headers(self.worker_token),json=body)

    def test_mock_booking_paid_exemption_snapshot_checkout_without_cash(self):
        self.mock_app();booking=self.assert_status(self.booking(),201);cash=self.drawer()
        self.stay=self.assert_status(self.arrive(booking['booking_id']),201)
        self.assertEqual(self.arrive(booking['booking_id']).json(),self.stay)
        self.assertEqual((self.stay['deposit_mnt'],self.stay['amount_mnt']),(0,80000))
        self.assertEqual(datetime.fromisoformat(self.stay['planned_checkout_at']),datetime.fromisoformat(booking['planned_checkout_at']))
        self.assert_status(self.command('checkout',dict(expected_revision=1,idempotency_key='checkout')),200)
        self.assertEqual(self.drawer(),cash)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT origin FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'ONLINE')
            self.assertEqual(conn.execute('SELECT state FROM prsystem.room_reservation WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],'CONSUMED')

    def test_production_cannot_simulate_booking_or_accept_client_payment(self):
        self.assert_status(self.booking(),503)
        self.mock_app();booking=self.assert_status(self.booking(),201)
        self.assert_status(self.arrive(booking['booking_id'],paid=True),422)

    def test_confirmed_reservation_blocks_walkin_and_early_arrival(self):
        self.mock_app();booking=self.assert_status(self.booking((datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()),201)
        self.assertEqual(self.checkin(kind='NIGHTLY',duration_units=1,deposit=dict(channel='CASH',amount_mnt=60000,received=True)).json()['code'],'RESERVATION_CONFLICT')
        self.assertEqual(self.arrive(booking['booking_id']).json()['code'],'ACTUAL_TIME_OUT_OF_RANGE')
