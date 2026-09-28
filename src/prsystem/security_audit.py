"""Secret-free denial records, committed independently of rejected commands."""

import re
import secrets
from datetime import timedelta

from prsystem.auth import digest
from prsystem.postgres.connection import transaction


def record_denial(auth, *, bearer, tenant, target, action, method, code, restaurant=None):
    with transaction(auth.dsn) as conn:
        actor = None
        if bearer:
            actor = conn.execute("""SELECT s.account_id, s.tenant_id, s.restaurant_id FROM prsystem.staff_session s
                JOIN prsystem.staff_account a ON a.id = s.account_id
                LEFT JOIN prsystem.staff_membership m ON (m.tenant_id, m.account_id) = (s.tenant_id, s.account_id)
                LEFT JOIN prsystem.restaurant_membership rm ON (rm.restaurant_id, rm.account_id) = (s.restaurant_id, s.account_id)
                WHERE s.token_hash = %s AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
                  AND s.last_seen_at + %s > clock_timestamp() AND s.auth_epoch = a.auth_epoch
                  AND a.status = 'ACTIVE' AND a.verified_at IS NOT NULL
                  AND ((s.restaurant_id IS NULL AND s.membership_revision = m.revision AND m.status = 'ACTIVE')
                    OR (s.restaurant_id IS NOT NULL AND s.membership_revision = rm.revision AND rm.status = 'ACTIVE'))""", (digest(bearer), timedelta(seconds=auth.settings.idle_seconds))).fetchone()
        requested = conn.execute("SELECT tenant_id FROM prsystem.hotel_access WHERE tenant_id = %s", (tenant,)).fetchone() if tenant else None
        resolved_target = conn.execute("""SELECT account_id FROM prsystem.staff_membership
            WHERE tenant_id = %s AND account_id = %s""", (tenant, target)).fetchone() if requested and target else None
        requested_restaurant = conn.execute("SELECT id FROM prsystem.restaurant WHERE id = %s", (restaurant,)).fetchone() if restaurant else None
        if requested_restaurant and target:
            resolved_target = conn.execute("SELECT account_id FROM prsystem.restaurant_membership WHERE restaurant_id = %s AND account_id = %s",
                                           (restaurant, target)).fetchone()
        conn.execute("""INSERT INTO prsystem.staff_denied_event
            (id, actor_id, actor_tenant_id, requested_tenant_id, target_id, action, method, code, actor_restaurant_id, requested_restaurant_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""", (secrets.token_hex(16), actor[0] if actor else None,
            actor[1] if actor else None, requested[0] if requested else None, resolved_target[0] if resolved_target else None,
            action, method, code if re.fullmatch(r"[A-Z_]{1,64}", code) else "DENIED", actor[2] if actor else None, requested_restaurant[0] if requested_restaurant else None))
