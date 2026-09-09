import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from uuid import uuid4

from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.booking_inventory import room_intervals


class MinibarConfigurationCase(GuestFinanceCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT ON prsystem.minibar_transfer,prsystem.minibar_reconciliation,prsystem.minibar_configuration_application TO {}',
                'GRANT SELECT,INSERT ON prsystem.minibar_product,prsystem.minibar_receipt,prsystem.minibar_template,prsystem.minibar_template_version,prsystem.minibar_template_item,prsystem.minibar_configuration_request TO {}',
                'GRANT UPDATE(revision) ON prsystem.minibar_product TO {}',
                'GRANT UPDATE(revision,default_version_id) ON prsystem.minibar_template TO {}',
                'GRANT UPDATE(state) ON prsystem.minibar_template_version TO {}',
                'GRANT DELETE ON prsystem.minibar_template_item TO {}',
                'GRANT UPDATE(state,revision,cancelled_by,cancel_reason,cancelled_at) ON prsystem.minibar_configuration_request TO {}',
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.product = self.assert_status(self.api('minibar/products', dict(name='Ус',category='Ундаа',unit='ш',selling_price_mnt=3000,unit_cost_mnt=1000,opening_quantity=10)),201)['product_id']
        t = self.assert_status(self.api('minibar/templates',dict(name='Стандарт')),201)
        self.template = t['template_id']
        d = self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=1)),201)
        self.version = d['version']['version_id']
        self.assert_status(self.api(self.version_path(),dict(expected_revision=2,items=[dict(product_id=self.product,target_quantity=2)]),method='put'),200)
        self.assert_status(self.api(self.version_path()+'/publish',dict(expected_revision=3)),200)

    def api(self, tail, data=None, token=None, method='post', tenant=None):
        kw = dict(headers=self.headers(token or self.manager_token))
        if data is not None:
            kw['json'] = {'idempotency_key':uuid4().hex,**data}
        return getattr(self.client,method)(f'/hotels/{tenant or self.tenant}/'+tail,**kw)

    def version_path(self):
        return f'minibar/templates/{self.template}/versions/{self.version}'

    def revision(self):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute('SELECT revision FROM prsystem.room WHERE tenant_id=%s AND id=%s',(self.tenant,self.room)).fetchone()[0]

    def request(self, token=None, **extra):
        body = dict(target_mode='ON',target_template_id=self.template,target_version_id=self.version,expected_room_revision=self.revision(),reason='Бүрдлийг шинэчлэх')
        body.update(extra)
        return self.api(f'rooms/{self.room}/minibar-configuration/requests',body,token)

    def cancel(self, request, **extra):
        return self.api(f'minibar/configuration-requests/{request["request_id"]}/cancel',dict(expected_revision=request['revision'],reason='Төлөвлөгөө өөрчлөгдсөн',**extra))

    def read(self, token=None, query=''):
        return self.api(f'rooms/{self.room}/minibar-configuration'+query,token=token,method='get')

