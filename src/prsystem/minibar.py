"""Canonical product/opening/purchase records, separate from Reception mock stock.

Warehouse availability subtracts canonical room transfers from hotel-wide stock.
Receipts and transfers create no sales or cash events.
Costs stay exact as integer inventory value and a rational average, never float.
"""

import secrets
from fractions import Fraction
from psycopg.types.json import Jsonb

from prsystem.common import DomainError, money
from prsystem.postgres.connection import transaction
from prsystem.rooms import RoomService
from prsystem.subscription import AccessFacts, Action, subscription_gate


def inventory_average(value, quantity):
    if not quantity:
        return None
    cost = Fraction(value, quantity)
    return dict(numerator=str(cost.numerator), denominator=str(cost.denominator))


class MinibarWarehouse(RoomService):
    def actor(self, conn, bearer, tenant):
        principal, _ = self.auth._authenticate(conn, bearer, tenant)
        package, expiry, suspended = conn.execute(
            'SELECT package_mnt,expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',
            (tenant,),
        ).fetchone()
        facts = AccessFacts(tenant, True, True, True,
                            self._manager(principal['roles'], package),
                            package in (25000, 30000), True, True, suspended)
        decision = subscription_gate(Action.CONFIGURE, facts, expiry,
                                     conn.execute('SELECT clock_timestamp()').fetchone()[0])
        if not decision.allowed:
            raise DomainError(decision.code)
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)", (tenant,))
        return principal['account_id'], principal['roles'], package

    @staticmethod
    def stock(conn, tenant, product):
        row = conn.execute('''SELECT stock_revision,total_quantity_after,inventory_value_after,inventory_value_denominator
            FROM prsystem.minibar_receipt WHERE tenant_id=%s AND product_id=%s
            ORDER BY stock_revision DESC LIMIT 1''', (tenant, product)).fetchone()
        if row is None:
            raise DomainError('STOCK_SOURCE_NOT_FOUND')
        return row[0], row[1], Fraction(int(row[2]),int(row[3]))

    @staticmethod
    def balance(revision, quantity, value, room_quantity=0):
        return dict(stock_revision=revision, warehouse_quantity=quantity-room_quantity, total_quantity=quantity, room_quantity=room_quantity,
                    inventory_value_mnt=str(value), inventory_value_exact=dict(numerator=str(Fraction(value).numerator),denominator=str(Fraction(value).denominator)), average_cost=inventory_average(value, quantity))

    def post(self, conn, tenant, product, kind, quantity, cost, reference, actor, roles, package, prior):
        version, before, value = prior
        after = before + quantity
        money(after)
        value += quantity * cost
        in_rooms = conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s)',(tenant,product)).fetchone()[0]
        movement = secrets.token_hex(16)
        actor_label = conn.execute("SELECT coalesce(nullif(display_name,''),email) FROM prsystem.staff_account WHERE id=%s", (actor,)).fetchone()[0]
        snapshot = conn.execute('''SELECT jsonb_build_object('name',name,'category',category,
            'unit',unit,'selling_price_mnt',selling_price_mnt,'revision',revision)
            FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s''', (tenant, product)).fetchone()[0]
        conn.execute('''INSERT INTO prsystem.minibar_receipt
            (tenant_id,id,product_id,stock_revision,kind,quantity,unit_cost_mnt,warehouse_after,
             inventory_value_after,inventory_value_denominator,actor_id,actor_roles,package_mnt,reference,product_snapshot,actor_label)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
            (tenant, movement, product, version+1, kind, quantity, cost, after-in_rooms,
             Fraction(value).numerator, Fraction(value).denominator, actor, roles, package, reference, Jsonb(snapshot), actor_label))
        result = dict(product_id=product, receipt_id=movement, kind=kind,
                      **self.balance(version+1, after, value, in_rooms))
        self.event(conn, tenant, actor, 'MINIBAR_'+kind, product,
                   dict(result, quantity=quantity, unit_cost_mnt=cost, warehouse_before=before-in_rooms,
                        actor_roles=roles, package_mnt=package, reference=reference))
        return result

    def create(self, bearer, tenant, data, key):
        data = dict(data, name=self._text(data['name']), category=self._text(data['category']),
                    unit=self._text(data['unit'], 50))
        money(data['selling_price_mnt'], positive=True)
        money(data['unit_cost_mnt'])
        money(data['opening_quantity'])
        if data['status'] not in {'ACTIVE', 'INACTIVE'}:
            raise DomainError('INVALID_REQUEST')
        command = dict(action='MINIBAR_PRODUCT_CREATE', data=data)
        with transaction(self.auth.dsn) as conn:
            actor, roles, package = self.actor(conn, bearer, tenant)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            self._catalog_lock(conn, tenant)
            product = secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.minibar_product
                (tenant_id,id,name,category,unit,selling_price_mnt,initial_unit_cost_mnt,status)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant, product, data['name'], data['category'], data['unit'],
                 data['selling_price_mnt'], data['unit_cost_mnt'], data['status']))
            result = self.post(conn, tenant, product, 'OPENING', data['opening_quantity'],
                               data['unit_cost_mnt'], '', actor, roles, package, (0, 0, 0))
            result.update(name=data['name'], status=data['status'])
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def receive(self, bearer, tenant, product, quantity, cost, revision, reference, key):
        money(quantity, positive=True)
        money(cost)
        if type(revision) is not int or revision < 1:
            raise DomainError('INVALID_REQUEST')
        reference = self._text(reference, 200) if reference else ''
        command = dict(action='MINIBAR_STOCK_RECEIPT', product=product, quantity=quantity,
                       unit_cost_mnt=cost, expected_revision=revision, reference=reference)
        with transaction(self.auth.dsn) as conn:
            actor, roles, package = self.actor(conn, bearer, tenant)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            self._catalog_lock(conn, tenant)
            row = conn.execute('SELECT status FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s FOR UPDATE',
                               (tenant, product)).fetchone()
            if not row:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[0] != 'ACTIVE':
                raise DomainError('PRODUCT_NOT_ACTIVE')
            prior = self.stock(conn, tenant, product)
            if prior[0] != revision:
                raise DomainError('REVISION_CONFLICT')
            result = self.post(conn, tenant, product, 'PURCHASE', quantity, cost, reference,
                               actor, roles, package, prior)
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def products(self, bearer, tenant, after='', limit=50):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn, bearer, tenant)
            rows = conn.execute('''SELECT p.id,p.name,p.category,p.unit,p.selling_price_mnt,p.status,
                p.initial_unit_cost_mnt,s.stock_revision,s.total_quantity_after,s.inventory_value_after,prsystem.minibar_room_quantity(p.tenant_id,p.id),s.inventory_value_denominator
                FROM prsystem.minibar_product p JOIN LATERAL
                (SELECT stock_revision,total_quantity_after,inventory_value_after,inventory_value_denominator FROM prsystem.minibar_receipt
                 WHERE tenant_id=p.tenant_id AND product_id=p.id ORDER BY stock_revision DESC LIMIT 1) s ON true
                WHERE p.tenant_id=%s AND p.id>%s ORDER BY p.id LIMIT %s''', (tenant, after, limit+1)).fetchall()
            items = [dict(product_id=r[0], name=r[1], category=r[2], unit=r[3], selling_price_mnt=r[4],
                          status=r[5], initial_unit_cost_mnt=r[6], **self.balance(r[7], r[8], Fraction(int(r[9]),int(r[11])), r[10]))
                     for r in rows[:limit]]
            return dict(items=items, next_after=items[-1]['product_id'] if len(rows)>limit else None)

    def ledger(self, bearer, tenant, product, after=0, limit=50):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn, bearer, tenant)
            if not conn.execute('SELECT 1 FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s',
                                (tenant, product)).fetchone():
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            rows = conn.execute('''SELECT id,stock_revision,kind,quantity,unit_cost_mnt,warehouse_after,
                inventory_value_after,actor_id,actor_roles,reference,recorded_at,package_mnt,product_snapshot,actor_label,total_quantity_after,inventory_value_denominator,cost_numerator,cost_denominator,report_stay_id,report_revision,original_receipt_id
                FROM prsystem.minibar_receipt WHERE tenant_id=%s AND product_id=%s AND stock_revision>%s
                ORDER BY stock_revision LIMIT %s''', (tenant, product, after, limit+1)).fetchall()
            items = [dict(receipt_id=r[0], kind=r[2], quantity=r[3], unit_cost_mnt=r[4],
                          **self.balance(r[1], r[14], Fraction(int(r[6]),int(r[15])),r[14]-r[5]), actor_id=r[7], actor_roles=r[8],
                          cost=dict(numerator=str(r[16]),denominator=str(r[17])) if r[2].startswith('CONSUMPTION') else dict(numerator=str(r[4]),denominator='1'),stay_id=r[18],report_revision=r[19],original_receipt_id=r[20],
                          reference=r[9], recorded_at=r[10], package_mnt=r[11], product_snapshot=r[12], actor_label=r[13]) for r in rows[:limit]]
            return dict(items=items, next_after=items[-1]['stock_revision'] if len(rows)>limit else None)
