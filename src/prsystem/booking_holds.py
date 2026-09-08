"""Durable, tenant-scoped mock booking holds and provider evidence.

Production remains closed until the verified booker/public-listing adapters
exist. Manager creates a test booking; its opaque guest token controls only
that booking. No staff permission is inferred from that token.
"""
import json
import secrets
from dataclasses import asdict
from datetime import datetime, timedelta

from psycopg.types.json import Jsonb

from prsystem.auth import digest
from prsystem.booking_policy import Contract, PaymentWindow, quote_nights, InventoryInterval
from prsystem.booking_inventory import scope, require_capacity
from prsystem.common import DomainError, timestamp
from prsystem.guest_payments import GuestPayments
from prsystem.mock_providers import require_development_database
from prsystem.postgres.connection import transaction


def snapshot(value):
    return json.loads(json.dumps(asdict(value), default=lambda obj: obj.isoformat()))


class BookingHolds(GuestPayments):
    def mock(self):
        if self.runtime_mode == 'production':
            raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
        require_development_database(self.auth.dsn, self.runtime_mode)
        if self.vault is None:
            raise DomainError('IDENTITY_VAULT_UNAVAILABLE')

    def contract(self, bearer, tenant, data, key):
        self.mock()
        start, end = self.instant(data['valid_from']), self.instant(data['valid_until'])
        contract = Contract(tenant, self._text(data['contract_id'],128), data['expected_revision']+1,
                            data['rate_bps'], start, end)
        command = dict(action='MOCK_BOOKING_CONTRACT', data=snapshot(contract))
        with transaction(self.auth.dsn) as conn:
            actor = self._queue_actor(conn,bearer,tenant)
            scope(conn,tenant)
            replay = self._receipt(conn,tenant,key,actor,command)
            if replay is not None:
                return replay
            self._catalog_lock(conn,tenant)
            version = conn.execute('SELECT coalesce(max(version),0) FROM prsystem.booking_contract WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            if version != data['expected_revision']:
                raise DomainError('REVISION_CONFLICT')
            conn.execute("INSERT INTO prsystem.booking_contract VALUES(%s,%s,%s,%s,%s,%s,%s,'MOCK_ONLY')",
                         (tenant,contract.version,contract.contract_id,contract.rate_bps,start,end,actor))
            result = dict(version=contract.version,mode='MOCK_ONLY')
            self.event(conn,tenant,actor,'MOCK_BOOKING_CONTRACT',tenant,snapshot(contract))
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    @staticmethod
    def instant(value):
        try:
            result = datetime.fromisoformat(value)
            timestamp(result)
            return result
        except (TypeError,ValueError) as exc:
            raise DomainError('INVALID_BOOKING_TIME') from exc

    @staticmethod
    def current_contract(conn,tenant,now):
        row = conn.execute('''SELECT contract_id,version,rate_bps,valid_from,valid_until
            FROM prsystem.booking_contract WHERE tenant_id=%s ORDER BY version DESC LIMIT 1''',(tenant,)).fetchone()
        if not row:
            raise DomainError('BOOKING_CONTRACT_REQUIRED')
        contract = Contract(tenant,*row)
        contract.require_current(now)
        return contract

    @staticmethod
    def event_row(conn,tenant,hold,kind,details):
        conn.execute('INSERT INTO prsystem.booking_hold_event(tenant_id,id,hold_id,kind,details) VALUES(%s,%s,%s,%s,%s)',
                     (tenant,secrets.token_hex(16),hold,kind,Jsonb(details)))

    @staticmethod
    def statement(conn,tenant,hold):
        row = conn.execute('''SELECT category_id,booking_state,hold_state,created_at,expires_at,snapshot,
            applied_attempt_id,confirmation_snapshot FROM prsystem.booking_hold WHERE tenant_id=%s AND id=%s''',(tenant,hold)).fetchone()
        attempts = conn.execute('''SELECT id,provider,state,invoice_id,invoice_expires_at FROM prsystem.booking_hold_attempt
            WHERE tenant_id=%s AND hold_id=%s ORDER BY created_at,id''',(tenant,hold)).fetchall()
        refund = conn.execute('SELECT coalesce(sum(refund_due),0) FROM prsystem.booking_hold_capture WHERE tenant_id=%s AND hold_id=%s',(tenant,hold)).fetchone()[0]
        return dict(booking_id=hold,category_id=row[0],booking_state=row[1],hold_state=row[2],
                    created_at=row[3],expires_at=row[4],quote=row[5],applied_attempt_id=row[6],confirmation=row[7],
                    refund_required_mnt=int(refund),mode='MOCK_ONLY',
                    attempts=[dict(zip(('attempt_id','provider','state','invoice_id','expires_at'),a)) for a in attempts])

    def create(self,bearer,tenant,category,arrival,nights,provider,key):
        self.mock()
        arrival=self.instant(arrival)
        command=dict(action='MOCK_BOOKING_HOLD',category=category,arrival=arrival.isoformat(),nights=nights,provider=provider)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            scope(conn,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:
                row=conn.execute('SELECT token_envelope FROM prsystem.booking_hold WHERE tenant_id=%s AND id=%s',(tenant,replay['booking_id'])).fetchone()
                return dict(self.statement(conn,tenant,replay['booking_id']),access_token=self.vault.open(row[0],tenant,replay['booking_id'],'mock-booker'))
            self._catalog_lock(conn,tenant)
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            hotel_expiry=conn.execute('SELECT expires_at FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            if now>=hotel_expiry+timedelta(hours=48):
                raise DomainError('SUBSCRIPTION_EXPIRED')
            contract=self.current_contract(conn,tenant,now)
            setting=conn.execute('''SELECT c.nightly_price,c.revision,h.nightly_price,h.revision,h.checkout_time,c.cleaning_buffer_minutes
                FROM prsystem.room_category c JOIN prsystem.room_hotel_settings h ON h.tenant_id=c.tenant_id
                WHERE c.tenant_id=%s AND c.id=%s AND c.status='ACTIVE' ''',(tenant,category)).fetchone()
            if not setting:
                raise DomainError('STAY_SETTINGS_REQUIRED')
            quote=quote_nights(tenant_id=tenant,category_id=category,now=now,arrival=arrival,nights=nights,
                category_price=setting[0],category_version=setting[1],hotel_price=setting[2],hotel_version=setting[3],
                checkout_time=setting[4],cleaning_buffer_minutes=setting[5],contract=contract)
            require_capacity(conn,tenant,category,InventoryInterval(arrival,quote.planned_checkout_at,setting[5]))
            gateway=self.gateway(provider)
            hold,attempt,secret=secrets.token_hex(16),secrets.token_hex(16),secrets.token_urlsafe(32)
            window=PaymentWindow.open(now)
            conn.execute('''INSERT INTO prsystem.booking_hold(tenant_id,id,category_id,actor_id,token_hash,token_envelope,
                created_at,expires_at,planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes,amount_mnt,snapshot)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,hold,category,actor,digest(secret),Jsonb(self.vault.seal(secret,tenant,hold,'mock-booker')),now,
                 window.expires_at,arrival,quote.planned_checkout_at,setting[5],quote.amount_mnt,Jsonb(snapshot(quote))))
            conn.execute('''INSERT INTO prsystem.booking_hold_attempt(tenant_id,id,hold_id,provider,merchant_id,created_at,invoice_expires_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s)''',(tenant,attempt,hold,provider,gateway.merchant_id,now,window.expires_at))
            self.event_row(conn,tenant,hold,'HOLD_CREATED',dict(attempt_id=attempt,provider=provider,amount_mnt=quote.amount_mnt))
            self._save_receipt(conn,tenant,key,actor,command,dict(booking_id=hold))
            return dict(self.statement(conn,tenant,hold),access_token=secret)

    def guest(self,conn,tenant,hold,secret):
        self.mock()
        scope(conn,tenant)
        hotel=conn.execute('SELECT expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        if not hotel or hotel[1]:
            raise DomainError('FORBIDDEN')
        self._catalog_lock(conn,tenant)
        row=conn.execute('''SELECT category_id,created_at,expires_at,booking_state,applied_attempt_id,amount_mnt,
            planned_checkin_at,planned_checkout_at,cleaning_buffer_minutes FROM prsystem.booking_hold
            WHERE tenant_id=%s AND id=%s AND token_hash=%s FOR UPDATE''',(tenant,hold,digest(secret))).fetchone()
        if not row:
            raise DomainError('FORBIDDEN')
        # A mock token may complete only its own previously started payment;
        # it cannot create bookings, enroll a booker, or grant staff authority.
        if row[1] >= hotel[0]+timedelta(hours=48):
            raise DomainError('FORBIDDEN')
        return row

    def read(self,tenant,hold,secret):
        with transaction(self.auth.dsn) as conn:
            self.guest(conn,tenant,hold,secret)
            return self.statement(conn,tenant,hold)

    @staticmethod
    def replay(conn,tenant,hold,key,command):
        row=conn.execute('SELECT command,result FROM prsystem.booking_hold_command WHERE tenant_id=%s AND hold_id=%s AND key=%s',
                         (tenant,hold,key)).fetchone()
        if row and row[0]!=command:
            raise DomainError('IDEMPOTENCY_CONFLICT')
        return row[1] if row else None

    def switch(self,tenant,hold,secret,provider,key):
        with transaction(self.auth.dsn) as conn:
            row=self.guest(conn,tenant,hold,secret)
            command=dict(action='SWITCH_PROVIDER',provider=provider)
            replay=self.replay(conn,tenant,hold,key,command)
            if replay is not None:
                return replay
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if row[3]!='HOLDING':
                raise DomainError('HOLD_EXPIRED')
            PaymentWindow(row[1],row[2]).invoice_deadline(now)
            # Resource cap, not an invented OTP/financial business limit.
            if conn.execute('SELECT count(*) FROM prsystem.booking_hold_attempt WHERE tenant_id=%s AND hold_id=%s',(tenant,hold)).fetchone()[0]>=20:
                raise DomainError('BOOKING_ATTEMPT_LIMIT')
            gateway=self.gateway(provider)
            conn.execute("UPDATE prsystem.booking_hold_attempt SET state='SUPERSEDED' WHERE tenant_id=%s AND hold_id=%s AND state='ACTIVE'",(tenant,hold))
            attempt=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.booking_hold_attempt(tenant_id,id,hold_id,provider,merchant_id,created_at,invoice_expires_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s)''',(tenant,attempt,hold,provider,gateway.merchant_id,now,row[2]))
            result=dict(attempt_id=attempt,expires_at=row[2].isoformat(),mode='MOCK_ONLY')
            conn.execute('INSERT INTO prsystem.booking_hold_command VALUES(%s,%s,%s,%s,%s)',(tenant,hold,key,Jsonb(command),Jsonb(result)))
            self.event_row(conn,tenant,hold,'PROVIDER_SWITCHED',dict(attempt_id=attempt,provider=provider))
            return result

    def reconcile(self,tenant,hold,secret):
        # Only bounded, isolated SQLite mocks are called under the catalog lock.
        # A network provider must use the outbox/worker adapter, not this method.
        with transaction(self.auth.dsn) as conn:
            row=self.guest(conn,tenant,hold,secret)
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            due=now>=row[2]
            attempts=conn.execute('''SELECT id,provider,merchant_id,invoice_id,state,created_at
                FROM prsystem.booking_hold_attempt WHERE tenant_id=%s AND hold_id=%s
                ORDER BY created_at,id FOR UPDATE''',(tenant,hold)).fetchall()
            for attempt,provider,merchant,invoice,state,started in attempts:
                if state=='PAID':
                    continue
                gateway=self.gateway(provider)
                if gateway.merchant_id!=merchant:
                    raise DomainError('PROVIDER_EVIDENCE_INVALID')
                if invoice is None:
                    if due or row[3]!='HOLDING' or state!='ACTIVE':
                        continue
                    invoice=gateway.create_invoice('booking:'+attempt,row[5],'MNT')
                    conn.execute('UPDATE prsystem.booking_hold_attempt SET invoice_id=%s WHERE tenant_id=%s AND id=%s',(invoice,tenant,attempt))
                evidence=gateway.payment('booking:'+attempt,invoice)
                if evidence.get('merchant_id')!=merchant or evidence.get('invoice_id')!=invoice or type(evidence.get('amount')) is not int or evidence['amount']!=row[5] or evidence.get('currency')!='MNT':
                    raise DomainError('PROVIDER_EVIDENCE_INVALID')
                if evidence.get('status')!='SUCCEEDED':
                    continue
                confirmed=evidence.get('confirmed_at')
                payment=evidence.get('payment_id')
                if not isinstance(confirmed,datetime) or confirmed.tzinfo is None or not started<=confirmed<=conn.execute('SELECT clock_timestamp()').fetchone()[0] or not isinstance(payment,str) or not payment:
                    raise DomainError('PROVIDER_EVIDENCE_INVALID')
                claim=conn.execute("INSERT INTO prsystem.billing_capture VALUES(%s,%s,%s,'BOOKING',%s) ON CONFLICT DO NOTHING RETURNING reference_id",
                                   (provider,merchant,payment,tenant+':'+attempt)).fetchone()
                if not claim:
                    raise DomainError('PAYMENT_REFERENCE_USED')
                current=conn.execute('SELECT booking_state,applied_attempt_id FROM prsystem.booking_hold WHERE tenant_id=%s AND id=%s',(tenant,hold)).fetchone()
                disposition='DUPLICATE_CAPTURE' if current[1] else 'LATE_PAYMENT_AFTER_HOLD' if current[0]=='EXPIRED' else 'APPLIED'
                confirmation=None
                if disposition=='APPLIED':
                    try:
                        contract=self.current_contract(conn,tenant,now)
                        expires=conn.execute('SELECT expires_at FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]
                        if now>=expires+timedelta(hours=48) or now>=row[7]:
                            raise DomainError('SUBSCRIPTION_EXPIRED')
                        require_capacity(conn,tenant,row[0],InventoryInterval(row[6],row[7],row[8]),excluding=hold)
                        confirmation=snapshot(contract)
                    except DomainError as exc:
                        if str(exc) not in {'BOOKING_CONTRACT_REQUIRED','BOOKING_CAPACITY_UNAVAILABLE','SUBSCRIPTION_EXPIRED'}:
                            raise
                        disposition='FULFILLMENT_UNAVAILABLE'
                refund=0 if disposition=='APPLIED' else row[5]
                conn.execute('INSERT INTO prsystem.booking_hold_capture VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                             (tenant,attempt,hold,provider,merchant,payment,row[5],confirmed,disposition,refund))
                conn.execute("UPDATE prsystem.booking_hold_attempt SET state='PAID' WHERE tenant_id=%s AND id=%s",(tenant,attempt))
                if disposition=='APPLIED':
                    conn.execute("UPDATE prsystem.booking_hold SET booking_state='CONFIRMED',hold_state='CONSUMED',applied_attempt_id=%s,confirmation_snapshot=%s WHERE tenant_id=%s AND id=%s",(attempt,Jsonb(confirmation),tenant,hold))
                elif disposition=='FULFILLMENT_UNAVAILABLE':
                    conn.execute("UPDATE prsystem.booking_hold SET booking_state='EXPIRED',hold_state='EXPIRED' WHERE tenant_id=%s AND id=%s",(tenant,hold))
                self.event_row(conn,tenant,hold,'CAPTURE_RECORDED',dict(attempt_id=attempt,disposition=disposition,amount_mnt=row[5],refund_due=refund))
            current=conn.execute('SELECT booking_state FROM prsystem.booking_hold WHERE tenant_id=%s AND id=%s',(tenant,hold)).fetchone()[0]
            if current=='HOLDING' and due:
                conn.execute("UPDATE prsystem.booking_hold SET booking_state='EXPIRED',hold_state='EXPIRED' WHERE tenant_id=%s AND id=%s",(tenant,hold))
                conn.execute("UPDATE prsystem.booking_hold_attempt SET state='EXPIRED' WHERE tenant_id=%s AND hold_id=%s AND state='ACTIVE'",(tenant,hold))
                self.event_row(conn,tenant,hold,'HOLD_EXPIRED',{})
            return self.statement(conn,tenant,hold)

    def expire_due(self,bearer,tenant,limit=25):
        self.mock()
        if type(limit) is not int or not 1<=limit<=50:
            raise DomainError('INVALID_REQUEST')
        with transaction(self.auth.dsn) as conn:
            self._queue_actor(conn,bearer,tenant)
            scope(conn,tenant)
            rows=conn.execute('''SELECT id,token_envelope FROM prsystem.booking_hold
                WHERE tenant_id=%s AND hold_state='ACTIVE' AND expires_at<=clock_timestamp()
                ORDER BY expires_at,id LIMIT %s''',(tenant,limit)).fetchall()
        results=[]
        for hold,envelope in rows:
            secret=self.vault.open(envelope,tenant,hold,'mock-booker')
            result=self.reconcile(tenant,hold,secret)
            results.append(dict(booking_id=hold,booking_state=result['booking_state']))
        return dict(results=results,limit=limit,mode='MOCK_ONLY')
