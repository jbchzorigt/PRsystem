"""Bounded email worker. No network runs while a database transaction is held."""

import argparse
import base64
import json
import os
import re
import secrets
import smtplib
import ssl
from dataclasses import dataclass, field
from datetime import timedelta
from email.message import EmailMessage
from email.utils import formatdate
from urllib.parse import quote, urlsplit

from prsystem.auth import StaffAuth
from prsystem.common import DomainError
from prsystem.postgres.connection import transaction
from prsystem.staff_lifecycle import StaffLifecycle, normalized_email


class TransportFailure(Exception):
    """Safe classification only: never pass an SMTP response or recipient here."""

    def __init__(self, code, *, permanent=False):
        super().__init__(code)
        self.code, self.permanent = code, permanent


@dataclass(frozen=True)
class SMTPSettings:
    host: str
    sender: str
    public_origin: str
    username: str = field(repr=False)
    password: str = field(repr=False)
    mode: str = "STARTTLS"
    port: int = 587
    timeout: int = 15

    def __post_init__(self):
        origin = urlsplit(self.public_origin)
        if (self.mode not in {"STARTTLS", "TLS"} or type(self.port) is not int or not 1 <= self.port <= 65535
                or type(self.timeout) is not int or not 1 <= self.timeout <= 30
                or not re.fullmatch(r"[A-Za-z0-9.-]+", self.host)
                or not self.username or not self.password or any(c in self.username for c in '\r\n')
                or origin.scheme != "https" or not origin.hostname or origin.username or origin.password
                or origin.query or origin.fragment or origin.path not in {"", "/"}):
            raise ValueError("Invalid SMTP or HTTPS origin configuration")
        if normalized_email(self.sender) != self.sender:
            raise ValueError("Use a normalized sender mailbox")


class SMTPTransport:
    def __init__(self, settings):
        self.settings = settings

    def message(self, envelope):
        s = self.settings
        path = {"INVITE": "/staff/accept", "RESET": "/staff/reset"}.get(envelope.purpose)
        if path is None or normalized_email(envelope.recipient) != envelope.recipient or not re.fullmatch(r"[a-f0-9]{32}", envelope.link_id):
            raise TransportFailure("INVALID_ENVELOPE", permanent=True)
        # Fragment keeps the secret out of HTTP URL/access logs. The HTTPS UI
        # must read/remove it and POST it to the existing one-use API endpoint.
        link = s.public_origin.rstrip('/') + path + '#token=' + quote(envelope.token, safe='')
        msg = EmailMessage()
        msg['From'], msg['To'] = s.sender, envelope.recipient
        msg['Subject'] = 'PRsystem: ажилтны урилга' if envelope.purpose == 'INVITE' else 'PRsystem: нууц үг сэргээх'
        msg['Date'] = formatdate(localtime=False, usegmt=True)
        msg['Message-ID'] = f'<{envelope.link_id}@{s.sender.split("@")[1]}>'
        msg.set_content('PRsystem\n\nДараах нэг удаагийн холбоосыг нээнэ үү:\n' + link
                        + '\n\nХэрэв та энэ хүсэлтийг гаргаагүй бол холбоосыг ашиглах шаардлагагүй.\n')
        return msg

    def __call__(self, envelope):
        s = self.settings
        message = self.message(envelope)
        context = ssl.create_default_context()
        try:
            client = (smtplib.SMTP_SSL(s.host, s.port, timeout=s.timeout, context=context) if s.mode == 'TLS'
                      else smtplib.SMTP(s.host, s.port, timeout=s.timeout))
            with client as smtp:
                smtp.ehlo()
                if s.mode == 'STARTTLS':
                    smtp.starttls(context=context)
                    smtp.ehlo()
                smtp.login(s.username, s.password)
                refused = smtp.send_message(message, from_addr=s.sender, to_addrs=[envelope.recipient])
                if refused:
                    raise TransportFailure('SMTP_RECIPIENT_REJECTED', permanent=True)
        except smtplib.SMTPRecipientsRefused as exc:
            permanent = all(code >= 500 for code, _ in exc.recipients.values())
            raise TransportFailure('SMTP_RECIPIENT_REJECTED', permanent=permanent) from None
        except smtplib.SMTPAuthenticationError:
            raise TransportFailure('SMTP_AUTH_FAILED', permanent=True) from None
        except smtplib.SMTPResponseException as exc:
            raise TransportFailure('SMTP_REJECTED', permanent=exc.smtp_code >= 500) from None
        except (ssl.SSLError, smtplib.SMTPNotSupportedError):
            raise TransportFailure('SMTP_TLS_FAILED', permanent=True) from None
        except (OSError, smtplib.SMTPException):
            raise TransportFailure('SMTP_UNAVAILABLE') from None


