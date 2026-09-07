"""Local, durable provider simulation. No sockets, SMS or money movement."""

import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from time import time
from urllib.parse import quote, urlsplit

from prsystem.common import DomainError, identifier, money


class MockStore:
    is_mock = True

    def __init__(self, path, *, environment, clock=time):
        if environment not in {'development', 'test'}:
            raise ValueError('Mock providers require development or test mode')
        self.path, self.clock = Path(path), clock
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        with self.connect() as conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS mock_phone (
                    challenge TEXT PRIMARY KEY, phone TEXT NOT NULL, code TEXT NOT NULL,
                    expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    consumed INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS mock_invoice (
                    provider TEXT NOT NULL, attempt TEXT NOT NULL, amount INTEGER NOT NULL,
                    invoice TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'PENDING',
                    confirmed REAL, PRIMARY KEY(provider,attempt));
                CREATE TABLE IF NOT EXISTS mock_mail (
                    link_id TEXT PRIMARY KEY, recipient TEXT NOT NULL,
                    purpose TEXT NOT NULL, url TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS mock_refund (
                    provider TEXT NOT NULL, request TEXT NOT NULL, original TEXT NOT NULL, amount INTEGER NOT NULL,
                    state TEXT NOT NULL DEFAULT 'PENDING',confirmed REAL,PRIMARY KEY(provider,request));
            ''')

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def inspect(self, kind, limit=25):
        if kind not in {'phone', 'invoice', 'mail', 'refund'} or type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('Invalid mock inspection')
        # Local operator only; this is never an HTTP endpoint or production log.
        with self.connect() as conn:
            return [dict(row) for row in conn.execute('SELECT * FROM mock_' + kind + ' ORDER BY rowid DESC LIMIT ?', (limit,))]


class MockPhoneGateway:
    is_mock = True

    def __init__(self, store):
        self.store = store

    def request(self, phone, challenge_id):
        identifier(phone); identifier(challenge_id)
        with self.store.connect() as conn:
            conn.execute('INSERT OR IGNORE INTO mock_phone(challenge,phone,code,expires) VALUES (?,?,?,?)',
                         (challenge_id, phone, f'{secrets.randbelow(1000000):06}', self.store.clock() + 300))
            row = conn.execute('SELECT phone FROM mock_phone WHERE challenge=?', (challenge_id,)).fetchone()
            if row['phone'] != phone:
                raise DomainError('IDEMPOTENCY_CONFLICT')

    def verify(self, challenge_id, code):
        with self.store.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT * FROM mock_phone WHERE challenge=?', (challenge_id,)).fetchone()
            if not row or row['consumed'] or row['attempts'] >= 5 or self.store.clock() >= row['expires']:
                return False
            valid = isinstance(code, str) and code.isascii() and secrets.compare_digest(code, row['code'])
            conn.execute('UPDATE mock_phone SET attempts=attempts+1,consumed=? WHERE challenge=?', (int(valid), challenge_id))
            return valid


class MockPaymentGateway:
    is_mock = True

    def __init__(self, store, provider):
        if provider not in {'QPAY', 'KHAAN'}:
            raise ValueError('Unknown simulated provider')
        self.store, self.provider = store, provider
        self.merchant_id = 'MOCK_ONLY_' + provider

    def create_invoice(self, attempt_id, amount, currency):
        identifier(attempt_id); money(amount, positive=True)
        if currency != 'MNT':
            raise DomainError('PROVIDER_EVIDENCE_INVALID')
        invoice = 'mock-' + self.provider.lower() + '-' + attempt_id
        with self.store.connect() as conn:
            conn.execute('INSERT OR IGNORE INTO mock_invoice(provider,attempt,amount,invoice) VALUES (?,?,?,?)',
                         (self.provider, attempt_id, amount, invoice))
            row = conn.execute('SELECT amount,invoice FROM mock_invoice WHERE provider=? AND attempt=?', (self.provider, attempt_id)).fetchone()
            if row['amount'] != amount:
                raise DomainError('IDEMPOTENCY_CONFLICT')
            return row['invoice']

    def set_status(self, attempt_id, state):
        """Explicit local simulation control, not a business/payment API."""
        if state not in {'PENDING', 'FAILED', 'EXPIRED', 'SUCCEEDED'}:
            raise ValueError('Invalid simulated payment state')
        with self.store.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT state FROM mock_invoice WHERE provider=? AND attempt=?', (self.provider, attempt_id)).fetchone()
            if not row:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row['state'] == 'VOIDED':raise DomainError('REFUND_TERMINAL')
            if row['state'] == 'SUCCEEDED':
                if state != 'SUCCEEDED':
                    raise DomainError('PAYMENT_ALREADY_PAID')
                return
            conn.execute('UPDATE mock_invoice SET state=?,confirmed=? WHERE provider=? AND attempt=?',
                         (state, self.store.clock() if state == 'SUCCEEDED' else None, self.provider, attempt_id))

    def void_invoice(self,attempt_id):
        """Authoritative mock cancellation serializes with simulated capture."""
        with self.store.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row=conn.execute('SELECT state FROM mock_invoice WHERE provider=? AND attempt=?',(self.provider,attempt_id)).fetchone()
            if not row:return
            if row['state']=='SUCCEEDED':raise DomainError('PAYMENT_ALREADY_PAID')
            conn.execute("UPDATE mock_invoice SET state='VOIDED' WHERE provider=? AND attempt=?",(self.provider,attempt_id))

    def payment(self, attempt_id, invoice_id):
        with self.store.connect() as conn:
            row = conn.execute('SELECT * FROM mock_invoice WHERE provider=? AND attempt=?', (self.provider, attempt_id)).fetchone()
        if not row or (invoice_id is not None and row['invoice'] != invoice_id):
            raise DomainError('PROVIDER_EVIDENCE_INVALID')
        return dict(status=row['state'], merchant_id=self.merchant_id, invoice_id=row['invoice'],
                    amount=row['amount'], currency='MNT', payment_id='mock-capture-' + row['invoice'],
                    confirmed_at=datetime.fromtimestamp(row['confirmed'], timezone.utc) if row['confirmed'] is not None else None)


    def create_refund(self,request_id,original,amount):
        identifier(request_id);identifier(original);money(amount,positive=True)
        with self.store.connect() as conn:
            conn.execute('INSERT OR IGNORE INTO mock_refund(provider,request,original,amount) VALUES(?,?,?,?)',(self.provider,request_id,original,amount))
            row=conn.execute('SELECT original,amount FROM mock_refund WHERE provider=? AND request=?',(self.provider,request_id)).fetchone()
            if (row['original'],row['amount'])!=(original,amount):raise DomainError('IDEMPOTENCY_CONFLICT')

    def set_refund_status(self,request_id,state):
        """Local-only controls include late success after a prior final failure."""
        if state not in {'PENDING','UNKNOWN','FAILED','FINAL_FAILED','VOIDED','NOT_PROCESSED','SUCCEEDED','CORRECTED_NOT_SUCCESS'}:raise ValueError('Invalid mock refund state')
        with self.store.connect() as conn:
            if not conn.execute('UPDATE mock_refund SET state=?,confirmed=? WHERE provider=? AND request=?',(state,self.store.clock() if state=='SUCCEEDED' else None,self.provider,request_id)).rowcount:raise DomainError('WORK_SOURCE_NOT_FOUND')

    def refund(self,request_id):
        with self.store.connect() as conn:row=conn.execute('SELECT * FROM mock_refund WHERE provider=? AND request=?',(self.provider,request_id)).fetchone()
        if not row:raise DomainError('PROVIDER_EVIDENCE_INVALID')
        return dict(status=row['state'],merchant_id=self.merchant_id,reference='mock-refund:'+self.provider+':'+request_id,
                    amount=row['amount'],currency='MNT',original=row['original'],confirmed_at=datetime.fromtimestamp(row['confirmed'],timezone.utc) if row['confirmed'] else None)


class MockMailTransport:
    is_mock = True

    def __init__(self, store, origin='http://127.0.0.1:8000'):
        parsed = urlsplit(origin)
        if parsed.scheme not in {'http', 'https'} or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'} or parsed.username or parsed.password or parsed.path not in {'', '/'} or parsed.query or parsed.fragment:
            raise ValueError('Mock mailbox requires a loopback origin')
        self.store, self.origin = store, origin.rstrip('/')

    def __call__(self, envelope):
        paths = {'INVITE': '/staff/accept', 'RESET': '/staff/reset',
                 'RESTAURANT_INVITE': '/staff/restaurant-accept', 'ADMIN_ACTIVATION': '/staff/activate'}
        if envelope.purpose not in paths:
            raise DomainError('INVALID_REQUEST')
        url = self.origin + paths[envelope.purpose] + '#token=' + quote(envelope.token, safe='')
        with self.store.connect() as conn:
            conn.execute('INSERT OR IGNORE INTO mock_mail VALUES (?,?,?,?)', (envelope.link_id, envelope.recipient, envelope.purpose, url))


def require_development_database(dsn, environment):
    from psycopg.conninfo import conninfo_to_dict
    database = conninfo_to_dict(dsn).get('dbname', '')
    if environment not in {'development', 'test'} or not database.startswith(('prsystem_dev', 'prsystem_test_')):
        raise ValueError('Use an explicit prsystem_dev* or prsystem_test_* database for mocks')
