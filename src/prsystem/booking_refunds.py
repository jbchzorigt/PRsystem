"""Persist first, then dispatch/query isolated mock original-payment refunds."""
import secrets
from datetime import datetime
from prsystem.booking_holds import BookingHolds
from prsystem.common import DomainError
from prsystem.postgres.connection import transaction


class BookingRefunds(BookingHolds):
    def reconcile_refunds(self,tenant,hold,secret):
        with transaction(self.auth.dsn) as conn:
            self.guest(conn,tenant,hold,secret)
            sources=conn.execute('''SELECT c.attempt_id,c.refund_due+coalesce(x.refund_due,0)
                FROM prsystem.booking_hold_capture c LEFT JOIN prsystem.booking_hold_cancellation x
                ON(x.tenant_id,x.hold_id,x.attempt_id)=(c.tenant_id,c.hold_id,c.attempt_id)
                WHERE c.tenant_id=%s AND c.hold_id=%s ORDER BY c.attempt_id''',(tenant,hold)).fetchall()
            for attempt,due in sources:
                if due<=0:continue
                conn.execute('''INSERT INTO prsystem.booking_refund_request(tenant_id,attempt_id,hold_id,id,amount_mnt)
                    VALUES(%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,attempt_id) DO NOTHING''',
                    (tenant,attempt,hold,'booking-refund:'+secrets.token_hex(16),due))
            requests=conn.execute('SELECT id FROM prsystem.booking_refund_request WHERE tenant_id=%s AND hold_id=%s ORDER BY id',(tenant,hold)).fetchall()
        # No external action occurs until the command identities have committed.
        # This loop only calls bounded SQLite mocks. Live networking requires
        # the separate outbox/worker adapter, not network calls under this lock.
        for (request,) in requests:
            with transaction(self.auth.dsn) as conn:
                self.guest(conn,tenant,hold,secret)
                row=conn.execute('''SELECT r.amount_mnt,r.created_at,c.provider,c.merchant_id,c.payment_id
                    FROM prsystem.booking_refund_request r JOIN prsystem.booking_hold_capture c
                    ON(c.tenant_id,c.attempt_id)=(r.tenant_id,r.attempt_id)
                    WHERE r.tenant_id=%s AND r.hold_id=%s AND r.id=%s FOR UPDATE OF r''',(tenant,hold,request)).fetchone()
                if conn.execute('SELECT 1 FROM prsystem.booking_refund_confirmation WHERE tenant_id=%s AND request_id=%s',(tenant,request)).fetchone():continue
                amount,created,provider,merchant,payment=row
                gateway=self.gateway(provider)
                if gateway.merchant_id!=merchant:raise DomainError('PROVIDER_EVIDENCE_INVALID')
                gateway.create_refund(request,payment,amount)
                evidence=gateway.refund(request)
                status=evidence.get('status')
                if (status not in {'PENDING','UNKNOWN','FAILED','FINAL_FAILED','VOIDED','NOT_PROCESSED','SUCCEEDED','CORRECTED_NOT_SUCCESS'}
                    or evidence.get('merchant_id')!=merchant or evidence.get('original')!=payment
                    or type(evidence.get('amount')) is not int or evidence['amount']!=amount
                    or evidence.get('currency')!='MNT'):
                    raise DomainError('PROVIDER_EVIDENCE_INVALID')
                if status=='SUCCEEDED':
                    confirmed,reference=evidence.get('confirmed_at'),evidence.get('reference')
                    now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
                    if (not isinstance(confirmed,datetime) or confirmed.tzinfo is None or not created<=confirmed<=now
                        or not isinstance(reference,str) or not reference or len(reference)>256):
                        raise DomainError('PROVIDER_EVIDENCE_INVALID')
                    conn.execute('''INSERT INTO prsystem.booking_refund_confirmation(tenant_id,request_id,provider,merchant_id,provider_reference,amount_mnt,confirmed_at)
                        VALUES(%s,%s,%s,%s,%s,%s,%s)''',(tenant,request,provider,merchant,reference,amount,confirmed))
                    self.event_row(conn,tenant,hold,'BOOKING_REFUND_CONFIRMED',dict(request_id=request,amount_mnt=amount,provider=provider))
                conn.execute('UPDATE prsystem.booking_refund_request SET last_provider_state=%s WHERE tenant_id=%s AND id=%s',(status,tenant,request))
        return self.read(tenant,hold,secret)
