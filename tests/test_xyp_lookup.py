"""ХУР lookup and check-in binding on real PostgreSQL through the API (RC-DEC-046)."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryDirectory
from threading import Barrier, Event
from time import sleep
from unittest.mock import patch

from postgres_support import ADMIN_DSN
from walkin_support import WalkInCase
if ADMIN_DSN:
    import psycopg
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.mock_providers import MockStore, MockXypGateway


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class XypLookupTests(WalkInCase):
    def setUp(self):
        super().setUp()
        directory = TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.xyp = MockXypGateway(MockStore(directory.name + '/xyp.sqlite3', environment='test'))
        self.xyp.add_citizen('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02')
        self.client.close()
        self.client = TestClient(create_app(self.app_dsn, self.settings, identity_vault=self.vault, runtime_mode='test',
                                            mock_stay_finance=True, xyp_gateway=self.xyp), client=(self.peer, 12345))
        self.addCleanup(self.client.close)

    def lookup(self, number='АБ90010211', consent=True, key='lookup', token=None):
        return self.client.post(f'/hotels/{self.tenant}/guest-identity/xyp-lookups', headers=self.headers(token or self.worker_token),
                                json=dict(document_number=number, consent=consent, idempotency_key=key))

    def test_found_lookup_returns_citizen_and_stores_only_encrypted_evidence(self):
        result = self.assert_status(self.lookup(), 201)
        self.assertEqual((result['status'], result['citizen']),
                         ('FOUND', dict(family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-02', nationality='MN')))
        with psycopg.connect(self.owner_dsn) as conn:
            row = conn.execute('''SELECT actor_id,status,reason,lookup_token,envelope,consent_at<=created_at,expires_at-created_at
                FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s''', (self.tenant, result['lookup_id'])).fetchone()
            events = str(conn.execute("SELECT details FROM prsystem.operational_event WHERE tenant_id=%s AND kind='XYP_LOOKUP'", (self.tenant,)).fetchall())
            receipts = str(conn.execute('SELECT result FROM prsystem.staff_command_receipt WHERE tenant_id=%s', (self.tenant,)).fetchall())
        self.assertEqual(row[:3], (self.worker, 'FOUND', None))
        self.assertTrue(row[5]); self.assertEqual(row[6].total_seconds(), 900)
        for secret in ('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02'):
            self.assertNotIn(secret, row[3] + str(row[4]) + events + receipts)

    def test_not_found_and_unavailable_are_recorded_without_evidence(self):
        self.assertEqual(self.assert_status(self.lookup('АБ85020311', key='miss'), 201)['status'], 'NOT_FOUND')
        down = self.assert_status(self.lookup(MockXypGateway.OUTAGE, key='down'), 201)
        self.assertEqual((down['status'], 'citizen' in down), ('UNAVAILABLE', False))
        self.xyp.add_citizen('АБ88010111', 'Буруу', 'Огноо', '1988-01-02')
        self.assertEqual(self.assert_status(self.lookup('АБ88010111', key='bad'), 201)['status'], 'UNAVAILABLE')
        with psycopg.connect(self.owner_dsn) as conn:
            rows = conn.execute('SELECT status,reason,envelope FROM prsystem.xyp_lookup WHERE tenant_id=%s ORDER BY created_at', (self.tenant,)).fetchall()
        self.assertEqual(rows, [('NOT_FOUND', None, None), ('UNAVAILABLE', 'PROVIDER_ERROR', None), ('UNAVAILABLE', 'INVALID_EVIDENCE', None)])

    def test_consent_structure_and_permissions_are_checked_before_calling_xyp(self):
        self.assertEqual(self.lookup(consent=False).json()['code'], 'XYP_CONSENT_REQUIRED')
        self.assertEqual(self.lookup(consent=False).status_code, 422)
        self.assertEqual(self.lookup('AB90010211', key='latin').json()['code'], 'INVALID_GUEST_IDENTITY')
        _, cleaner = self.add_staff(['CLEANER'])
        for token in (cleaner, self.admin):
            self.assert_status(self.lookup(token=token, key='denied'), 403)
        self.assertEqual(self.xyp.calls, 0)

    def test_retry_replays_without_second_xyp_call_and_limit_applies(self):
        first = self.assert_status(self.lookup(), 201)
        self.assertEqual(self.assert_status(self.lookup(), 201), first)
        self.assertEqual(self.xyp.calls, 1)
        for index in range(19):
            self.assert_status(self.lookup(key=f'more-{index}'), 201)
        over = self.lookup(key='over')
        self.assertEqual((over.status_code, over.json()['code']), (429, 'XYP_LOOKUP_LIMIT'))
        self.assertEqual(self.xyp.calls, 20)

    def test_limit_holds_for_concurrent_lookups(self):
        for index in range(19):
            self.assert_status(self.lookup(key=f'seq-{index}'), 201)
        citizen = self.xyp.citizen
        def slow(number):
            sleep(0.5); return citizen(number)
        self.xyp.citizen = slow  # every request passes the first count before any row is stored
        barrier = Barrier(6)
        def attempt(index):
            barrier.wait(); return self.lookup(key=f'burst-{index}')
        with ThreadPoolExecutor(6) as pool:
            responses = list(pool.map(attempt, range(6)))
        self.assertEqual(sorted(r.status_code for r in responses), [201] + [429] * 5)
        self.assertEqual({r.json()['code'] for r in responses if r.status_code == 429}, {'XYP_LOOKUP_LIMIT'})
        with psycopg.connect(self.owner_dsn) as conn:
            stored = conn.execute('SELECT count(*) FROM prsystem.xyp_lookup WHERE tenant_id=%s', (self.tenant,)).fetchone()[0]
        self.assertEqual(stored, 20)

    def test_unconfigured_lookups_report_reason_and_skip_the_limit(self):
        with TestClient(create_app(self.app_dsn, self.settings, identity_vault=self.vault), client=(self.peer, 12345)) as client:
            def unconfigured(key):
                return client.post(f'/hotels/{self.tenant}/guest-identity/xyp-lookups', headers=self.headers(self.worker_token),
                                   json=dict(document_number='АБ90010211', consent=True, idempotency_key=key))
            first = self.assert_status(unconfigured('unconfigured-0'), 201)
            self.assertEqual((first['status'], first['reason']), ('UNAVAILABLE', 'NOT_CONFIGURED'))
            self.assertEqual(self.assert_status(unconfigured('unconfigured-0'), 201), first)
            for index in range(1, 25):
                self.assertEqual(self.assert_status(unconfigured(f'unconfigured-{index}'), 201)['reason'], 'NOT_CONFIGURED')
        self.assertNotIn('reason', self.assert_status(self.lookup(), 201))
        self.assertNotIn('reason', self.assert_status(self.lookup('АБ85020311', key='miss'), 201))
        down = self.assert_status(self.lookup(MockXypGateway.OUTAGE, key='down'), 201)
        self.assertEqual((down['status'], down['reason']), ('UNAVAILABLE', 'PROVIDER_ERROR'))

    def test_slow_adapter_times_out_and_its_late_answer_is_discarded(self):
        citizen, release = self.xyp.citizen, Event()
        def stuck(number):
            release.wait(5); return citizen(number)
        self.xyp.citizen = stuck
        with patch('prsystem.xyp_lookups.TIMEOUT_SECONDS', 0.2):
            result = self.assert_status(self.lookup(), 201)
        release.set()
        self.assertEqual((result['status'], result['reason'], 'citizen' in result), ('UNAVAILABLE', 'TIMEOUT', False))
        for _ in range(50):  # the abandoned adapter call finishes in the background
            if self.xyp.calls:
                break
            sleep(0.05)
        self.assertEqual(self.xyp.calls, 1)
        with psycopg.connect(self.owner_dsn) as conn:
            rows = conn.execute('SELECT status,reason,envelope FROM prsystem.xyp_lookup WHERE tenant_id=%s', (self.tenant,)).fetchall()
        self.assertEqual(rows, [('UNAVAILABLE', 'TIMEOUT', None)])

    def test_crashing_adapter_records_only_the_error_type(self):
        def crash(number):
            raise RuntimeError(f'register rejected {number}')
        self.xyp.citizen = crash
        self.assertEqual(self.assert_status(self.lookup(), 201)['reason'], 'PROVIDER_ERROR')
        with psycopg.connect(self.owner_dsn) as conn:
            details = conn.execute("SELECT details FROM prsystem.operational_event WHERE tenant_id=%s AND kind='XYP_LOOKUP'", (self.tenant,)).fetchone()[0]
        self.assertEqual(details, dict(status='UNAVAILABLE', reason='PROVIDER_ERROR', error='RuntimeError'))
        self.assertNotIn('АБ90010211', str(details))

    def test_unconfigured_production_adapter_reports_unavailable(self):
        with TestClient(create_app(self.app_dsn, self.settings, identity_vault=self.vault), client=(self.peer, 12345)) as client:
            response = client.post(f'/hotels/{self.tenant}/guest-identity/xyp-lookups', headers=self.headers(self.worker_token),
                                   json=dict(document_number='АБ90010211', consent=True, idempotency_key='prod'))
        self.assertEqual(self.assert_status(response, 201)['status'], 'UNAVAILABLE')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT reason FROM prsystem.xyp_lookup WHERE tenant_id=%s', (self.tenant,)).fetchone()[0], 'NOT_CONFIGURED')

    def test_lookup_rows_are_tenant_scoped_and_append_only(self):
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        with psycopg.connect(self.app_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.xyp_lookup').fetchone()[0], 0)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,false)", (self.tenant,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.xyp_lookup').fetchone()[0], 1)
        with psycopg.connect(self.owner_dsn) as conn, self.assertRaises(psycopg.errors.CheckViolation):
            conn.execute("UPDATE prsystem.xyp_lookup SET status='NOT_FOUND' WHERE id=%s", (lookup,))

    MANUAL = dict(family_name='Бат', given_name='Болд', date_of_birth='1985-02-03', nationality='MN', document_number='АБ85020311')

    def guest(self, lookup, **manual):
        return dict(identity_type='MN_REG_NO', xyp_lookup_id=lookup, **manual)

    def identity(self, stay):
        with psycopg.connect(self.owner_dsn) as conn:
            provenance, envelope = conn.execute('SELECT provenance,envelope FROM prsystem.stay_guest_identity WHERE tenant_id=%s AND stay_id=%s',
                                                (self.tenant, stay)).fetchone()
        return provenance, self.vault.open(envelope, self.tenant, stay)

    def second_room(self):
        room = self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms', headers=self.headers(self.manager_token),
            json=dict(number='102', floor='1', category_id=self.category, idempotency_key='room-102')), 201)['room_id']
        task = self.assert_status(self.client.post(f'/hotels/{self.tenant}/rooms/{room}/cleaning-requests', headers=self.headers(self.manager_token),
            json=dict(assignee_id=self.worker, expected_revision=1, idempotency_key='cleaning-102')), 201)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start', headers=self.headers(self.worker_token),
            json=dict(expected_revision=task['assignment_version'], idempotency_key='start-102')), 200)
        self.assert_status(self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/post', headers=self.headers(self.worker_token),
            json=dict(expected_revision=task['assignment_version'], action_id=task['action_id'], quantity=1, idempotency_key='clean-102')), 200)
        return room

    def test_found_lookup_checks_in_as_xyp_verified_and_locks_fields(self):
        self.ready()
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        self.assertEqual(self.checkin(guest=self.guest(lookup, family_name='Өөр'), idempotency_key='edited').json()['code'], 'XYP_VERIFIED_FIELDS_LOCKED')
        stay = self.assert_status(self.checkin(guest=self.guest(lookup)), 201)['stay_id']
        provenance, identity = self.identity(stay)
        self.assertEqual((provenance, identity['family_name'], identity['given_name'], identity['date_of_birth'], identity['nationality'], identity['document_number']),
                         ('XYP_VERIFIED', 'Туршилт', 'Зочин', '1990-01-02', 'MN', 'АБ90010211'))

    def test_manual_entry_only_for_the_failed_normalized_rd(self):
        self.ready()
        miss = self.assert_status(self.lookup(' аб85020311 ', key='miss'), 201)['lookup_id']
        other = dict(self.MANUAL, document_number='АБ90010211', date_of_birth='1990-01-02')
        self.assertEqual(self.checkin(guest=self.guest(miss, **other), idempotency_key='other').json()['code'], 'XYP_LOOKUP_MISMATCH')
        stay = self.assert_status(self.checkin(guest=self.guest(miss, **self.MANUAL)), 201)['stay_id']
        provenance, identity = self.identity(stay)
        self.assertEqual((provenance, identity['xyp_fallback']), ('MANUAL', dict(status='NOT_FOUND', reason=None)))

    def test_unavailable_lookup_allows_manual_entry_with_reason(self):
        self.ready(); self.xyp.set_available(False)
        down = self.assert_status(self.lookup('АБ85020311', key='down'), 201)['lookup_id']
        stay = self.assert_status(self.checkin(guest=self.guest(down, **self.MANUAL)), 201)['stay_id']
        self.assertEqual(self.identity(stay)[1]['xyp_fallback'], dict(status='UNAVAILABLE', reason='PROVIDER_ERROR'))

    def test_lookup_is_required_known_unexpired_and_mn_only(self):
        self.ready()
        # Posted directly: the WalkInCase.checkin helper would add a lookup on its own.
        none = self.client.post(f'/hotels/{self.tenant}/stays/check-in', headers=self.headers(self.worker_token), json=dict(
            room_id=self.room, kind='HOURLY', duration_units=3, guest=dict(self.MANUAL, identity_type='MN_REG_NO'), idempotency_key='none'))
        self.assertEqual(none.json()['code'], 'XYP_LOOKUP_REQUIRED')
        missing = self.checkin(guest=self.guest('0' * 32), idempotency_key='missing')
        self.assertEqual((missing.status_code, missing.json()['code']), (404, 'XYP_LOOKUP_NOT_FOUND'))
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        passport = dict(identity_type='FOREIGN_PASSPORT', family_name='Test', given_name='Guest', date_of_birth='2000-09-08', nationality='US',
                        document_number='P123', issuing_country='US', expiry_date='2030-01-01', xyp_lookup_id=lookup)
        self.assertEqual(self.checkin(guest=passport, idempotency_key='passport').json()['code'], 'INVALID_GUEST_IDENTITY')
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('ALTER TABLE prsystem.xyp_lookup DISABLE TRIGGER xyp_lookup_guard')
            conn.execute("UPDATE prsystem.xyp_lookup SET created_at=created_at-interval '16 minutes',consent_at=consent_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' WHERE id=%s", (lookup,))
            conn.execute('ALTER TABLE prsystem.xyp_lookup ENABLE TRIGGER xyp_lookup_guard')
        late = self.checkin(guest=self.guest(lookup), idempotency_key='late')
        self.assertEqual((late.status_code, late.json()['code']), (409, 'XYP_LOOKUP_EXPIRED'))

    def test_lookup_is_single_use_and_replay_returns_the_first_result(self):
        self.ready(); room = self.second_room()
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        first = self.assert_status(self.checkin(guest=self.guest(lookup)), 201)
        self.assertEqual(self.assert_status(self.checkin(guest=self.guest(lookup)), 201), first)
        used = self.checkin(room_id=room, guest=self.guest(lookup), idempotency_key='second')
        self.assertEqual((used.status_code, used.json()['code']), (409, 'XYP_LOOKUP_USED'))

    def test_concurrent_checkins_with_one_lookup_have_one_winner(self):
        self.ready(); room = self.second_room()
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        barrier = Barrier(2)
        def attempt(args):
            room_id, key = args; barrier.wait()
            return self.checkin(room_id=room_id, guest=self.guest(lookup), idempotency_key=key)
        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(attempt, [(self.room, 'a'), (room, 'b')]))
        self.assertEqual(sorted(r.status_code for r in responses), [201, 409])
        self.assertEqual(next(r for r in responses if r.status_code == 409).json()['code'], 'XYP_LOOKUP_USED')

    def test_failed_checkin_leaves_the_lookup_usable(self):
        lookup = self.assert_status(self.lookup(), 201)['lookup_id']
        self.assertEqual(self.checkin(guest=self.guest(lookup), idempotency_key='dirty').json()['code'], 'ROOM_NOT_READY')
        self.ready()
        self.assert_status(self.checkin(guest=self.guest(lookup)), 201)

    def test_xyp_birth_date_applies_the_adult_rule(self):
        self.ready(); self.xyp.add_citizen('АБ15210211', 'Бага', 'Хүүхэд', '2015-01-02')
        lookup = self.assert_status(self.lookup('АБ15210211'), 201)['lookup_id']
        self.assertEqual(self.checkin(guest=self.guest(lookup)).json()['code'], 'GUEST_UNDER_18')
