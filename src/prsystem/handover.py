"""Blind, independent counts; operational close never waits for financial review."""
import secrets
from datetime import timedelta
from prsystem.auth import digest
from prsystem.common import DomainError,money
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.postgres.connection import transaction
from prsystem.subscription import Action,AccessFacts,subscription_gate
from prsystem.obligations import shift_root


class HandoverService(ShiftService):
    @staticmethod
    def reason(value):
        if not isinstance(value,str) or not value.strip() or len(value)>1000:raise DomainError('INVALID_REASON')
        return value.strip()

    def policy(self,bearer,tenant,enabled,revision,key):
        command=dict(action='SINGLE_WORKER_POLICY',enabled=enabled,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor,_=self._admin(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._book(conn,tenant)
            old=conn.execute('SELECT revision,single_worker FROM prsystem.shift_policy WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            if revision!=(old[0] if old else 0):raise DomainError('REVISION_CONFLICT')
            conn.execute('''INSERT INTO prsystem.shift_policy VALUES(%s,%s,%s,%s) ON CONFLICT(tenant_id)
                DO UPDATE SET single_worker=EXCLUDED.single_worker,revision=EXCLUDED.revision,configured_by=EXCLUDED.configured_by''',(tenant,enabled,revision+1,actor))
            result=dict(single_worker=enabled,revision=revision+1)
            self.event(conn,tenant,actor,'SHIFT_POLICY_CHANGED',tenant,dict(before=old[1] if old else False,**result))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def eligible(self,conn,tenant,account,shift,*,receiver=False):
        row=conn.execute('''SELECT m.roles,m.status,a.status,a.verified_at,h.package_mnt,h.expires_at,h.security_suspended
            FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
            JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id WHERE m.tenant_id=%s AND m.account_id=%s FOR SHARE OF m,h''',(tenant,account)).fetchone()
        if not row or row[1:3]!=('ACTIVE','ACTIVE') or row[3] is None:raise DomainError('FORBIDDEN')
        allowed='RECEPTION' in row[0] or (receiver and ('HOTEL_ADMIN' in row[0] or self._manager(row[0],row[4])))
        gate=subscription_gate(Action.SHIFT_CLOSE,AccessFacts(tenant,True,True,True,allowed,True,True,True,row[6]),row[5],conn.execute('SELECT clock_timestamp()').fetchone()[0],shift_root(conn,tenant,shift))
        if not gate.allowed:raise DomainError(gate.code)
        return row[0],row[4],row[5]

    def submit(self,bearer,tenant,receiver,actual,key,reason,*,self_close=False,custody=None):
        money(actual);reason=self.reason(reason)
        command=dict(action='SUBMIT_HANDOVER',receiver=receiver,actual=actual,reason=reason,self_close=self_close,custody=custody)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant,receiver)
            principal,_=self.auth._authenticate(conn,bearer,tenant);actor=principal['account_id']
            replay=self._receipt(conn,tenant,key,actor,command)
            revision=self._book(conn,tenant)
            if replay is not None:
                self.eligible(conn,tenant,actor,replay['shift_id'],receiver=bool(custody))
                return replay
            if custody:
                source=conn.execute('''SELECT h.shift_id,c.drawer_id FROM prsystem.cash_custody c JOIN prsystem.shift_handover h
                    ON(h.tenant_id,h.id)=(c.tenant_id,c.handover_id) WHERE c.tenant_id=%s AND c.id=%s AND c.owner_id=%s AND c.state='HELD' FOR UPDATE OF c''',(tenant,custody,actor)).fetchone()
                if not source:raise DomainError('WORK_NOT_OPEN')
                shift,drawer=source
            else:
                source=StayService._shift(conn,tenant,actor);shift,drawer=source[0],source[2]
            self.eligible(conn,tenant,actor,shift,receiver=bool(custody))
            receiver_roles,package,_=self.eligible(conn,tenant,receiver,shift,receiver=True)
            if self_close:
                policy=conn.execute('SELECT single_worker FROM prsystem.shift_policy WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
                if custody or actor!=receiver or not policy or not policy[0] or 'RECEPTION' not in receiver_roles or not self._manager(receiver_roles,package):raise DomainError('SELF_CLOSE_NOT_ALLOWED')
            elif actor==receiver:raise DomainError('SELF_CLOSE_NOT_ALLOWED')
            if self._pending(conn,tenant,(shift,None,None,drawer)):raise DomainError('PENDING_SHIFT_OBLIGATIONS')
            balance=conn.execute('SELECT posted,reserved,shift_id FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,drawer)).fetchone()
            if not balance or balance[1] or balance[2]!=shift:raise DomainError('WORK_SOURCE_CONFLICT')
            if conn.execute("SELECT 1 FROM prsystem.shift_handover WHERE tenant_id=%s AND shift_id=%s AND state='SUBMITTED'",(tenant,shift)).fetchone():raise DomainError('HANDOVER_PENDING')
            identity=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.shift_handover(tenant_id,id,shift_id,drawer_id,sender_id,receiver_id,source_custody_id,expected,sender_actual,book_revision,reason,self_close)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,identity,shift,drawer,actor,receiver,custody,balance[0],actual,revision,reason,self_close))
            if not custody:conn.execute("UPDATE prsystem.reception_shift SET state='SUBMITTED' WHERE tenant_id=%s AND id=%s",(tenant,shift))
            result=dict(handover_id=identity,shift_id=shift,state='SUBMITTED',expected=balance[0],sender_actual=actual,variance=actual-balance[0])
            self.event(conn,tenant,actor,'HANDOVER_SUBMITTED',shift,result)
            if self_close:
                count=secrets.token_hex(16)
                conn.execute('INSERT INTO prsystem.handover_count(tenant_id,id,handover_id,actor_id,actual) VALUES(%s,%s,%s,%s,%s)',(tenant,count,identity,actor,actual))
                result=self.finish(conn,tenant,actor,identity,count,reason)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def authenticate_handover(self,conn,bearer,tenant,handover):
        item=conn.execute('SELECT sender_id,receiver_id,shift_id FROM prsystem.shift_handover WHERE tenant_id=%s AND id=%s',(tenant,handover)).fetchone()
        session=conn.execute('SELECT account_id FROM prsystem.staff_session WHERE token_hash=%s',(digest(bearer),)).fetchone()
        if not item or not session:raise DomainError('FORBIDDEN')
        self._lock_accounts(conn,{session[0],item[0],item[1]})
        principal,_=self.auth._authenticate(conn,bearer,tenant);actor=principal['account_id']
        if actor!=item[1]:raise DomainError('FORBIDDEN')
        self.eligible(conn,tenant,actor,item[2],receiver=True)
        return actor

    def count_handover(self,bearer,tenant,handover,actual,key):
        money(actual);command=dict(action='COUNT_HANDOVER',handover=handover,actual=actual)
        with transaction(self.auth.dsn) as conn:
            actor=self.authenticate_handover(conn,bearer,tenant,handover)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._book(conn,tenant)
            row=conn.execute('SELECT state,expected,sender_actual,shift_id FROM prsystem.shift_handover WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,handover)).fetchone()
            if row[0]!='SUBMITTED':raise DomainError('WORK_NOT_OPEN')
            identity=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.handover_count(tenant_id,id,handover_id,actor_id,actual) VALUES(%s,%s,%s,%s,%s)',(tenant,identity,handover,actor,actual))
            result=dict(count_id=identity,handover_id=handover,actual=actual,expected=row[1],sender_actual=row[2],variance=actual-row[1],counts_match=actual==row[2])
            self.event(conn,tenant,actor,'HANDOVER_COUNTED',row[3],result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def finish(self,conn,tenant,actor,handover,count_id,reason):
        row=conn.execute('''SELECT shift_id,drawer_id,sender_id,receiver_id,expected,sender_actual,state,self_close,source_custody_id
            FROM prsystem.shift_handover WHERE tenant_id=%s AND id=%s FOR UPDATE''',(tenant,handover)).fetchone()
        if not row or row[6]!='SUBMITTED' or row[3]!=actor:raise DomainError('WORK_NOT_OPEN')
        roles,package,expires=self.eligible(conn,tenant,actor,row[0],receiver=True)
        # Sender suspension turns the source into takeover work, not an ordinary handover.
        if not row[8]:
            self.eligible(conn,tenant,row[2],row[0])
            if not conn.execute("SELECT 1 FROM prsystem.staff_open_work WHERE tenant_id=%s AND source_id=%s AND kind='SHIFT' AND state='OPEN'",(tenant,row[0])).fetchone():raise DomainError('WORK_NOT_OPEN')
        count=conn.execute('SELECT id,actual,counted_at FROM prsystem.handover_count WHERE tenant_id=%s AND handover_id=%s AND actor_id=%s ORDER BY counted_at DESC,id DESC LIMIT 1',(tenant,handover,actor)).fetchone()
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        if not count or count[0]!=count_id or now>=count[2]+timedelta(minutes=5):raise DomainError('STALE_CASH_COUNT')
        if count[1]!=row[5] and conn.execute('SELECT count(*) FROM prsystem.handover_count WHERE tenant_id=%s AND handover_id=%s',(tenant,handover)).fetchone()[0]<2:raise DomainError('RECOUNT_REQUIRED')
        if self._pending(conn,tenant,(row[0],None,None,row[1])):raise DomainError('PENDING_SHIFT_OBLIGATIONS')
        drawer=conn.execute('SELECT posted,reserved,shift_id FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,row[1])).fetchone()
        if drawer!=(row[4],0,row[0]):raise DomainError('STALE_CASH_COUNT')
        if conn.execute("SELECT 1 FROM prsystem.reception_shift WHERE tenant_id=%s AND owner_id=%s AND state IN ('OPEN','SUBMITTED') AND id<>%s",(tenant,actor,row[0])).fetchone():raise DomainError('REPLACEMENT_HAS_OPEN_SHIFT')
        variance=count[1]-row[4]
        original_roles=conn.execute('SELECT owner_roles FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(tenant,row[0])).fetchone()[0]
        review=('NOT_REQUIRED' if not variance else 'ADMIN_REQUIRED') if row[7] else ('ADMIN_REQUIRED' if {'MANAGER','MANAGER_PLUS','UNKNOWN'} & set(original_roles) else 'MANAGER_REQUIRED')
        if not row[7] and (count[1]!=row[5] or variance):review='DISPUTED'
        new_shift=secrets.token_hex(16) if 'RECEPTION' in roles and now<expires+timedelta(hours=48) else None
        if not row[8]:
            changed=conn.execute("UPDATE prsystem.reception_shift SET state='CLOSED',closed_at=%s,review_state=%s WHERE tenant_id=%s AND id=%s AND state='SUBMITTED' RETURNING id",(now,review,tenant,row[0])).fetchone()
            if not changed:raise DomainError('WORK_NOT_OPEN')
            conn.execute("UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=%s AND source_id=%s AND kind='SHIFT'",(tenant,row[0]))
        else:
            if not conn.execute("UPDATE prsystem.cash_custody SET state='RELEASED',released_at=%s WHERE tenant_id=%s AND id=%s AND state='HELD' RETURNING id",(now,tenant,row[8])).fetchone():raise DomainError('WORK_NOT_OPEN')
        conn.execute('UPDATE prsystem.cash_drawer SET posted=%s,shift_id=%s WHERE tenant_id=%s AND id=%s',(count[1],new_shift or row[0],tenant,row[1]))
        if new_shift:
            conn.execute('INSERT INTO prsystem.reception_shift(tenant_id,id,drawer_id,owner_id,opening_actual,owner_roles) VALUES(%s,%s,%s,%s,%s,%s)',(tenant,new_shift,row[1],actor,count[1],roles))
            self.register_open_work(conn,tenant,actor,'SHIFT',new_shift)
        custody=None
        if not new_shift:
            custody=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.cash_custody(tenant_id,id,handover_id,drawer_id,owner_id) VALUES(%s,%s,%s,%s,%s)',(tenant,custody,handover,row[1],actor))
        conn.execute("UPDATE prsystem.shift_handover SET state='ACCEPTED',decided_at=%s,decision_reason=%s,new_shift_id=%s WHERE tenant_id=%s AND id=%s",(now,reason,new_shift,tenant,handover))
        conn.execute('UPDATE prsystem.cash_book SET revision=revision+1 WHERE tenant_id=%s',(tenant,))
        result=dict(handover_id=handover,shift_id=row[0],state='ACCEPTED',new_shift_id=new_shift,custody_id=custody,closing_actual=count[1],variance=variance,review_state=review)
        self.event(conn,tenant,actor,'HANDOVER_ACCEPTED',row[0],dict(result,count_id=count_id,reason=reason))
        return result

    def decide(self,bearer,tenant,handover,accept,count_id,reason,key):
        reason=self.reason(reason)
        command=dict(action='DECIDE_HANDOVER',handover=handover,accept=accept,count_id=count_id,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=self.authenticate_handover(conn,bearer,tenant,handover)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._book(conn,tenant)
            if accept:result=self.finish(conn,tenant,actor,handover,count_id,reason)
            else:
                row=conn.execute("UPDATE prsystem.shift_handover SET state='RETURNED',decided_at=clock_timestamp(),decision_reason=%s WHERE tenant_id=%s AND id=%s AND state='SUBMITTED' RETURNING shift_id,source_custody_id",(reason,tenant,handover)).fetchone()
                if not row:raise DomainError('WORK_NOT_OPEN')
                if not row[1]:conn.execute("UPDATE prsystem.reception_shift SET state='OPEN' WHERE tenant_id=%s AND id=%s AND state='SUBMITTED'",(tenant,row[0]))
                result=dict(handover_id=handover,state='RETURNED',shift_id=row[0])
                self.event(conn,tenant,actor,'HANDOVER_RETURNED',row[0],dict(result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def inbox(self,bearer,tenant):
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);principal,_=self.auth._authenticate(conn,bearer,tenant)
            actor=principal['account_id']
            rows=conn.execute("SELECT id,shift_id,sender_id,submitted_at FROM prsystem.shift_handover WHERE tenant_id=%s AND receiver_id=%s AND state='SUBMITTED' ORDER BY submitted_at,id LIMIT 100",(tenant,actor)).fetchall()
            for row in rows:self.eligible(conn,tenant,actor,row[1],receiver=True)
            # Expected/sender amounts deliberately absent until this receiver counts.
            return [dict(zip(('handover_id','shift_id','sender_id','submitted_at'),row)) for row in rows]
