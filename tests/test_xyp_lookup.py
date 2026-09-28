"""ХУР lookup and check-in binding on real PostgreSQL through the API (RC-DEC-046)."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryDirectory
from threading import Barrier

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
