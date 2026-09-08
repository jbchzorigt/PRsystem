"""Conservative category claims, serialized by the existing room-catalog lock."""
from prsystem.booking_policy import InventoryInterval, unassigned_capacity
from prsystem.common import DomainError


def scope(conn, tenant):
    conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)", (tenant,))


def claims(conn, tenant, category):
    scope(conn, tenant)
    # Elapsed ACTIVE holds keep inventory until the expiry worker queries and
    # persists its terminal decision. Time alone is not a reservation release.
    return conn.execute('''SELECT id,planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes
        FROM prsystem.booking_hold h WHERE tenant_id=%s AND category_id=%s
        AND hold_state IN ('ACTIVE','CONSUMED') AND NOT EXISTS(SELECT 1 FROM prsystem.booking_hold_application a
            WHERE (a.tenant_id,a.hold_id)=(h.tenant_id,h.id)) ORDER BY id''', (tenant, category)).fetchall()


def room_intervals(conn, tenant, category, *, excluding_stay=None):
    result = {}
    rooms = conn.execute('''SELECT r.id FROM prsystem.room r JOIN prsystem.room_category c
        ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id) WHERE r.tenant_id=%s AND r.category_id=%s
        AND r.status='ACTIVE' AND c.status='ACTIVE' AND r.minibar_mode='OFF'
        AND NOT EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker b
            WHERE b.tenant_id=r.tenant_id AND b.room_id=r.id AND b.state='OPEN')''', (tenant, category)).fetchall()
    # Minibar-configured online capacity waits for the stage-five canonical
    # configuration adapter; never infer readiness from a mock stock flag.
    for (room,) in rooms:
        entries = conn.execute('''SELECT coalesce((SELECT a.actual_checkin_at FROM prsystem.stay_time_amendment a
            WHERE a.tenant_id=s.tenant_id AND a.stay_id=s.id AND a.state='APPROVED'
            ORDER BY a.decided_at DESC,a.id DESC LIMIT 1),s.actual_checkin_at),
            CASE WHEN s.state='ACTIVE' THEN greatest(s.planned_checkout_at,clock_timestamp()) ELSE s.actual_checkout_at END,
            s.cleaning_buffer_minutes FROM prsystem.stay s WHERE s.tenant_id=%s AND s.room_id=%s AND (%s::text IS NULL OR s.id<>%s)
            UNION ALL SELECT planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes
            FROM prsystem.room_reservation WHERE tenant_id=%s AND room_id=%s AND state='CONFIRMED' ''', (tenant, room, excluding_stay, excluding_stay, tenant, room)).fetchall()
        result[room] = [InventoryInterval(*entry) for entry in entries]
    return result


def require_capacity(conn, tenant, category, candidate, *, excluding=None):
    entries = claims(conn, tenant, category)
    intervals = room_intervals(conn, tenant, category)
    if unassigned_capacity(candidate, eligible_room_intervals=intervals,
                           category_reservations=[InventoryInterval(*r[1:]) for r in entries if r[0] != excluding]) < 1:
        raise DomainError('BOOKING_CAPACITY_UNAVAILABLE')


def protect_existing_claims(conn, tenant, room, candidate, *, excluding_stay=None, excluding_hold=None):
    """Existing walk-in/physical-reservation producers call under catalog lock.

    Test every outstanding claim over its full interval. Looking only at the
    new walk-in's interval can miss fragmentation of a longer future booking.
    """
    category = conn.execute('SELECT category_id FROM prsystem.room WHERE tenant_id=%s AND id=%s', (tenant, room)).fetchone()
    if not category:
        return
    entries = [r for r in claims(conn, tenant, category[0]) if r[0] != excluding_hold]
    if not entries:
        return
    intervals = room_intervals(conn, tenant, category[0], excluding_stay=excluding_stay)
    if room in intervals:
        intervals[room] = [*intervals[room], candidate]
    for identity, start, end, buffer in entries:
        if unassigned_capacity(InventoryInterval(start, end, buffer), eligible_room_intervals=intervals,
                               category_reservations=[InventoryInterval(*r[1:]) for r in entries if r[0] != identity]) < 1:
            raise DomainError('BOOKING_CAPACITY_UNAVAILABLE')
