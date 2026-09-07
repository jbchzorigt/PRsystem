"""Server-owned historical roots for the narrow expiry completion allowlist."""

from datetime import timedelta

from prsystem.subscription import Obligation, RootKind


def shift_root(conn, tenant, shift_id):
    # Identity/open time are immutable. State is checked again by the command
    # under the cash-book lock; a closed root cannot authorize a new effect.
    row = conn.execute("""SELECT s.opened_at, s.closed_at, h.expires_at
        FROM prsystem.reception_shift s JOIN prsystem.hotel_access h
        ON h.tenant_id=s.tenant_id WHERE s.tenant_id=%s AND s.id=%s""",
        (tenant, shift_id)).fetchone()
    if not row:
        return None
    eligible = row[1] is None or row[1] >= row[2] + timedelta(hours=48)
    return Obligation(tenant, shift_id, RootKind.SHIFT, row[0], eligible)


def exception_shift_root(conn, tenant, exception_id):
    row = conn.execute("""SELECT w.source_id FROM prsystem.staff_work_exception e
        JOIN prsystem.staff_open_work w ON (w.tenant_id,w.id)=(e.tenant_id,e.work_id)
        WHERE e.tenant_id=%s AND e.id=%s AND w.kind='SHIFT'""",
        (tenant, exception_id)).fetchone()
    return shift_root(conn, tenant, row[0]) if row else None


def transfer_root(conn, tenant, transfer_id):
    conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)", (tenant,))
    row = conn.execute("""SELECT recorded_at FROM prsystem.cash_event
        WHERE tenant_id=%s AND reference=%s AND kind='TRANSFER_RESERVED'""",
        (tenant, transfer_id)).fetchone()
    return Obligation(tenant, transfer_id, RootKind.TRANSFER, row[0], True) if row else None
