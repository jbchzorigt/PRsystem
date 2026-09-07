import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4
from postgres_support import ADMIN_DSN
from walkin_support import WalkInCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.common import DomainError
    from prsystem.guest_finance import GuestFinance
    from prsystem.shifts import ShiftService
    from prsystem.auth import StaffAuth
    from prsystem.postgres.connection import transaction


class GuestFinanceCase(WalkInCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.deposit_hotel_settings,prsystem.deposit_category_settings,prsystem.guest_finance,prsystem.guest_charge,prsystem.guest_receipt,prsystem.guest_allocation,prsystem.guest_refund,prsystem.guest_finance_event,prsystem.shift_obligation TO {}',
                'GRANT UPDATE (amount_mnt,revision) ON prsystem.deposit_hotel_settings,prsystem.deposit_category_settings TO {}',
                'GRANT UPDATE (revision,received,reversed,allocated,refund_reserved,refunded) ON prsystem.guest_finance TO {}',
                'GRANT UPDATE (allocated,refund_reserved,refunded,reversed) ON prsystem.guest_receipt TO {}',
                'GRANT UPDATE (paid_mnt) ON prsystem.guest_charge TO {}',
                'GRANT UPDATE (state,completed_at,released_at,confirmation_envelope) ON prsystem.guest_refund TO {}',
                'GRANT UPDATE (state) ON prsystem.shift_obligation TO {}',
                'GRANT UPDATE (reserved) ON prsystem.cash_drawer TO {}',
                'GRANT UPDATE (snapshot) ON prsystem.stay TO {}',
                'GRANT SELECT,INSERT ON prsystem.guest_correction,prsystem.guest_receipt_reversal,prsystem.guest_allocation_reversal TO {}',
                'GRANT UPDATE (state,decider_id,decision_reason,decided_at) ON prsystem.guest_correction TO {}',
                'GRANT SELECT,INSERT ON prsystem.guest_payment_intent,prsystem.guest_payment_evidence,prsystem.billing_capture TO {}',
                'GRANT UPDATE (invoice_id,state,last_provider_state,receipt_id) ON prsystem.guest_payment_intent TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.client.close()
        # Exercise the production CASH path against disposable test databases.
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault),client=(self.peer,12345))
        self.addCleanup(self.client.close)
        self.ready()
        self.configure(60000)

    def configure(self,amount,revision=0,category=None,token=None,key=None):
        path=f'/hotels/{self.tenant}/'+(f'room-categories/{category}/deposit-settings' if category else 'deposit-settings')
        return self.client.put(path,headers=self.headers(token or self.manager_token),json=dict(amount_mnt=amount,expected_revision=revision,idempotency_key=key or uuid4().hex))

    def start(self,amount=60000,**extra):
        response=self.checkin(kind='NIGHTLY',duration_units=1,deposit=dict(channel='CASH',amount_mnt=amount,received=True),**extra)
        self.stay=self.assert_status(response,201)
        return self.stay

    def command(self,path,body,token=None,method='post'):
        return getattr(self.client,method)(f'/hotels/{self.tenant}/stays/{self.stay["stay_id"]}/'+path,headers=self.headers(token or self.worker_token),json=body)

    def statement(self,token=None):
        return self.client.get(f'/hotels/{self.tenant}/stays/{self.stay["stay_id"]}/finance',headers=self.headers(token or self.worker_token))

    def allocate(self,amount,revision=1,key='allocate',token=None,**extra):
        body=dict(receipt_id=self.stay['deposit_receipt_id'],charge_id=self.stay['room_charge_id'],amount_mnt=amount,expected_revision=revision,idempotency_key=key);body.update(extra)
        return self.command('deposit-allocations',body,token)

    def reserve(self,amount,revision=1,key='reserve',token=None):
        return self.command('cash-refunds',dict(receipt_id=self.stay['deposit_receipt_id'],amount_mnt=amount,expected_revision=revision,idempotency_key=key),token)

    def refund_finish(self,refund,revision=2,release=False,token=None,key='finish',**extra):
        body=dict(expected_revision=revision,idempotency_key=key)
        body.update(dict(reason='Cash never handed to guest',cash_not_handed=True) if release else dict(recipient_confirmation='Guest signed cash receipt'))
        body.update(extra)
        return self.command('cash-refunds/'+refund+('/release' if release else '/complete'),body,token)

    def drawer(self):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute('SELECT posted,reserved FROM prsystem.cash_drawer WHERE tenant_id=%s AND shift_id=%s',(self.tenant,self.shift)).fetchone()

