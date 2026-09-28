"""Mail retries/leases on PostgreSQL and TLS transport contract tests."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock, patch

from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase

try:
    import smtplib
    from prsystem.mail_worker import MailWorker, SMTPSettings, SMTPTransport, TransportFailure
    from prsystem.staff_lifecycle import MailEnvelope, StaffLifecycle
    from prsystem.auth import StaffAuth
    MAIL_AVAILABLE = True
except ImportError:
    MAIL_AVAILABLE = False

if ADMIN_DSN:
    import psycopg
    from psycopg import sql


@unittest.skipUnless(MAIL_AVAILABLE, 'API dependencies are not installed')
class SMTPTransportTests(unittest.TestCase):
    def setUp(self):
        self.settings = SMTPSettings('smtp.example.com', 'staff@example.com', 'https://staff.example.com', 'smtp-user', 'smtp-password')
        self.envelope = MailEnvelope('a' * 32, 'INVITE', 'recipient@example.com', 'private-token')

    def test_starttls_precedes_credentials_and_has_certificate_verification(self):
        smtp = Mock()
        smtp.__enter__ = Mock(return_value=smtp)
        smtp.__exit__ = Mock(return_value=False)
        smtp.send_message.return_value = {}
        with patch('prsystem.mail_worker.smtplib.SMTP', return_value=smtp):
            SMTPTransport(self.settings)(self.envelope)
        self.assertEqual([c[0] for c in smtp.method_calls], ['ehlo', 'starttls', 'ehlo', 'login', 'send_message'])
        context = smtp.starttls.call_args.kwargs['context']
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode.name, 'CERT_REQUIRED')
        self.assertEqual(smtp.send_message.call_args.kwargs['to_addrs'], ['recipient@example.com'])
        self.assertNotIn('smtp-password', repr(self.settings))

    def test_tls_failure_never_sends_credentials_or_message(self):
        smtp = Mock()
        smtp.__enter__ = Mock(return_value=smtp)
        smtp.__exit__ = Mock(return_value=False)
        smtp.starttls.side_effect = smtplib.SMTPNotSupportedError('server response should stay private')
        with patch('prsystem.mail_worker.smtplib.SMTP', return_value=smtp):
            with self.assertRaisesRegex(TransportFailure, '^SMTP_TLS_FAILED$'):
                SMTPTransport(self.settings)(self.envelope)
        smtp.login.assert_not_called()
        smtp.send_message.assert_not_called()

    def test_message_uses_stable_id_fragment_token_and_no_password(self):
        message = SMTPTransport(self.settings).message(self.envelope)
        self.assertEqual(message['Message-ID'], '<'+'a'*32+'@example.com>')
        self.assertIn('https://staff.example.com/staff/accept#token=private-token', message.get_content())
        self.assertNotIn('private-token', str(list(message.items())))
        self.assertNotIn('smtp-password', message.as_string())

    def test_plaintext_and_origin_injection_are_rejected(self):
        for origin in ['http://staff.example.com', 'https://staff.example.com?next=evil', 'https://user:password@staff.example.com', 'https://staff.example.com/path']:
            with self.assertRaises(ValueError):
                SMTPSettings('smtp.example.com', 'staff@example.com', origin, 'user', 'password')
        with self.assertRaises(ValueError):
            SMTPSettings('smtp.example.com', 'staff@example.com', 'https://staff.example.com', 'user', 'password', mode='PLAIN')


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MailWorkerTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT, INSERT ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request TO {}',
                'GRANT INSERT ON prsystem.staff_lifecycle_event TO {}',
                'GRANT UPDATE (state) ON prsystem.staff_link TO {}',
                'GRANT UPDATE (processed_at) ON prsystem.password_reset_request TO {}',
                'GRANT UPDATE (delivered_at, lease_token, lease_until, attempts, next_attempt_at, discarded_at, dead_letter_at, last_error_code) ON prsystem.staff_mail_intent TO {}',
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.email = self.account + '@example.com'
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.staff_account SET email = %s WHERE id = %s', (self.email, self.account))
        self.links = StaffLifecycle(StaffAuth(self.app_dsn, self.settings), b'k' * 32)
        self.sent = []
        self.worker = MailWorker(self.links, self.sent.append)
        self.addCleanup(self.clear_jobs)

    def clear_jobs(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('DELETE FROM prsystem.staff_lifecycle_event WHERE target_id = %s', (self.account,))
            conn.execute('DELETE FROM prsystem.staff_mail_intent WHERE link_id IN (SELECT id FROM prsystem.staff_link WHERE account_id = %s)', (self.account,))
            conn.execute('DELETE FROM prsystem.staff_link WHERE account_id = %s', (self.account,))
            conn.execute('DELETE FROM prsystem.password_reset_request WHERE email = %s', (self.email,))

    def request(self):
        self.links.request_reset(self.email, self.peer)

    def prepare_job(self):
        self.request()
        with psycopg.connect(self.owner_dsn) as conn:
            request_id = conn.execute('SELECT id FROM prsystem.password_reset_request WHERE email = %s ORDER BY created_at DESC LIMIT 1', (self.email,)).fetchone()[0]
        self.links.process_reset_request(request_id)

    def test_reset_request_becomes_delivered_mail_and_is_not_sent_again(self):
        self.request()
        self.assertEqual(self.worker.once()['delivered'], 1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0].recipient, self.email)
        self.assertEqual(self.worker.once()['delivered'], 0)

    def test_transient_failure_retries_same_link_without_plaintext_persistence(self):
        self.prepare_job()
        self.worker.transport = Mock(side_effect=TransportFailure('SMTP_UNAVAILABLE'))
        self.assertEqual(self.worker.once()['retry'], 1)
        first = self.worker.transport.call_args.args[0]
        self.assertEqual(self.worker.once()['retry'], 0)
        with psycopg.connect(self.owner_dsn) as conn:
            row = conn.execute('SELECT row_to_json(m) FROM prsystem.staff_mail_intent m WHERE link_id = %s', (first.link_id,)).fetchone()[0]
            self.assertNotIn(first.token, str(row))
            conn.execute('UPDATE prsystem.staff_mail_intent SET next_attempt_at = now() WHERE link_id = %s', (first.link_id,))
        self.worker.transport = self.sent.append
        self.assertEqual(self.worker.once()['delivered'], 1)
        self.assertEqual(self.sent, [first])

    def test_permanent_rejection_is_dead_letter_and_not_retried(self):
        self.request()
        self.worker.transport = Mock(side_effect=TransportFailure('SMTP_RECIPIENT_REJECTED', permanent=True))
        self.assertEqual(self.worker.once()['dead_letter'], 1)
        self.worker.once()
        self.assertEqual(self.worker.transport.call_count, 1)

    def test_revoked_link_is_discarded_without_delivery(self):
        self.prepare_job()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_link SET state = 'REVOKED' WHERE account_id = %s", (self.account,))
        self.assertEqual(self.worker.once()['discarded'], 1)
        self.assertEqual(self.sent, [])

    def test_two_workers_claim_one_message(self):
        self.prepare_job()
        barrier = Barrier(2)
        def run(_):
            barrier.wait(timeout=10)
            return self.worker.once()['delivered']
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(run, range(2))), [0, 1])
        self.assertEqual(len(self.sent), 1)

    def test_crashed_lease_is_reclaimed_and_exhaustion_is_terminal(self):
        self.prepare_job()
        claim = self.worker._claim()
        self.assertIsNotNone(claim)
        self.assertEqual(self.worker.once()['delivered'], 0)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_mail_intent SET lease_until = now() - interval '1 second' WHERE link_id = %s", (claim[0],))
        self.assertEqual(self.worker.once()['delivered'], 1)
        self.prepare_job()
        claim = self.worker._claim()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_mail_intent SET lease_until = now() - interval '1 second', attempts = 8 WHERE link_id = %s", (claim[0],))
        self.assertIsNone(self.worker._claim())
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertIsNotNone(conn.execute('SELECT dead_letter_at FROM prsystem.staff_mail_intent WHERE link_id = %s', (claim[0],)).fetchone()[0])

    def test_expired_worker_cannot_ack_another_lease(self):
        self.prepare_job()
        def lose_lease(envelope):
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("UPDATE prsystem.staff_mail_intent SET lease_until = now() - interval '1 second' WHERE link_id = %s", (envelope.link_id,))
            self.assertIsNotNone(self.worker._claim())
        self.worker.transport = lose_lease
        self.assertEqual(self.worker.once(batch=1)['lease_lost'], 1)
        with psycopg.connect(self.owner_dsn) as conn:
            row = conn.execute('SELECT delivered_at, lease_token FROM prsystem.staff_mail_intent WHERE link_id IN (SELECT id FROM prsystem.staff_link WHERE account_id = %s)', (self.account,)).fetchone()
            self.assertIsNone(row[0])
            self.assertIsNotNone(row[1])
