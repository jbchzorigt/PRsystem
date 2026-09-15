"""Disposable human-review session, reusing the restricted-role test grants."""
from contextlib import contextmanager
from dataclasses import dataclass
import secrets
from uuid import uuid4


@dataclass
class ReviewSession:
    fixture: object
    app: object
    client: object
    tenant: str
    accounts: dict
    password: str
    cleaning_task: dict

    def login(self, role):
        response = self.client.post('/auth/login', json=dict(tenant_id=self.tenant,
            email=self.accounts[role], password=self.password))
        self.fixture.assert_status(response, 200)
        return {'Authorization': 'Bearer ' + response.json()['access_token']}

    def verify(self):
        expected = {'Ресепшн': ['RECEPTION'], 'Менежер': ['MANAGER'], 'Цэвэрлэгч': ['CLEANER']}
        paths = {'Ресепшн': ['rooms', 'room-categories', 'stays/active', 'bookings'],
                 'Менежер': ['rooms', 'room-categories', 'booking-holds', 'booking-settings', 'minibar/products', 'minibar/templates'],
                 'Цэвэрлэгч': ['cleaning/checkouts']}
        for role, wanted in expected.items():
            headers = self.login(role)
            overview = self.client.get(f'/hotels/{self.tenant}/operations', headers=headers)
            data = self.fixture.assert_status(overview, 200)
            self.fixture.assertEqual(data['roles'], wanted)
            self.fixture.assertEqual(data['mode'], 'MOCK_CASH_LEDGER')
            for path in paths[role]:
                response = self.client.get(f'/hotels/{self.tenant}/'+path, headers=headers)
                self.fixture.assert_status(response, 200)
        self.fixture.assertEqual(self.client.get('/reception').status_code, 200)


@contextmanager
def review_session(dsn):
    """Always create a fresh database; never seed or reset an existing hotel."""
    from scripts.ui_review import require_local_database
    require_local_database(dsn)
    from postgres_support import ADMIN_DSN
    if dsn != ADMIN_DSN:
        raise ValueError('Review fixture and test administration connection must match')
    import psycopg
    from argon2 import PasswordHasher
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.guest_identity import IdentityVault
    from guest_finance_support import GuestFinanceCase
    from minibar_configuration_support import MinibarConfigurationCase
    from test_booking_holds import BookingHoldTests

    class ReviewFixture(BookingHoldTests, MinibarConfigurationCase):
        @classmethod
        def setUpClass(cls):
            # Cooperative class setup combines existing granular grants, not a broad owner grant.
            super().setUpClass()
            cls.password = secrets.token_urlsafe(24)
            cls.password_hash = PasswordHasher().hash(cls.password)

        def setUp(self):
            # Use only the standard ready room/cash-shift fixture; no pre-paid booking.
            GuestFinanceCase.setUp(self)

    fixture = None
    client = None
    try:
        ReviewFixture.setUpClass()
        fixture = ReviewFixture(methodName='runTest')
        fixture.setUp()
        cleaner, _ = fixture.add_staff(['CLEANER'])
        accounts = {'Ресепшн': 'reception@ui-review.example.test',
                    'Менежер': 'manager@ui-review.example.test',
                    'Цэвэрлэгч': 'cleaner@ui-review.example.test'}
        with psycopg.connect(fixture.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt=25000 WHERE tenant_id=%s', (fixture.tenant,))
            conn.execute("UPDATE prsystem.staff_membership SET roles=ARRAY['RECEPTION'] WHERE tenant_id=%s AND account_id=%s", (fixture.tenant, fixture.worker))
            for actor, role in ((fixture.worker, 'Ресепшн'), (fixture.manager, 'Менежер'), (cleaner, 'Цэвэрлэгч')):
                conn.execute('UPDATE prsystem.staff_account SET email=%s WHERE id=%s', (accounts[role], actor))
        vault = IdentityVault({'review': secrets.token_bytes(32)}, 'review', secrets.token_bytes(32))
        app = create_app(fixture.app_dsn, fixture.settings, token_key=secrets.token_bytes(32), identity_vault=vault,
                         runtime_mode='development', mock_stay_finance=True)
        from starlette.middleware.trustedhost import TrustedHostMiddleware
        from starlette.responses import PlainTextResponse
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost'])

        @app.middleware('http')
        async def local_review_origin(request, call_next):
            origin = request.headers.get('origin')
            if origin and origin != str(request.base_url).rstrip('/'):
                return PlainTextResponse('Local UI review only', status_code=403)
            return await call_next(request)

        client = TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 12345))
        session = ReviewSession(fixture, app, client, fixture.tenant, accounts, fixture.password, {})
        headers = session.login('Менежер')
        room = fixture.assert_status(client.post(f'/hotels/{fixture.tenant}/rooms', headers=headers,
            json=dict(number='201', floor='2', category_id=fixture.category, idempotency_key=uuid4().hex)), 201)
        session.cleaning_task = fixture.assert_status(client.post(f'/hotels/{fixture.tenant}/rooms/{room["room_id"]}/cleaning-requests',
            headers=headers, json=dict(assignee_id=cleaner, expected_revision=1, idempotency_key=uuid4().hex)), 201)
        photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII='
        fixture.assert_status(client.put(f'/hotels/{fixture.tenant}/booking-profile', headers=headers,
            json=dict(name='UI туршилтын буудал', address='Туршилтын хаяг — Улаанбаатар', phone='99112233',
                description='Зөвхөн хийсвэр өгөгдөлтэй UI/UX туршилт.', latitude=47.9, longitude=106.9,
                photos=[photo], published=False, accepting=False, expected_revision=0, idempotency_key=uuid4().hex)), 200)
        yield session
    finally:
        if client is not None:
            client.close()
        if fixture is not None:
            fixture.doCleanups()
        ReviewFixture.doClassCleanups()
        if ReviewFixture.tearDown_exceptions:
            raise RuntimeError('Review database cleanup failed; inspect the disposable PostgreSQL container')
