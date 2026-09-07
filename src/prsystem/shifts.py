"""Reception takeover: separate replacement authorization, count and close.

Payment terminal state is written only by the trusted provider adapter; the
replacement can enqueue reconciliation, never submit a success flag.
"""
import secrets
from dataclasses import asdict
from datetime import timedelta
from prsystem.auth import digest
from prsystem.cash import CashContext, ConfirmTransfer, CancelTransfer, execute
from prsystem.common import DomainError, money
from prsystem.cleaning import CleaningService
from prsystem.postgres.cash import PostgresCash
from prsystem.postgres.connection import transaction
from prsystem.subscription import AccessFacts, Action, subscription_gate


class ShiftService(CleaningService):
    @staticmethod
    def _reception(conn,tenant,account):
        row=conn.execute('''SELECT m.status,m.roles,a.status,a.verified_at,h.expires_at,h.security_suspended
            FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
            JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
            WHERE m.tenant_id=%s AND m.account_id=%s FOR SHARE OF m,h''',(tenant,account)).fetchone()
        if not row or row[0]!='ACTIVE' or row[2]!='ACTIVE' or row[3] is None:
            raise DomainError('ACCOUNT_NOT_ACTIVE_VERIFIED')
        decision=subscription_gate(Action.CONFIGURE,AccessFacts(tenant,True,True,True,'RECEPTION' in row[1],True,True,True,row[5]),row[4],conn.execute('SELECT clock_timestamp()').fetchone()[0])
        if not decision.allowed: raise DomainError(decision.code)

    @staticmethod
    def _book(conn,tenant):
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        row=conn.execute('SELECT revision FROM prsystem.cash_book WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
        if not row: raise DomainError('CASH_BOOK_NOT_FOUND')
        return row[0]

    @classmethod
    def register_shift(cls,conn,tenant,owner,drawer):
        """Internal shift-opening transaction, after authoritative float/handover.

        Adopts only the current posted opening projection; cannot fabricate an
        opening amount. The upstream opening adapter owns initial float policy.
        """
        cls._lock_accounts(conn,{owner}); cls._reception(conn,tenant,owner); cls._book(conn,tenant)
        row=conn.execute('SELECT shift_id,posted,reserved FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,drawer)).fetchone()
        if not row or row[2]: raise DomainError('WORK_SOURCE_CONFLICT')
        conn.execute('INSERT INTO prsystem.reception_shift (tenant_id,id,owner_id,drawer_id,opening_actual) VALUES (%s,%s,%s,%s,%s)',(tenant,row[0],owner,drawer,row[1]))
        cls.register_open_work(conn,tenant,owner,'SHIFT',row[0])
        return row[0]

    def prepare(self,bearer,tenant,exception,revision,replacement,key,reason):
        if not isinstance(reason,str) or not reason.strip() or len(reason)>1000: raise DomainError('INVALID_REASON')
        command=dict(action='PREPARE_TAKEOVER',exception=exception,revision=revision,replacement=replacement,reason=reason)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant,replacement)
            actor=self._queue_actor(conn,bearer,tenant); self._reception(conn,tenant,replacement)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            self._book(conn,tenant)
            row=conn.execute('''SELECT e.claimant_id,e.revision,w.source_id,w.owner_id FROM prsystem.staff_work_exception e
                JOIN prsystem.staff_open_work w ON (w.tenant_id,w.id)=(e.tenant_id,e.work_id)
                JOIN prsystem.reception_shift s ON (s.tenant_id,s.id)=(w.tenant_id,w.source_id)
                WHERE e.tenant_id=%s AND e.id=%s AND w.kind='SHIFT' AND w.state='BLOCKED' AND s.state='OPEN'
                FOR UPDATE OF e,w,s''',(tenant,exception)).fetchone()
            if not row: raise DomainError('WORK_SOURCE_NOT_FOUND')
            if type(revision) is not int or row[1]!=revision: raise DomainError('REVISION_CONFLICT')
            if row[0]!=actor: raise DomainError('EXCEPTION_NOT_CLAIMED')
            if replacement==row[3]: raise DomainError('REPLACEMENT_REQUIRED')
            if conn.execute("SELECT 1 FROM prsystem.reception_shift WHERE tenant_id=%s AND owner_id=%s AND state='OPEN'",(tenant,replacement)).fetchone(): raise DomainError('REPLACEMENT_HAS_OPEN_SHIFT')
            if conn.execute('SELECT 1 FROM prsystem.shift_takeover WHERE tenant_id=%s AND exception_id=%s',(tenant,exception)).fetchone(): raise DomainError('TAKEOVER_ALREADY_PREPARED')
            takeover=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.shift_takeover (tenant_id,id,exception_id,shift_id,replacement_id,created_by) VALUES (%s,%s,%s,%s,%s,%s)',(tenant,takeover,exception,row[2],replacement,actor))
            result=dict(takeover_id=takeover,shift_id=row[2],replacement_id=replacement,status='PREPARED')
            self.event(conn,tenant,actor,'TAKEOVER_PREPARED',row[2],dict(result,original_owner=row[3],reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result); return result

    def _replacement(self,conn,bearer,tenant,takeover):
        self._actors(conn,bearer,tenant)
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        actor=principal['account_id']; self._reception(conn,tenant,actor)
        revision=self._book(conn,tenant)
        row=conn.execute('''SELECT t.shift_id,t.replacement_id,t.completed_at,s.drawer_id,s.state,e.created_at,s.owner_id
            FROM prsystem.shift_takeover t JOIN prsystem.reception_shift s ON (s.tenant_id,s.id)=(t.tenant_id,t.shift_id)
            JOIN prsystem.staff_work_exception e ON (e.tenant_id,e.id)=(t.tenant_id,t.exception_id)
            WHERE t.tenant_id=%s AND t.id=%s FOR UPDATE OF t,s''',(tenant,takeover)).fetchone()
        if not row or row[1]!=actor: raise DomainError('FORBIDDEN')
        return actor,revision,row

    @staticmethod
    def _pending(conn,tenant,row):
        return conn.execute("SELECT 1 FROM prsystem.shift_obligation WHERE tenant_id=%s AND shift_id=%s AND state='PENDING'",(tenant,row[0])).fetchone() or conn.execute("SELECT 1 FROM prsystem.cash_transfer WHERE tenant_id=%s AND (source_id=%s OR destination_id=%s) AND state='PENDING'",(tenant,row[3],row[3])).fetchone()

    def count(self,bearer,tenant,takeover,actual,key):
        money(actual)
        command=dict(action='COUNT_TAKEOVER',takeover=takeover,actual=actual)
        with transaction(self.auth.dsn) as conn:
            actor,revision,row=self._replacement(conn,bearer,tenant,takeover)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            if row[2] or row[4]!='OPEN': raise DomainError('WORK_NOT_OPEN')
            if self._pending(conn,tenant,row): raise DomainError('PENDING_SHIFT_OBLIGATIONS')
            drawer=conn.execute('SELECT posted,reserved,shift_id FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,row[3])).fetchone()
            if drawer[1] or drawer[2]!=row[0]: raise DomainError('WORK_SOURCE_CONFLICT')
            count=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.shift_cash_count (tenant_id,id,takeover_id,actor_id,book_revision,expected,actual,variance)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,count,takeover,actor,revision,drawer[0],actual,actual-drawer[0]))
            result=dict(count_id=count,expected=drawer[0],actual=actual,variance=actual-drawer[0])
            self.event(conn,tenant,actor,'TAKEOVER_COUNTED',row[0],result)
            self._save_receipt(conn,tenant,key,actor,command,result); return result

    def close(self,bearer,tenant,takeover,count_id,key):
        command=dict(action='CLOSE_TAKEOVER',takeover=takeover,count_id=count_id)
        with transaction(self.auth.dsn) as conn:
            actor,revision,row=self._replacement(conn,bearer,tenant,takeover)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            if row[2] or row[4]!='OPEN': raise DomainError('WORK_NOT_OPEN')
            if self._pending(conn,tenant,row): raise DomainError('PENDING_SHIFT_OBLIGATIONS')
            count=conn.execute('SELECT book_revision,expected,actual,variance,counted_at FROM prsystem.shift_cash_count WHERE tenant_id=%s AND id=%s AND takeover_id=%s AND actor_id=%s',(tenant,count_id,takeover,actor)).fetchone()
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            # Count TTL is a server-side P1 configuration default, never client time.
            if not count or count[0]!=revision or now>=count[4]+timedelta(minutes=5): raise DomainError('STALE_CASH_COUNT')
            latest=conn.execute('SELECT id FROM prsystem.shift_cash_count WHERE tenant_id=%s AND takeover_id=%s ORDER BY counted_at DESC,id DESC LIMIT 1',(tenant,takeover)).fetchone()[0]
            if latest!=count_id: raise DomainError('STALE_CASH_COUNT')
            drawer=conn.execute('SELECT posted,reserved,shift_id FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,row[3])).fetchone()
            if drawer!=(count[1],0,row[0]): raise DomainError('STALE_CASH_COUNT')
            if conn.execute("SELECT 1 FROM prsystem.reception_shift WHERE tenant_id=%s AND owner_id=%s AND state='OPEN'",(tenant,actor)).fetchone(): raise DomainError('REPLACEMENT_HAS_OPEN_SHIFT')
            original_roles=conn.execute('SELECT roles FROM prsystem.staff_membership WHERE tenant_id=%s AND account_id=%s',(tenant,row[6])).fetchone()[0]
            review='ADMIN_REQUIRED' if {'MANAGER','MANAGER_PLUS'} & set(original_roles) else 'MANAGER_REQUIRED'
            new_shift=secrets.token_hex(16)
            conn.execute("UPDATE prsystem.reception_shift SET state='CLOSED',closed_at=clock_timestamp(),review_state=%s WHERE tenant_id=%s AND id=%s",(review,tenant,row[0]))
            conn.execute("UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=%s AND kind='SHIFT' AND source_id=%s",(tenant,row[0]))
            # A new opening snapshot is not income. Prior expected/actual and
            # variance remain immutable in shift_cash_count and review history.
            conn.execute('UPDATE prsystem.cash_drawer SET shift_id=%s,posted=%s WHERE tenant_id=%s AND id=%s',(new_shift,count[2],tenant,row[3]))
            conn.execute('INSERT INTO prsystem.reception_shift (tenant_id,id,owner_id,drawer_id,opening_actual) VALUES (%s,%s,%s,%s,%s)',(tenant,new_shift,actor,row[3],count[2]))
            self.register_open_work(conn,tenant,actor,'SHIFT',new_shift)
            conn.execute('UPDATE prsystem.shift_takeover SET completed_at=clock_timestamp(),new_shift_id=%s WHERE tenant_id=%s AND id=%s',(new_shift,tenant,takeover))
            conn.execute('UPDATE prsystem.cash_book SET revision=revision+1 WHERE tenant_id=%s',(tenant,))
            result=dict(old_shift_id=row[0],new_shift_id=new_shift,opening_actual=count[2],variance=count[3],review_state=review)
            self.event(conn,tenant,actor,'TAKEOVER_CLOSED',row[0],dict(result,count_id=count_id,takeover_id=takeover))
            self._save_receipt(conn,tenant,key,actor,command,result); return result

    def reconcile(self,bearer,tenant,takeover,obligation,key):
        command=dict(action='TAKEOVER_RECONCILE',takeover=takeover,obligation=obligation)
        with transaction(self.auth.dsn) as conn:
            actor,_,row=self._replacement(conn,bearer,tenant,takeover)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            if row[2] or row[4]!='OPEN': raise DomainError('WORK_NOT_OPEN')
            item=conn.execute('SELECT shift_id,state,created_at FROM prsystem.shift_obligation WHERE tenant_id=%s AND id=%s FOR SHARE',(tenant,obligation)).fetchone()
            if not item or item[0]!=row[0] or item[1]!='PENDING' or item[2]>=row[5]: raise DomainError('OBLIGATION_NOT_ELIGIBLE')
            conn.execute('INSERT INTO prsystem.shift_reconcile_intent (tenant_id,obligation_id,takeover_id,requested_by) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING',(tenant,obligation,takeover,actor))
            result=dict(status='QUEUED',obligation_id=obligation)
            self.event(conn,tenant,actor,'TAKEOVER_RECONCILE_REQUESTED',row[0],dict(result,takeover_id=takeover))
            self._save_receipt(conn,tenant,key,actor,command,result); return result

    def transfer(self,bearer,tenant,takeover,transfer_id,action,actual,key):
        money(actual)
        if action not in {'RECEIVE','RETURN'}: raise DomainError('INVALID_REQUEST')
        command=dict(action='TAKEOVER_TRANSFER_'+action,takeover=takeover,transfer_id=transfer_id,actual=actual)
        with transaction(self.auth.dsn) as conn:
            actor,revision,row=self._replacement(conn,bearer,tenant,takeover)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            if row[2] or row[4]!='OPEN': raise DomainError('WORK_NOT_OPEN')
            transfer=conn.execute('SELECT source_shift_id,destination_shift_id,state FROM prsystem.cash_transfer WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,transfer_id)).fetchone()
            reserved=conn.execute("SELECT recorded_at FROM prsystem.cash_event WHERE tenant_id=%s AND reference=%s AND kind='TRANSFER_RESERVED'",(tenant,transfer_id)).fetchone()
            if not transfer or transfer[2]!='PENDING' or not reserved or reserved[0]>=row[5] or transfer[0 if action=='RETURN' else 1]!=row[0]: raise DomainError('OBLIGATION_NOT_ELIGIBLE')
            cancel=conn.execute('SELECT reason FROM prsystem.transfer_cancel_request WHERE tenant_id=%s AND transfer_id=%s',(tenant,transfer_id)).fetchone() if action=='RETURN' else None
            if action=='RETURN' and not cancel: raise DomainError('MANAGER_CANCEL_REQUIRED')
            cash_command=ConfirmTransfer(transfer_id,actual) if action=='RECEIVE' else CancelTransfer(transfer_id,actual,cancel[0])
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            ctx=CashContext(tenant,actor,'takeover:'+key,revision,now,authorized=True,shift_id=row[0])
            before=PostgresCash._load(conn,cash_command,tenant,revision)
            after=execute(before,cash_command,ctx)
            PostgresCash._persist(conn,before,after,cash_command,ctx,dict(type=type(cash_command).__name__,fields=asdict(cash_command)))
            result=dict(transfer_id=transfer_id,status='COMPLETED' if action=='RECEIVE' else 'CANCELLED')
            self.event(conn,tenant,actor,'TAKEOVER_TRANSFER_'+action,row[0],dict(result,takeover_id=takeover))
            self._save_receipt(conn,tenant,key,actor,command,result); return result

    def cancel_request(self,bearer,tenant,transfer_id,key,reason):
        if not isinstance(reason,str) or not reason.strip() or len(reason)>1000: raise DomainError('INVALID_REASON')
        command=dict(action='TRANSFER_CANCEL_REQUEST',transfer_id=transfer_id,reason=reason)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant)
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            self._book(conn,tenant)
            transfer=conn.execute("SELECT state FROM prsystem.cash_transfer WHERE tenant_id=%s AND id=%s FOR UPDATE",(tenant,transfer_id)).fetchone()
            initiator=conn.execute("SELECT actor_id FROM prsystem.cash_event WHERE tenant_id=%s AND reference=%s AND kind='TRANSFER_RESERVED'",(tenant,transfer_id)).fetchone()
            if not transfer or transfer[0]!='PENDING' or not initiator or initiator[0]!=actor: raise DomainError('FORBIDDEN')
            conn.execute('INSERT INTO prsystem.transfer_cancel_request (tenant_id,transfer_id,actor_id,reason) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING',(tenant,transfer_id,actor,reason))
            result=dict(transfer_id=transfer_id,status='AWAITING_PHYSICAL_RETURN')
            self.event(conn,tenant,actor,'TRANSFER_CANCEL_REQUESTED',transfer_id,dict(result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result); return result

    def review(self,bearer,tenant,shift_id,decision,key,reason):
        if decision not in {'APPROVE','DISPUTE'} or not isinstance(reason,str) or not reason.strip() or len(reason)>1000: raise DomainError('INVALID_REQUEST')
        command=dict(action='REVIEW_SHIFT',shift_id=shift_id,decision=decision,reason=reason)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant)
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            actor=principal['account_id']
            hotel=conn.execute('SELECT package_mnt,expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
            roles=principal['roles']
            if 'HOTEL_ADMIN' not in roles and not self._manager(roles,hotel[0]): raise DomainError('FORBIDDEN')
            decision_gate=subscription_gate(Action.CONFIGURE,AccessFacts(tenant,True,True,True,True,True,True,True,hotel[2]),hotel[1],conn.execute('SELECT clock_timestamp()').fetchone()[0])
            if not decision_gate.allowed: raise DomainError(decision_gate.code)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            self._book(conn,tenant)
            row=conn.execute('SELECT owner_id,state,review_state FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,shift_id)).fetchone()
            if not row or row[1]!='CLOSED' or row[2] not in {'MANAGER_REQUIRED','ADMIN_REQUIRED','DISPUTED'}: raise DomainError('WORK_NOT_OPEN')
            replacement=conn.execute('SELECT replacement_id FROM prsystem.shift_takeover WHERE tenant_id=%s AND shift_id=%s',(tenant,shift_id)).fetchone()
            self_review=actor in {row[0],replacement[0] if replacement else None}
            if row[2]=='ADMIN_REQUIRED' or self_review:
                if 'HOTEL_ADMIN' not in roles: raise DomainError('FORBIDDEN')
            result=dict(shift_id=shift_id,review_state='APPROVED' if decision=='APPROVE' else 'DISPUTED',self_reviewed=self_review)
            conn.execute('UPDATE prsystem.reception_shift SET review_state=%s WHERE tenant_id=%s AND id=%s',(result['review_state'],tenant,shift_id))
            self.event(conn,tenant,actor,'SHIFT_REVIEWED',shift_id,dict(result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result); return result
