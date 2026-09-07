"""Approved effective-time overlay; original stay and financial terms never change."""
import secrets
from datetime import datetime
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.guest_finance import GuestFinance
from prsystem.postgres.connection import transaction
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.stay_policy import actual_time, overlaps


class StayAmendments(GuestFinance):
    @staticmethod
    def source(conn,tenant,stay):
        source=conn.execute('SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()
        if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
        conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,source[0])).fetchone()
        row=conn.execute('''SELECT s.room_id,s.check_in_recorded_at,sh.opened_at,s.planned_checkout_at,
            s.cleaning_buffer_minutes,s.snapshot,s.state FROM prsystem.stay s JOIN prsystem.reception_shift sh
            ON(sh.tenant_id,sh.id)=(s.tenant_id,s.shift_id) WHERE s.tenant_id=%s AND s.id=%s FOR UPDATE OF s''',(tenant,stay)).fetchone()
        if row[6]!='ACTIVE':raise DomainError('WORK_NOT_OPEN')
        if conn.execute('SELECT 1 FROM prsystem.reception_checkout_intent WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone():raise DomainError('WORK_NOT_OPEN')
        return row

    @staticmethod
    def validate(conn,tenant,stay,row,requested,reason):
        actual=actual_time(row[1],row[2],requested,reason)
        snapshot=row[5]
        if snapshot.get('planned_checkin_at') and actual<datetime.fromisoformat(snapshot['planned_checkin_at']):raise DomainError('ACTUAL_TIME_OUT_OF_RANGE')
        StayService._readiness(conn,tenant,row[0],snapshot['category_id'],actual,row[1])
        history=conn.execute('''SELECT s.state,coalesce((SELECT a.actual_checkin_at FROM prsystem.stay_time_amendment a
            WHERE a.tenant_id=s.tenant_id AND a.stay_id=s.id AND a.state='APPROVED' ORDER BY a.decided_at DESC,a.id DESC LIMIT 1),s.actual_checkin_at),
            s.actual_checkout_at,s.cleaning_buffer_minutes FROM prsystem.stay s WHERE s.tenant_id=%s AND s.room_id=%s AND s.id<>%s''',(tenant,row[0],stay)).fetchall()
        if any(state=='ACTIVE' or overlaps(actual,row[3],start,end,row[4],buffer) for state,start,end,buffer in history):raise DomainError('ROOM_OCCUPIED')
        reservations=conn.execute("SELECT planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes FROM prsystem.room_reservation WHERE tenant_id=%s AND room_id=%s AND state='CONFIRMED'",(tenant,row[0])).fetchall()
        if any(overlaps(actual,row[3],start,end,row[4],buffer) for start,end,buffer in reservations):raise DomainError('RESERVATION_CONFLICT')
        return actual

    def request(self,bearer,tenant,stay,requested,reason,key):
        reason=self._text(reason,1000)
        try:requested=datetime.fromisoformat(requested.replace('Z','+00:00'))
        except (ValueError,AttributeError) as exc:raise DomainError('INVALID_REQUEST') from exc
        if self.vault is None:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
        command=dict(action='REQUEST_STAY_TIME_AMENDMENT',stay=stay,actual=requested.isoformat(),reason_hash=self.vault.fingerprint('time-reason',[tenant,stay,reason]))
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);self._catalog_lock(conn,tenant)
            row=self.source(conn,tenant,stay);StayService._shift(conn,tenant,actor)
            if conn.execute("SELECT 1 FROM prsystem.stay_time_amendment WHERE tenant_id=%s AND stay_id=%s AND state='PENDING'",(tenant,stay)).fetchone():raise DomainError('AMENDMENT_PENDING')
            actual=self.validate(conn,tenant,stay,row,requested,reason)
            identity=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.stay_time_amendment(tenant_id,id,stay_id,requester_id,actual_checkin_at,reason_envelope)
                VALUES(%s,%s,%s,%s,%s,%s)''',(tenant,identity,stay,actor,actual,Jsonb(self.vault.seal(reason,tenant,stay,'time-amendment'))))
            result=dict(amendment_id=identity,stay_id=stay,state='PENDING',actual_checkin_at=actual.isoformat())
            self.event(conn,tenant,actor,'STAY_TIME_AMENDMENT_REQUESTED',stay,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def decide(self,bearer,tenant,stay,amendment,approve,reason,key):
        reason=self._text(reason,1000)
        command=dict(action='DECIDE_STAY_TIME_AMENDMENT',stay=stay,amendment=amendment,approve=approve,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=True)
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            # STAY-DEC-014 explicitly requires Manager, not an inherited Admin/Plus privilege.
            if 'MANAGER' not in principal['roles']:raise DomainError('FORBIDDEN')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);self._catalog_lock(conn,tenant)
            row=self.source(conn,tenant,stay)
            item=conn.execute('SELECT requester_id,actual_checkin_at,state,reason_envelope FROM prsystem.stay_time_amendment WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE',(tenant,stay,amendment)).fetchone()
            if not item or item[2]!='PENDING':raise DomainError('WORK_NOT_OPEN')
            if approve:self.validate(conn,tenant,stay,row,item[1],self.vault.open(item[3],tenant,stay,'time-amendment'))
            state='APPROVED' if approve else 'REJECTED'
            conn.execute('''UPDATE prsystem.stay_time_amendment SET state=%s,decider_id=%s,decided_at=clock_timestamp(),decision_reason=%s,self_approved=%s
                WHERE tenant_id=%s AND id=%s''',(state,actor,reason,actor==item[0],tenant,amendment))
            result=dict(amendment_id=amendment,stay_id=stay,state=state,self_approved=actor==item[0])
            self.event(conn,tenant,actor,'STAY_TIME_AMENDMENT_DECIDED',stay,dict(result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def history(self,bearer,tenant,stay):
        with transaction(self.auth.dsn) as conn:
            self._reader(conn,bearer,tenant)
            rows=conn.execute('''SELECT id,actual_checkin_at,state,requested_at,decided_at,self_approved FROM prsystem.stay_time_amendment
                WHERE tenant_id=%s AND stay_id=%s ORDER BY requested_at DESC,id DESC LIMIT 100''',(tenant,stay)).fetchall()
            return [dict(zip(('amendment_id','actual_checkin_at','state','requested_at','decided_at','self_approved'),r)) for r in rows]
