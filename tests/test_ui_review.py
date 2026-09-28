"""Real database acceptance for the local human-review launcher."""
import os
import unittest
from unittest.mock import patch
from uuid import uuid4
from postgres_support import ADMIN_DSN
try:
    import psycopg
    from scripts.ui_review import require_local_database
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'Optional PostgreSQL dependency is not installed')
class UIReviewBoundaryTests(unittest.TestCase):
    def test_review_database_rejects_remote_ambiguous_and_existing_application_targets(self):
        with patch.dict(os.environ, {}, clear=True):
            for dsn in ('postgresql://u:p@127.0.0.1/postgres', 'postgresql://u:p@localhost:5432/postgres'):
                self.assertEqual(require_local_database(dsn), dsn)
            for dsn in ('postgresql://u:p@production.example/postgres',
                        'postgresql://u:p@127.0.0.1/production', 'dbname=postgres',
                        'host=127.0.0.1 hostaddr=192.0.2.1 dbname=postgres',
                        'host=127.0.0.1,localhost dbname=postgres',
                        'host=localhost dbname=postgres service=live'):
                with self.subTest(dsn=dsn), self.assertRaises(ValueError):
                    require_local_database(dsn)
            with patch.dict(os.environ, {'PGHOSTADDR': '192.0.2.1'}), self.assertRaises(ValueError):
                require_local_database('postgresql://u:p@localhost/postgres')


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class UIReviewDatabaseTests(unittest.TestCase):
    def test_real_review_roles_room_workflow_profile_and_cleanup(self):
        from ui_review_support import review_session
        with review_session(ADMIN_DSN) as session:
            session.verify()
            fixture = session.fixture
            database, role = fixture.database, fixture.role
            root = f'/hotels/{session.tenant}/'
            cleaner = session.login('Цэвэрлэгч')
            reception = session.login('Ресепшн')
            manager = session.login('Менежер')
            client = session.client
            self.assertEqual(client.get('/reception', headers={'Host':'untrusted.example'}).status_code, 400)
            self.assertEqual(client.post('/auth/login', headers={'Origin':'https://untrusted.example'}, json={}).status_code, 403)
            with psycopg.connect(fixture.app_dsn) as conn:
                self.assertEqual(conn.execute('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user').fetchone(), (False, False))
            self.assertEqual(client.get(root+'rooms', headers=cleaner).status_code, 403)
            data = fixture.assert_status(client.get(root+'operations', headers=cleaner), 200)
            self.assertEqual([(r['room_number'],r['floor']) for r in data['cleaning']], [('201','2')])
            task = session.cleaning_task
            for suffix, values in [('start', {}), ('post', dict(action_id=task['action_id'],quantity=1))]:
                fixture.assert_status(client.post(root+f'cleaning/tasks/{task["task_id"]}/'+suffix, headers=cleaner,
                    json=dict(expected_revision=task['assignment_version'],idempotency_key=uuid4().hex,**values)), 200)
            self.assertEqual(client.get(root+'operations',headers=cleaner).json()['cleaning'], [])
            # Walk-in -> deposit allocation -> collection -> checkout -> Cleaner claim.
            lookup = fixture.assert_status(client.post(root+'guest-identity/xyp-lookups', headers=reception,
                json=dict(document_number='АБ90010211', consent=True, idempotency_key=uuid4().hex)), 201)
            stay = fixture.assert_status(client.post(root+'stays/check-in', headers=reception, json=dict(
                room_id=fixture.room, kind='NIGHTLY', duration_units=1,
                guest=dict(identity_type='MN_REG_NO',xyp_lookup_id=lookup['lookup_id'],family_name='Туршилт',given_name='Зочин',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),
                deposit=dict(channel='CASH',amount_mnt=60000,received=True),idempotency_key=uuid4().hex)), 201)
            stay_url = root+'stays/'+stay['stay_id']+'/'
            fixture.assert_status(client.post(stay_url+'deposit-allocations',headers=reception,json=dict(
                receipt_id=stay['deposit_receipt_id'],charge_id=stay['room_charge_id'],amount_mnt=60000,expected_revision=1,idempotency_key=uuid4().hex)),201)
            fixture.assert_status(client.post(stay_url+'cash-receipts',headers=reception,json=dict(
                channel='CASH',received=True,purpose='PAYMENT',charge_id=stay['room_charge_id'],amount_mnt=20000,expected_revision=2,idempotency_key=uuid4().hex)),201)
            fixture.assert_status(client.post(stay_url+'checkout',headers=reception,json=dict(expected_revision=3,idempotency_key=uuid4().hex)),200)
            queue=fixture.assert_status(client.get(root+'cleaning/checkouts',headers=cleaner),200)
            self.assertEqual(queue[0]['room_number'],'101')
            fixture.assert_status(client.post(stay_url+'checkout-cleaning/claim',headers=cleaner,json=dict(idempotency_key=uuid4().hex)),201)
            settings=fixture.assert_status(client.get(root+'booking-settings',headers=manager),200)
            profile=settings['profile'];photos=profile['photos']
            profile['description']='UI туршилтын засвар'
            profile['expected_revision']=profile.pop('revision');profile['idempotency_key']=uuid4().hex
            fixture.assert_status(client.put(root+'booking-profile',headers=manager,json=profile),200)
            self.assertEqual(client.get(root+'booking-settings',headers=manager).json()['profile']['photos'],photos)
        # The session removes only its own generated resources on normal exit.
        with psycopg.connect(ADMIN_DSN) as conn:
            self.assertIsNone(conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(database,)).fetchone())
            self.assertIsNone(conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(role,)).fetchone())
