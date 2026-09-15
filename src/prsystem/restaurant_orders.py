"""Scoped restaurant commands with durable invoice intent and order row locks.

Gateway instances are injected by trusted deployment configuration per restaurant.
HTTP clients can request reconciliation but cannot supply provider results.
"""
import secrets
from dataclasses import asdict
from datetime import date, datetime

from psycopg.types.json import Jsonb

from prsystem.auth import digest
from prsystem.common import DomainError, identifier, money
from prsystem.postgres.connection import transaction
from prsystem.restaurant_identity import RestaurantIdentity
from prsystem.restaurant_policy import Order, TERMINAL, invoice_expiry, opening_window, quote_items


def encode(order):
    return {k: v.isoformat() if isinstance(v, datetime) else v for k, v in asdict(order).items()}


def decode(state):
    return Order(**{k: datetime.fromisoformat(v) if k.endswith('_at') and v is not None else v for k, v in state.items()})


class RestaurantOrders:
    def __init__(self, auth, identities, gateways=None, runtime_mode='production'):
        self.auth, self.identities = auth, identities
        self.gateways, self.runtime_mode = gateways or {}, runtime_mode
        if any(getattr(g, 'is_mock', False) for g in self.gateways.values()):
            from prsystem.mock_providers import require_development_database
            require_development_database(auth.dsn, runtime_mode)

    def gateway(self, restaurant, merchant=None):
        gateway = self.gateways.get(restaurant)
        if gateway is None:
            raise DomainError('RESTAURANT_PROVIDER_UNAVAILABLE')
        if merchant is not None and gateway.merchant_id != merchant:
            raise DomainError('RESTAURANT_MERCHANT_CHANGED')
        return gateway

    @staticmethod
    def now(conn):
        return conn.execute('SELECT clock_timestamp()').fetchone()[0]

    @staticmethod
    def scope(conn, *, tenant='', restaurant=''):
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true),set_config('prsystem.restaurant_id',%s,true)", (tenant, restaurant))

    def restaurant_actor(self, conn, bearer, restaurant):
        principal, _ = self.auth._authenticate(conn, bearer, restaurant=restaurant)
        self.scope(conn, restaurant=restaurant)
        return 'staff:' + principal['account_id']

    def guest(self, conn, bearer, *, ordering=False):
        identity = conn.execute('SELECT tenant_id,room_id,stay_id FROM prsystem.guest_session WHERE token_hash=%s', (digest(bearer),)).fetchone()
        if not identity:
            raise DomainError('INVALID_GUEST_ACCESS')
        tenant, room, stay = identity
        self.scope(conn, tenant=tenant)
        conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant, room)).fetchone()
        row = conn.execute('SELECT state FROM prsystem.stay WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant, stay)).fetchone()
        valid = conn.execute('''SELECT 1 FROM prsystem.guest_session g JOIN prsystem.room_guest_qr q
            ON(q.tenant_id,q.room_id,q.revision)=(g.tenant_id,g.room_id,g.qr_revision)
            WHERE g.token_hash=%s AND g.revoked_at IS NULL''', (digest(bearer),)).fetchone()
        if row != ('ACTIVE',) or not valid:
            raise DomainError('INVALID_GUEST_ACCESS')
        access = conn.execute('SELECT package_mnt,expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE', (tenant,)).fetchone()
        if not access or access[0] != 30000 or access[2]:
            raise DomainError('FORBIDDEN')
        if ordering:
            if self.now(conn) >= access[1]:
                raise DomainError('SUBSCRIPTION_EXPIRED')
            if conn.execute('SELECT 1 FROM prsystem.reception_checkout_intent WHERE tenant_id=%s AND stay_id=%s', (tenant, stay)).fetchone():
                raise DomainError('CHECKOUT_ALREADY_INITIATED')
        return tenant, room, stay, 'guest:' + digest(bearer)

    @staticmethod
    def receipt(conn, scope, key, actor, command):
        identifier(key)
        if len(key) > 128:
            raise DomainError('INVALID_IDENTIFIER')
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('restaurant:' + scope + ':' + key,))
        row = conn.execute('SELECT actor,command,result FROM prsystem.restaurant_command_receipt WHERE scope=%s AND key=%s', (scope, key)).fetchone()
        if row:
            if row[:2] != (actor, command):
                raise DomainError('IDEMPOTENCY_CONFLICT')
            return row[2]

    @staticmethod
    def save_receipt(conn, scope, key, actor, command, result):
        conn.execute('INSERT INTO prsystem.restaurant_command_receipt VALUES(%s,%s,%s,%s,%s)', (scope, key, actor, Jsonb(command), Jsonb(result)))

    @staticmethod
    def lock_link(conn, tenant, restaurant):
        row = conn.execute('SELECT active,revision FROM prsystem.hotel_restaurant WHERE tenant_id=%s AND restaurant_id=%s FOR UPDATE', (tenant, restaurant)).fetchone()
        if row is None:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        return row

    @staticmethod
    def paused(conn, tenant, restaurant, now):
        return bool(conn.execute('''SELECT 1 FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND restaurant_id=%s
            AND state->>'refund_request' IN ('OPEN','APPROVED')
            AND (state->>'refund_requested_at')::timestamptz<=%s-interval '30 minutes' LIMIT 1''', (tenant, restaurant, now)).fetchone())

    @staticmethod
    def venue(conn, restaurant):
        row = conn.execute('SELECT name,phone,weekly_hours FROM prsystem.restaurant WHERE id=%s FOR SHARE', (restaurant,)).fetchone()
        if row is None:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        closures = [r[0] for r in conn.execute('SELECT closed_date FROM prsystem.restaurant_schedule_exception WHERE restaurant_id=%s', (restaurant,)).fetchall()]
        return row, closures

    def menu(self, bearer, restaurant):
        with transaction(self.auth.dsn) as conn:
            tenant, _, _, _ = self.guest(conn, bearer)
            link = self.lock_link(conn, tenant, restaurant)
            venue, closures = self.venue(conn, restaurant)
            now = self.now(conn)
            rows = conn.execute('''SELECT id,category,name,description,price_mnt,available,revision,image_data
                FROM prsystem.restaurant_menu_item WHERE restaurant_id=%s AND active ORDER BY category,name,id LIMIT 501''', (restaurant,)).fetchall()
            return dict(restaurant_id=restaurant, name=venue[0],
                        ordering_available=link[0] and not self.paused(conn, tenant, restaurant, now) and opening_window(venue[2], closures, now) is not None,
                        items=[dict(zip(('item_id','category','name','description','price_mnt','available','revision','image_data'), r)) for r in rows[:500]],
                        truncated=len(rows)>500)

    def guest_restaurants(self, bearer):
        with transaction(self.auth.dsn) as conn:
            tenant, _, _, _ = self.guest(conn, bearer)
            rows = conn.execute('''SELECT r.id,r.name,h.active FROM prsystem.hotel_restaurant h
                JOIN prsystem.restaurant r ON r.id=h.restaurant_id WHERE h.tenant_id=%s ORDER BY r.name,r.id LIMIT 100''', (tenant,)).fetchall()
            return [dict(restaurant_id=r[0],name=r[1],active=r[2]) for r in rows]

    def guest_orders(self, bearer, after=''):
        with transaction(self.auth.dsn) as conn:
            tenant, _, stay, _ = self.guest(conn, bearer)
            rows = conn.execute('''SELECT id FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND stay_id=%s
                AND id>%s ORDER BY id LIMIT 51''', (tenant,stay,after)).fetchall()
            return dict(orders=[self.view(conn,self.record(conn,tenant,r[0])) for r in rows[:50]],next_after=rows[49][0] if len(rows)>50 else None)

    def own_menu(self, bearer, restaurant, after=''):
        with transaction(self.auth.dsn) as conn:
            self.restaurant_actor(conn,bearer,restaurant)
            rows=conn.execute('''SELECT id,category,name,description,price_mnt,active,available,revision,image_data
                FROM prsystem.restaurant_menu_item WHERE restaurant_id=%s AND id>%s ORDER BY id LIMIT 51''',(restaurant,after)).fetchall()
            return dict(items=[dict(zip(('item_id','category','name','description','price_mnt','active','available','revision','image_data'),r)) for r in rows[:50]],
                        next_after=rows[49][0] if len(rows)>50 else None)

    def image(self,bearer,restaurant,item_id,image,revision,key):
        from prsystem.image_assets import menu_image
        canonical=menu_image(image) if image is not None else None
        command=dict(action='MENU_IMAGE',item_id=item_id,image_hash=digest(canonical) if canonical else None,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self.restaurant_actor(conn,bearer,restaurant)
            replay=self.receipt(conn,restaurant,key,actor,command)
            if replay is not None:return replay
            row=conn.execute('SELECT revision FROM prsystem.restaurant_menu_item WHERE restaurant_id=%s AND id=%s FOR UPDATE',(restaurant,item_id)).fetchone()
            if row is None:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[0]!=revision:raise DomainError('REVISION_CONFLICT')
            conn.execute('UPDATE prsystem.restaurant_menu_item SET image_data=%s,revision=revision+1 WHERE restaurant_id=%s AND id=%s',(canonical,restaurant,item_id))
            result=dict(item_id=item_id,revision=revision+1)
            self.save_receipt(conn,restaurant,key,actor,command,result);return result

    def hotel_restaurants(self,bearer,tenant):
        with transaction(self.auth.dsn) as conn:
            actor=self.identities._owner(conn,bearer,tenant)
            rows=conn.execute('''SELECT r.id,r.name,h.active,h.revision,r.revision FROM prsystem.restaurant r
                JOIN prsystem.hotel_restaurant h ON h.restaurant_id=r.id WHERE h.tenant_id=%s AND r.created_by=%s ORDER BY r.name,r.id LIMIT 100''',(tenant,actor)).fetchall()
            return [dict(zip(('restaurant_id','name','active','link_revision','revision'),r)) for r in rows]

    @staticmethod
    def profile_data(conn,restaurant):
        row=conn.execute('SELECT name,category,description,address,latitude,longitude,phone,weekly_hours,revision FROM prsystem.restaurant WHERE id=%s',(restaurant,)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        result=dict(zip(('name','category','description','address','latitude','longitude','phone','weekly_hours','revision'),row))
        result['closed_dates']=[r[0].isoformat() for r in conn.execute('SELECT closed_date FROM prsystem.restaurant_schedule_exception WHERE restaurant_id=%s ORDER BY closed_date',(restaurant,)).fetchall()]
        return result

    def profile(self,bearer,tenant,restaurant,data=None,key=None):
        with transaction(self.auth.dsn) as conn:
            actor=self.identities._owner(conn,bearer,tenant,restaurant)
            if data is None:return self.profile_data(conn,restaurant)
            command=dict(action='RESTAURANT_PROFILE',restaurant=restaurant,data=data)
            replay=self.receipt(conn,tenant,key,'staff:'+actor,command)
            if replay is not None:return replay
            reason=self.identities._text(data['reason'],1000)
            try:closures=[date.fromisoformat(v) for v in data['closed_dates']]
            except (ValueError,TypeError):raise DomainError('INVALID_RESTAURANT_CLOSURES') from None
            opening_window(data['weekly_hours'],closures,self.now(conn))
            conn.execute('SELECT id FROM prsystem.restaurant WHERE id=%s FOR UPDATE',(restaurant,)).fetchone()
            before=self.profile_data(conn,restaurant)
            if before['revision']!=data['expected_revision']:raise DomainError('REVISION_CONFLICT')
            conn.execute('''UPDATE prsystem.restaurant SET name=%s,category=%s,description=%s,address=%s,latitude=%s,longitude=%s,
                phone=%s,weekly_hours=%s,revision=revision+1 WHERE id=%s''',(data['name'],data['category'],data['description'],data['address'],data['latitude'],data['longitude'],data['phone'],Jsonb(data['weekly_hours']),restaurant))
            conn.execute('DELETE FROM prsystem.restaurant_schedule_exception WHERE restaurant_id=%s',(restaurant,))
            for closed in sorted(set(closures)):
                conn.execute('INSERT INTO prsystem.restaurant_schedule_exception VALUES(%s,%s)',(restaurant,closed))
            after=self.profile_data(conn,restaurant)
            conn.execute('INSERT INTO prsystem.restaurant_configuration_event(restaurant_id,revision,actor_id,reason,before_snapshot,after_snapshot) VALUES(%s,%s,%s,%s,%s,%s)',
                (restaurant,after['revision'],actor,reason,Jsonb(before),Jsonb(after)))
            result=dict(restaurant_id=restaurant,revision=after['revision'])
            self.save_receipt(conn,tenant,key,'staff:'+actor,command,result);return result

    def guest_logout(self, bearer):
        with transaction(self.auth.dsn) as conn:
            self.guest(conn,bearer)
            conn.execute('UPDATE prsystem.guest_session SET revoked_at=clock_timestamp() WHERE token_hash=%s',(digest(bearer),))
            return dict(status='SIGNED_OUT')

    def menu_item(self, bearer, restaurant, item_id, data, revision, key):
        identifier(item_id)
        money(data['price_mnt'], positive=True)
        if type(data['active']) is not bool or type(data['available']) is not bool:
            raise DomainError('INVALID_REQUEST')
        for field, maximum in [('name',200), ('category',100), ('description',2000)]:
            if not isinstance(data[field], str) or len(data[field]) > maximum or (field != 'description' and not data[field].strip()):
                raise DomainError('INVALID_REQUEST')
        command = dict(action='MENU_ITEM', item_id=item_id, data=data, revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor = self.restaurant_actor(conn, bearer, restaurant)
            replay = self.receipt(conn, restaurant, key, actor, command)
            if replay is not None:
                return replay
            conn.execute('SELECT id FROM prsystem.restaurant WHERE id=%s FOR UPDATE', (restaurant,)).fetchone()
            row = conn.execute('SELECT revision FROM prsystem.restaurant_menu_item WHERE restaurant_id=%s AND id=%s FOR UPDATE', (restaurant, item_id)).fetchone()
            if revision != (row[0] if row else 0):
                raise DomainError('REVISION_CONFLICT')
            conn.execute('''INSERT INTO prsystem.restaurant_menu_item(restaurant_id,id,category,name,description,price_mnt,active,available,revision)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(restaurant_id,id) DO UPDATE SET
                category=EXCLUDED.category,name=EXCLUDED.name,description=EXCLUDED.description,price_mnt=EXCLUDED.price_mnt,
                active=EXCLUDED.active,available=EXCLUDED.available,revision=EXCLUDED.revision''',
                (restaurant, item_id, data['category'], data['name'], data['description'], data['price_mnt'], data['active'], data['available'], revision+1))
            result = dict(item_id=item_id, revision=revision+1)
            self.save_receipt(conn, restaurant, key, actor, command, result)
            return result

    def set_link(self, bearer, tenant, restaurant, active, revision, key):
        if type(active) is not bool:
            raise DomainError('INVALID_REQUEST')
        command = dict(action='RESTAURANT_LINK_STATE', restaurant=restaurant, active=active, revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor = 'staff:' + self.identities._owner(conn, bearer, tenant, restaurant)
            self.scope(conn, tenant=tenant)
            replay = self.receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            link = self.lock_link(conn, tenant, restaurant)
            if link[1] != revision:
                raise DomainError('REVISION_CONFLICT')
            conn.execute('UPDATE prsystem.hotel_restaurant SET active=%s,revision=revision+1 WHERE tenant_id=%s AND restaurant_id=%s', (active, tenant, restaurant))
            if not active:
                rows = conn.execute('''SELECT id FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND restaurant_id=%s
                    AND state->>'payment'='PENDING' ORDER BY id FOR UPDATE''', (tenant, restaurant)).fetchall()
                for (order_id,) in rows:
                    row = self.record(conn, tenant, order_id)
                    self.save(conn, row, decode(row['state']).expire(self.now(conn), inactive=True), actor, 'LINK_DISABLED')
            result = dict(restaurant_id=restaurant, active=active, revision=revision+1)
            self.save_receipt(conn, tenant, key, actor, command, result)
            return result

    @staticmethod
    def record(conn, tenant, order_id):
        row = conn.execute('''SELECT tenant_id,id,restaurant_id,stay_id,merchant_id,amount_mnt,items,contact_phone_snapshot,
            restaurant_name_snapshot,room_number_snapshot,created_at,expires_at,invoice_id,state,revision
            FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND id=%s FOR UPDATE''', (tenant, order_id)).fetchone()
        if row is None:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        return dict(zip(('tenant_id','order_id','restaurant_id','stay_id','merchant_id','amount_mnt','items','contact_phone_snapshot',
                         'restaurant_name_snapshot','room_number_snapshot','created_at','expires_at','invoice_id','state','revision'), row))

    @staticmethod
    def save(conn, row, state, actor, action):
        encoded = encode(state)
        if encoded == row['state']:
            return row
        revision = row['revision'] + 1
        conn.execute('UPDATE prsystem.restaurant_order_record SET invoice_id=%s,state=%s,revision=%s WHERE tenant_id=%s AND id=%s',
                     (state.invoice_id, Jsonb(encoded), revision, row['tenant_id'], row['order_id']))
        conn.execute('INSERT INTO prsystem.restaurant_order_event(tenant_id,restaurant_id,order_id,revision,actor,action,before_state,after_state) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                     (row['tenant_id'], row['restaurant_id'], row['order_id'], revision, actor, action, Jsonb(row['state']) if row['state'] is not None else None, Jsonb(encoded)))
        return dict(row, invoice_id=state.invoice_id, state=encoded, revision=revision)

    def create(self, bearer, restaurant, quantities, key):
        command = dict(action='CREATE_RESTAURANT_ORDER', restaurant_id=restaurant, quantities=quantities)
        # The intent commits before the provider call. Retries use its pinned
        # amount and stable ID even after a crash or later menu edits.
        with transaction(self.auth.dsn) as conn:
            tenant, room, stay, actor = self.guest(conn, bearer, ordering=True)
            replay = self.receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            link = self.lock_link(conn, tenant, restaurant)
            venue, closures = self.venue(conn, restaurant)
            now = self.now(conn)
            if not link[0] or self.paused(conn, tenant, restaurant, now):
                raise DomainError('RESTAURANT_LINK_UNAVAILABLE')
            expires = invoice_expiry(venue[2], closures, now)
            rows = conn.execute('SELECT id,name,price_mnt,active,available FROM prsystem.restaurant_menu_item WHERE restaurant_id=%s ORDER BY id FOR SHARE', (restaurant,)).fetchall()
            catalog = {r[0]: dict(zip(('name','price_mnt','active','available'), r[1:])) for r in rows}
            items, total = quote_items(catalog, quantities)
            merchant = self.gateway(restaurant).merchant_id
            number = conn.execute('SELECT number FROM prsystem.room WHERE tenant_id=%s AND id=%s', (tenant, room)).fetchone()[0]
            order_id = secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.restaurant_order_record(tenant_id,id,restaurant_id,stay_id,merchant_id,amount_mnt,items,
                contact_phone_snapshot,restaurant_name_snapshot,room_number_snapshot,created_at,expires_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant, order_id, restaurant, stay, merchant, total, Jsonb(items), venue[1], venue[0], number, now, expires))
            result = dict(order_id=order_id, amount_mnt=total, expires_at=expires.isoformat(), revision=0, invoice_id=None)
            self.save_receipt(conn, tenant, key, actor, command, result)
            return result

    def invoice(self, bearer, order_id):
        with transaction(self.auth.dsn) as conn:
            tenant, _, stay, actor = self.guest(conn, bearer, ordering=True)
            # Lock link before order, consistently with link disable and captures.
            ref = conn.execute('SELECT restaurant_id FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND id=%s AND stay_id=%s', (tenant, order_id, stay)).fetchone()
            if not ref:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            link = self.lock_link(conn, tenant, ref[0])
            row = self.record(conn, tenant, order_id)
            if row['invoice_id'] is not None:
                return self.view(conn, row)
            now = self.now(conn)
            if not link[0] or now >= row['expires_at'] or self.paused(conn, tenant, ref[0], now):
                raise DomainError('RESTAURANT_LINK_UNAVAILABLE')
            venue, closures = self.venue(conn, ref[0])
            if opening_window(venue[2], closures, now) is None:
                raise DomainError('RESTAURANT_CLOSED')
            gateway = self.gateway(ref[0], row['merchant_id'])
            invoice = gateway.create_invoice(order_id, row['amount_mnt'], 'MNT')
            state = Order(invoice, row['merchant_id'], row['amount_mnt'], row['created_at'], row['expires_at'])
            row = self.save(conn, row, state, actor, 'INVOICE_CREATED')
            return self.view(conn, row)

    def view(self, conn, row):
        result = {k: v for k, v in row.items() if k not in {'merchant_id'}}
        result['contact_phone'] = conn.execute('SELECT phone FROM prsystem.restaurant WHERE id=%s', (row['restaurant_id'],)).fetchone()[0]
        result['alerts'] = decode(row['state']).alerts(self.now(conn)) if row['state'] else {}
        return result

    def guest_detail(self, bearer, order_id):
        with transaction(self.auth.dsn) as conn:
            tenant, _, stay, _ = self.guest(conn, bearer)
            row = self.record(conn, tenant, order_id)
            if row['stay_id'] != stay:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            return self.view(conn, row)

    def restaurant_queue(self, bearer, restaurant, after='', limit=50):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise DomainError('INVALID_REQUEST')
        with transaction(self.auth.dsn) as conn:
            self.restaurant_actor(conn, bearer, restaurant)
            rows = conn.execute('''SELECT tenant_id,id FROM prsystem.restaurant_order_record WHERE restaurant_id=%s
                AND id>%s AND state->>'payment'='PAID' ORDER BY id LIMIT %s''', (restaurant, after, limit+1)).fetchall()
            return dict(orders=[self.view(conn, self.record(conn, tenant, order)) for tenant, order in rows[:limit]],
                        next_after=rows[limit-1][1] if len(rows)>limit else None)

    def command(self, bearer, tenant, order_id, action, revision, key, data=None, *, restaurant=None, hotel_staff=False):
        data = data or {}
        command = dict(action=action, order_id=order_id, revision=revision, data=data)
        with transaction(self.auth.dsn) as conn:
            if hotel_staff:
                principal=self.hotel_actor(conn,bearer,tenant)
                actor='staff:'+principal['account_id'];stay=None
                if action!='REQUEST_REFUND' or 'RECEPTION' not in principal['roles']:raise DomainError('FORBIDDEN')
            elif restaurant is None:
                actual_tenant, _, stay, actor = self.guest(conn, bearer)
                if actual_tenant != tenant or action not in {'REQUEST_REFUND', 'RECONCILE_PAYMENT'}:
                    raise DomainError('FORBIDDEN')
            else:
                actor = self.restaurant_actor(conn, bearer, restaurant)
                stay = None
            replay = self.receipt(conn, restaurant or tenant, key, actor, command)
            if replay is not None:
                return replay
            ref = conn.execute('SELECT restaurant_id,stay_id FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND id=%s', (tenant, order_id)).fetchone()
            if not ref or (restaurant is not None and ref[0] != restaurant) or (stay is not None and ref[1] != stay):
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            self.scope(conn, tenant=tenant, restaurant=restaurant or '')
            if action == 'RECONCILE_PAYMENT':
                # Use checkout's room -> stay order before locking the link/order.
                room = conn.execute('SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s', (tenant,ref[1])).fetchone()[0]
                conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant,room)).fetchone()
                conn.execute('SELECT id FROM prsystem.stay WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant,ref[1])).fetchone()
            link = self.lock_link(conn, tenant, ref[0])
            row = self.record(conn, tenant, order_id)
            if row['revision'] != revision:
                raise DomainError('REVISION_CONFLICT')
            if row['state'] is None:
                raise DomainError('RESTAURANT_INVOICE_REQUIRED')
            state, now = decode(row['state']), self.now(conn)
            if action == 'RECONCILE_PAYMENT':
                state=self.payment_state(conn,row,state,link,now)
            elif action == 'REQUEST_REFUND':
                if restaurant is not None:
                    raise DomainError('FORBIDDEN')
                state = state.request_refund(now)
            elif action == 'ACCEPT':
                state = state.accept(now, data.get('eta_minutes'))
            elif action == 'FULFILL':
                state = state.fulfill(now, data.get('fulfillment'))
            elif action == 'CANNOT_FULFILL':
                state = state.cannot_fulfill(now)
            elif action == 'DECIDE_REFUND':
                state = state.decide_refund(now, data.get('approve'), data.get('reason'))
            elif action == 'BEGIN_REFUND':
                # The same provider key is reused after ambiguous retries.
                attempt = state.refund_attempt_id or 'restaurant-refund:' + order_id
                state = state.begin_refund(now, attempt)
            elif action == 'RECONCILE_REFUND':
                state=self.refund_state(row,state,now)
            else:
                raise DomainError('INVALID_REQUEST')
            updated = self.save(conn, row, state, actor, action)
            self.emit(conn,updated,now)
            result = dict(order_id=order_id, revision=updated['revision'], state=updated['state'])
            self.save_receipt(conn, restaurant or tenant, key, actor, command, result)
            return result

    def payment_state(self,conn,row,state,link,now,evidence=None):
        evidence=evidence or self.gateway(row['restaurant_id'],row['merchant_id']).payment(row['order_id'],row['invoice_id'])
        if evidence['status']=='SUCCEEDED':
            items=conn.execute('SELECT id,active,available FROM prsystem.restaurant_menu_item WHERE restaurant_id=%s FOR SHARE',(row['restaurant_id'],)).fetchall()
            eligible_items={item[0] for item in items if item[1] and item[2]}
            active_stay=conn.execute("SELECT state='ACTIVE' FROM prsystem.stay WHERE tenant_id=%s AND id=%s",(row['tenant_id'],row['stay_id'])).fetchone()[0]
            active_account=conn.execute("""SELECT 1 FROM prsystem.restaurant_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
                WHERE m.restaurant_id=%s AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL LIMIT 1""",(row['restaurant_id'],)).fetchone()
            eligible=bool(link[0] and active_stay and active_account and all(item['item_id'] in eligible_items for item in row['items']))
            venue,closures=self.venue(conn,row['restaurant_id'])
            return state.capture(now,merchant_id=evidence['merchant_id'],invoice_id=evidence['invoice_id'],amount_mnt=evidence['amount'],
                currency=evidence['currency'],payment_id=evidence['payment_id'],eligible=eligible,within_hours=opening_window(venue[2],closures,now) is not None)
        return state.expire(now) if now>=state.expires_at else state

    def refund_state(self,row,state,now):
        if state.refund not in {'PENDING','FAILED','REFUNDED'}:raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        gateway=self.gateway(row['restaurant_id'],row['merchant_id'])
        gateway.create_refund(state.refund_attempt_id,state.payment_id,state.amount_mnt)
        evidence=gateway.refund(state.refund_attempt_id)
        if evidence['original']!=state.payment_id:raise DomainError('RESTAURANT_REFUND_MISMATCH')
        if evidence['status'] in {'SUCCEEDED','FINAL_FAILED','NOT_PROCESSED','VOIDED'}:
            return state.refund_result(now,attempt_id=state.refund_attempt_id,merchant_id=evidence['merchant_id'],invoice_id=state.invoice_id,
                amount_mnt=evidence['amount'],currency=evidence['currency'],succeeded=evidence['status']=='SUCCEEDED',provider_id=evidence['reference'])
        return state

    @staticmethod
    def emit(conn,row,now,extra=None):
        if row['state'] is None:return
        state=decode(row['state']);alerts=state.alerts(now);events=[]
        if state.payment=='PAID':events.append(('ORDER_PAID','RESTAURANT'))
        if state.refund_request!='NONE':events.append(('REFUND_REQUESTED','RESTAURANT'))
        mapping={'acceptance_warning':('ACCEPTANCE_WARNING',('GUEST','RESTAURANT')),
            'acceptance_reception':('ACCEPTANCE_LATE',('GUEST','RECEPTION')),
            'eta_warning':('ETA_WARNING',('GUEST','RESTAURANT')),'eta_refund_available':('ETA_LATE',('GUEST','RECEPTION')),
            'refund_reminder':('REFUND_REMINDER',('RESTAURANT',)),
            'refund_escalation':('REFUND_ESCALATED',('RECEPTION','MANAGER_PLUS')),
            'link_paused':('LINK_PAUSED',('RESTAURANT','RECEPTION','MANAGER_PLUS'))}
        for flag,(code,audiences) in mapping.items():
            if alerts[flag]:events.extend((code,audience) for audience in audiences)
        if state.refund=='FAILED':events.extend(('REFUND_FAILED',a) for a in ('RESTAURANT','MANAGER_PLUS'))
        if state.refund=='REFUNDED':events.extend(('REFUND_RESOLVED',a) for a in ('GUEST','RESTAURANT','RECEPTION','MANAGER_PLUS'))
        if extra:events.append((extra,'RESTAURANT'))
        for code,audience in events:
            conn.execute('''INSERT INTO prsystem.restaurant_notification(tenant_id,restaurant_id,order_id,code,audience,recorded_at)
                VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',(row['tenant_id'],row['restaurant_id'],row['order_id'],code,audience,now))

    def hotel_actor(self,conn,bearer,tenant):
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        access=conn.execute('SELECT package_mnt,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        if access!=(30000,False) or not set(principal['roles'])&{'RECEPTION','MANAGER_PLUS'}:raise DomainError('FORBIDDEN')
        self.scope(conn,tenant=tenant);return principal

    def notifications(self,bearer,*,restaurant=None,tenant=None,after=''):
        with transaction(self.auth.dsn) as conn:
            if restaurant:
                self.restaurant_actor(conn,bearer,restaurant);audiences=['RESTAURANT'];scope=restaurant
            else:
                principal=self.hotel_actor(conn,bearer,tenant);audiences=list(set(principal['roles'])&{'RECEPTION','MANAGER_PLUS'});scope=tenant
            column='restaurant_id' if restaurant else 'tenant_id'
            # Column comes only from the realm branch, never user input.
            rows=conn.execute('''SELECT n.order_id,n.code,n.recorded_at,o.room_number_snapshot,o.restaurant_name_snapshot,o.tenant_id,
                n.order_id||':'||n.code||':'||n.audience AS notification_id
                FROM prsystem.restaurant_notification n JOIN prsystem.restaurant_order_record o ON(o.tenant_id,o.id)=(n.tenant_id,n.order_id)
                WHERE n.'''+column+'''=%s AND n.audience=ANY(%s) AND n.order_id||':'||n.code||':'||n.audience>%s
                ORDER BY notification_id LIMIT 101''',(scope,audiences,after)).fetchall()
            return dict(items=[dict(zip(('order_id','code','recorded_at','room_number','restaurant_name','tenant_id','notification_id'),r)) for r in rows[:100]],
                        next_after=rows[99][6] if len(rows)>100 else None)

    def hotel_orders(self,bearer,tenant,after=''):
        with transaction(self.auth.dsn) as conn:
            self.hotel_actor(conn,bearer,tenant)
            rows=conn.execute("SELECT id FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND id>%s AND state->>'payment'='PAID' ORDER BY id LIMIT 51",(tenant,after)).fetchall()
            return dict(orders=[self.view(conn,self.record(conn,tenant,r[0])) for r in rows[:50]],next_after=rows[49][0] if len(rows)>50 else None)

    def tick(self,limit=25):
        """Trusted, bounded provider worker; no new invoices or refund decisions.

        A provider lookup can recover an already-created invoice after a crash.
        Sending a refund requires the restaurant's persisted BEGIN_REFUND first.
        """
        if type(limit) is not int or not 1<=limit<=100:raise DomainError('INVALID_REQUEST')
        outcomes=[];candidates=[]
        for restaurant in sorted(self.gateways):
            with transaction(self.auth.dsn) as conn:
                self.scope(conn,restaurant=restaurant)
                rows=conn.execute('''SELECT o.tenant_id,o.id,o.stay_id,c.checked_at,o.created_at FROM prsystem.restaurant_order_record o
                    LEFT JOIN prsystem.restaurant_worker_cursor c ON(c.tenant_id,c.order_id)=(o.tenant_id,o.id) WHERE o.restaurant_id=%s
                    AND (o.state IS NULL OR o.state->>'payment'<>'PAID' OR o.state->>'fulfillment' NOT IN ('CANCELLED','DELIVERED_TO_ROOM','HANDED_TO_RECEPTION','PICKED_UP_BY_GUEST')
                         OR o.state->>'refund_request' IN ('OPEN','APPROVED')) ORDER BY c.checked_at NULLS FIRST,o.created_at,o.id LIMIT %s''',(restaurant,limit)).fetchall()
            candidates.extend((*row,restaurant) for row in rows)
        candidates.sort(key=lambda r:(r[3] is not None,r[3] or r[4],r[4],r[1]))
        for tenant,order_id,stay,checked,created,restaurant in candidates[:limit]:
            try:
                with transaction(self.auth.dsn) as conn:
                    self.scope(conn,tenant=tenant,restaurant=restaurant)
                    room=conn.execute('SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()[0]
                    conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,room)).fetchone()
                    conn.execute('SELECT id FROM prsystem.stay WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,stay)).fetchone()
                    link=self.lock_link(conn,tenant,restaurant);row=self.record(conn,tenant,order_id);now=self.now(conn)
                    gateway=self.gateway(restaurant,row['merchant_id']);evidence=None
                    if row['state'] is None:
                        evidence=gateway.payment(order_id,None)
                        if (evidence['merchant_id'],evidence['amount'],evidence['currency'])!=(row['merchant_id'],row['amount_mnt'],'MNT'):
                            raise DomainError('RESTAURANT_PAYMENT_MISMATCH')
                        state=Order(evidence['invoice_id'],row['merchant_id'],row['amount_mnt'],row['created_at'],row['expires_at'])
                        row=self.save(conn,row,state,'provider:QPAY','INVOICE_RECOVERED')
                    state=decode(row['state'])
                    if state.payment!='PAID':state=self.payment_state(conn,row,state,link,now,evidence)
                    if state.refund in {'PENDING','FAILED'}:state=self.refund_state(row,state,now)
                    updated=self.save(conn,row,state,'provider:QPAY','PROVIDER_RECONCILED')
                    self.emit(conn,updated,now)
                    outcomes.append(dict(order_id=order_id,status='CHECKED'))
            except (DomainError,TimeoutError,OSError) as exc:
                outcomes.append(dict(order_id=order_id,status='RETRY_REQUIRED',code=str(exc) if isinstance(exc,DomainError) else 'PROVIDER_UNAVAILABLE'))
            with transaction(self.auth.dsn) as conn:
                self.scope(conn,tenant=tenant,restaurant=restaurant)
                conn.execute('''INSERT INTO prsystem.restaurant_worker_cursor VALUES(%s,%s,%s,clock_timestamp())
                    ON CONFLICT(tenant_id,order_id) DO UPDATE SET checked_at=EXCLUDED.checked_at''',(tenant,order_id,restaurant))
        return outcomes

    @staticmethod
    def checkout_orders(conn, tenant, stay):
        RestaurantOrders.scope(conn, tenant=tenant)
        return conn.execute('''SELECT id,restaurant_name_snapshot,contact_phone_snapshot,state->>'fulfillment'
            FROM prsystem.restaurant_order_record WHERE tenant_id=%s AND stay_id=%s AND state->>'payment'='PAID'
            AND state->>'fulfillment' NOT IN ('CANCELLED','DELIVERED_TO_ROOM','HANDED_TO_RECEPTION','PICKED_UP_BY_GUEST')
            ORDER BY id FOR UPDATE''', (tenant, stay)).fetchall()

    @staticmethod
    def checkout_apply(conn, tenant, stay, actor, choice):
        row = RestaurantOrders.record(conn, tenant, choice['order_id'])
        mode = 'RECEPTION' if choice['choice']=='RECEPTION_PICKUP' else choice['choice']
        state = decode(row['state']).checkout_handoff(RestaurantOrders.now(conn), mode, True)
        updated=RestaurantOrders.save(conn, row, state, 'staff:'+actor, 'CHECKOUT_HANDOFF')
        RestaurantOrders.emit(conn,updated,RestaurantOrders.now(conn),'GUEST_CHECKED_OUT')
        conn.execute('''INSERT INTO prsystem.restaurant_order_handoff(tenant_id,order_id,stay_id,actor_id,choice,guest_informed)
            VALUES(%s,%s,%s,%s,%s,true)''', (tenant, choice['order_id'], stay, actor, choice['choice']))