class MailWorker:
    def __init__(self, lifecycle, transport, *, lease_seconds=300, max_attempts=8):
        if type(lease_seconds) is not int or not 60 <= lease_seconds <= 3600 or type(max_attempts) is not int or not 1 <= max_attempts <= 20:
            raise ValueError('Invalid mail worker bounds')
        self.links, self.transport = lifecycle, transport
        self.dsn, self.lease_seconds, self.max_attempts = lifecycle.auth.dsn, lease_seconds, max_attempts

    def _claim(self):
        with transaction(self.dsn) as conn:
            # Exhausted crashed leases become visible dead letters, not endless retries.
            conn.execute("""UPDATE prsystem.staff_mail_intent SET dead_letter_at = clock_timestamp(),
                lease_token = NULL, lease_until = NULL, last_error_code = 'RETRY_EXHAUSTED'
                WHERE delivered_at IS NULL AND discarded_at IS NULL AND dead_letter_at IS NULL
                AND attempts >= %s AND (lease_until IS NULL OR lease_until <= clock_timestamp())""", (self.max_attempts,))
            token = secrets.token_hex(16)
            row = conn.execute("""WITH candidate AS (
                SELECT link_id FROM prsystem.staff_mail_intent
                WHERE delivered_at IS NULL AND discarded_at IS NULL AND dead_letter_at IS NULL
                AND next_attempt_at <= clock_timestamp() AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                AND attempts < %s ORDER BY next_attempt_at, link_id FOR UPDATE SKIP LOCKED LIMIT 1)
                UPDATE prsystem.staff_mail_intent m SET lease_token = %s,
                    lease_until = clock_timestamp() + %s, attempts = attempts + 1
                FROM candidate c WHERE m.link_id = c.link_id RETURNING m.link_id, m.attempts""",
                (self.max_attempts, token, timedelta(seconds=self.lease_seconds))).fetchone()
            return (row[0], token, row[1]) if row else None

    def once(self, batch=25):
        if type(batch) is not int or not 1 <= batch <= 100:
            raise ValueError('Batch must be 1..100')
        # Reset processing is short, transactional and idempotent; no email here.
        with transaction(self.dsn) as conn:
            resets = conn.execute("""SELECT id FROM prsystem.password_reset_request WHERE processed_at IS NULL
                ORDER BY created_at, id LIMIT %s""", (batch,)).fetchall()
        for (request_id,) in resets:
            self.links.process_reset_request(request_id)
        counts = {'reset_requests': len(resets), 'delivered': 0, 'discarded': 0, 'retry': 0, 'dead_letter': 0, 'lease_lost': 0}
        for _ in range(batch):
            claim = self._claim()
            if claim is None:
                break
            link_id, token, attempts = claim
            code, permanent, outcome = None, False, 'delivered'
            try:
                envelope = self.links.prepare_delivery(link_id)
                if envelope is None:
                    outcome = 'discarded'
                else:
                    self.transport(envelope)
            except TransportFailure as exc:
                code, permanent = exc.code, exc.permanent
                outcome = 'dead_letter' if permanent or attempts >= self.max_attempts else 'retry'
            except DomainError:
                code, outcome = 'LINK_CONFIGURATION_ERROR', 'dead_letter'
            with transaction(self.dsn) as conn:
                row = conn.execute("""UPDATE prsystem.staff_mail_intent SET lease_token = NULL, lease_until = NULL,
                    delivered_at = CASE WHEN %s = 'delivered' THEN clock_timestamp() ELSE delivered_at END,
                    discarded_at = CASE WHEN %s = 'discarded' THEN clock_timestamp() ELSE discarded_at END,
                    dead_letter_at = CASE WHEN %s = 'dead_letter' THEN clock_timestamp() ELSE dead_letter_at END,
                    last_error_code = %s, next_attempt_at = clock_timestamp() + %s
                    WHERE link_id = %s AND lease_token = %s AND lease_until > clock_timestamp() RETURNING link_id""",
                    (outcome, outcome, outcome, code, timedelta(seconds=min(3600, 30 * 2 ** (attempts - 1))), link_id, token)).fetchone()
            counts[outcome if row else 'lease_lost'] += 1
        return counts


def main():
    parser = argparse.ArgumentParser(description='Process one bounded batch of staff mail; schedule externally.')
    parser.add_argument('--batch', type=int, default=25)
    args = parser.parse_args()
    try:
        settings = SMTPSettings(host=os.environ['PRSYSTEM_SMTP_HOST'], sender=os.environ['PRSYSTEM_MAIL_FROM'],
            public_origin=os.environ['PRSYSTEM_PUBLIC_ORIGIN'], username=os.environ['PRSYSTEM_SMTP_USER'],
            password=os.environ['PRSYSTEM_SMTP_PASSWORD'], mode=os.environ.get('PRSYSTEM_SMTP_MODE', 'STARTTLS'),
            port=int(os.environ.get('PRSYSTEM_SMTP_PORT', '587')))
        key = base64.b64decode(os.environ['PRSYSTEM_LINK_KEY'], altchars=b'-_', validate=True)
        lifecycle = StaffLifecycle(StaffAuth(os.environ['PRSYSTEM_MAIL_DSN']), key)
        print(json.dumps(MailWorker(lifecycle, SMTPTransport(settings)).once(args.batch)))
    except Exception:
        # Connection/SMTP exception strings can include credentials or recipients.
        raise SystemExit('MAIL_WORKER_FAILED: check configuration and delivery counters') from None


if __name__ == '__main__':
    main()
