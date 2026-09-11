"""Restaurant identity only: no menu, guest ordering, merchant or refund authority."""

import secrets

from psycopg.types.json import Jsonb

from prsystem.auth import digest
from prsystem.common import DomainError
from prsystem.postgres.connection import transaction
from prsystem.staff_commands import StaffCommands
from prsystem.staff_lifecycle import normalized_email
from prsystem.subscription import AccessFacts, Action, subscription_gate


class RestaurantIdentity(StaffCommands):
    def __init__(self, auth, links=None):
        super().__init__(auth)
        self.links = links

    def _links(self):
        if self.links is None:
            raise DomainError('LINK_SERVICE_UNAVAILABLE')
        return self.links

    @staticmethod
    def _event(conn, restaurant, tenant, actor, target, kind, details):
        conn.execute('''INSERT INTO prsystem.restaurant_staff_event
            (id, restaurant_id, sponsor_tenant_id, actor_id, target_id, kind, details)
            VALUES (%s, %s, %s, %s, %s, %s, %s)''',
            (secrets.token_hex(16), restaurant, tenant, actor, target, kind, Jsonb(details)))

    @staticmethod
    def _gate(conn, tenant, permission):
        hotel = conn.execute('''SELECT package_mnt, expires_at, security_suspended FROM prsystem.hotel_access
            WHERE tenant_id = %s FOR SHARE''', (tenant,)).fetchone()
        if hotel is None:
            raise DomainError('FORBIDDEN')
        facts = AccessFacts(tenant, True, True, True, permission, hotel[0] == 30000, True, True, hotel[2])
        result = subscription_gate(Action.CONFIGURE, facts, hotel[1], conn.execute('SELECT clock_timestamp()').fetchone()[0])
        if not result.allowed:
            raise DomainError(result.code)

    def _owner(self, conn, token, tenant, restaurant=None, target=None, *, require_link=True):
        identity = conn.execute('SELECT account_id FROM prsystem.staff_session WHERE token_hash = %s', (digest(token),)).fetchone()
        if identity is None:
            raise DomainError('UNAUTHENTICATED')
        self._lock_accounts(conn, {identity[0], target} - {None})
        principal, _ = self.auth._authenticate(conn, token, tenant)
        self._gate(conn, tenant, 'MANAGER_PLUS' in principal['roles'])
        if restaurant is not None:
            venue = conn.execute('SELECT created_by FROM prsystem.restaurant WHERE id = %s FOR SHARE', (restaurant,)).fetchone()
            if venue is None or venue[0] != principal['account_id']:
                raise DomainError('FORBIDDEN')
            if require_link:
                link = conn.execute('''SELECT revision FROM prsystem.hotel_restaurant
                    WHERE tenant_id = %s AND restaurant_id = %s FOR SHARE''', (tenant, restaurant)).fetchone()
                if link is None:
                    raise DomainError('FORBIDDEN')
        return principal['account_id']

    def _issue(self, conn, tenant, restaurant, target, actor, revision, epoch):
        links = self._links()
        conn.execute('''UPDATE prsystem.staff_link SET state = 'SUPERSEDED' WHERE restaurant_id = %s
            AND account_id = %s AND purpose = 'RESTAURANT_INVITE' AND state = 'ACTIVE' ''', (restaurant, target))
        link_id = secrets.token_hex(16)
        expires = conn.execute('SELECT clock_timestamp() + %s', (links.invite_ttl,)).fetchone()[0]
        conn.execute('''INSERT INTO prsystem.staff_link (id, purpose, account_id, inviter_id, membership_revision,
            issued_epoch, token_hash, expires_at, restaurant_id, sponsor_tenant_id)
            VALUES (%s, 'RESTAURANT_INVITE', %s, %s, %s, %s, %s, %s, %s, %s)''',
            (link_id, target, actor, revision, epoch, digest(links._token('RESTAURANT_INVITE', link_id)), expires, restaurant, tenant))
        conn.execute('INSERT INTO prsystem.staff_mail_intent (link_id) VALUES (%s)', (link_id,))
        return {'restaurant_id': restaurant, 'account_id': target, 'revision': revision, 'invitation_id': link_id,
                'state': 'ACTIVE', 'expires_at': expires.isoformat()}

    @staticmethod
    def _email_lock(conn, email):
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', (f'staff-email:{email}',))
        row = conn.execute('SELECT id FROM prsystem.staff_account WHERE email = %s', (email,)).fetchone()
        return row[0] if row else None

    def _invite(self, conn, tenant, restaurant, actor, target, email, name):
        if target is None:
            target = secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.staff_account (id, email, password_hash, display_name)
                VALUES (%s, %s, '!', %s)''', (target, email, name))
        account = conn.execute('SELECT status, auth_epoch FROM prsystem.staff_account WHERE id = %s', (target,)).fetchone()
        if account[0] != 'ACTIVE':
            raise DomainError('SECURITY_SUSPENDED')
        if conn.execute('''SELECT 1 FROM prsystem.restaurant_membership WHERE restaurant_id = %s
            AND account_id = %s FOR UPDATE''', (restaurant, target)).fetchone():
            raise DomainError('MEMBERSHIP_EXISTS')
        conn.execute('''INSERT INTO prsystem.restaurant_membership (restaurant_id, account_id, status)
            VALUES (%s, %s, 'PENDING')''', (restaurant, target))
        result = self._issue(conn, tenant, restaurant, target, actor, 0, account[1])
        self._event(conn, restaurant, tenant, actor, target, 'INVITED', {'revision': 0, 'invitation_id': result['invitation_id']})
        return result

    def register(self, token, tenant, data, key):
        self._links()
        data = {**data, 'email': normalized_email(data['email'])}
        command = {'action': 'REGISTER_RESTAURANT', 'data': data}
        with transaction(self.auth.dsn) as conn:
            target = self._email_lock(conn, data['email'])
            actor = self._owner(conn, token, tenant, target=target)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            restaurant = secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.restaurant
                (id, created_by, name, category, description, address, latitude, longitude, phone, weekly_hours)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)''',
                (restaurant, actor, data['name'], data['category'], data['description'], data['address'],
                 data['latitude'], data['longitude'], data['phone'], Jsonb(data['weekly_hours'])))
            conn.execute('INSERT INTO prsystem.hotel_restaurant (tenant_id, restaurant_id, created_by) VALUES (%s, %s, %s)',
                         (tenant, restaurant, actor))
            invitation = self._invite(conn, tenant, restaurant, actor, target, data['email'], data['manager_name'])
            result = {'restaurant_id': restaurant, 'tenant_id': tenant, 'active': False, 'invitation': invitation}
            self._event(conn, restaurant, tenant, actor, invitation['account_id'], 'REGISTERED', {'active': False})
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def link(self, token, tenant, restaurant, key):
        command = {'action': 'LINK_RESTAURANT', 'restaurant_id': restaurant}
        with transaction(self.auth.dsn) as conn:
            actor = self._owner(conn, token, tenant, restaurant, require_link=False)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            if conn.execute('SELECT 1 FROM prsystem.hotel_restaurant WHERE tenant_id = %s AND restaurant_id = %s', (tenant, restaurant)).fetchone():
                raise DomainError('RESTAURANT_LINK_EXISTS')
            conn.execute('INSERT INTO prsystem.hotel_restaurant (tenant_id, restaurant_id, created_by) VALUES (%s, %s, %s)',
                         (tenant, restaurant, actor))
            result = {'restaurant_id': restaurant, 'tenant_id': tenant, 'active': False}
            self._event(conn, restaurant, tenant, actor, None, 'LINKED', {'active': False})
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def invite(self, token, tenant, restaurant, email, name, key):
        self._links()
        email = normalized_email(email)
        command = {'action': 'RESTAURANT_INVITE', 'restaurant_id': restaurant, 'email': email, 'name': name}
        with transaction(self.auth.dsn) as conn:
            target = self._email_lock(conn, email)
            actor = self._owner(conn, token, tenant, restaurant, target)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            result = self._invite(conn, tenant, restaurant, actor, target, email, name)
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def change(self, token, tenant, restaurant, target, action, revision, key, reason=None):
        if action not in {'RESEND', 'REVOKE', 'SUSPEND', 'TERMINATE', 'REACTIVATE', 'RECOVER'}:
            raise DomainError('INVALID_REQUEST')
        if action not in {'RESEND', 'REVOKE'} and (not isinstance(reason, str) or not reason.strip() or len(reason) > 1000):
            raise DomainError('INVALID_REASON')
        command = {'action': f'RESTAURANT_{action}', 'restaurant_id': restaurant, 'account_id': target, 'revision': revision, 'reason': reason}
        with transaction(self.auth.dsn) as conn:
            actor = self._owner(conn, token, tenant, restaurant, target)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            member = conn.execute('''SELECT status, revision FROM prsystem.restaurant_membership
                WHERE restaurant_id = %s AND account_id = %s FOR UPDATE''', (restaurant, target)).fetchone()
            if member is None:
                raise DomainError('MEMBERSHIP_NOT_FOUND')
            if type(revision) is not int or revision != member[1]:
                raise DomainError('REVISION_CONFLICT')
            account = conn.execute('SELECT status, verified_at, auth_epoch FROM prsystem.staff_account WHERE id = %s', (target,)).fetchone()
            status = member[0]
            if action in {'RESEND', 'REVOKE'}:
                if status != 'PENDING':
                    raise DomainError('MEMBERSHIP_NOT_PENDING')
                if action == 'RESEND' and account[0] != 'ACTIVE':
                    raise DomainError('SECURITY_SUSPENDED')
            elif action == 'SUSPEND' and status in {'ACTIVE', 'PENDING'}:
                status = 'SUSPENDED'
            elif action == 'TERMINATE' and status in {'ACTIVE', 'PENDING', 'SUSPENDED'}:
                status = 'TERMINATED'
            elif action in {'REACTIVATE', 'RECOVER'} and status in {'SUSPENDED', 'TERMINATED'}:
                if account[0] != 'ACTIVE':
                    raise DomainError('SECURITY_SUSPENDED')
                if action == 'REACTIVATE' and account[1] is None:
                    raise DomainError('ACCOUNT_NOT_VERIFIED')
                if action == 'RECOVER' and account[1] is not None:
                    raise DomainError('VERIFIED_ACCOUNT_REQUIRES_REACTIVATION')
                status = 'ACTIVE' if action == 'REACTIVATE' else 'PENDING'
            else:
                raise DomainError('INVALID_MEMBERSHIP_TRANSITION')
            new_revision = conn.execute('''UPDATE prsystem.restaurant_membership SET status = %s
                WHERE restaurant_id = %s AND account_id = %s RETURNING revision''', (status, restaurant, target)).fetchone()[0]
            conn.execute('''UPDATE prsystem.staff_session SET revoked_at = clock_timestamp()
                WHERE restaurant_id = %s AND account_id = %s AND revoked_at IS NULL''', (restaurant, target))
            if action in {'RESEND', 'RECOVER'}:
                result = self._issue(conn, tenant, restaurant, target, actor, new_revision, account[2])
            else:
                changed = conn.execute('''UPDATE prsystem.staff_link SET state = 'REVOKED'
                    WHERE restaurant_id = %s AND account_id = %s AND state = 'ACTIVE' AND purpose = 'RESTAURANT_INVITE'
                    RETURNING id''', (restaurant, target)).fetchone()
                if action == 'REVOKE' and changed is None:
                    raise DomainError('INVALID_LINK')
                result = {'restaurant_id': restaurant, 'account_id': target, 'revision': new_revision, 'status': status}
            kind = {'RESEND': 'RESENT', 'REVOKE': 'REVOKED', 'SUSPEND': 'SUSPENDED', 'TERMINATE': 'TERMINATED',
                    'REACTIVATE': 'REACTIVATED', 'RECOVER': 'INVITE_RECOVERED'}[action]
            self._event(conn, restaurant, tenant, actor, target, kind,
                        {'before': member[0], 'after': status, 'revision': new_revision, 'reason': reason})
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def accept(self, token, password, peer):
        links = self._links()
        self.auth._rate_limit(digest(token), peer, 'restaurant-invite-accept')
        with transaction(self.auth.dsn) as conn:
            initial = links._link(conn, token, 'RESTAURANT_INVITE')
            self._lock_accounts(conn, {initial[1], initial[3]})
            invitation = links._link(conn, token, 'RESTAURANT_INVITE')
            scope = conn.execute('SELECT restaurant_id, sponsor_tenant_id FROM prsystem.staff_link WHERE id = %s', (invitation[0],)).fetchone()
            restaurant, tenant = scope
            # Account locks precede both realm memberships and source/hotel rows.
            author = conn.execute('''SELECT status, roles FROM prsystem.staff_membership
                WHERE tenant_id = %s AND account_id = %s FOR SHARE''', (tenant, invitation[3])).fetchone()
            member = conn.execute('''SELECT status, revision FROM prsystem.restaurant_membership
                WHERE restaurant_id = %s AND account_id = %s FOR UPDATE''', (restaurant, invitation[1])).fetchone()
            accounts = {r[0]: r[1:] for r in conn.execute('''SELECT id, status, verified_at, password_hash FROM prsystem.staff_account
                WHERE id = ANY(%s)''', (list({invitation[1], invitation[3]}),)).fetchall()}
            target, inviter = accounts[invitation[1]], accounts[invitation[3]]
            if (member != ('PENDING', invitation[4]) or author[0] != 'ACTIVE' or 'MANAGER_PLUS' not in author[1]
                    or target[0] != 'ACTIVE' or inviter[0] != 'ACTIVE' or inviter[1] is None):
                raise DomainError('INVALID_LINK')
            venue = conn.execute('SELECT created_by FROM prsystem.restaurant WHERE id = %s FOR SHARE', (restaurant,)).fetchone()
            association = conn.execute('''SELECT revision FROM prsystem.hotel_restaurant WHERE tenant_id = %s
                AND restaurant_id = %s FOR SHARE''', (tenant, restaurant)).fetchone()
            if venue[0] != invitation[3] or association is None:
                raise DomainError('INVALID_LINK')
            self._gate(conn, tenant, True)
            if target[1] is None:
                if not 12 <= len(password) <= 128:
                    raise DomainError('INVALID_PASSWORD')
                conn.execute('UPDATE prsystem.staff_account SET password_hash = %s, verified_at = clock_timestamp() WHERE id = %s',
                             (self.auth.passwords.hash(password), invitation[1]))
            elif not self.auth._verify(self.auth.passwords, target[2], password):
                raise DomainError('INVALID_CREDENTIALS')
            revision = conn.execute('''UPDATE prsystem.restaurant_membership SET status = 'ACTIVE'
                WHERE restaurant_id = %s AND account_id = %s RETURNING revision''', (restaurant, invitation[1])).fetchone()[0]
            links._consume(conn, invitation[0])
            self._event(conn, restaurant, tenant, invitation[1], invitation[1], 'ACCEPTED', {'revision': revision})
            return {'restaurant_id': restaurant, 'account_id': invitation[1], 'revision': revision, 'status': 'ACTIVE'}

    def profile(self, token, tenant, restaurant):
        with transaction(self.auth.dsn) as conn:
            self.auth._authenticate(conn, token, restaurant=restaurant)
            row = conn.execute('''SELECT r.name, r.category, r.description, r.address, r.latitude, r.longitude,
                r.phone, r.weekly_hours, r.timezone, h.active FROM prsystem.restaurant r
                JOIN prsystem.hotel_restaurant h ON h.restaurant_id = r.id
                WHERE r.id = %s AND h.tenant_id = %s FOR SHARE OF r, h''', (restaurant, tenant)).fetchone()
            if row is None:
                raise DomainError('FORBIDDEN')
            self._gate(conn, tenant, True)
            return dict(zip(('name', 'category', 'description', 'address', 'latitude', 'longitude', 'phone',
                             'weekly_hours', 'timezone', 'active'), row))
