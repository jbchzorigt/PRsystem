import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4
from postgres_support import ADMIN_DSN
from reception_support import ReceptionCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.common import DomainError
    from prsystem.guest_identity import IdentityVault
    from prsystem.stays import StayService


class WalkInCase(ReceptionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT ON prsystem.stay_time_amendment TO {}',
                'GRANT SELECT ON prsystem.booking_hold TO {}',
                'GRANT SELECT,INSERT ON prsystem.stay,prsystem.stay_guest_identity,prsystem.stay_guest_code,prsystem.room_cleaning_request TO {}',
                'GRANT INSERT ON prsystem.identity_match_outbox,prsystem.cleaning_source,prsystem.cleaning_action TO {}',
                'GRANT SELECT ON prsystem.room_reservation TO {}',
                'GRANT UPDATE (cleaning_state,revision) ON prsystem.room TO {}',
                'GRANT UPDATE (state) ON prsystem.room_cleaning_request,prsystem.reception_shift TO {}',
            ):conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.vault=IdentityVault({'v1':b'a'*32},'v1',b'b'*32)
        self.client.close()
        self.client=TestClient(create_app(self.app_dsn,self.settings,identity_vault=self.vault,runtime_mode='test',mock_stay_finance=True),client=(self.peer,12345))
        self.addCleanup(self.client.close)
        self.shift=self.open_shift(self.worker_token,'front')
        self.assert_status(self.client.put(f'/hotels/{self.tenant}/rooms/settings',headers=self.headers(self.manager_token),json=dict(hourly_price=10001,nightly_price=80000,checkout_time='12:00',expected_revision=0,idempotency_key='settings')),200)
        response=self.client.post(f'/hotels/{self.tenant}/room-categories',headers=self.headers(self.manager_token),json=dict(name='Standard',cleaning_buffer_minutes=30,deposit=50000,idempotency_key='category'))
        self.category=self.assert_status(response,201)['category_id']
        response=self.client.post(f'/hotels/{self.tenant}/rooms',headers=self.headers(self.manager_token),json=dict(number='101',floor='1',category_id=self.category,idempotency_key='room'))
        self.room=self.assert_status(response,201)['room_id']

    def assert_status(self,response,status):
        self.assertEqual(response.status_code,status,response.text)
        return response.json()

    def open_shift(self,token,code):
        response=self.client.post(f'/hotels/{self.tenant}/cash/drawers',headers=self.headers(self.admin),json=dict(code=code,name=code,physical_location='Reception',expected_float=0,idempotency_key='drawer-'+code))
        drawer=self.assert_status(response,201)['drawer_id']
        return self.assert_status(self.client.post(f'/hotels/{self.tenant}/cash/drawers/{drawer}/open',headers=self.headers(token),json=dict(actual=0,idempotency_key='open-'+code)),201)['shift_id']

    def request_cleaning(self):
        response=self.client.post(f'/hotels/{self.tenant}/rooms/{self.room}/cleaning-requests',headers=self.headers(self.manager_token),json=dict(assignee_id=self.worker,expected_revision=1,idempotency_key='cleaning'))
        return self.assert_status(response,201)

    def start_cleaning(self,task,token=None):
        return self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/start',headers=self.headers(token or self.worker_token),json=dict(expected_revision=task['assignment_version'],idempotency_key='start'))

    def post_cleaning(self,task,token=None,key='clean'):
        return self.client.post(f'/hotels/{self.tenant}/cleaning/tasks/{task["task_id"]}/post',headers=self.headers(token or self.worker_token),json=dict(expected_revision=task['assignment_version'],action_id=task['action_id'],quantity=1,idempotency_key=key))

    def ready(self):
        task=self.request_cleaning();self.assert_status(self.start_cleaning(task),200);self.assert_status(self.post_cleaning(task),200)
        return task

    def checkin(self,token=None,tenant=None,**extra):
        body=dict(room_id=self.room,kind='HOURLY',duration_units=3,guest=dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='АБ90010211'),idempotency_key='checkin')
        body.update(extra)
        return self.client.post(f'/hotels/{tenant or self.tenant}/stays/check-in',headers=self.headers(token or self.worker_token),json=body)
