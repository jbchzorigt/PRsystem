"""Walk-in check-in transaction, before guest financial posting (package four).

Account -> receipt -> cash book -> catalog -> room -> shift/work. Every future
booking writer must lock this same room before reserving an interval. No client
price, cleanliness, paid/confirmed flag, shift root or snapshot is accepted.
"""
import secrets
from datetime import datetime, timedelta
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.guest_identity import validate_identity
from prsystem.rooms import RoomService
from prsystem.shifts import ShiftService
from prsystem.stay_policy import HOTEL_ZONE, actual_time, stay_terms, overlaps
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction


class StayService(RoomService):
    def __init__(self, auth, vault=None, *, mock_finance=False, runtime_mode='production'):
        super().__init__(auth)
        self.vault = vault
        if mock_finance:
            from prsystem.mock_providers import require_development_database
            require_development_database(auth.dsn, runtime_mode)
        self.mock_finance = mock_finance
        self.runtime_mode = runtime_mode

    def _actor(self, conn, bearer, tenant):
        self._actors(conn, bearer, tenant)
        principal, _ = self.auth._authenticate(conn, bearer, tenant)
        actor = principal['account_id']
        ShiftService._reception(conn, tenant, actor, action=Action.CHECK_IN)
        return actor

    @staticmethod
    def _shift(conn, tenant, actor):
        row = conn.execute("""SELECT s.id,s.opened_at,s.drawer_id FROM prsystem.reception_shift s
            JOIN prsystem.staff_open_work w ON w.tenant_id=s.tenant_id AND w.source_id=s.id AND w.kind='SHIFT'
            JOIN prsystem.cash_drawer d ON (d.tenant_id,d.id,d.shift_id)=(s.tenant_id,s.drawer_id,s.id)
            WHERE s.tenant_id=%s AND s.owner_id=%s AND s.state='OPEN' AND w.state='OPEN' AND w.owner_id=s.owner_id
            FOR UPDATE OF s,w""", (tenant, actor)).fetchone()
        if not row:
            raise DomainError('OPEN_SHIFT_REQUIRED')
        return row

    @staticmethod
    def _readiness(conn, tenant, room, category, actual, recorded):
        proof = conn.execute('''SELECT sequence,cleaning_state,room_status,category_status,category_id
            FROM prsystem.room_readiness_event WHERE tenant_id=%s AND room_id=%s AND recorded_at<=%s
            ORDER BY recorded_at DESC,sequence DESC LIMIT 1''', (tenant, room, actual)).fetchone()
        if not proof or proof[1:] != ('CLEAN', 'ACTIVE', 'ACTIVE', category):
            raise DomainError('HISTORICAL_READINESS_REQUIRED')
        changed = conn.execute('''SELECT 1 FROM prsystem.room_readiness_event WHERE tenant_id=%s AND room_id=%s
            AND recorded_at>%s AND recorded_at<=%s
            AND (cleaning_state<>'CLEAN' OR room_status<>'ACTIVE' OR category_status<>'ACTIVE' OR category_id<>%s) LIMIT 1''', (tenant, room, actual, recorded, category)).fetchone()
        if changed:
            raise DomainError('HISTORICAL_READINESS_REQUIRED')
        return proof[0]

    @staticmethod
    def _available(conn, tenant, room, actual, end, buffer_minutes,excluding_reservation=None,excluding_hold=None):
        history = conn.execute('''SELECT state,coalesce((SELECT a.actual_checkin_at FROM prsystem.stay_time_amendment a
            WHERE a.tenant_id=s.tenant_id AND a.stay_id=s.id AND a.state='APPROVED' ORDER BY a.decided_at DESC,a.id DESC LIMIT 1),actual_checkin_at),actual_checkout_at,cleaning_buffer_minutes
            FROM prsystem.stay s WHERE tenant_id=%s AND room_id=%s''', (tenant, room)).fetchall()
        for state, start, checkout, buffer in history:
            # An overdue, unchecked-out stay remains occupied indefinitely.
            if state == 'ACTIVE' or overlaps(actual, end, start, checkout, buffer_minutes, buffer):
                raise DomainError('ROOM_OCCUPIED')
        reservations = conn.execute("""SELECT planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes
            FROM prsystem.room_reservation WHERE tenant_id=%s AND room_id=%s AND state='CONFIRMED' AND id IS DISTINCT FROM %s""", (tenant, room,excluding_reservation)).fetchall()
        if any(overlaps(actual, end, start, finish, buffer_minutes, buffer) for start, finish, buffer in reservations):
            raise DomainError('RESERVATION_CONFLICT')
        from prsystem.booking_inventory import protect_existing_claims
        from prsystem.booking_policy import InventoryInterval
        protect_existing_claims(conn,tenant,room,InventoryInterval(actual,end,buffer_minutes),excluding_hold=excluding_hold)

    def _response(self, conn, tenant, result):
        result = dict(result)
        code = conn.execute('''SELECT envelope FROM prsystem.stay_guest_code
            WHERE tenant_id=%s AND stay_id=%s AND consumed_at IS NULL AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM prsystem.stay s WHERE (s.tenant_id,s.id)=(stay_guest_code.tenant_id,stay_guest_code.stay_id) AND s.state='ACTIVE')
            AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 1''', (tenant, result['stay_id'])).fetchone()
        # Raw codes are never stored in command receipts or audit events.
        result['guest_access_code'] = self.vault.open(code[0], tenant, result['stay_id'], 'guest-code') if code else None
        return result

    def check_in(self, bearer, tenant, data, key):
        # Keep legacy command fingerprints stable when the new optional field is absent.
        if data.get('deposit') is None:
            data={k:v for k,v in data.items() if k!='deposit'}
        cash_deposit=data.get('deposit')
        funding_id=data.get('funding_id')
        if funding_id is None:data={k:v for k,v in data.items() if k!='funding_id'}
        if funding_id and cash_deposit is not None:raise DomainError('INVALID_REQUEST')
        booking_id=data.get('booking_id')
        hold_id=data.get('booking_hold_id')
        hold_attempt=None
        from prsystem.guest_finance import GuestFinance
        finance=GuestFinance(self.auth,self.vault,self.runtime_mode)
        with transaction(self.auth.dsn) as conn:
            actor = self._actor(conn, bearer, tenant)
            if self.vault is None:
                raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
            # Cash confirmation now posts atomically; absent or unsupported
            # funding never bypasses the production deposit requirement.
            if cash_deposit is None and not self.mock_finance and booking_id is None and funding_id is None:
                raise DomainError('STAY_FINANCE_UNAVAILABLE')
            command = dict(action='WALK_IN_CHECK_IN', fingerprint=self.vault.fingerprint('check-in-command', [tenant, data]))
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return self._response(conn, tenant, replay)
            ShiftService._book(conn, tenant)
            self._catalog_lock(conn, tenant)
            conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant, data['room_id'])).fetchone()
            row = conn.execute('''SELECT r.id,r.number,r.floor,r.category_id,c.name,r.status,r.cleaning_state,r.revision,
                r.hourly_price,r.nightly_price,c.hourly_price,c.nightly_price,c.revision,
                h.hourly_price,h.nightly_price,h.revision,r.tenant_id,c.cleaning_buffer_minutes,c.status,
                c.deposit,h.checkout_time,r.minibar_mode
                FROM prsystem.room r JOIN prsystem.room_category c ON (c.tenant_id,c.id)=(r.tenant_id,r.category_id)
                LEFT JOIN prsystem.room_hotel_settings h ON h.tenant_id=r.tenant_id
                WHERE r.tenant_id=%s AND r.id=%s''', (tenant, data['room_id'])).fetchone()
            if not row:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            if (row[5], row[6], row[18]) != ('ACTIVE', 'CLEAN', 'ACTIVE'):
                raise DomainError('ROOM_NOT_READY')
            from prsystem.minibar_configuration import MinibarConfiguration
            if MinibarConfiguration.pending(conn,tenant,row[0]):
                raise DomainError('CONFIGURATION_PENDING')
            shift = self._shift(conn, tenant, actor)
            recorded = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            # Recheck expiry after potentially waiting on the serialization locks.
            ShiftService._reception(conn, tenant, actor, action=Action.CHECK_IN)
            requested = data.get('actual_checkin_at')
            try:
                requested = datetime.fromisoformat(requested.replace('Z', '+00:00')) if requested is not None else None
            except (ValueError, AttributeError) as exc:
                raise DomainError('INVALID_REQUEST') from exc
            actual = actual_time(recorded, shift[1], requested, data.get('backdate_reason'))
            from prsystem.reception_dependencies import ReceptionDependencies
            minibar=ReceptionDependencies.opening(conn,tenant,row[0],row[21],actual,self.runtime_mode,recorded)
            booking=None
            if booking_id:
                from prsystem.mock_providers import require_development_database
                if self.runtime_mode=='production':raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
                require_development_database(self.auth.dsn,self.runtime_mode)
                if hold_id:
                    from prsystem.booking_inventory import scope
                    scope(conn,tenant)
                    source=conn.execute('''SELECT h.category_id,h.planned_checkin_at,h.planned_checkout_at,h.amount_mnt,h.snapshot,h.booking_state,h.applied_attempt_id
                        FROM prsystem.booking_hold h WHERE h.tenant_id=%s AND h.id=%s FOR UPDATE''',(tenant,hold_id)).fetchone()
                    if not source or source[5]!='CONFIRMED' or row[21]!='OFF':raise DomainError('INVALID_FINANCIAL_SOURCE')
                    if source[0]!=row[3]:
                        upgrade=conn.execute('''SELECT u.id,u.room_id,m.roles,m.status,a.status,a.verified_at,h.package_mnt,s.rank,t.rank
                            FROM prsystem.booking_upgrade u JOIN prsystem.staff_membership m ON(m.tenant_id,m.account_id)=(u.tenant_id,u.actor_id)
                            JOIN prsystem.staff_account a ON a.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=u.tenant_id
                            LEFT JOIN prsystem.booking_category_rank s ON s.tenant_id=u.tenant_id AND s.category_id=%s
                            LEFT JOIN prsystem.booking_category_rank t ON t.tenant_id=u.tenant_id AND t.category_id=%s
                            WHERE u.tenant_id=%s AND u.hold_id=%s ORDER BY u.recorded_at DESC,u.id DESC LIMIT 1''',(source[0],row[3],tenant,hold_id)).fetchone()
                        if (not upgrade or upgrade[1]!=row[0] or upgrade[3:5]!=('ACTIVE','ACTIVE') or upgrade[5] is None
                            or not self._manager(upgrade[2],upgrade[6]) or upgrade[7] is None or upgrade[8] is None or upgrade[8]<=upgrade[7]):raise DomainError('INVALID_FINANCIAL_SOURCE')
                    if conn.execute("SELECT 1 FROM prsystem.reception_dependency_blocker WHERE tenant_id=%s AND room_id=%s AND state='OPEN'",(tenant,row[0])).fetchone():raise DomainError('ROOM_NOT_READY')
                    if conn.execute('SELECT 1 FROM prsystem.booking_hold_cancellation WHERE tenant_id=%s AND hold_id=%s',(tenant,hold_id)).fetchone():raise DomainError('INVALID_FINANCIAL_SOURCE')
                    if conn.execute('SELECT 1 FROM prsystem.booking_hold_application WHERE tenant_id=%s AND hold_id=%s',(tenant,hold_id)).fetchone():raise DomainError('INVALID_FINANCIAL_SOURCE')
                    capture=conn.execute('''SELECT 1 FROM prsystem.booking_hold_capture WHERE tenant_id=%s AND hold_id=%s AND attempt_id=%s
                        AND disposition='APPLIED' AND amount_mnt=%s''',(tenant,hold_id,source[6],source[3])).fetchone()
                    if not capture or cash_deposit is not None or funding_id:raise DomainError('INVALID_FINANCIAL_SOURCE')
                    hold_attempt=source[6]
                    booking=(row[0],'NIGHTLY',source[4]['nights'],source[1],source[2],source[3],source[4],source[5])
                else:
                    booking=conn.execute('''SELECT b.room_id,b.kind,b.duration_units,b.planned_checkin_at,b.planned_checkout_at,b.amount_mnt,b.snapshot,r.state
                        FROM prsystem.reception_booking b JOIN prsystem.room_reservation r ON(r.tenant_id,r.id)=(b.tenant_id,b.id)
                        WHERE b.tenant_id=%s AND b.id=%s FOR UPDATE OF r''',(tenant,booking_id)).fetchone()
                if not booking or booking[:3]!=(row[0],data['kind'],data['duration_units']) or booking[7]!='CONFIRMED' or cash_deposit is not None:raise DomainError('INVALID_FINANCIAL_SOURCE')
                if actual<booking[3] or recorded>=booking[4]:raise DomainError('ACTUAL_TIME_OUT_OF_RANGE')
            price = self.effective_prices(row)[data['kind'].lower()]
            if not booking and (price is None or row[20] is None):
                raise DomainError('STAY_SETTINGS_REQUIRED')
            deposit_amount=row[19]
            deposit_snapshot=None
            funding_evidence=None
            if cash_deposit is not None or funding_id:
                deposit_snapshot=finance.setting(conn,tenant,row[3])
                deposit_amount=deposit_snapshot['amount_mnt']
                if cash_deposit is not None and (cash_deposit.get('channel')!='CASH' or cash_deposit.get('received') is not True
                        or type(cash_deposit.get('amount_mnt')) is not int or cash_deposit['amount_mnt']!=deposit_amount):
                    raise DomainError('DEPOSIT_REQUIREMENT_NOT_MET')
                if funding_id:
                    from prsystem.checkin_funding import CheckinFunding
                    funding_evidence=CheckinFunding.load(conn,tenant,funding_id,row[0],actor,shift,deposit_amount,finance.mode)
            elif not booking and not 50000 <= deposit_amount <= 100000:
                raise DomainError('STAY_DEPOSIT_SETTINGS_REQUIRED')
            buffer=row[17]
            if booking:
                end,amount,deposit_amount=booking[4],booking[5],0
                buffer=booking[6]['cleaning_buffer_minutes']
                price=dict(unit_price=booking[6]['unit_price'],source='BOOKING',source_id=booking_id)
            else:
                end, amount = stay_terms(data['kind'], data['duration_units'], actual, recorded, price['unit_price'], row[20])
            proof = self._readiness(conn, tenant, row[0], row[3], actual, recorded)
            self._available(conn, tenant, row[0], actual, end, buffer,excluding_reservation=None if hold_id else booking_id,excluding_hold=hold_id)
            identity, exact = validate_identity(data['guest'], actual.astimezone(HOTEL_ZONE).date())
            stay = secrets.token_hex(16)
            snapshot = dict(room_id=row[0], room_number=row[1], room_revision=row[7], category_id=row[3], category_name=row[4],
                            category_revision=row[12], hotel_settings_revision=row[15], price=price, checkout_time=booking[6].get('checkout_time',str(row[20])) if booking else str(row[20]),
                            timezone='Asia/Ulaanbaatar', minibar_mode=row[21], financial_integration=finance.mode if cash_deposit is not None or booking or funding_id else 'DEFERRED_MOCK', cleaning_buffer_minutes=buffer, deposit_mnt=deposit_amount)
            if minibar:snapshot['minibar_snapshot']=minibar
            if booking:snapshot.update(booking_id=booking_id,booking_snapshot=booking[6],planned_checkin_at=booking[3].isoformat(),deposit_exemption='MOCK_PLATFORM_CONFIRMED_PAID')
            if deposit_snapshot is not None:
                snapshot['deposit_configuration']=deposit_snapshot
            reason = self.vault.seal(data['backdate_reason'], tenant, stay, 'backdate-reason') if data.get('backdate_reason') else None
            conn.execute('''INSERT INTO prsystem.stay (tenant_id,id,room_id,shift_id,actor_id,kind,duration_units,
                actual_checkin_at,check_in_recorded_at,planned_checkout_at,backdate_reason_envelope,origin,
                amount_mnt,deposit_mnt,cleaning_buffer_minutes,snapshot,readiness_sequence)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant, stay, row[0], shift[0], actor, data['kind'], data['duration_units'], actual, recorded, end,
                 Jsonb(reason) if reason else None,'ONLINE' if booking else 'WALK_IN', amount, deposit_amount, buffer, Jsonb(snapshot), proof))
            lookup = self.vault.fingerprint('guest-exact-identity', list(exact)) if exact else None
            conn.execute('''INSERT INTO prsystem.stay_guest_identity (tenant_id,stay_id,identity_type,provenance,envelope,lookup_token)
                VALUES (%s,%s,%s,'MANUAL',%s,%s)''', (tenant, stay, identity['identity_type'], Jsonb(self.vault.seal(identity, tenant, stay)), lookup))
            if identity['identity_type'] == 'MN_REG_NO':
                conn.execute('INSERT INTO prsystem.identity_match_outbox VALUES (%s,%s,1,%s,%s)', (tenant, stay, recorded, lookup))
            package = conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s', (tenant,)).fetchone()[0]
            if package == 30000:
                code = f'{secrets.randbelow(1000000):06d}'
                conn.execute('''INSERT INTO prsystem.stay_guest_code (tenant_id,stay_id,id,code_hash,envelope,created_at,expires_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)''', (tenant, stay, secrets.token_hex(16),
                    self.vault.fingerprint('guest-code', [tenant, stay, code]), Jsonb(self.vault.seal(code, tenant, stay, 'guest-code')), recorded, recorded+timedelta(minutes=10)))
            result = dict(stay_id=stay, room_id=row[0], shift_id=shift[0], state='ACTIVE', kind=data['kind'], duration_units=data['duration_units'],
                          actual_checkin_at=actual.isoformat(), check_in_recorded_at=recorded.isoformat(), planned_checkout_at=end.isoformat(),
                          amount_mnt=amount, deposit_mnt=deposit_amount, snapshot=snapshot, guest_identity_revision=1)
            if cash_deposit is not None or funding_id:
                result.update(finance.initial(conn,tenant,stay,actor,shift,deposit_amount,amount,recorded,funding_evidence[0] if funding_id else 'CASH'))
                if funding_id:CheckinFunding.apply(conn,tenant,funding_id,stay,result['deposit_receipt_id'],funding_evidence)
            elif booking:
                conn.execute('INSERT INTO prsystem.guest_finance(tenant_id,stay_id) VALUES(%s,%s)',(tenant,stay))
                charge=secrets.token_hex(16)
                conn.execute("INSERT INTO prsystem.guest_charge(tenant_id,stay_id,id,kind,source_id,amount_mnt,paid_mnt,recorded_at) VALUES(%s,%s,%s,'ROOM',%s,%s,%s,%s)",(tenant,stay,charge,stay,amount,amount,recorded))
                if hold_id:
                    conn.execute('''INSERT INTO prsystem.booking_hold_application(tenant_id,hold_id,stay_id,attempt_id,amount_mnt)
                        VALUES(%s,%s,%s,%s,%s)''',(tenant,hold_id,stay,hold_attempt,amount))
                else:
                    conn.execute('INSERT INTO prsystem.booking_stay_application VALUES(%s,%s,%s,%s)',(tenant,booking_id,stay,amount))
                    conn.execute("UPDATE prsystem.room_reservation SET state='CONSUMED' WHERE tenant_id=%s AND id=%s",(tenant,booking_id))
                result.update(room_charge_id=charge,deposit_receipt_id=None,finance_revision=1)
                finance.audit(conn,tenant,stay,actor,'MOCK_BOOKING_PREPAID_APPLIED',booking_id,dict(amount_mnt=amount,deposit_exemption=True),1,recorded)
            self.event(conn, tenant, actor, 'STAY_CHECKED_IN', stay, dict(room_id=row[0], shift_id=shift[0], kind=data['kind'], amount_mnt=amount))
            self._save_receipt(conn, tenant, key, actor, command, result)
            return self._response(conn, tenant, result)

    def list_active(self, bearer, tenant, limit=100, after=''):
        with transaction(self.auth.dsn) as conn:
            self._reader(conn, bearer, tenant)
            rows = conn.execute("""SELECT id,room_id,kind,coalesce((SELECT a.actual_checkin_at FROM prsystem.stay_time_amendment a
                WHERE a.tenant_id=s.tenant_id AND a.stay_id=s.id AND a.state='APPROVED' ORDER BY a.decided_at DESC,a.id DESC LIMIT 1),actual_checkin_at),planned_checkout_at,amount_mnt,
                clock_timestamp()>planned_checkout_at AS overdue FROM prsystem.stay s
                WHERE tenant_id=%s AND state='ACTIVE' AND id>%s ORDER BY id LIMIT %s""", (tenant, after, limit)).fetchall()
            return [dict(zip(('stay_id','room_id','kind','actual_checkin_at','planned_checkout_at','amount_mnt','overdue'), row)) for row in rows]
