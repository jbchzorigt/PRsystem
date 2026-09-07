"""Source-bound pre-check-in deposit evidence, consumed once in the stay transaction."""
import secrets
from datetime import datetime
from psycopg.types.json import Jsonb
from prsystem.common import DomainError,timestamp
from prsystem.guest_payments import GuestPayments
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.postgres.connection import transaction


class CheckinFunding(GuestPayments):
    def create(self,bearer,tenant,room,channel,key,reference=None,terminal=None,transacted=None):
        if channel=='MANUAL_POS':
            reference=self._text(reference,200).upper();terminal=self._text(terminal,100).upper()
            try:transacted=datetime.fromisoformat(transacted);timestamp(transacted)
            except (ValueError,TypeError) as exc:raise DomainError('INVALID_TRANSACTION_TIME') from exc
        elif reference is not None or terminal is not None or transacted is not None:raise DomainError('INVALID_REQUEST')
        command=dict(action='CHECKIN_FUNDING',room=room,channel=channel,reference=reference,terminal=terminal,transacted=transacted.isoformat() if transacted else None)
        with transaction(self.auth.dsn) as conn:
            actor=StayService._actor(self,conn,bearer,tenant)
            gateway=self.gateway(channel) if channel!='MANUAL_POS' else None
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);self._catalog_lock(conn,tenant)
            row=conn.execute('''SELECT r.category_id,r.status,c.status FROM prsystem.room r JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id)
                WHERE r.tenant_id=%s AND r.id=%s FOR UPDATE OF r''',(tenant,room)).fetchone()
            if not row or row[1:]!=('ACTIVE','ACTIVE'):raise DomainError('ROOM_NOT_READY')
            shift=StayService._shift(conn,tenant,actor);setting=self.setting(conn,tenant,row[0])
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if transacted and not shift[1]<=transacted<=now:raise DomainError('INVALID_TRANSACTION_TIME')
            merchant='POS:'+tenant if channel=='MANUAL_POS' else gateway.merchant_id
            if reference and conn.execute('SELECT 1 FROM prsystem.billing_capture WHERE provider=%s AND merchant_id=%s AND payment_id=%s',(channel,merchant,reference)).fetchone():raise DomainError('PAYMENT_REFERENCE_USED')
            identity=secrets.token_hex(16);state='CONFIRMED' if channel=='MANUAL_POS' else 'PENDING'
            conn.execute('''INSERT INTO prsystem.checkin_funding(tenant_id,id,room_id,actor_id,shift_id,drawer_id,channel,merchant_id,amount_mnt,mode,setting_snapshot,state,payment_id,confirmed_at,terminal_id)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,identity,room,actor,shift[0],shift[2],channel,merchant,setting['amount_mnt'],self.mode,Jsonb(setting),state,reference,transacted,terminal))
            conn.execute("INSERT INTO prsystem.shift_obligation(tenant_id,id,shift_id,provider_reference,state) VALUES(%s,%s,%s,%s,'PENDING')",(tenant,identity,shift[0],'checkin-funding:'+identity))
            result=dict(funding_id=identity,room_id=room,channel=channel,amount_mnt=setting['amount_mnt'],state=state)
            self.event(conn,tenant,actor,'CHECKIN_FUNDING_CREATED',identity,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def reconcile(self,bearer,tenant,funding):
        with transaction(self.auth.dsn) as conn:
            actor=StayService._actor(self,conn,bearer,tenant)
            row=conn.execute('SELECT channel,merchant_id,amount_mnt,invoice_id,state,actor_id,mode FROM prsystem.checkin_funding WHERE tenant_id=%s AND id=%s',(tenant,funding)).fetchone()
            if not row or row[5]!=actor or row[6]!=self.mode:raise DomainError('FORBIDDEN')
            if row[4]!='PENDING':return dict(funding_id=funding,state=row[4])
            gateway=self.gateway(row[0])
        invoice=gateway.create_invoice(funding,row[2],'MNT')
        evidence=gateway.payment(funding,invoice)
        if evidence.get('merchant_id')!=row[1] or evidence.get('invoice_id')!=invoice or type(evidence.get('amount')) is not int or evidence['amount']!=row[2] or evidence.get('currency')!='MNT':raise DomainError('PROVIDER_EVIDENCE_INVALID')
        with transaction(self.auth.dsn) as conn:
            actor=StayService._actor(self,conn,bearer,tenant);ShiftService._book(conn,tenant)
            current=conn.execute('SELECT state,actor_id,invoice_id,recorded_at FROM prsystem.checkin_funding WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,funding)).fetchone()
            if current[1]!=actor:raise DomainError('FORBIDDEN')
            if current[0]!='PENDING':return dict(funding_id=funding,state=current[0])
            if current[2] is not None and current[2]!=invoice:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            conn.execute('UPDATE prsystem.checkin_funding SET invoice_id=%s WHERE tenant_id=%s AND id=%s',(invoice,tenant,funding))
            state='PENDING'
            if evidence.get('status')=='SUCCEEDED':
                now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
                confirmed=evidence.get('confirmed_at')
                if not isinstance(confirmed,datetime) or confirmed.tzinfo is None or not current[3]<=confirmed<=now or not isinstance(evidence.get('payment_id'),str) or not evidence['payment_id']:raise DomainError('PROVIDER_EVIDENCE_INVALID')
                conn.execute("UPDATE prsystem.checkin_funding SET state='CONFIRMED',payment_id=%s,confirmed_at=%s WHERE tenant_id=%s AND id=%s",(evidence['payment_id'],confirmed,tenant,funding))
                state='CONFIRMED'
                self.event(conn,tenant,actor,'CHECKIN_FUNDING_CONFIRMED',funding,dict(channel=row[0],amount_mnt=row[2]))
            return dict(funding_id=funding,state=state,invoice_id=invoice)

    @staticmethod
    def load(conn,tenant,funding,room,actor,shift,amount,mode):
        row=conn.execute('''SELECT channel,merchant_id,payment_id,confirmed_at,terminal_id,state,room_id,actor_id,shift_id,amount_mnt,mode
            FROM prsystem.checkin_funding WHERE tenant_id=%s AND id=%s FOR UPDATE''',(tenant,funding)).fetchone()
        if not row or row[5:]!=('CONFIRMED',room,actor,shift[0],amount,mode):raise DomainError('DEPOSIT_REQUIREMENT_NOT_MET')
        return row

    @staticmethod
    def apply(conn,tenant,funding,stay,receipt,evidence):
        conn.execute('''INSERT INTO prsystem.guest_payment_evidence(tenant_id,stay_id,receipt_id,provider,merchant_id,payment_id,amount_mnt,transacted_at,terminal_id,funding_id)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,stay,receipt,*evidence[:3],evidence[9],evidence[3],evidence[4],funding))
        conn.execute("UPDATE prsystem.checkin_funding SET state='APPLIED',stay_id=%s,receipt_id=%s WHERE tenant_id=%s AND id=%s",(stay,receipt,tenant,funding))
        conn.execute("UPDATE prsystem.shift_obligation SET state='SUCCEEDED' WHERE tenant_id=%s AND id=%s",(tenant,funding))

    def cancel(self,bearer,tenant,funding,key,reason):
        reason=self._text(reason,1000)
        command=dict(action='CANCEL_PENDING_CHECKIN_FUNDING',funding=funding,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=StayService._actor(self,conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            row=conn.execute('SELECT channel,merchant_id,amount_mnt,actor_id,state FROM prsystem.checkin_funding WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,funding)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[3]!=actor:raise DomainError('FORBIDDEN')
            if row[4]!='PENDING':raise DomainError('PAYMENT_ALREADY_PAID')
            gateway=self.gateway(row[0])
            if gateway.merchant_id!=row[1]:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            invoice=gateway.create_invoice(funding,row[2],'MNT');gateway.void_invoice(funding)
            if gateway.payment(funding,invoice).get('status')!='VOIDED':raise DomainError('PROVIDER_EVIDENCE_INVALID')
            conn.execute("UPDATE prsystem.checkin_funding SET state='CANCELLED',invoice_id=%s WHERE tenant_id=%s AND id=%s",(invoice,tenant,funding))
            conn.execute("UPDATE prsystem.shift_obligation SET state='FAILED' WHERE tenant_id=%s AND id=%s",(tenant,funding))
            self.event(conn,tenant,actor,'PENDING_CHECKIN_FUNDING_VOIDED',funding,dict(reason=reason))
            result=dict(funding_id=funding,state='CANCELLED')
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def request_return(self,bearer,tenant,funding,key,reason):
        reason=self._text(reason,1000)
        command=dict(action='RETURN_UNAPPLIED_FUNDING',funding=funding,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=StayService._actor(self,conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            row=conn.execute('SELECT actor_id,state,mode FROM prsystem.checkin_funding WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,funding)).fetchone()
            if not row or row[0]!=actor:raise DomainError('FORBIDDEN')
            if row[1]!='CONFIRMED' or row[2]!=self.mode:raise DomainError('INVALID_FINANCIAL_SOURCE')
            conn.execute('INSERT INTO prsystem.checkin_funding_return(tenant_id,funding_id,actor_id,reason) VALUES(%s,%s,%s,%s)',(tenant,funding,actor,reason))
            conn.execute("UPDATE prsystem.checkin_funding SET state='REFUNDING' WHERE tenant_id=%s AND id=%s",(tenant,funding))
            result=dict(funding_id=funding,state='REFUNDING')
            self.event(conn,tenant,actor,'UNAPPLIED_FUNDING_RETURN_REQUESTED',funding,{})
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def finish_return(self,bearer,tenant,funding,key,reference=None,confirmation=None):
        if reference is not None:self._text(reference,200)
        if confirmation is not None:self._text(confirmation,1000)
        with transaction(self.auth.dsn) as conn:
            actor=StayService._actor(self,conn,bearer,tenant)
            if not self.vault:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
            command=dict(action='FINISH_UNAPPLIED_FUNDING_RETURN',funding=funding,reference=reference,
                         proof=self.vault.fingerprint('unapplied-funding-return',[tenant,funding,confirmation]))
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            row=conn.execute('SELECT actor_id,state,channel,merchant_id,payment_id,amount_mnt,recorded_at,mode FROM prsystem.checkin_funding WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,funding)).fetchone()
            if not row or row[0]!=actor:raise DomainError('FORBIDDEN')
            if row[1]!='REFUNDING' or row[7]!=self.mode:raise DomainError('INVALID_FINANCIAL_SOURCE')
            if row[2]=='MANUAL_POS':
                if not reference or not confirmation:raise DomainError('INVALID_REQUEST')
            else:
                if reference is not None or confirmation is not None:raise DomainError('INVALID_REQUEST')
                gateway=self.gateway(row[2]);request='funding-return:'+funding
                if gateway.merchant_id!=row[3]:raise DomainError('PROVIDER_EVIDENCE_INVALID')
                gateway.create_refund(request,row[4],row[5]);evidence=gateway.refund(request)
                if evidence.get('merchant_id')!=row[3] or evidence.get('original')!=row[4] or evidence.get('amount')!=row[5] or evidence.get('currency')!='MNT':raise DomainError('PROVIDER_EVIDENCE_INVALID')
                if evidence.get('status')!='SUCCEEDED':return dict(funding_id=funding,state='REFUNDING',provider_state=evidence.get('status'))
                now=conn.execute('SELECT clock_timestamp()').fetchone()[0];confirmed=evidence.get('confirmed_at')
                if not isinstance(confirmed,datetime) or confirmed.tzinfo is None or not row[6]<=confirmed<=now:raise DomainError('PROVIDER_EVIDENCE_INVALID')
                reference=evidence.get('reference');self._text(reference,200);confirmation='Authoritative mock provider refund'
            conn.execute('UPDATE prsystem.checkin_funding_return SET completed_at=clock_timestamp(),provider_reference=%s,confirmation_envelope=%s WHERE tenant_id=%s AND funding_id=%s',(reference,Jsonb(self.vault.seal(confirmation,tenant,funding,'funding-return')),tenant,funding))
            conn.execute("UPDATE prsystem.checkin_funding SET state='CANCELLED' WHERE tenant_id=%s AND id=%s",(tenant,funding))
            conn.execute("UPDATE prsystem.shift_obligation SET state='FAILED' WHERE tenant_id=%s AND id=%s",(tenant,funding))
            result=dict(funding_id=funding,state='CANCELLED',returned=True)
            self.event(conn,tenant,actor,'UNAPPLIED_FUNDING_RETURNED',funding,dict(channel=row[2],amount_mnt=row[5]))
            self._save_receipt(conn,tenant,key,actor,command,result);return result
