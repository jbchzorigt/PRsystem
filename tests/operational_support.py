"""Restricted operational role fixtures; no tests inherited by feature suites."""
from uuid import uuid4
from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql

class OperationalCase(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for statement in (
                'GRANT SELECT ON prsystem.staff_link,prsystem.staff_command_receipt,prsystem.staff_open_work,prsystem.staff_work_exception TO {}',
                'GRANT INSERT ON prsystem.staff_command_receipt,prsystem.staff_change_event,prsystem.staff_open_work,prsystem.staff_work_exception,prsystem.operational_event TO {}',
                'GRANT UPDATE (status,roles) ON prsystem.staff_membership TO {}',
                'GRANT UPDATE (state) ON prsystem.staff_link TO {}',
                'GRANT UPDATE (state,owner_id,assignment_version) ON prsystem.staff_open_work TO {}',
                'GRANT UPDATE (claimant_id,revision) ON prsystem.staff_work_exception TO {}',
                'GRANT SELECT ON prsystem.room_cleaning_request TO {}',
                'GRANT SELECT ON prsystem.cleaning_source,prsystem.cleaning_action,prsystem.cleaning_task,prsystem.cleaning_stock,prsystem.cleaning_posting TO {}',
                'GRANT UPDATE (id) ON prsystem.cleaning_source TO {}',
                'GRANT UPDATE (completed) ON prsystem.cleaning_action TO {}',
                'GRANT UPDATE (assignee_id,assignment_version,state,started_at) ON prsystem.cleaning_task TO {}',
                'GRANT UPDATE (quantity) ON prsystem.cleaning_stock TO {}',
                'GRANT INSERT ON prsystem.cleaning_task,prsystem.cleaning_posting TO {}',
            ): conn.execute(sql.SQL(statement).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.admin=self.token()
        self.manager,self.manager_token=self.add_staff(['MANAGER'])
        self.worker,self.worker_token=self.add_staff(['CLEANER','RECEPTION'])
        self.replacement,self.replacement_token=self.add_staff(['CLEANER','RECEPTION'])

    def add_staff(self,roles,tenant=None):
        tenant=tenant or self.tenant
        account=uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('INSERT INTO prsystem.staff_account (id,email,password_hash,verified_at) VALUES (%s,%s,%s,now())',(account,account+'@example.test',self.password_hash))
            conn.execute("INSERT INTO prsystem.staff_membership (tenant_id,account_id,status,roles) VALUES (%s,%s,'ACTIVE',%s)",(tenant,account,roles))
        response=self.client.post('/auth/login',json=dict(email=account+'@example.test',password=self.password,tenant_id=tenant))
        self.assertEqual(response.status_code,200,response.text)
        return account,response.json()['access_token']

    def suspend(self,target=None,revision=0):
        result=self.client.post(f'/hotels/{self.tenant}/staff/{target or self.worker}/suspend',headers=self.headers(self.admin),
            json=dict(expected_revision=revision,idempotency_key=uuid4().hex,reason='Suspension fixture'))
        self.assertEqual(result.status_code,200,result.text)
        return result.json()['exception_ids'][0]

    def claim(self,exception,revision=0):
        r=self.client.post(f'/hotels/{self.tenant}/staff-work/exceptions/{exception}/claim',headers=self.headers(self.manager_token),
            json=dict(expected_revision=revision,idempotency_key=uuid4().hex))
        self.assertEqual(r.status_code,200,r.text)
        return r.json()['revision']
