import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4
from postgres_support import ADMIN_DSN
from reception_support import ReceptionCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.common import DomainError
    from prsystem.guest_identity import IdentityVault
    from prsystem.stays import StayService


from walkin_support import WalkInCase


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class WalkInStayTests(WalkInCase):
    def test_cleaning_producer_enforces_start_assignment_and_full_completion(self):
        self.assertEqual(self.checkin().json()['code'],'ROOM_NOT_READY')
        task=self.request_cleaning()
        self.assertEqual(self.post_cleaning(task).json()['code'],'CLEANING_NOT_STARTED')
        self.assert_status(self.start_cleaning(task,self.replacement_token),403)
        self.assert_status(self.start_cleaning(task),200)
        self.assertEqual(self.checkin().json()['code'],'ROOM_NOT_READY')
        self.assert_status(self.post_cleaning(task),200)
        result=self.assert_status(self.checkin(),201)
        self.assertEqual(result['amount_mnt'],15002)
        self.assertEqual(result['snapshot']['price']['source'],'HOTEL')
        self.assertEqual(result['shift_id'],self.shift)
        self.assertEqual(len(result['guest_access_code']),6)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT cleaning_state FROM prsystem.room_readiness_event WHERE tenant_id=%s ORDER BY sequence',(self.tenant,)).fetchall(),[('DIRTY',),('CLEANING',),('CLEAN',)])
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.cash_event WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_idempotency_encrypts_guest_and_replay_code_without_receipt_leak(self):
        self.ready();result=self.assert_status(self.checkin(),201)
        self.assertEqual(self.checkin().json(),result)
        self.assertEqual(self.checkin(duration_units=4).json()['code'],'IDEMPOTENCY_CONFLICT')
        with psycopg.connect(self.owner_dsn) as conn:
            envelope=conn.execute('SELECT envelope FROM prsystem.stay_guest_identity WHERE tenant_id=%s',(self.tenant,)).fetchone()[0]
            self.assertEqual(self.vault.open(envelope,self.tenant,result['stay_id'])['document_number'],'АБ90010211')
            receipt=conn.execute("SELECT command,result FROM prsystem.staff_command_receipt WHERE tenant_id=%s AND key='checkin'",(self.tenant,)).fetchone()
            self.assertNotIn('АБ90010211',str(receipt));self.assertNotIn('guest_access_code',receipt[1])
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.stay WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
            self.assertEqual(conn.execute('SELECT recorded_at FROM prsystem.identity_match_outbox WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],datetime.fromisoformat(result['check_in_recorded_at']))
        with psycopg.connect(self.app_dsn) as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute('SELECT * FROM prsystem.identity_match_outbox')

    def test_price_snapshot_survives_configuration_changes_and_sql_mutation(self):
        self.ready();result=self.assert_status(self.checkin(),201)
        self.assert_status(self.client.put(f'/hotels/{self.tenant}/rooms/settings',headers=self.headers(self.manager_token),json=dict(hourly_price=99999,nightly_price=90000,checkout_time='11:00',expected_revision=1,idempotency_key='reprice')),200)
        self.assertEqual(self.checkin().json(),result)
        with psycopg.connect(self.owner_dsn) as conn:
            for field,value in [('amount_mnt',1),('duration_units',4)]:
                with self.assertRaises(psycopg.errors.CheckViolation),conn.transaction():
                    conn.execute(sql.SQL('UPDATE prsystem.stay SET {}=%s WHERE tenant_id=%s').format(sql.Identifier(field)),(value,self.tenant))
                    # Each expected failure must roll back its savepoint.

    def test_server_rejects_client_authority_and_identifier_provenance(self):
        self.ready()
        for extra in (dict(amount_mnt=1),dict(paid=True),dict(snapshot={}),dict(shift_id=self.shift),dict(booking_id='invented'),dict(clean=True)):
            self.assert_status(self.checkin(**extra),422)
        bad=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211',provenance='XYP_VERIFIED')
        self.assert_status(self.checkin(guest=bad),422)

    def test_current_clean_does_not_prove_backdated_readiness(self):
        with psycopg.connect(self.owner_dsn) as conn:before=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        self.ready()
        self.assertEqual(self.checkin(actual_checkin_at=before.isoformat(),backdate_reason='Earlier arrival').json()['code'],'HISTORICAL_READINESS_REQUIRED')
        with psycopg.connect(self.owner_dsn) as conn:after=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        self.assert_status(self.client.put(f'/hotels/{self.tenant}/rooms/settings',headers=self.headers(self.manager_token),json=dict(hourly_price=22222,nightly_price=80000,checkout_time='12:00',expected_revision=1,idempotency_key='current-price')),200)
        result=self.assert_status(self.checkin(actual_checkin_at=after.isoformat(),backdate_reason='Correct arrival'),201)
        self.assertEqual(result['amount_mnt'],33333)
        self.assertLess(datetime.fromisoformat(result['actual_checkin_at']),datetime.fromisoformat(result['check_in_recorded_at']))

    def test_two_receptions_cannot_check_into_same_room(self):
        self.ready();self.open_shift(self.replacement_token,'second');barrier=Barrier(2)
        def go(token):barrier.wait();return self.checkin(token=token,idempotency_key=uuid4().hex)
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(go,[self.worker_token,self.replacement_token]))
        self.assertEqual(sorted(r.status_code for r in responses),[201,409])
        self.assertEqual(next(r.json()['code'] for r in responses if r.status_code==409),'ROOM_OCCUPIED')

    def test_active_stay_blocks_even_with_different_key_and_current_clean(self):
        self.ready();self.assert_status(self.checkin(),201)
        self.assertEqual(self.checkin(idempotency_key='second').json()['code'],'ROOM_OCCUPIED')

    def test_future_confirmed_reservation_enforces_cleaning_buffer(self):
        self.ready()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.room_reservation VALUES (%s,'booking',%s,clock_timestamp()+interval '100 minutes',clock_timestamp()+interval '1 day',30,'trusted-confirmed-booking','CONFIRMED')",(self.tenant,self.room))
        self.assertEqual(self.checkin().json()['code'],'RESERVATION_CONFLICT')
        self.assert_status(self.checkin(duration_units=1),201)

    def test_permissions_shift_expiry_security_and_cross_tenant(self):
        self.ready()
        for token in (self.manager_token,self.admin):self.assert_status(self.checkin(token=token),403)
        self.assertEqual(self.checkin(token=self.replacement_token).json()['code'],'OPEN_SHIFT_REQUIRED')
        self.assert_status(self.checkin(tenant=self.other),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=%s",(self.tenant,))
        self.assert_status(self.checkin(idempotency_key='within-grace'),201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=clock_timestamp()-interval '49 hours' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.checkin().json()['code'],'SUBSCRIPTION_EXPIRED')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.checkin().json()['code'],'SECURITY_SUSPENDED')

    def test_blocked_shift_prevents_new_checkin(self):
        self.ready()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.staff_open_work SET state='BLOCKED' WHERE tenant_id=%s AND kind='SHIFT'",(self.tenant,))
        self.assertEqual(self.checkin().json()['code'],'OPEN_SHIFT_REQUIRED')

    def test_manager_can_only_mark_clean_in_20000_package(self):
        body=dict(expected_revision=1,idempotency_key='manager-clean')
        path=f'/hotels/{self.tenant}/rooms/{self.room}/manager-clean'
        self.assert_status(self.client.post(path,headers=self.headers(self.manager_token),json=body),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=20000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.client.post(path,headers=self.headers(self.worker_token),json=body),403)
        self.assert_status(self.client.post(path,headers=self.headers(self.manager_token),json=body),200)
        self.assertIsNone(self.assert_status(self.checkin(),201)['guest_access_code'])

    def test_foreign_guest_never_enqueues_rd_exact_matching(self):
        self.ready()
        guest=dict(identity_type='FOREIGN_PASSPORT',family_name='Guest',given_name='Test',date_of_birth='1990-01-01',nationality='US',issuing_country='US',document_number='P123',expiry_date='2030-01-01')
        result=self.assert_status(self.checkin(guest=guest,kind='NIGHTLY',duration_units=1),201)
        self.assertEqual(result['amount_mnt'],80000)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.identity_match_outbox WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_failure_rolls_back_stay_identity_code_outbox_and_receipt(self):
        self.ready()
        with patch.object(StayService,'event',side_effect=DomainError('INVALID_REQUEST')):self.assert_status(self.checkin(),422)
        with psycopg.connect(self.owner_dsn) as conn:
            for table in ('stay','stay_guest_identity','stay_guest_code','identity_match_outbox'):
                self.assertEqual(conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,)).fetchone()[0],0)
        self.assert_status(self.checkin(),201)

    def test_missing_vault_fails_closed_without_plaintext_fallback(self):
        self.ready()
        with TestClient(create_app(self.app_dsn,self.settings)) as client:
            old=self.client;self.client=client
            try:self.assert_status(self.checkin(),503)
            finally:self.client=old

    def test_active_listing_has_no_guest_identifier_code_or_match_details(self):
        self.ready();self.assert_status(self.checkin(),201)
        response=self.client.get(f'/hotels/{self.tenant}/stays/active',headers=self.headers(self.worker_token))
        rows=self.assert_status(response,200);self.assertEqual(len(rows),1)
        self.assertNotIn('guest_access_code',rows[0]);self.assertNotIn('АБ90010211',response.text)
        self.assert_status(self.client.get(f'/hotels/{self.other}/stays/active',headers=self.headers(self.worker_token)),403)

    def test_started_cleaning_continuation_completes_the_same_room_source(self):
        task=self.request_cleaning();self.assert_status(self.start_cleaning(task),200)
        self.suspend()
        with psycopg.connect(self.owner_dsn) as conn:
            exception=conn.execute("""SELECT e.id FROM prsystem.staff_work_exception e JOIN prsystem.staff_open_work w
                ON (w.tenant_id,w.id)=(e.tenant_id,e.work_id) WHERE e.tenant_id=%s AND w.kind='CLEANING_TASK'""",(self.tenant,)).fetchone()[0]
        revision=self.claim(exception)
        response=self.client.post(f'/hotels/{self.tenant}/staff-work/exceptions/{exception}/cleaning/reassign',headers=self.headers(self.manager_token),json=dict(expected_revision=revision,replacement_id=self.replacement,idempotency_key='continue',reason='Continue room cleaning'))
        continued=self.assert_status(response,200)
        self.assertEqual(continued['mode'],'CONTINUATION')
        self.assertEqual(continued['source_id'],task['source_id'])
        continued['action_id']=task['action_id']
        self.assert_status(self.post_cleaning(continued,self.replacement_token),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT cleaning_state FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0],'CLEAN')

    def test_replay_never_resurrects_consumed_code_or_bypasses_current_auth(self):
        self.ready();result=self.assert_status(self.checkin(),201)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.stay_guest_code SET consumed_at=clock_timestamp() WHERE tenant_id=%s',(self.tenant,))
        replay=self.assert_status(self.checkin(),201)
        self.assertEqual(replay['stay_id'],result['stay_id']);self.assertIsNone(replay['guest_access_code'])
        self.suspend()
        self.assertEqual(self.checkin().status_code,401)

    def test_production_financial_gate_cannot_be_bypassed_by_mock_flag(self):
        with self.assertRaises(ValueError):
            create_app(self.app_dsn,self.settings,identity_vault=self.vault,mock_stay_finance=True)
        self.ready()
        with TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault)) as client:
            old=self.client;self.client=client
            try:self.assert_status(self.checkin(),503)
            finally:self.client=old
        response=self.checkin()
        result=self.assert_status(response,201)
        self.assertEqual(response.headers['X-PRsystem-Mode'],'MOCK_ONLY')
        self.assertEqual(result['snapshot']['financial_integration'],'DEFERRED_MOCK')
        self.assertEqual(result['deposit_mnt'],50000)

    def test_checkin_does_not_adopt_out_of_range_catalog_deposit(self):
        self.ready()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.room_category SET deposit=0 WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.checkin().json()['code'],'STAY_DEPOSIT_SETTINGS_REQUIRED')
