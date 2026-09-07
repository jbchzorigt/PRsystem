"""Original/approved alternate refund channels with held liability and late-success cases."""
import secrets
from datetime import datetime
from psycopg.types.json import Jsonb
from prsystem.common import DomainError,money
from prsystem.deposit_policy import require_available
from prsystem.guest_payments import GuestPayments
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction


FINAL_NOT_PAID={'FINAL_FAILED','VOIDED','NOT_PROCESSED','CORRECTED_NOT_SUCCESS'}


class RoutedRefunds(GuestPayments):
    def reserve(self,bearer,tenant,stay,receipt,amount,channel,recipient,reason,revision,key):
        money(amount,positive=True);reason=self._text(reason,1000);recipient=self._text(recipient,1000)
        if channel not in {'CASH','MANUAL_POS','QPAY','KHAAN'}:raise DomainError('INVALID_REQUEST')
        if self.vault is None:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
        command=dict(action='RESERVE_ROUTED_REFUND',stay=stay,receipt=receipt,amount=amount,channel=channel,reason=reason,revision=revision,recipient_hash=self.vault.fingerprint('refund-recipient',[tenant,stay,recipient]))
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,action=Action.REFUND)
            if channel in {'QPAY','KHAAN'}:self.gateway(channel)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before=self.lock(conn,tenant,stay,revision);after=dict(before)
            shift=StayService._shift(conn,tenant,actor)
            self.no_pending_correction(conn,tenant,receipt)
            source=self.load_receipt(conn,tenant,stay,receipt)
            if source[5]!='DEPOSIT':raise DomainError('INVALID_FINANCIAL_SOURCE')
            if channel==source[7]=='CASH' and source[6]!=shift[2]:raise DomainError('ORIGINAL_CASH_DRAWER_REQUIRED')
            require_available(amount,self.receipt_balance(source));require_available(amount,self.balance(before)['available'])
            refund=secrets.token_hex(16);now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute("INSERT INTO prsystem.guest_refund(tenant_id,stay_id,id,receipt_id,amount_mnt,channel,state,actor_id,shift_id,drawer_id,recorded_at) VALUES(%s,%s,%s,%s,%s,%s,'RESERVED',%s,%s,%s,%s)",(tenant,stay,refund,receipt,amount,channel,actor,shift[0],shift[2],now))
            approval='APPROVED' if channel==source[7] else 'PENDING'
            conn.execute('''INSERT INTO prsystem.guest_refund_route(tenant_id,refund_id,original_channel,recipient_envelope,reason,approval)
                VALUES(%s,%s,%s,%s,%s,%s)''',(tenant,refund,source[7],Jsonb(self.vault.seal(recipient,tenant,stay,'refund-recipient:'+refund)),reason,approval))
            conn.execute('UPDATE prsystem.guest_receipt SET refund_reserved=refund_reserved+%s WHERE tenant_id=%s AND id=%s',(amount,tenant,receipt))
            conn.execute("INSERT INTO prsystem.shift_obligation(tenant_id,id,shift_id,provider_reference,state) VALUES(%s,%s,%s,%s,'PENDING')",(tenant,refund,shift[0],'guest-routed-refund:'+refund))
            if channel=='CASH':self.cash(conn,tenant,actor,shift[0],shift[2],'GUEST_REFUND_RESERVED',refund,0,amount,now)
            after['refund_reserved']+=amount
            balance=self.save(conn,tenant,stay,before,after,actor,'ROUTED_REFUND_RESERVED',refund,dict(channel=channel,original_channel=source[7],amount_mnt=amount,approval=approval),now)
            result=dict(refund_id=refund,state='RESERVED',approval=approval,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    @staticmethod
    def source(conn,tenant,stay,refund):
        row=conn.execute('''SELECT f.receipt_id,f.amount_mnt,f.channel,f.state,f.actor_id,f.shift_id,f.drawer_id,
            r.approval,r.sent_at,r.provider_reference,f.recorded_at FROM prsystem.guest_refund f
            JOIN prsystem.guest_refund_route r ON(r.tenant_id,r.refund_id)=(f.tenant_id,f.id)
            WHERE f.tenant_id=%s AND f.stay_id=%s AND f.id=%s FOR UPDATE OF f,r''',(tenant,stay,refund)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        return row

    def approve(self,bearer,tenant,stay,refund,approve,reason,key):
        reason=self._text(reason,1000);command=dict(action='REFUND_ROUTE_APPROVAL',stay=stay,refund=refund,approve=approve,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=True,action=Action.REFUND)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);before=self.lock(conn,tenant,stay)
            row=self.source(conn,tenant,stay,refund)
            if row[3]!='RESERVED' or row[7]!='PENDING' or row[8] is not None:raise DomainError('WORK_NOT_OPEN')
            conn.execute('''UPDATE prsystem.guest_refund_route SET approval=%s,approver_id=%s,approval_reason=%s,approved_at=clock_timestamp()
                WHERE tenant_id=%s AND refund_id=%s''',('APPROVED' if approve else 'REJECTED',actor,reason,tenant,refund))
            if not approve:result=self.terminal(conn,tenant,stay,refund,row,before,actor,reason,release=True)
            else:
                now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
                balance=self.save(conn,tenant,stay,before,before,actor,'REFUND_ROUTE_APPROVED',refund,dict(reason=reason,self_approved=actor==row[4]),now)
                result=dict(refund_id=refund,approval='APPROVED',balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def terminal(self,conn,tenant,stay,refund,row,before,actor,confirmation,*,release=False):
        if row[3]!='RESERVED':raise DomainError('REFUND_TERMINAL')
        if not release and row[7]!='APPROVED':raise DomainError('REFUND_APPROVAL_REQUIRED')
        source=self.load_receipt(conn,tenant,stay,row[0])
        if row[1]>source[2] or row[1]>before['refund_reserved']:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0];after=dict(before)
        state='RELEASED' if release else 'COMPLETED'
        envelope=self.vault.seal(dict(confirmation=confirmation,actor_id=actor),tenant,stay,'routed-refund:'+refund)
        conn.execute('UPDATE prsystem.guest_refund SET state=%s,completed_at=%s,released_at=%s,confirmation_envelope=%s WHERE tenant_id=%s AND id=%s',(state,None if release else now,now if release else None,Jsonb(envelope),tenant,refund))
        conn.execute('UPDATE prsystem.guest_receipt SET refund_reserved=refund_reserved-%s,refunded=refunded+%s WHERE tenant_id=%s AND id=%s',(row[1],0 if release else row[1],tenant,row[0]))
        conn.execute('UPDATE prsystem.shift_obligation SET state=%s WHERE tenant_id=%s AND id=%s',('FAILED' if release else 'SUCCEEDED',tenant,refund))
        if row[2]=='CASH':self.cash(conn,tenant,actor,row[5],row[6],'GUEST_REFUND_RELEASED' if release else 'GUEST_REFUND_PAID',refund,0 if release else -row[1],-row[1],now)
        after['refund_reserved']-=row[1]
        if not release:after['refunded']+=row[1]
        balance=self.save(conn,tenant,stay,before,after,actor,'ROUTED_REFUND_'+state,refund,dict(amount_mnt=row[1],channel=row[2],receipt_id=row[0]),now)
        return dict(refund_id=refund,state=state,balance=balance)

    def manual(self,bearer,tenant,stay,refund,confirmation,reference,revision,key):
        confirmation=self._text(confirmation,1000)
        if self.vault is None:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
        command=dict(action='MANUAL_ROUTED_REFUND',stay=stay,refund=refund,reference=reference,revision=revision,confirmation_hash=self.vault.fingerprint('refund-confirmation',[tenant,stay,confirmation]))
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,action=Action.REFUND)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);before=self.lock(conn,tenant,stay,revision)
            row=self.source(conn,tenant,stay,refund)
            if row[2] not in {'CASH','MANUAL_POS'}:raise DomainError('INVALID_FINANCIAL_SOURCE')
            shift=StayService._shift(conn,tenant,actor)
            if (shift[0],shift[2])!=(row[5],row[6]):raise DomainError('ORIGINAL_CASH_DRAWER_REQUIRED')
            if row[2]=='MANUAL_POS':
                reference=self._text(reference,200).upper()
                conn.execute('INSERT INTO prsystem.refund_provider_evidence VALUES(%s,%s,%s,%s,%s,%s,clock_timestamp())',(tenant,refund,'MANUAL_POS','POS:'+tenant,reference,row[1]))
            result=self.terminal(conn,tenant,stay,refund,row,before,actor,confirmation)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def evidence(self,channel,refund,receipt,amount,*,send=False):
        gateway=self.gateway(channel)
        if send:gateway.create_refund(refund,receipt,amount)
        evidence=gateway.refund(refund)
        if evidence.get('merchant_id')!=gateway.merchant_id or evidence.get('original')!=receipt or type(evidence.get('amount')) is not int or evidence['amount']!=amount or evidence.get('currency')!='MNT' or not isinstance(evidence.get('reference'),str) or not evidence['reference']:raise DomainError('PROVIDER_EVIDENCE_INVALID')
        return evidence

    def reconcile(self,bearer,tenant,stay,refund):
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,action=Action.REFUND)
            ShiftService._book(conn,tenant);self.lock(conn,tenant,stay,allow_frozen=True)
            row=self.source(conn,tenant,stay,refund);self.gateway(row[2])
            if row[3]=='COMPLETED':return dict(refund_id=refund,state='COMPLETED')
            if row[7]!='APPROVED':raise DomainError('REFUND_APPROVAL_REQUIRED')
            if row[3]=='RESERVED' and row[8] is None:
                conn.execute('UPDATE prsystem.guest_refund_route SET sent_at=clock_timestamp() WHERE tenant_id=%s AND refund_id=%s',(tenant,refund))
            if row[3]=='RELEASED' and row[8] is None:return dict(refund_id=refund,state='RELEASED')
        evidence=self.evidence(row[2],refund,row[0],row[1],send=row[3]=='RESERVED')
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,action=Action.REFUND)
            ShiftService._book(conn,tenant);before=self.lock(conn,tenant,stay,allow_frozen=True)
            row=self.source(conn,tenant,stay,refund)
            conn.execute('UPDATE prsystem.guest_refund_route SET provider_reference=%s,last_provider_state=%s WHERE tenant_id=%s AND refund_id=%s',(evidence['reference'],evidence['status'],tenant,refund))
            if evidence['status']!='SUCCEEDED':return dict(refund_id=refund,state=row[3],provider_state=evidence['status'])
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0];confirmed=evidence.get('confirmed_at')
            if not isinstance(confirmed,datetime) or confirmed.tzinfo is None or not row[10]<=confirmed<=now:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            if row[3]=='RELEASED':
                created=conn.execute('''INSERT INTO prsystem.late_refund_case(tenant_id,refund_id,provider_reference,amount_mnt) VALUES(%s,%s,%s,%s)
                    ON CONFLICT DO NOTHING RETURNING refund_id''',(tenant,refund,evidence['reference'],row[1])).fetchone()
                if created:
                    conn.execute('UPDATE prsystem.guest_finance SET frozen=true WHERE tenant_id=%s AND stay_id=%s',(tenant,stay))
                    self.save(conn,tenant,stay,before,dict(before,frozen=True),actor,'LATE_REFUND_SUCCESS',refund,dict(amount_mnt=row[1]),now)
                else:
                    case=conn.execute('SELECT state FROM prsystem.late_refund_case WHERE tenant_id=%s AND refund_id=%s',(tenant,refund)).fetchone()
                    if case[0] not in {'OPEN','RECONCILING'}:return dict(refund_id=refund,state=case[0],frozen=before['frozen'])
                return dict(refund_id=refund,state='LATE_REFUND_SUCCESS',frozen=True)
            if row[3]=='COMPLETED':return dict(refund_id=refund,state='COMPLETED')
            if before['frozen']:raise DomainError('FINANCIAL_AGGREGATE_FROZEN')
            conn.execute('INSERT INTO prsystem.refund_provider_evidence VALUES(%s,%s,%s,%s,%s,%s,%s)',(tenant,refund,row[2],evidence['merchant_id'],evidence['reference'],row[1],confirmed))
            return self.terminal(conn,tenant,stay,refund,row,before,actor,'SERVER_CONFIRMED_PROVIDER_REFUND')

    def release(self,bearer,tenant,stay,refund,reason,revision,key):
        reason=self._text(reason,1000)
        # An authoritative query, never a status supplied by Reception/Manager.
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant,stay,manager=True,action=Action.REFUND)
            row=self.source(conn,tenant,stay,refund)
            sent=row[8]
        evidence=self.evidence(row[2],refund,row[0],row[1]) if sent and row[2] in {'QPAY','KHAAN'} else None
        command=dict(action='RELEASE_ROUTED_REFUND',stay=stay,refund=refund,reason=reason,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=True,action=Action.REFUND)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);before=self.lock(conn,tenant,stay,revision)
            row=self.source(conn,tenant,stay,refund)
            if row[8] is not None and (sent!=row[8] or not evidence or evidence['status'] not in FINAL_NOT_PAID):raise DomainError('REFUND_RELEASE_NOT_PROVEN')
            result=self.terminal(conn,tenant,stay,refund,row,before,actor,reason,release=True)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def claim_case(self,platform,bearer,tenant,refund,key):
        command=dict(action='CLAIM_LATE_REFUND',tenant=tenant,refund=refund)
        with transaction(self.auth.dsn) as conn:
            actor,_=platform.authenticate(conn,bearer,'DEPOSIT_REFUND_RECONCILE')
            replay=platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            row=conn.execute('SELECT state,claimant_id FROM prsystem.late_refund_case WHERE tenant_id=%s AND refund_id=%s FOR UPDATE',(tenant,refund)).fetchone()
            if not row or row[0] not in {'OPEN','RECONCILING'}:raise DomainError('WORK_NOT_OPEN')
            if row[1] not in {None,actor}:raise DomainError('EXCEPTION_ALREADY_CLAIMED')
            conn.execute("UPDATE prsystem.late_refund_case SET state='RECONCILING',claimant_id=%s WHERE tenant_id=%s AND refund_id=%s",(actor,tenant,refund))
            result=dict(refund_id=refund,state='RECONCILING')
            platform._event(conn,actor,'LATE_REFUND_CLAIMED',refund,dict(tenant_id=tenant))
            platform.save(conn,key,actor,command,result);return result

    def resolve_case(self,platform,bearer,tenant,refund,reason,key):
        reason=self._text(reason,1000)
        with transaction(self.auth.dsn) as conn:
            platform.authenticate(conn,bearer,'DEPOSIT_REFUND_RECONCILE')
            source=conn.execute('SELECT stay_id,channel,receipt_id,amount_mnt FROM prsystem.guest_refund WHERE tenant_id=%s AND id=%s',(tenant,refund)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
        evidence=self.evidence(source[1],refund,source[2],source[3])
        command=dict(action='RESOLVE_LATE_REFUND',tenant=tenant,refund=refund,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor,_=platform.authenticate(conn,bearer,'DEPOSIT_REFUND_RECONCILE')
            replay=platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);before=self.lock(conn,tenant,source[0],allow_frozen=True)
            case=conn.execute('SELECT state,claimant_id,provider_reference FROM prsystem.late_refund_case WHERE tenant_id=%s AND refund_id=%s FOR UPDATE',(tenant,refund)).fetchone()
            if not case or case[0]!='RECONCILING' or case[1]!=actor:raise DomainError('EXCEPTION_NOT_CLAIMED')
            if case[2]!=evidence['reference']:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            if evidence['status']!='SUCCEEDED' and evidence['status'] not in FINAL_NOT_PAID:
                return dict(refund_id=refund,state='RECONCILING',frozen=True)
            covered=shortfall=0;after=dict(before)
            state='PROVIDER_STATUS_CORRECTED_NOT_SUCCESS'
            if evidence['status']=='SUCCEEDED':
                covered=min(self.balance(before)['available'],source[3]);shortfall=source[3]-covered
                remaining=covered
                receipts=conn.execute("SELECT id,amount_mnt-allocated-refund_reserved-refunded-reversed FROM prsystem.guest_receipt WHERE tenant_id=%s AND stay_id=%s AND purpose='DEPOSIT' ORDER BY (id=%s) DESC,id FOR UPDATE",(tenant,source[0],source[2])).fetchall()
                for receipt_id,available in receipts:
                    take=min(remaining,available)
                    if take:conn.execute('UPDATE prsystem.guest_receipt SET refunded=refunded+%s WHERE tenant_id=%s AND id=%s',(take,tenant,receipt_id))
                    remaining-=take
                if remaining:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
                after['refunded']+=covered
                for kind,amount in [('LATE_REFUND_COVERED',covered),('LATE_REFUND_SHORTFALL',shortfall)]:
                    if amount:conn.execute('INSERT INTO prsystem.late_refund_posting(tenant_id,refund_id,kind,amount_mnt,resolver_id) VALUES(%s,%s,%s,%s,%s)',(tenant,refund,kind,amount,actor))
                state='PROVIDER_SUCCESS_POSTED'
            conn.execute('UPDATE prsystem.late_refund_case SET state=%s,resolver_id=%s,resolved_at=clock_timestamp(),reason=%s WHERE tenant_id=%s AND refund_id=%s',(state,actor,reason,tenant,refund))
            frozen=bool(conn.execute("SELECT 1 FROM prsystem.late_refund_case c JOIN prsystem.guest_refund f ON(f.tenant_id,f.id)=(c.tenant_id,c.refund_id) WHERE f.tenant_id=%s AND f.stay_id=%s AND c.state IN ('OPEN','RECONCILING')",(tenant,source[0])).fetchone())
            after['frozen']=frozen
            conn.execute('UPDATE prsystem.guest_finance SET frozen=%s WHERE tenant_id=%s AND stay_id=%s',(frozen,tenant,source[0]))
            requester=conn.execute('SELECT actor_id FROM prsystem.guest_refund WHERE tenant_id=%s AND id=%s',(tenant,refund)).fetchone()[0]
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            self.save(conn,tenant,source[0],before,after,requester,'LATE_REFUND_RESOLVED',refund,dict(platform_resolver_id=actor,covered_amount=covered,shortfall_amount=shortfall,outcome=state),now)
            result=dict(refund_id=refund,state=state,covered_amount=covered,shortfall_amount=shortfall,frozen=frozen)
            platform._event(conn,actor,'LATE_REFUND_RESOLVED',refund,dict(result,tenant_id=tenant,reason=reason))
            platform.save(conn,key,actor,command,result);return result
