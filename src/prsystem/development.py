"""Opt-in local provider simulation and one-shot workers; never a live adapter."""

import argparse
import base64
import json
import os

from prsystem.mock_providers import MockStore, MockPhoneGateway, MockPaymentGateway, MockMailTransport, require_development_database


def store_from_environment():
    mode = os.environ.get('PRSYSTEM_ENV', '')
    if mode != 'development':
        raise ValueError('PRSYSTEM_ENV=development is required')
    return MockStore(os.environ.get('PRSYSTEM_MOCK_STATE', '.dev/providers.sqlite3'), environment=mode)


def create_app():
    from prsystem.api import create_app as staff_app
    store = store_from_environment()
    dsn = os.environ['PRSYSTEM_APP_DSN']
    require_development_database(dsn, 'development')
    # Domain-separated dev keys are stable across restarts; production never derives them from LINK_KEY.
    import hashlib
    import hmac
    from prsystem.guest_identity import IdentityVault
    key = base64.b64decode(os.environ['PRSYSTEM_LINK_KEY'], altchars=b'-_', validate=True)
    if len(key) < 32:
        raise ValueError('Development key must have at least 32 bytes')
    derive = lambda purpose: hmac.new(key, purpose, hashlib.sha256).digest()
    vault = IdentityVault({'dev-v1': derive(b'dev-identity-encryption')}, 'dev-v1', derive(b'dev-identity-lookup'))
    return staff_app(dsn, runtime_mode='development', identity_vault=vault, phone_gateway=MockPhoneGateway(store),
                     payment_gateways={name: MockPaymentGateway(store, name) for name in ('QPAY', 'KHAAN')})


def tick(store, dsn, key, limit=25):
    from prsystem.auth import StaffAuth
    from prsystem.mail_worker import MailWorker
    from prsystem.onboarding import OnboardingService
    from prsystem.renewal import RenewalService
    from prsystem.staff_lifecycle import StaffLifecycle
    from prsystem.postgres.connection import transaction
    require_development_database(dsn, 'development')
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('Batch must be between 1 and 100')
    auth = StaffAuth(dsn); links = StaffLifecycle(auth, key)
    gateways = {name: MockPaymentGateway(store, name) for name in ('QPAY', 'KHAAN')}
    onboarding = OnboardingService(auth, links, phone_gateway=MockPhoneGateway(store), payment_gateways=gateways)
    renewals = RenewalService(auth, gateways)
    with transaction(dsn) as conn:
        applications = conn.execute("SELECT id FROM prsystem.onboarding_attempt WHERE state IN ('PENDING','UNCERTAIN','EXPIRED','FAILED','SUPERSEDED') ORDER BY id LIMIT %s", (limit,)).fetchall()
        extensions = conn.execute("SELECT id FROM prsystem.subscription_renewal WHERE state IN ('PENDING','UNCERTAIN','EXPIRED','FAILED') ORDER BY id LIMIT %s", (limit,)).fetchall()
    # A bounded local diagnostic tick, not the production scheduling contract.
    results = {'mode': 'MOCK_ONLY', 'onboarding': [onboarding.reconcile(r[0]) for r in applications],
               'renewals': [renewals.reconcile(r[0]) for r in extensions]}
    results['provisioning'] = onboarding.once(limit)
    results['entitlements'] = renewals.apply_due(limit)
    results['mail'] = MailWorker(links, MockMailTransport(store, os.environ.get('PRSYSTEM_DEV_ORIGIN', 'http://127.0.0.1:8000'))).once(limit)
    return results


def main():
    parser = argparse.ArgumentParser(description='MOCK ONLY: inspect local delivery or simulate a payment; no external requests.')
    sub = parser.add_subparsers(dest='command', required=True)
    read = sub.add_parser('inspect'); read.add_argument('kind', choices=['phone', 'invoice', 'mail'])
    pay = sub.add_parser('payment'); pay.add_argument('provider', choices=['QPAY', 'KHAAN']); pay.add_argument('attempt'); pay.add_argument('state', choices=['PENDING', 'FAILED', 'EXPIRED', 'SUCCEEDED'])
    worker = sub.add_parser('tick'); worker.add_argument('--limit', type=int, default=25)
    args = parser.parse_args()
    try:
        store = store_from_environment()
        if args.command == 'inspect':
            result = {'mode': 'MOCK_ONLY', 'items': store.inspect(args.kind)}
        elif args.command == 'payment':
            MockPaymentGateway(store, args.provider).set_status(args.attempt, args.state)
            result = {'mode': 'MOCK_ONLY', 'state': args.state}
        else:
            dsn = os.environ['PRSYSTEM_DEV_WORKER_DSN']
            key = base64.b64decode(os.environ['PRSYSTEM_LINK_KEY'], altchars=b'-_', validate=True)
            result = tick(store, dsn, key, args.limit)
        print(json.dumps(result, ensure_ascii=False, default=str))
    except Exception:
        raise SystemExit('MOCK_COMMAND_FAILED: verify local configuration and simulation state') from None


if __name__ == '__main__':
    main()
