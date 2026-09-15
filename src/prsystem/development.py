"""Opt-in local provider simulation and one-shot workers; never a live adapter."""

import argparse
import base64
import json
import os
import re

from prsystem.mock_bank import MockBankGateway
from prsystem.mock_providers import MockStore, MockPhoneGateway, MockPaymentGateway, MockMailTransport, MockSMSGateway, MockEbarimtGateway, MockContactNoticeGateway, require_development_database


def store_from_environment():
    mode = os.environ.get('PRSYSTEM_ENV', '')
    if mode != 'development':
        raise ValueError('PRSYSTEM_ENV=development is required')
    return MockStore(os.environ.get('PRSYSTEM_MOCK_STATE', '.dev/providers.sqlite3'), environment=mode)


def restaurant_gateways(store):
    names=json.loads(os.environ.get('PRSYSTEM_DEV_RESTAURANTS','[]'))
    if not isinstance(names,list) or len(names)>100 or any(not isinstance(n,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',n) for n in names):
        raise ValueError('Invalid development restaurant configuration')
    gateways={}
    for name in sorted(set(names)):
        gateway=MockPaymentGateway(MockStore(store.path.parent/'restaurants'/(name+'.sqlite3'),environment='development'),'QPAY')
        gateway.merchant_id='MOCK_ONLY_RESTAURANT_'+name
        gateways[name]=gateway
    return gateways


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
    return staff_app(dsn, runtime_mode='development', identity_vault=vault, mock_stay_finance=True, phone_gateway=MockPhoneGateway(store),
                     payment_gateways={name: MockPaymentGateway(store, name) for name in ('QPAY', 'KHAAN')}, bank_gateway=MockBankGateway(store),
                     platform_secret_resolver=lambda ref: base64.b64decode(os.environ.get('PRSYSTEM_DEV_MFA_'+ref,''),validate=True),
                     restaurant_gateways=restaurant_gateways(store),sms_gateway=MockSMSGateway(store),ebarimt_gateway=MockEbarimtGateway(store),contact_notice_gateway=MockContactNoticeGateway(store))


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
    read = sub.add_parser('inspect'); read.add_argument('kind', choices=['phone', 'invoice', 'mail','refund'])
    pay = sub.add_parser('payment'); pay.add_argument('provider', choices=['QPAY', 'KHAAN']); pay.add_argument('attempt'); pay.add_argument('state', choices=['PENDING', 'FAILED', 'EXPIRED', 'SUCCEEDED'])
    refund = sub.add_parser('refund'); refund.add_argument('provider',choices=['QPAY','KHAAN']); refund.add_argument('request'); refund.add_argument('state',choices=['PENDING','UNKNOWN','FAILED','FINAL_FAILED','VOIDED','NOT_PROCESSED','SUCCEEDED','CORRECTED_NOT_SUCCESS'])
    credit=sub.add_parser('bank-credit');credit.add_argument('tenant');credit.add_argument('provider',choices=['QPAY','KHAAN']);credit.add_argument('merchant');credit.add_argument('payment');credit.add_argument('amount',type=int);credit.add_argument('fee',type=int)
    beneficiary=sub.add_parser('bank-beneficiary');beneficiary.add_argument('tenant');beneficiary.add_argument('reference')
    dispute=sub.add_parser('bank-dispute');dispute.add_argument('tenant');dispute.add_argument('payment');dispute.add_argument('chargeback',type=int);dispute.add_argument('--opened',action='store_true')
    payout=sub.add_parser('bank-payout');payout.add_argument('attempt');payout.add_argument('state',choices=['PENDING','UNKNOWN','FAILED','SUCCEEDED'])
    worker = sub.add_parser('tick'); worker.add_argument('--limit', type=int, default=25)
    contact_notice=sub.add_parser('contact-notices');contact_notice.add_argument('tenant');contact_notice.add_argument('--limit',type=int,default=25)
    operation_tick=sub.add_parser('operation-tick');operation_tick.add_argument('--limit',type=int,default=25)
    operation_sms=sub.add_parser('operation-sms');operation_sms.add_argument('recipient');operation_sms.add_argument('attempt',type=int);operation_sms.add_argument('state',choices=['SENT','DELIVERED','FAILED','UNKNOWN'])
    restaurant_tick=sub.add_parser('restaurant-tick');restaurant_tick.add_argument('--limit',type=int,default=25)
    restaurant_pay=sub.add_parser('restaurant-payment');restaurant_pay.add_argument('restaurant');restaurant_pay.add_argument('attempt');restaurant_pay.add_argument('state',choices=['PENDING','FAILED','EXPIRED','SUCCEEDED'])
    restaurant_refund=sub.add_parser('restaurant-refund');restaurant_refund.add_argument('restaurant');restaurant_refund.add_argument('request');restaurant_refund.add_argument('state',choices=['PENDING','UNKNOWN','FAILED','FINAL_FAILED','NOT_PROCESSED','SUCCEEDED'])
    args = parser.parse_args()
    try:
        store = store_from_environment()
        if args.command=='contact-notices':
            from prsystem.subscription_contact import SubscriptionContact
            from prsystem.auth import StaffAuth
            result=SubscriptionContact(StaffAuth(os.environ['PRSYSTEM_APP_DSN']),None,None,MockContactNoticeGateway(store)).notice_once(args.tenant,args.limit)
        elif args.command in {'operation-tick','operation-sms'}:
            sms=MockSMSGateway(store)
            if args.command=='operation-sms':
                sms.set_status(args.recipient,args.attempt,args.state);result={'mode':'MOCK_ONLY','state':args.state}
            else:
                from prsystem.operation_dashboard import OperationDashboard
                from prsystem.auth import StaffAuth
                from prsystem.onboarding import OnboardingService
                from prsystem.renewal import RenewalService
                auth=StaffAuth(os.environ['PRSYSTEM_APP_DSN'])
                gateways={name:MockPaymentGateway(store,name) for name in ('QPAY','KHAAN')}
                worker=OperationDashboard(auth,None,sms=sms,onboarding=OnboardingService(auth,None,payment_gateways=gateways),renewals=RenewalService(auth,gateways),ebarimt=MockEbarimtGateway(store))
                result={'sms':worker.sms_once(args.limit),'billing':worker.billing_once(args.limit)}
        elif args.command.startswith('restaurant-'):
            gateways=restaurant_gateways(store)
            if args.command=='restaurant-tick':
                from prsystem.auth import StaffAuth
                from prsystem.restaurant_identity import RestaurantIdentity
                from prsystem.restaurant_orders import RestaurantOrders
                dsn=os.environ['PRSYSTEM_DEV_WORKER_DSN'];require_development_database(dsn,'development')
                auth=StaffAuth(dsn)
                result={'mode':'MOCK_ONLY','orders':RestaurantOrders(auth,RestaurantIdentity(auth),gateways,'development').tick(args.limit)}
            elif args.command=='restaurant-payment':
                gateways[args.restaurant].set_status(args.attempt,args.state);result={'mode':'MOCK_ONLY','state':args.state}
            else:
                gateways[args.restaurant].set_refund_status(args.request,args.state);result={'mode':'MOCK_ONLY','state':args.state}
        elif args.command == 'inspect':
            result = {'mode': 'MOCK_ONLY', 'items': store.inspect(args.kind)}
        elif args.command == 'payment':
            MockPaymentGateway(store, args.provider).set_status(args.attempt, args.state)
            result = {'mode': 'MOCK_ONLY', 'state': args.state}
        elif args.command == 'refund':
            MockPaymentGateway(store,args.provider).set_refund_status(args.request,args.state)
            result={'mode':'MOCK_ONLY','state':args.state}
        elif args.command.startswith('bank-'):
            bank=MockBankGateway(store)
            if args.command=='bank-credit':bank.record_credit(args.tenant,args.provider,args.merchant,args.payment,args.amount,args.fee)
            elif args.command=='bank-beneficiary':bank.set_beneficiary(args.tenant,args.reference)
            elif args.command=='bank-dispute':bank.dispute(args.tenant,args.payment,opened=args.opened,chargeback=args.chargeback)
            else:bank.set_payout_status(args.attempt,args.state)
            result={'mode':'MOCK_ONLY','status':'RECORDED'}
        else:
            dsn = os.environ['PRSYSTEM_DEV_WORKER_DSN']
            key = base64.b64decode(os.environ['PRSYSTEM_LINK_KEY'], altchars=b'-_', validate=True)
            result = tick(store, dsn, key, args.limit)
        print(json.dumps(result, ensure_ascii=False, default=str))
    except Exception:
        raise SystemExit('MOCK_COMMAND_FAILED: verify local configuration and simulation state') from None


if __name__ == '__main__':
    main()
