import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarWarehouseTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_product,prsystem.minibar_receipt,prsystem.staff_command_receipt TO {}',
                'GRANT UPDATE(revision) ON prsystem.minibar_product TO {}',
                'GRANT INSERT ON prsystem.operational_event TO {}',
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.update_membership(roles=['HOTEL_ADMIN', 'MANAGER'])
        self.bearer = self.token()

    def call(self, suffix='', body=None, method='get', tenant=None):
        kwargs = dict(headers=self.headers(self.bearer))
        if method != 'get':
            kwargs['json'] = body
        return getattr(self.client, method)(f'/hotels/{tenant or self.tenant}/minibar/products'+suffix, **kwargs)

    def create(self, key='product', **changes):
        body = dict(name='Ус', category='Ундаа', unit='ширхэг', selling_price_mnt=3000,
                    unit_cost_mnt=1000, opening_quantity=10, status='ACTIVE', idempotency_key=key)
        body.update(changes)
        return self.call(body=body, method='post')

    def receive(self, product, key='receipt', **changes):
        body = dict(quantity=10, unit_cost_mnt=1200, expected_revision=1, reference='INV-001', idempotency_key=key)
        body.update(changes)
        return self.call('/'+product+'/receipts', body, 'post')

    def ok(self, response, status=201):
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def test_opening_is_atomic_and_retry_is_one_movement(self):
        first = self.ok(self.create())
        self.assertEqual(self.ok(self.create()), first)
        product = first['product_id']
        history = self.ok(self.call('/'+product+'/ledger'), 200)['items']
        self.assertEqual(len(history), 1)
        self.assertEqual((history[0]['kind'], history[0]['warehouse_quantity']), ('OPENING', 10))
        self.assertEqual(history[0]['product_snapshot']['selling_price_mnt'], 3000)
        self.assertEqual(self.call(body={}, method='post').status_code, 422)
        self.assertEqual(self.create(selling_price_mnt=4000).json()['code'], 'IDEMPOTENCY_CONFLICT')

    def test_receipt_average_and_prior_snapshot_are_independent_of_selling_price(self):
        product = self.ok(self.create())['product_id']
        before = self.ok(self.call('/'+product+'/ledger'), 200)['items'][0]
        receipt = self.ok(self.receive(product))
        self.assertEqual((receipt['warehouse_quantity'], receipt['inventory_value_mnt']), (20, '22000'))
        self.assertEqual(receipt['average_cost'], dict(numerator='1100', denominator='1'))
        self.assertEqual(self.ok(self.receive(product)), receipt)
        history = self.ok(self.call('/'+product+'/ledger'), 200)['items']
        self.assertEqual(history[0], before)
        self.assertEqual(history[1]['product_snapshot']['selling_price_mnt'], 3000)
        self.assertEqual(self.ok(self.call(), 200)['items'][0]['selling_price_mnt'], 3000)

    def test_repeating_average_keeps_exact_fraction(self):
        product = self.ok(self.create(opening_quantity=1, unit_cost_mnt=1001))['product_id']
        result = self.ok(self.receive(product, quantity=2, unit_cost_mnt=0))
        self.assertEqual(result['average_cost'], dict(numerator='1001', denominator='3'))
        self.assertEqual(result['inventory_value_mnt'], '1001')

    def test_zero_opening_and_free_receipt_do_not_invent_cost(self):
        first = self.ok(self.create(opening_quantity=0, unit_cost_mnt=999))
        self.assertIsNone(first['average_cost'])
        receipt = self.ok(self.receive(first['product_id'], quantity=2, unit_cost_mnt=0))
        self.assertEqual(receipt['average_cost'], dict(numerator='0', denominator='1'))
        self.assertEqual(receipt['warehouse_quantity'], 2)

    def test_concurrent_create_retry_posts_once(self):
        barrier = Barrier(2)
        def create(_):
            barrier.wait()
            return self.create()
        with ThreadPoolExecutor(2) as pool:
            replies = list(pool.map(create, range(2)))
        self.assertEqual(self.ok(replies[0]), self.ok(replies[1]))
        self.assertEqual(len(self.ok(self.call(), 200)['items']), 1)

    def test_concurrent_receipts_require_reloading_the_revision(self):
        product = self.ok(self.create())['product_id']
        barrier = Barrier(2)
        def receive(key):
            barrier.wait()
            return self.receive(product, key)
        with ThreadPoolExecutor(2) as pool:
            replies = list(pool.map(receive, ('one', 'two')))
        self.assertEqual(sorted(r.status_code for r in replies), [201, 409])
        self.assertEqual(next(r for r in replies if r.status_code == 409).json()['code'], 'REVISION_CONFLICT')
        self.assertEqual(self.ok(self.call(), 200)['items'][0]['warehouse_quantity'], 20)

    def test_role_and_package_intersection_protects_cost_and_writes(self):
        product = self.ok(self.create())['product_id']
        for package, roles, allowed in (
            (20000, ['HOTEL_ADMIN','MANAGER'], False),
            (25000, ['HOTEL_ADMIN','MANAGER_PLUS'], False),
            (25000, ['HOTEL_ADMIN','MANAGER'], True),
            (30000, ['HOTEL_ADMIN','MANAGER_PLUS'], True),
            (30000, ['HOTEL_ADMIN'], False),
            (30000, ['HOTEL_ADMIN','RECEPTION'], False),
            (30000, ['HOTEL_ADMIN','CLEANER'], False),
        ):
            with self.subTest(package=package, roles=roles):
                self.update_membership(roles=roles)
                with psycopg.connect(self.owner_dsn) as conn:
                    conn.execute('UPDATE prsystem.hotel_access SET package_mnt=%s WHERE tenant_id=%s', (package, self.tenant))
                self.bearer = self.token()
                self.assertEqual(self.call().status_code, 200 if allowed else 403)
                self.assertEqual(self.call('/'+product+'/ledger').status_code, 200 if allowed else 403)
                if not allowed:
                    self.assertEqual(self.receive(product).status_code, 403)
                    self.assertEqual(self.create().status_code, 403)  # reauthorization precedes replay

    def test_security_suspension_and_expiry_block_new_stock_even_on_replay(self):
        product = self.ok(self.create())['product_id']
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s', (self.tenant,))
        self.assertEqual(self.call().status_code, 403)
        self.assertEqual(self.create().status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET security_suspended=false,expires_at=now()-interval '49 hours' WHERE tenant_id=%s", (self.tenant,))
        self.assertEqual(self.receive(product).json()['code'], 'SUBSCRIPTION_EXPIRED')
        self.assertEqual(self.call().status_code, 403)

    def test_revoked_membership_cannot_read_cost_history(self):
        product = self.ok(self.create())['product_id']
        self.update_membership(status='SUSPENDED')
        self.assertIn(self.call('/'+product+'/ledger').status_code, (401,403))
        self.assertIn(self.receive(product).status_code, (401,403))

    def test_cross_hotel_ids_and_direct_rls_are_denied(self):
        product = self.ok(self.create())['product_id']
        self.assertEqual(self.call(tenant=self.other).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_membership SET roles=ARRAY['HOTEL_ADMIN','MANAGER'] WHERE tenant_id=%s AND account_id=%s", (self.other, self.account))
        self.bearer = self.token(self.other)
        self.assertEqual(self.call('/'+product+'/ledger', tenant=self.other).status_code, 404)
        response = self.call('/'+product+'/receipts', dict(quantity=1,unit_cost_mnt=1,expected_revision=1,idempotency_key='foreign'), 'post', self.other)
        self.assertEqual(response.status_code, 404)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)", (self.other,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_receipt').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_product').fetchone()[0], 0)

    def test_inactive_opening_stock_remains_visible(self):
        first = self.ok(self.create(status='INACTIVE'))
        result = self.ok(self.call(), 200)['items'][0]
        self.assertEqual((result['status'], result['warehouse_quantity']), ('INACTIVE', 10))
        self.assertEqual(self.receive(first['product_id']).json()['code'], 'PRODUCT_NOT_ACTIVE')

    def test_bounded_products_and_ledger_pages_have_no_overlap(self):
        products = [self.ok(self.create(key=str(n)))['product_id'] for n in range(3)]
        first = self.ok(self.call('?limit=2'), 200)
        second = self.ok(self.call('?limit=2&after='+first['next_after']), 200)
        self.assertEqual({x['product_id'] for x in first['items']+second['items']}, set(products))
        self.assertIsNone(second['next_after'])
        self.ok(self.receive(products[0]))
        first = self.ok(self.call('/'+products[0]+'/ledger?limit=1'), 200)
        second = self.ok(self.call('/'+products[0]+'/ledger?limit=1&after='+str(first['next_after'])), 200)
        self.assertEqual([x['stock_revision'] for x in first['items']+second['items']], [1,2])
        self.assertIsNone(second['next_after'])

    def test_client_cannot_supply_balance_proof_or_fractional_quantity(self):
        for invalid in ({'opening_quantity':-1}, {'opening_quantity':True}, {'opening_quantity':1.5},
                        {'unit_cost_mnt':-1}, {'warehouse_after':10}, {'average_cost':0}):
            with self.subTest(invalid=invalid):
                self.assertEqual(self.create(**invalid).status_code, 422)
        self.assertEqual(self.ok(self.call(), 200)['items'], [])

    def test_inventory_quantity_overflow_rolls_back(self):
        product = self.ok(self.create(opening_quantity=2**63-1, unit_cost_mnt=2**63-1))['product_id']
        self.assertEqual(self.receive(product, quantity=1).status_code, 422)
        item = self.ok(self.call(), 200)['items'][0]
        self.assertEqual(item['stock_revision'], 1)
        self.assertEqual(item['inventory_value_mnt'], str((2**63-1)**2))

    def test_database_guard_rejects_forged_totals_and_history_mutation(self):
        product = self.ok(self.create())['product_id']
        with self.assertRaises(psycopg.errors.CheckViolation), psycopg.connect(self.owner_dsn) as conn:
            conn.execute('''INSERT INTO prsystem.minibar_receipt
                (tenant_id,id,product_id,stock_revision,kind,quantity,unit_cost_mnt,warehouse_after,inventory_value_after,actor_id,actor_roles,package_mnt,reference,product_snapshot,actor_label)
                SELECT tenant_id,'forged',product_id,2,'PURCHASE',1,1000,999,11000,actor_id,actor_roles,package_mnt,reference,product_snapshot,actor_label
                FROM prsystem.minibar_receipt WHERE tenant_id=%s AND product_id=%s''', (self.tenant,product))
        with self.assertRaises(psycopg.Error), psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.minibar_receipt SET quantity=0 WHERE tenant_id=%s', (self.tenant,))
        with self.assertRaises(psycopg.Error), psycopg.connect(self.owner_dsn) as conn:
            conn.execute('DELETE FROM prsystem.minibar_receipt WHERE tenant_id=%s', (self.tenant,))
        self.assertEqual(self.ok(self.call(),200)['items'][0]['warehouse_quantity'],10)

    def test_commit_failure_rolls_back_product_ledger_audit_and_receipt(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_minibar_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_minibar_commit AFTER INSERT ON prsystem.minibar_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_minibar_commit()').format(sql.Literal(self.tenant)))
        try:
            self.ok(self.create(), 503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_minibar_commit ON prsystem.minibar_receipt')
                conn.execute('DROP FUNCTION prsystem.fail_minibar_commit()')
        with psycopg.connect(self.owner_dsn) as conn:
            for table in ('minibar_product','minibar_receipt','operational_event','staff_command_receipt'):
                self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.'+table+' WHERE tenant_id=%s', (self.tenant,)).fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT posted FROM prsystem.cash_drawer WHERE tenant_id=%s', (self.tenant,)).fetchone()[0], 100000)
        self.ok(self.create())
