"""Manual POS proof and isolated, durable QPay/Khaan payment simulations.

An intent is committed before contacting the mock. Unknown/failed/expired
results keep charge capacity and the original shift obligation reserved.
"""
import secrets
from datetime import datetime
from prsystem.common import DomainError, money, timestamp
from prsystem.guest_finance import GuestFinance
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.postgres.connection import transaction


class GuestPayments(GuestFinance):
    def __init__(self, auth, vault=None, runtime_mode='production', gateways=None):
        super().__init__(auth,vault,runtime_mode)
        self.runtime_mode = runtime_mode
        self.gateways = gateways or {}

    def gateway(self, provider):
        gateway = self.gateways.get(provider)
        # No unimplemented live port can accidentally turn a simulation into a
        # real provider payment. The production adapter is a separate release.
        from prsystem.mock_providers import MockPaymentGateway
        if self.runtime_mode == 'production' or not isinstance(gateway,MockPaymentGateway) or gateway.provider != provider:
            raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
        return gateway

    @staticmethod
    def claim(conn, provider, merchant, reference, tenant, receipt):
        claimed = conn.execute("""INSERT INTO prsystem.billing_capture VALUES (%s,%s,%s,'GUEST',%s)
            ON CONFLICT DO NOTHING RETURNING reference_id""", (provider,merchant,reference,tenant+':'+receipt)).fetchone()
        if not claimed:
            raise DomainError('PAYMENT_REFERENCE_USED')

    def apply(self, conn, tenant, stay, actor, shift, amount, charge, provider, merchant, reference, transacted, terminal, intent, before, now):
        self.charge(conn,tenant,stay,charge,amount,excluding_intent=intent)
        receipt = self.record_receipt(conn,tenant,stay,actor,shift,amount,'PAYMENT',now,post_cash=False,channel=provider)
        self.claim(conn,provider,merchant,reference,tenant,receipt)
        conn.execute('INSERT INTO prsystem.guest_payment_evidence VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                     (tenant,stay,receipt,provider,merchant,reference,amount,transacted,terminal,intent))
        conn.execute('UPDATE prsystem.guest_receipt SET allocated=%s WHERE tenant_id=%s AND id=%s', (amount,tenant,receipt))
        conn.execute('INSERT INTO prsystem.guest_allocation VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                     (tenant,stay,secrets.token_hex(16),receipt,charge,amount,actor,now))
        balance = self.save(conn,tenant,stay,before,before,actor,'GUEST_NON_CASH_PAYMENT',receipt,
                            dict(channel=provider,charge_id=charge,amount_mnt=amount,intent_id=intent,shift_id=shift[0]),now)
        return dict(receipt_id=receipt,balance=balance)

    def pos(self, bearer, tenant, stay, charge, amount, reference, terminal, transacted, revision, key):
        money(amount,positive=True)
        reference = self._text(reference,200).upper()
        terminal = self._text(terminal,100).upper()
        try:
            transacted = datetime.fromisoformat(transacted)
            timestamp(transacted)
        except (TypeError,ValueError):
            raise DomainError('INVALID_TRANSACTION_TIME') from None
        command = dict(action='MANUAL_POS_PAYMENT',stay_id=stay,charge_id=charge,amount_mnt=amount,reference=reference,
                       terminal_id=terminal,transacted_at=transacted.isoformat(),revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor = self.actor(conn,bearer,tenant,stay)
            replay = self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before = self.lock(conn,tenant,stay,revision,active=True)
            shift = StayService._shift(conn,tenant,actor)
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            source = conn.execute('SELECT recorded_at FROM prsystem.guest_charge WHERE tenant_id=%s AND stay_id=%s AND id=%s',(tenant,stay,charge)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if not source[0] <= transacted <= now:raise DomainError('INVALID_TRANSACTION_TIME')
            # The merchant namespace is server-owned; choosing another terminal
            # or stay cannot reuse a receipt reference within this hotel.
            result = self.apply(conn,tenant,stay,actor,shift,amount,charge,'MANUAL_POS','POS:'+tenant,reference,transacted,terminal,None,before,now)
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def intent(self, bearer, tenant, stay, charge, amount, provider, revision, key):
        money(amount,positive=True)
        command = dict(action='GUEST_PAYMENT_INTENT',stay_id=stay,charge_id=charge,amount_mnt=amount,provider=provider,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor = self.actor(conn,bearer,tenant,stay)
            gateway = self.gateway(provider)
            replay = self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before = self.lock(conn,tenant,stay,revision,active=True)
            shift = StayService._shift(conn,tenant,actor)
            charge_row = conn.execute('SELECT amount_mnt,paid_mnt FROM prsystem.guest_charge WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE',(tenant,stay,charge)).fetchone()
            if not charge_row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if conn.execute("SELECT 1 FROM prsystem.guest_payment_intent WHERE tenant_id=%s AND charge_id=%s AND state='PENDING'",(tenant,charge)).fetchone():
                raise DomainError('PAYMENT_ALREADY_PENDING')
            if amount>charge_row[0]-charge_row[1]:raise DomainError('CHARGE_OVERPAYMENT')
            intent = secrets.token_hex(16)
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute('''INSERT INTO prsystem.guest_payment_intent
                (tenant_id,stay_id,id,charge_id,provider,merchant_id,amount_mnt,actor_id,shift_id,drawer_id,recorded_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,stay,intent,charge,provider,gateway.merchant_id,amount,actor,shift[0],shift[2],now))
            conn.execute("INSERT INTO prsystem.shift_obligation (tenant_id,id,shift_id,provider_reference,state) VALUES (%s,%s,%s,%s,'PENDING')",
                         (tenant,intent,shift[0],'guest-provider-payment:'+intent))
            balance = self.save(conn,tenant,stay,before,before,actor,'GUEST_PAYMENT_INTENT',intent,dict(charge_id=charge,amount_mnt=amount,provider=provider),now)
            result = dict(intent_id=intent,state='PENDING',invoice_id=None,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def reconcile(self, bearer, tenant, stay, intent):
        # This endpoint accepts no status/evidence payload. Repeating it queries
        # the same provider intent, including after a lost response or restart.
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant,stay)
            ShiftService._book(conn,tenant)
            self.lock(conn,tenant,stay)
            row = conn.execute('''SELECT provider,merchant_id,amount_mnt,invoice_id,state,receipt_id
                FROM prsystem.guest_payment_intent WHERE tenant_id=%s AND stay_id=%s AND id=%s''',(tenant,stay,intent)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            gateway = self.gateway(row[0])
            if row[4]=='APPLIED':return dict(intent_id=intent,state='APPLIED',receipt_id=row[5],invoice_id=row[3])
        try:
            invoice = row[3] or gateway.create_invoice(intent,row[2],'MNT')
            if not isinstance(invoice,str) or not 1<=len(invoice)<=200:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            evidence = gateway.payment(intent,invoice)
        except (OSError,TimeoutError):
            return dict(intent_id=intent,state='PENDING',provider_state='UNKNOWN',invoice_id=row[3])
        if not isinstance(evidence,dict) or evidence.get('status') not in {'PENDING','FAILED','EXPIRED','SUCCEEDED'}:
            raise DomainError('PROVIDER_EVIDENCE_INVALID')
        with transaction(self.auth.dsn) as conn:
            actor = self.actor(conn,bearer,tenant,stay)
            ShiftService._book(conn,tenant)
            before = self.lock(conn,tenant,stay)
            current = conn.execute('''SELECT charge_id,actor_id,shift_id,drawer_id,recorded_at,state,receipt_id,invoice_id
                FROM prsystem.guest_payment_intent WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE''',(tenant,stay,intent)).fetchone()
            if current[5]=='APPLIED':return dict(intent_id=intent,state='APPLIED',receipt_id=current[6],invoice_id=current[7])
            if current[7] is not None and current[7]!=invoice:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            if evidence.get('merchant_id')!=row[1] or gateway.merchant_id!=row[1] or evidence.get('invoice_id')!=invoice or type(evidence.get('amount')) is not int or evidence['amount']!=row[2] or evidence.get('currency')!='MNT':
                raise DomainError('PROVIDER_EVIDENCE_INVALID')
            state = evidence['status']
            if state!='SUCCEEDED':
                conn.execute('UPDATE prsystem.guest_payment_intent SET invoice_id=%s,last_provider_state=%s WHERE tenant_id=%s AND id=%s',(invoice,state,tenant,intent))
                return dict(intent_id=intent,state='PENDING',provider_state=state,invoice_id=invoice)
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            confirmed = evidence.get('confirmed_at')
            try:timestamp(confirmed)
            except DomainError:raise DomainError('PROVIDER_EVIDENCE_INVALID') from None
            reference = evidence.get('payment_id')
            if not isinstance(reference,str) or not 1<=len(reference)<=200 or not current[4]<=confirmed<=now:
                raise DomainError('PROVIDER_EVIDENCE_INVALID')
            shift = conn.execute('''SELECT s.id,s.opened_at,s.drawer_id FROM prsystem.reception_shift s
                JOIN prsystem.cash_drawer d ON (d.tenant_id,d.id,d.shift_id)=(s.tenant_id,s.drawer_id,s.id)
                WHERE s.tenant_id=%s AND s.id=%s AND s.state='OPEN' FOR UPDATE OF s''',(tenant,current[2])).fetchone()
            if not shift or shift[2]!=current[3]:raise DomainError('CASH_SOURCE_CONFLICT')
            result = self.apply(conn,tenant,stay,actor,shift,row[2],current[0],row[0],row[1],reference,confirmed,None,intent,before,now)
            conn.execute("UPDATE prsystem.guest_payment_intent SET invoice_id=%s,last_provider_state='SUCCEEDED',state='APPLIED',receipt_id=%s WHERE tenant_id=%s AND id=%s",(invoice,result['receipt_id'],tenant,intent))
            conn.execute("UPDATE prsystem.shift_obligation SET state='SUCCEEDED' WHERE tenant_id=%s AND id=%s",(tenant,intent))
            return dict(intent_id=intent,state='APPLIED',receipt_id=result['receipt_id'],invoice_id=invoice)
