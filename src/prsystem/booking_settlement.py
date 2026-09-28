"""MFA-authorized mock bank reconciliation, immutable eligibility and payout."""
import json
import secrets
from datetime import datetime
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.booking_lifecycle import BookingLifecycle
from prsystem.booking_inventory import scope
from prsystem.common import DomainError
from prsystem.postgres.connection import transaction
from prsystem.settlement import commission_mnt,payout_batch_at
from prsystem.mock_bank import MockBankGateway


class BookingSettlement(BookingLifecycle):
    def __init__(self,auth,vault,runtime_mode,gateways,platform,bank):
        super().__init__(auth,vault,runtime_mode,gateways)
        self.platform,self.bank=platform,bank
    def finance_actor(self,conn,token,tenant,permission='BOOKING_FINANCE'):
        self.mock()
        if self.platform is None or not isinstance(self.bank,MockBankGateway):raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
        actor,_=self.platform.authenticate(conn,token,permission)
        scope(conn,tenant);self._catalog_lock(conn,tenant)
        hotel=conn.execute('SELECT security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        if not hotel or hotel[0]:raise DomainError('FORBIDDEN')
        return actor
    def ledger(self,conn,tenant,hold,kind,amount,source):
        conn.execute('INSERT INTO prsystem.booking_finance_event(tenant_id,id,hold_id,kind,amount_mnt,source_id) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,kind,source_id) DO NOTHING',(tenant,secrets.token_hex(16),hold,kind,amount,source))
    def assessment(self,conn,tenant,hold,*,record_fees=False):
        result=self.statement(conn,tenant,hold)
        terminal=result['booking_state'] in {'COMPLETED','NO_SHOW','CANCELLED_GUEST','CANCELLED_HOTEL'}
        if not terminal:return dict(state='NOT_ELIGIBLE',booking_id=hold)
        if result['refund_remaining_mnt']:return dict(state='HELD',booking_id=hold,reason='REFUND_REQUIRED')
        # Completed refund evidence is independently checked before settlement;
        # corrections never silently turn into permission to pay.
        refs=conn.execute('''SELECT r.id,c.provider,c.merchant_id,c.payment_id,r.amount_mnt,f.provider_reference
            FROM prsystem.booking_refund_request r JOIN prsystem.booking_hold_capture c ON(c.tenant_id,c.attempt_id)=(r.tenant_id,r.attempt_id)
            JOIN prsystem.booking_refund_confirmation f ON(f.tenant_id,f.request_id)=(r.tenant_id,r.id) WHERE r.tenant_id=%s AND r.hold_id=%s''',(tenant,hold)).fetchall()
        for identity,provider,merchant,payment,amount,reference in refs:
            e=self.gateway(provider).refund(identity)
            if (e.get('status'),e.get('merchant_id'),e.get('original'),e.get('amount'),e.get('currency'),e.get('reference'))!=('SUCCEEDED',merchant,payment,amount,'MNT',reference):return dict(state='HELD',booking_id=hold,reason='REFUND_RECONCILIATION')
        captures=conn.execute('SELECT attempt_id,provider,merchant_id,payment_id,amount_mnt FROM prsystem.booking_hold_capture WHERE tenant_id=%s AND hold_id=%s ORDER BY attempt_id',(tenant,hold)).fetchall()
        credits=[];chargeback=0
        for attempt,provider,merchant,payment,amount in captures:
            credit=self.bank.credit(tenant,provider,merchant,payment)
            if not credit or credit['amount']!=amount or credit['disputed']:return dict(state='HELD',booking_id=hold,reason='BANK_RECONCILIATION')
            credits.append(credit)
            if record_fees:self.ledger(conn,tenant,hold,'PROVIDER_FEE',credit['fee'],attempt)
            if attempt==result['applied_attempt_id']:chargeback=credit['chargeback']
            elif credit['chargeback']:return dict(state='HELD',booking_id=hold,reason='EXTRA_CAPTURE_RECONCILIATION')
        # An issued invoice with a newly successful capture must be applied by
        # payment reconciliation before finance may settle this booking.
        for attempt in result['attempts']:
            if attempt['invoice_id'] and attempt['state']!='PAID':
                evidence=self.gateway(attempt['provider']).payment('booking:'+attempt['attempt_id'],attempt['invoice_id'])
                if evidence.get('status') in {'SUCCEEDED','UNKNOWN'}:return dict(state='HELD',booking_id=hold,reason='PAYMENT_RECONCILIATION')
        captured=result['quote']['amount_mnt'] if result['applied_attempt_id'] else 0;retained=result['cancellation']['retained_mnt'] if result['cancellation'] else captured
        if chargeback>retained:return dict(state='HELD',booking_id=hold,reason='CHARGEBACK_RECONCILIATION')
        retained-=chargeback
        commission=commission_mnt(retained,(result['confirmation'] or {}).get('rate_bps',0));net=retained-commission
        return dict(state='ELIGIBLE' if net else 'NO_PAYABLE',booking_id=hold,captured_mnt=captured,retained_mnt=retained,commission_mnt=commission,net_mnt=net,contract=result['confirmation'],bank=credits)
    def assess(self,token,tenant,hold):
        with transaction(self.auth.dsn) as conn:
            actor=self.finance_actor(conn,token,tenant)
            current=self.assessment(conn,tenant,hold,record_fees=True)
            old=conn.execute('SELECT net_mnt,eligible_at,batch_after FROM prsystem.booking_settlement WHERE tenant_id=%s AND hold_id=%s',(tenant,hold)).fetchone()
            if current['state'] in {'HELD','NOT_ELIGIBLE'}:return current
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if not old:
                conn.execute('INSERT INTO prsystem.booking_settlement VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,hold,current['captured_mnt'],current['retained_mnt'],current['commission_mnt'],current['net_mnt'],now,payout_batch_at(now),Jsonb(current)))
                self.ledger(conn,tenant,hold,'COMMISSION',current['commission_mnt'],hold)
                self.ledger(conn,tenant,hold,'HOTEL_PAYABLE',current['net_mnt'],hold)
                self.platform._event(conn,actor,'BOOKING_ELIGIBLE',hold,dict(tenant_id=tenant,net_mnt=current['net_mnt']))
                old=(current['net_mnt'],now,payout_batch_at(now))
            else:
                effective=old[0]+conn.execute('SELECT coalesce(sum(amount_mnt),0) FROM prsystem.booking_settlement_adjustment WHERE tenant_id=%s AND hold_id=%s',(tenant,hold)).fetchone()[0]
                delta=current['net_mnt']-effective
                if delta:
                    identity=secrets.token_hex(16);fingerprint=digest(json.dumps(current,sort_keys=True,default=str))
                    conn.execute('INSERT INTO prsystem.booking_settlement_adjustment(tenant_id,id,hold_id,amount_mnt,target_net,source_hash,snapshot) VALUES(%s,%s,%s,%s,%s,%s,%s)',(tenant,identity,hold,delta,current['net_mnt'],fingerprint,Jsonb(current)))
                    self.ledger(conn,tenant,hold,'ADJUSTMENT',delta,identity)
                    prior=conn.execute("SELECT coalesce(sum(amount_mnt),0) FROM prsystem.booking_finance_event WHERE tenant_id=%s AND hold_id=%s AND kind IN ('COMMISSION','COMMISSION_ADJUSTMENT')",(tenant,hold)).fetchone()[0]
                    self.ledger(conn,tenant,hold,'COMMISSION_ADJUSTMENT',current['commission_mnt']-prior,identity)
                    self.platform._event(conn,actor,'BOOKING_ADJUSTMENT',hold,dict(tenant_id=tenant,amount_mnt=int(delta)))
            return dict(current,eligible_at=old[1],batch_after=old[2])
    def beneficiary(self,token,tenant,reference,revision,key):
        with transaction(self.auth.dsn) as conn:
            actor=self.finance_actor(conn,token,tenant)
            command=dict(action='BOOKING_BENEFICIARY',tenant=tenant,reference=reference,revision=revision)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            if not self.bank.beneficiary(tenant,reference):raise DomainError('BANK_BENEFICIARY_UNVERIFIED')
            version=conn.execute('SELECT coalesce(max(revision),0) FROM prsystem.booking_beneficiary WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            if version!=revision:raise DomainError('REVISION_CONFLICT')
            conn.execute('INSERT INTO prsystem.booking_beneficiary(tenant_id,revision,reference,actor_id) VALUES(%s,%s,%s,%s)',(tenant,revision+1,reference,actor))
            result=dict(revision=revision+1,reference=reference)
            self.platform._event(conn,actor,'BOOKING_BENEFICIARY',tenant,result);self.platform.save(conn,key,actor,command,result)
            return result
    def batch(self,token,tenant,key):
        with transaction(self.auth.dsn) as conn:
            actor=self.finance_actor(conn,token,tenant,'PAYOUT_EXECUTE')
            command=dict(action='BOOKING_PAYOUT_BATCH',tenant=tenant)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            beneficiary=conn.execute('SELECT revision,reference FROM prsystem.booking_beneficiary WHERE tenant_id=%s ORDER BY revision DESC LIMIT 1',(tenant,)).fetchone()
            if not beneficiary or not self.bank.beneficiary(tenant,beneficiary[1]):raise DomainError('BANK_BENEFICIARY_UNVERIFIED')
            rows=conn.execute('''SELECT 'BASE',s.hold_id,s.hold_id,s.net_mnt FROM prsystem.booking_settlement s WHERE s.tenant_id=%s AND s.batch_after<=clock_timestamp() AND s.net_mnt>0
                AND NOT EXISTS(SELECT 1 FROM prsystem.booking_payout_line l WHERE l.tenant_id=s.tenant_id AND l.kind='BASE' AND l.source_id=s.hold_id AND NOT EXISTS(SELECT 1 FROM prsystem.booking_payout_void v WHERE (v.tenant_id,v.batch_id)=(l.tenant_id,l.batch_id)))
                UNION ALL SELECT 'ADJUSTMENT',a.id,a.hold_id,a.amount_mnt FROM prsystem.booking_settlement_adjustment a JOIN prsystem.booking_settlement s ON(s.tenant_id,s.hold_id)=(a.tenant_id,a.hold_id) WHERE a.tenant_id=%s AND s.batch_after<=clock_timestamp()
                AND NOT EXISTS(SELECT 1 FROM prsystem.booking_payout_line l WHERE l.tenant_id=a.tenant_id AND l.kind='ADJUSTMENT' AND l.source_id=a.id AND NOT EXISTS(SELECT 1 FROM prsystem.booking_payout_void v WHERE (v.tenant_id,v.batch_id)=(l.tenant_id,l.batch_id))) ORDER BY 2''',(tenant,tenant)).fetchall()
            eligible=[]
            for kind,source,hold,amount in rows:
                assessment=self.assessment(conn,tenant,hold)
                if assessment['state'] not in {'ELIGIBLE','NO_PAYABLE'}:
                    if amount<0:raise DomainError('SETTLEMENT_HELD')
                    continue
                current=conn.execute('SELECT net_mnt+(SELECT coalesce(sum(amount_mnt),0) FROM prsystem.booking_settlement_adjustment a WHERE a.tenant_id=s.tenant_id AND a.hold_id=s.hold_id) FROM prsystem.booking_settlement s WHERE tenant_id=%s AND hold_id=%s',(tenant,hold)).fetchone()[0]
                if current!=assessment['net_mnt']:raise DomainError('SETTLEMENT_REFRESH_REQUIRED')
                eligible.append((kind,source,hold,amount,assessment['net_mnt']))
            total=sum(r[3] for r in eligible)
            if total<=0:
                result=dict(state='NO_PAYABLE',receivable_mnt=int(-total),mode='MOCK_ONLY')
                self.platform.save(conn,key,actor,command,result);return result
            batch=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.booking_payout_batch(tenant_id,id,amount_mnt,beneficiary_revision) VALUES(%s,%s,%s,%s)',(tenant,batch,total,beneficiary[0]))
            for kind,source,hold,amount,expected in eligible:conn.execute('INSERT INTO prsystem.booking_payout_line VALUES(%s,%s,%s,%s,%s,%s,%s)',(tenant,batch,kind,source,hold,amount,expected))
            result=dict(batch_id=batch,amount_mnt=int(total),state='BATCHED',mode='MOCK_ONLY')
            self.platform._event(conn,actor,'BOOKING_PAYOUT_BATCH',tenant,result);self.platform.save(conn,key,actor,command,result)
            return result
    def payout(self,token,tenant,batch,key):
        with transaction(self.auth.dsn) as conn:
            actor=self.finance_actor(conn,token,tenant,'PAYOUT_EXECUTE')
            command=dict(action='BOOKING_PAYOUT',tenant=tenant,batch=batch)
            replay=self.platform.receipt(conn,key,actor,command)
            if conn.execute('SELECT 1 FROM prsystem.booking_payout_void WHERE tenant_id=%s AND batch_id=%s',(tenant,batch)).fetchone():raise DomainError('PAYOUT_TERMINAL')
            if replay is None:
                row=conn.execute('SELECT amount_mnt,beneficiary_revision FROM prsystem.booking_payout_batch WHERE tenant_id=%s AND id=%s',(tenant,batch)).fetchone()
                if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
                if conn.execute("SELECT 1 FROM prsystem.booking_payout_result WHERE tenant_id=%s AND batch_id=%s AND state='SUCCEEDED'",(tenant,batch)).fetchone():raise DomainError('PAYOUT_TERMINAL')
                latest=conn.execute('''SELECT a.id,a.sequence,r.state FROM prsystem.booking_payout_attempt a LEFT JOIN prsystem.booking_payout_result r ON(r.tenant_id,r.attempt_id)=(a.tenant_id,a.id)
                    WHERE a.tenant_id=%s AND a.batch_id=%s ORDER BY a.sequence DESC LIMIT 1''',(tenant,batch)).fetchone()
                if latest and latest[2] is None:raise DomainError('PAYOUT_PENDING')
                identity='booking-payout:'+secrets.token_hex(16)
                conn.execute('INSERT INTO prsystem.booking_payout_attempt(tenant_id,id,batch_id,sequence) VALUES(%s,%s,%s,%s)',(tenant,identity,batch,latest[1]+1 if latest else 1))
                replay=dict(attempt_id=identity,batch_id=batch)
                self.platform.save(conn,key,actor,command,replay)
        return self.reconcile_payout(token,tenant,batch,replay['attempt_id'])
    def reconcile_payout(self,token,tenant,batch,attempt):
        with transaction(self.auth.dsn) as conn:
            actor=self.finance_actor(conn,token,tenant,'PAYOUT_EXECUTE')
            row=conn.execute('''SELECT b.amount_mnt,d.reference,a.created_at FROM prsystem.booking_payout_batch b JOIN prsystem.booking_beneficiary d ON(d.tenant_id,d.revision)=(b.tenant_id,b.beneficiary_revision)
                JOIN prsystem.booking_payout_attempt a ON(a.tenant_id,a.batch_id)=(b.tenant_id,b.id) WHERE b.tenant_id=%s AND b.id=%s AND a.id=%s''',(tenant,batch,attempt)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            existing=conn.execute('SELECT state,reference FROM prsystem.booking_payout_result WHERE tenant_id=%s AND attempt_id=%s',(tenant,attempt)).fetchone()
            if existing:return dict(attempt_id=attempt,batch_id=batch,state=existing[0],bank_reference=existing[1],mode='MOCK_ONLY')
            if conn.execute('SELECT 1 FROM prsystem.booking_payout_void WHERE tenant_id=%s AND batch_id=%s',(tenant,batch)).fetchone():raise DomainError('PAYOUT_TERMINAL')
            try:e=self.bank.payout(attempt)
            except DomainError as exc:
                if str(exc)!='PROVIDER_EVIDENCE_INVALID':raise
                e=None
            if e is None:
                holds=conn.execute('SELECT DISTINCT hold_id,expected_net FROM prsystem.booking_payout_line WHERE tenant_id=%s AND batch_id=%s',(tenant,batch)).fetchall()
                for hold,expected in holds:
                    assessment=self.assessment(conn,tenant,hold)
                    if assessment['state'] not in {'ELIGIBLE','NO_PAYABLE'}:raise DomainError('SETTLEMENT_HELD')
                    if assessment['net_mnt']!=expected:raise DomainError('SETTLEMENT_REFRESH_REQUIRED')
                self.bank.create_payout(attempt,tenant,row[1],row[0]);e=self.bank.payout(attempt)
            if type(e.get('amount')) is not int or (e.get('tenant'),e.get('beneficiary'),e.get('amount'),e.get('currency'))!=(tenant,row[1],row[0],'MNT'):raise DomainError('PROVIDER_EVIDENCE_INVALID')
            state=e.get('state')
            if state not in {'PENDING','UNKNOWN','FAILED','SUCCEEDED'}:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            if state in {'FAILED','SUCCEEDED'}:
                now=conn.execute('SELECT clock_timestamp()').fetchone()[0];confirmed=e.get('confirmed_at')
                if not isinstance(e.get('reference'),str) or not 1<=len(e['reference'])<=256 or not isinstance(confirmed,datetime) or confirmed.tzinfo is None or not row[2]<=confirmed<=now:raise DomainError('PROVIDER_EVIDENCE_INVALID')
                conn.execute('INSERT INTO prsystem.booking_payout_result(tenant_id,attempt_id,batch_id,state,reference,amount_mnt,confirmed_at) VALUES(%s,%s,%s,%s,%s,%s,%s)',(tenant,attempt,batch,state,e['reference'],row[0],confirmed))
                self.platform._event(conn,actor,'BOOKING_PAYOUT_'+state,tenant,dict(batch_id=batch,attempt_id=attempt,amount_mnt=row[0],reference=e['reference']))
            return dict(attempt_id=attempt,batch_id=batch,state=state,bank_reference=e.get('reference'),mode='MOCK_ONLY')

    def void_batch(self,token,tenant,batch,reason,key):
        reason=self._text(reason,1000)
        with transaction(self.auth.dsn) as conn:
            actor=self.finance_actor(conn,token,tenant,'PAYOUT_EXECUTE')
            command=dict(action='VOID_BOOKING_BATCH',tenant=tenant,batch=batch,reason=reason)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            if not conn.execute('SELECT 1 FROM prsystem.booking_payout_batch WHERE tenant_id=%s AND id=%s',(tenant,batch)).fetchone():raise DomainError('WORK_SOURCE_NOT_FOUND')
            if conn.execute('SELECT 1 FROM prsystem.booking_payout_void WHERE tenant_id=%s AND batch_id=%s',(tenant,batch)).fetchone():raise DomainError('PAYOUT_TERMINAL')
            attempts=conn.execute('SELECT id FROM prsystem.booking_payout_attempt WHERE tenant_id=%s AND batch_id=%s',(tenant,batch)).fetchall()
            for (attempt,) in attempts:self.bank.cancel_payout(attempt)
            if conn.execute("SELECT 1 FROM prsystem.booking_payout_result WHERE tenant_id=%s AND batch_id=%s AND state='SUCCEEDED'",(tenant,batch)).fetchone():raise DomainError('PAYOUT_TERMINAL')
            conn.execute('INSERT INTO prsystem.booking_payout_void(tenant_id,batch_id,actor_id,reason) VALUES(%s,%s,%s,%s)',(tenant,batch,actor,reason))
            result=dict(batch_id=batch,state='VOIDED')
            self.platform._event(conn,actor,'BOOKING_PAYOUT_VOIDED',tenant,result);self.platform.save(conn,key,actor,command,result)
            return result

    def finance_inbox(self,token,tenant,booking_after='',batch_after=''):
        with transaction(self.auth.dsn) as conn:
            self.finance_actor(conn,token,tenant)
            bookings=conn.execute('SELECT id FROM prsystem.booking_hold WHERE tenant_id=%s AND id>%s ORDER BY id LIMIT 100',(tenant,booking_after)).fetchall()
            items=[self.assessment(conn,tenant,h[0]) for h in bookings]
            for item in items:
                dates=conn.execute('SELECT eligible_at,batch_after FROM prsystem.booking_settlement WHERE tenant_id=%s AND hold_id=%s',(tenant,item['booking_id'])).fetchone()
                if dates:item.update(eligible_at=dates[0],batch_after=dates[1])
            batches=conn.execute("""SELECT b.id,b.amount_mnt,b.created_at,v.batch_id,
                (SELECT a.id FROM prsystem.booking_payout_attempt a WHERE a.tenant_id=b.tenant_id AND a.batch_id=b.id ORDER BY a.sequence DESC LIMIT 1),
                (SELECT r.state FROM prsystem.booking_payout_result r RIGHT JOIN prsystem.booking_payout_attempt a ON(a.tenant_id,a.id)=(r.tenant_id,r.attempt_id) WHERE a.tenant_id=b.tenant_id AND a.batch_id=b.id ORDER BY a.sequence DESC LIMIT 1),d.reference
                FROM prsystem.booking_payout_batch b JOIN prsystem.booking_beneficiary d ON(d.tenant_id,d.revision)=(b.tenant_id,b.beneficiary_revision) LEFT JOIN prsystem.booking_payout_void v ON(v.tenant_id,v.batch_id)=(b.tenant_id,b.id)
                WHERE b.tenant_id=%s AND b.id>%s ORDER BY b.id LIMIT 100""",(tenant,batch_after)).fetchall()
            return dict(next_booking_after=bookings[-1][0] if len(bookings)==100 else None,next_batch_after=batches[-1][0] if len(batches)==100 else None,bookings=items,batches=[dict(batch_id=r[0],amount_mnt=r[1],created_at=r[2],state='VOIDED' if r[3] else r[5] or ('PENDING' if r[4] else 'BATCHED'),attempt_id=r[4],beneficiary=r[6]) for r in batches])
