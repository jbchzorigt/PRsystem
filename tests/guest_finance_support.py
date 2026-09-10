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
                'GRANT SELECT ON prsystem.minibar_manager_exception,prsystem.minibar_refill_request,prsystem.minibar_refill_result,prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
                'GRANT SELECT,INSERT ON prsystem.checkin_funding_return TO {}',
                'GRANT UPDATE(completed_at,provider_reference,confirmation_envelope) ON prsystem.checkin_funding_return TO {}',
                'GRANT INSERT ON prsystem.reception_dependency_blocker TO {}',
                'GRANT UPDATE(state) ON prsystem.reception_dependency_blocker TO {}',
                'GRANT SELECT,INSERT ON prsystem.mock_minibar_configuration,prsystem.reception_checkout_intent,prsystem.reception_minibar_inspection,prsystem.reception_minibar_report,prsystem.guest_charge_adjustment,prsystem.reception_restaurant_order,prsystem.restaurant_checkout_outbox TO {}',
                'GRANT UPDATE(state,revision) ON prsystem.reception_minibar_inspection TO {}',
                'GRANT INSERT ON prsystem.cleaning_stock TO {}',
                'GRANT UPDATE(minibar_mode) ON prsystem.room TO {}',
                'GRANT SELECT,INSERT ON prsystem.guest_correction_route TO {}',
                'GRANT SELECT,INSERT ON prsystem.guest_refund_route,prsystem.refund_provider_evidence,prsystem.late_refund_case,prsystem.late_refund_posting TO {}',
                'GRANT UPDATE(approval,approver_id,approval_reason,approved_at,sent_at,provider_reference,last_provider_state) ON prsystem.guest_refund_route TO {}',
                'GRANT UPDATE(state,claimant_id,resolver_id,resolved_at,reason) ON prsystem.late_refund_case TO {}',
                'GRANT UPDATE(frozen) ON prsystem.guest_finance TO {}',
                'GRANT SELECT,INSERT ON prsystem.checkin_funding TO {}',
                'GRANT UPDATE(state,invoice_id,payment_id,confirmed_at,stay_id,receipt_id) ON prsystem.checkin_funding TO {}',
                'GRANT SELECT,INSERT ON prsystem.reception_booking,prsystem.booking_stay_application TO {}',
                'GRANT INSERT ON prsystem.room_reservation TO {}',
                'GRANT UPDATE(state) ON prsystem.room_reservation TO {}',
                'GRANT SELECT,INSERT ON prsystem.room_guest_qr,prsystem.guest_session,prsystem.stay_time_amendment TO {}',
                'GRANT UPDATE(token_hash,envelope,revision,failures,blocked_until) ON prsystem.room_guest_qr TO {}',
                'GRANT UPDATE(revoked_at) ON prsystem.guest_session TO {}',
                'GRANT UPDATE(consumed_at) ON prsystem.stay_guest_code TO {}',
                'GRANT UPDATE(state,decider_id,decided_at,decision_reason,self_approved) ON prsystem.stay_time_amendment TO {}',
                'GRANT SELECT,INSERT ON prsystem.deposit_hotel_settings,prsystem.deposit_category_settings,prsystem.guest_finance,prsystem.guest_charge,prsystem.guest_receipt,prsystem.guest_allocation,prsystem.guest_refund,prsystem.guest_finance_event,prsystem.shift_obligation TO {}',
                'GRANT UPDATE (amount_mnt,revision) ON prsystem.deposit_hotel_settings,prsystem.deposit_category_settings TO {}',
                'GRANT UPDATE (revision,received,reversed,allocated,refund_reserved,refunded) ON prsystem.guest_finance TO {}',
                'GRANT UPDATE (allocated,refund_reserved,refunded,reversed) ON prsystem.guest_receipt TO {}',
                'GRANT UPDATE (paid_mnt) ON prsystem.guest_charge TO {}',
                'GRANT UPDATE (state,completed_at,released_at,confirmation_envelope) ON prsystem.guest_refund TO {}',
                'GRANT UPDATE (state) ON prsystem.shift_obligation TO {}',
                'GRANT UPDATE (reserved) ON prsystem.cash_drawer TO {}',
                'GRANT UPDATE (snapshot,state,actual_checkout_at) ON prsystem.stay TO {}',
                'GRANT SELECT,INSERT ON prsystem.stay_checkout TO {}',
                'GRANT UPDATE (revoked_at) ON prsystem.stay_guest_code TO {}',
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
