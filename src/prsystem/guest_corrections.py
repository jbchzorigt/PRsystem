"""Manager-approved, atomic cash receipt reversal/replacement.

The cash movement is the net correction, never a fictitious refund followed by
another collection. Original receipt/allocation amounts remain immutable.
"""
import secrets
from datetime import datetime
from psycopg.types.json import Jsonb
from prsystem.common import DomainError, money
from prsystem.guest_finance import GuestFinance
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction


class GuestCorrections(GuestFinance):
    def __init__(self,auth,vault=None,runtime_mode='production',gateways=None):
        super().__init__(auth,vault,runtime_mode)
        from prsystem.guest_payments import GuestPayments
        self.payments=GuestPayments(auth,vault,runtime_mode,gateways)

    @staticmethod
    def source(conn, tenant, stay, receipt,allow_noncash=False):
        row = conn.execute('''SELECT amount_mnt,allocated,refund_reserved,refunded,reversed,purpose,channel,drawer_id
            FROM prsystem.guest_receipt WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE''', (tenant,stay,receipt)).fetchone()
        if not row:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        if (row[6] != 'CASH' and not allow_noncash) or row[2] or row[3] or row[4]:
            raise DomainError('CORRECTION_SOURCE_IN_USE')
        allocations = conn.execute('''SELECT id,charge_id,amount_mnt FROM prsystem.guest_allocation
            WHERE tenant_id=%s AND stay_id=%s AND receipt_id=%s ORDER BY id''', (tenant,stay,receipt)).fetchall()
        if row[5] == 'DEPOSIT' and (row[1] or allocations) and not allow_noncash:
            raise DomainError('CORRECTION_SOURCE_IN_USE')
        if row[5] == 'PAYMENT' and (len(allocations) != 1 or allocations[0][2] != row[0] or row[1] != row[0]):
            raise DomainError('CORRECTION_SOURCE_IN_USE')
        return dict(amount_mnt=row[0],allocated=row[1],purpose=row[5],channel=row[6],drawer_id=row[7],
                    allocations=[dict(id=a[0],charge_id=a[1],amount_mnt=a[2]) for a in allocations])

    def request(self, bearer, tenant, stay, receipt, replacement, reason, revision, key,channel=None,proof=None):
        money(replacement)
        reason = self._text(reason,1000)
        command = dict(action='REQUEST_CASH_CORRECTION',stay_id=stay,receipt_id=receipt,replacement_amount_mnt=replacement,reason=reason,revision=revision)
        if channel is not None:
            if channel not in {'CASH','MANUAL_POS','QPAY','KHAAN'}:raise DomainError('INVALID_REQUEST')
            proof=proof or {}
            if channel=='MANUAL_POS' and replacement:
                proof=dict(reference=self._text(proof.get('reference'),200).upper(),terminal_id=self._text(proof.get('terminal_id'),100).upper(),transacted_at=proof.get('transacted_at'))
                try:
                    when=datetime.fromisoformat(proof['transacted_at'])
                    if when.tzinfo is None:raise ValueError()
                except (ValueError,TypeError) as exc:raise DomainError('INVALID_TRANSACTION_TIME') from exc
            elif proof:raise DomainError('INVALID_REQUEST')
            command.update(action='REQUEST_FINANCIAL_CORRECTION',replacement_channel=channel,proof=proof)
        with transaction(self.auth.dsn) as conn:
            actor = self.actor(conn,bearer,tenant,stay)
            if channel in {'QPAY','KHAAN'}:self.payments.gateway(channel)
            replay = self._receipt(conn,tenant,key,actor,command)
            if replay is not None:
                return replay
            ShiftService._book(conn,tenant)
            before = self.lock(conn,tenant,stay,revision)
            shift = StayService._shift(conn,tenant,actor)
            self.no_pending_correction(conn,tenant,receipt)
            source = self.source(conn,tenant,stay,receipt,allow_noncash=channel is not None)
            if shift[2] != source['drawer_id']:
                raise DomainError('ORIGINAL_CASH_DRAWER_REQUIRED')
            if source['amount_mnt'] == replacement and (channel is None or channel==source['channel']=='CASH'):
                raise DomainError('CORRECTION_HAS_NO_CHANGE')
            correction = secrets.token_hex(16)
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute('''INSERT INTO prsystem.guest_correction
                (tenant_id,stay_id,id,receipt_id,replacement_amount_mnt,requester_id,shift_id,drawer_id,reason,original_snapshot,requested_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                 (tenant,stay,correction,receipt,replacement,actor,shift[0],shift[2],reason,Jsonb(source),now))
            if channel is not None:
                if channel=='MANUAL_POS' and replacement and not shift[1]<=when<=now:raise DomainError('INVALID_TRANSACTION_TIME')
                conn.execute('INSERT INTO prsystem.guest_correction_route VALUES(%s,%s,%s,%s)',(tenant,correction,channel,Jsonb(proof)))
            conn.execute("INSERT INTO prsystem.shift_obligation (tenant_id,id,shift_id,provider_reference,state) VALUES (%s,%s,%s,%s,'PENDING')",
                         (tenant,correction,shift[0],'guest-cash-correction:'+correction))
            balance = self.save(conn,tenant,stay,before,before,actor,'CASH_CORRECTION_REQUESTED',correction,
                                dict(receipt_id=receipt,replacement_amount_mnt=replacement),now)
            result = dict(correction_id=correction,state='PENDING',balance=balance)
            if channel in {'QPAY','KHAAN'}:result['provider_attempt_id']='correction-'+correction
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def decide(self, bearer, tenant, stay, correction, approve, reason, revision, key):
        if type(approve) is not bool:
            raise DomainError('INVALID_REQUEST')
        reason = self._text(reason,1000)
        command = dict(action='DECIDE_CASH_CORRECTION',stay_id=stay,correction_id=correction,approve=approve,reason=reason,revision=revision)
        with transaction(self.auth.dsn) as conn:
            # Lock both named accounts in stable order before membership/book.
            target = conn.execute('SELECT requester_id FROM prsystem.guest_correction WHERE tenant_id=%s AND stay_id=%s AND id=%s', (tenant,stay,correction)).fetchone()
            self._actors(conn,bearer,tenant,target[0] if target else None)
            actor = self.actor(conn,bearer,tenant,stay,manager=True)
            replay = self._receipt(conn,tenant,key,actor,command)
            if replay is not None:
                return replay
            ShiftService._book(conn,tenant)
            # Rejection is permitted while frozen: it posts no monetary change.
            before = self.lock(conn,tenant,stay,revision,allow_frozen=not approve)
            row = conn.execute('''SELECT receipt_id,replacement_amount_mnt,requester_id,shift_id,drawer_id,original_snapshot,state
                FROM prsystem.guest_correction WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE''', (tenant,stay,correction)).fetchone()
            if not row:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[6] != 'PENDING':
                raise DomainError('CORRECTION_TERMINAL')
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            after = dict(before)
            route=conn.execute('SELECT replacement_channel,proof FROM prsystem.guest_correction_route WHERE tenant_id=%s AND correction_id=%s',(tenant,correction)).fetchone()
            channel=route[0] if route else 'CASH'
            evidence=None
            if route and channel in {'QPAY','KHAAN'} and row[1]:
                gateway=self.payments.gateway(channel)
                if not approve:gateway.void_invoice('correction-'+correction)
                else:
                    evidence=gateway.payment('correction-'+correction,None)
                    if evidence.get('status')!='SUCCEEDED':raise DomainError('PAYMENT_REQUIRED')
                    if evidence.get('merchant_id')!=gateway.merchant_id or evidence.get('amount')!=row[1] or type(evidence.get('amount')) is not int or evidence.get('currency')!='MNT' or not isinstance(evidence.get('confirmed_at'),datetime) or evidence['confirmed_at'].tzinfo is None or evidence['confirmed_at']>now:raise DomainError('PROVIDER_EVIDENCE_INVALID')
            replacement = reversal = None
            if approve:
                ShiftService._reception(conn,tenant,row[2],action=Action.SETTLE_STAY,obligation=self.root(conn,tenant,stay))
                shift = StayService._shift(conn,tenant,row[2])
                if (shift[0],shift[2]) != (row[3],row[4]):
                    raise DomainError('ORIGINAL_CASH_DRAWER_REQUIRED')
                source = self.source(conn,tenant,stay,row[0],allow_noncash=route is not None)
                if source != row[5]:
                    raise DomainError('CORRECTION_SOURCE_CHANGED')
                old_amount, new_amount = source['amount_mnt'], row[1]
                # Reverse payment allocation through an additional immutable
                # record. The original allocation is never updated or deleted.
                for allocation in source['allocations']:
                    charge = conn.execute('SELECT paid_mnt FROM prsystem.guest_charge WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE',
                                          (tenant,stay,allocation['charge_id'])).fetchone()
                    if not charge or charge[0] < allocation['amount_mnt']:
                        raise DomainError('DEPOSIT_BALANCE_CONFLICT')
                    conn.execute('UPDATE prsystem.guest_charge SET paid_mnt=paid_mnt-%s WHERE tenant_id=%s AND id=%s',
                                 (allocation['amount_mnt'],tenant,allocation['charge_id']))
                    conn.execute('INSERT INTO prsystem.guest_allocation_reversal VALUES (%s,%s,%s,%s,%s,%s)',
                                 (tenant,stay,allocation['id'],correction,allocation['amount_mnt'],now))
                conn.execute('UPDATE prsystem.guest_receipt SET allocated=0,reversed=amount_mnt WHERE tenant_id=%s AND id=%s', (tenant,row[0]))
                if new_amount:
                    replacement = self.record_receipt(conn,tenant,stay,row[2],shift,new_amount,source['purpose'],now,post_cash=False,channel=channel)
                    if route and channel!='CASH':
                        proof=route[1]
                        merchant='POS:'+tenant if channel=='MANUAL_POS' else evidence['merchant_id']
                        reference=proof['reference'] if channel=='MANUAL_POS' else evidence['payment_id']
                        transacted=datetime.fromisoformat(proof['transacted_at']) if channel=='MANUAL_POS' else evidence['confirmed_at']
                        terminal=proof['terminal_id'] if channel=='MANUAL_POS' else None
                        self.payments.claim(conn,channel,merchant,reference,tenant,replacement)
                        conn.execute('''INSERT INTO prsystem.guest_payment_evidence(tenant_id,stay_id,receipt_id,provider,merchant_id,payment_id,amount_mnt,transacted_at,terminal_id,correction_id)
                            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,stay,replacement,channel,merchant,reference,new_amount,transacted,terminal,correction))
                    if source['purpose'] == 'PAYMENT':
                        charge_id = source['allocations'][0]['charge_id']
                        self.charge(conn,tenant,stay,charge_id,new_amount)
                        conn.execute('UPDATE prsystem.guest_receipt SET allocated=%s WHERE tenant_id=%s AND id=%s', (new_amount,tenant,replacement))
                        conn.execute('INSERT INTO prsystem.guest_allocation VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                                     (tenant,stay,secrets.token_hex(16),replacement,charge_id,new_amount,actor,now))
                    elif source['allocations']:
                        remaining=new_amount;allocated=0
                        for allocation in source['allocations']:
                            take=min(remaining,allocation['amount_mnt'])
                            if take:
                                self.charge(conn,tenant,stay,allocation['charge_id'],take)
                                conn.execute('INSERT INTO prsystem.guest_allocation VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,secrets.token_hex(16),replacement,allocation['charge_id'],take,actor,now))
                                allocated+=take;remaining-=take
                        conn.execute('UPDATE prsystem.guest_receipt SET allocated=%s WHERE tenant_id=%s AND id=%s',(allocated,tenant,replacement))
                        after['allocated']+=allocated
                if source['purpose'] == 'DEPOSIT':
                    after['received'] += new_amount
                    after['reversed'] += old_amount
                    after['allocated']-=source['allocated']
                reversal = secrets.token_hex(16)
                conn.execute('INSERT INTO prsystem.guest_receipt_reversal VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                             (tenant,stay,reversal,correction,row[0],replacement,old_amount,now))
                cash_delta=(new_amount if channel=='CASH' else 0)-(old_amount if source['channel']=='CASH' else 0)
                if cash_delta or not route:self.cash(conn,tenant,actor,shift[0],shift[2],'GUEST_CASH_CORRECTED',correction,cash_delta,0,now)
            state = 'EXECUTED' if approve else 'REJECTED'
            conn.execute('''UPDATE prsystem.guest_correction SET state=%s,decider_id=%s,decision_reason=%s,decided_at=%s
                WHERE tenant_id=%s AND id=%s''', (state,actor,reason,now,tenant,correction))
            conn.execute('UPDATE prsystem.shift_obligation SET state=%s WHERE tenant_id=%s AND id=%s', ('SUCCEEDED' if approve else 'FAILED',tenant,correction))
            balance = self.save(conn,tenant,stay,before,after,actor,'CASH_CORRECTION_'+state,correction,
                                dict(receipt_id=row[0],replacement_receipt_id=replacement,reversal_id=reversal,requester_id=row[2],approver_id=actor),now)
            result = dict(correction_id=correction,state=state,reversal_id=reversal,replacement_receipt_id=replacement,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def invoice(self,bearer,tenant,stay,correction):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant,stay);ShiftService._book(conn,tenant)
            row=conn.execute('''SELECT c.state,c.replacement_amount_mnt,r.replacement_channel FROM prsystem.guest_correction c
                JOIN prsystem.guest_correction_route r ON(r.tenant_id,r.correction_id)=(c.tenant_id,c.id)
                WHERE c.tenant_id=%s AND c.stay_id=%s AND c.id=%s FOR UPDATE OF c''',(tenant,stay,correction)).fetchone()
            if not row or row[0]!='PENDING' or not row[1]:raise DomainError('WORK_NOT_OPEN')
            gateway=self.payments.gateway(row[2])
            invoice=gateway.create_invoice('correction-'+correction,row[1],'MNT')
            return dict(correction_id=correction,invoice_id=invoice,provider_attempt_id='correction-'+correction)
