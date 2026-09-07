"""Source-bound cash guest ledger. Provider/POS/corrections are separate ports.

Lock order: actor/account -> receipt -> cash book -> stay -> deposit aggregate
-> receipt/charge/refund. Settings/check-in also serialize on catalog -> room.
No HTTP payload supplies a balance, success flag, source snapshot or cash root.
"""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError, money
from prsystem.deposit_policy import available, require_available, deposit_setting
from prsystem.rooms import RoomService
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.subscription import Action, Obligation, RootKind
from prsystem.postgres.connection import transaction


class GuestFinance(RoomService):
    def __init__(self, auth, vault=None, runtime_mode='production'):
        super().__init__(auth)
        self.vault=vault
        if runtime_mode not in {'production','development','test'}:
            raise ValueError('Unknown runtime mode')
        if runtime_mode!='production':
            from prsystem.mock_providers import require_development_database
            require_development_database(auth.dsn,runtime_mode)
        self.mode='CASH_LEDGER' if runtime_mode=='production' else 'MOCK_CASH_LEDGER'

    def configure(self,bearer,tenant,category,amount,revision,key):
        deposit_setting(amount,nullable=category is not None)
        command=dict(action='DEPOSIT_CONFIGURE',category_id=category,amount_mnt=amount,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            if category is None:
                old=conn.execute('SELECT amount_mnt,revision FROM prsystem.deposit_hotel_settings WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            else:
                if not conn.execute('SELECT 1 FROM prsystem.room_category WHERE tenant_id=%s AND id=%s',(tenant,category)).fetchone():raise DomainError('WORK_SOURCE_NOT_FOUND')
                old=conn.execute('SELECT amount_mnt,revision FROM prsystem.deposit_category_settings WHERE tenant_id=%s AND category_id=%s FOR UPDATE',(tenant,category)).fetchone()
            if type(revision) is not int or revision!=(old[1] if old else 0):raise DomainError('REVISION_CONFLICT')
            if category is None:
                conn.execute('''INSERT INTO prsystem.deposit_hotel_settings VALUES (%s,%s,%s) ON CONFLICT (tenant_id)
                    DO UPDATE SET amount_mnt=EXCLUDED.amount_mnt,revision=EXCLUDED.revision''',(tenant,amount,revision+1))
            else:
                conn.execute('''INSERT INTO prsystem.deposit_category_settings VALUES (%s,%s,%s,%s) ON CONFLICT (tenant_id,category_id)
                    DO UPDATE SET amount_mnt=EXCLUDED.amount_mnt,revision=EXCLUDED.revision''',(tenant,category,amount,revision+1))
            result=dict(category_id=category,amount_mnt=amount,revision=revision+1)
            self.event(conn,tenant,actor,'DEPOSIT_SETTINGS_CHANGED',category or tenant,dict(before=dict(amount_mnt=old[0],revision=old[1]) if old else None,after=result))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    @staticmethod
    def setting(conn,tenant,category):
        override=conn.execute('SELECT amount_mnt,revision FROM prsystem.deposit_category_settings WHERE tenant_id=%s AND category_id=%s',(tenant,category)).fetchone()
        default=conn.execute('SELECT amount_mnt,revision FROM prsystem.deposit_hotel_settings WHERE tenant_id=%s',(tenant,)).fetchone()
        if override and override[0] is not None:
            return dict(amount_mnt=override[0],source='CATEGORY',source_id=category,revision=override[1])
        if default:
            return dict(amount_mnt=default[0],source='HOTEL',source_id=tenant,revision=default[1],category_override_revision=override[1] if override else 0)
        raise DomainError('STAY_DEPOSIT_SETTINGS_REQUIRED')

    def read_setting(self,bearer,tenant,category):
        with transaction(self.auth.dsn) as conn:
            self._reader(conn,bearer,tenant)
            self._catalog_lock(conn,tenant)
            if not conn.execute('SELECT 1 FROM prsystem.room_category WHERE tenant_id=%s AND id=%s',(tenant,category)).fetchone():raise DomainError('WORK_SOURCE_NOT_FOUND')
            return self.setting(conn,tenant,category)

    @staticmethod
    def root(conn,tenant,stay):
        row=conn.execute('SELECT check_in_recorded_at FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()
        return Obligation(tenant,stay,RootKind.STAY,row[0],True) if row else None

    def actor(self,conn,bearer,tenant,stay,*,manager=False,action=Action.SETTLE_STAY):
        self._actors(conn,bearer,tenant)
        root=self.root(conn,tenant,stay)
        if manager:return self._queue_actor(conn,bearer,tenant,action=action,obligation=root)
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        actor=principal['account_id']
        ShiftService._reception(conn,tenant,actor,action=action,obligation=root)
        return actor

    @staticmethod
    def balance(row):
        return dict(row,available=available(row['received'],row['reversed'],row['allocated'],row['refund_reserved'],row['refunded']))

    def lock(self,conn,tenant,stay,revision=None,*,active=False,allow_frozen=False):
        source=conn.execute('SELECT state,snapshot FROM prsystem.stay WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,stay)).fetchone()
        if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
        if source[1].get('financial_integration')!=self.mode:raise DomainError('FINANCIAL_SOURCE_NOT_READY')
        if active and source[0]!='ACTIVE':raise DomainError('WORK_NOT_OPEN')
        row=conn.execute('SELECT revision,received,reversed,allocated,refund_reserved,refunded,frozen FROM prsystem.guest_finance WHERE tenant_id=%s AND stay_id=%s FOR UPDATE',(tenant,stay)).fetchone()
        if not row:raise DomainError('FINANCIAL_SOURCE_NOT_READY')
        result=dict(zip(('revision','received','reversed','allocated','refund_reserved','refunded','frozen'),row))
        if result['frozen'] and not allow_frozen:raise DomainError('FINANCIAL_AGGREGATE_FROZEN')
        if revision is not None and (type(revision) is not int or revision!=result['revision']):raise DomainError('REVISION_CONFLICT')
        return result

    def save(self,conn,tenant,stay,before,after,actor,kind,source,details,now):
        self.balance(after)
        after=dict(after,revision=before['revision']+1)
        conn.execute('''UPDATE prsystem.guest_finance SET revision=%s,received=%s,reversed=%s,allocated=%s,refund_reserved=%s,refunded=%s
            WHERE tenant_id=%s AND stay_id=%s''',(after['revision'],after['received'],after['reversed'],after['allocated'],after['refund_reserved'],after['refunded'],tenant,stay))
        self.audit(conn,tenant,stay,actor,kind,source,dict(details,before=self.balance(before),after=self.balance(after)),after['revision'],now)
        return self.balance(after)

    def audit(self,conn,tenant,stay,actor,kind,source,details,revision,now):
        conn.execute('INSERT INTO prsystem.guest_finance_event VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,revision,kind,source,actor,Jsonb(details),now))
        self.event(conn,tenant,actor,kind,stay,dict(source_id=source,finance_revision=revision))

    @staticmethod
    def cash(conn,tenant,actor,shift,drawer,kind,reference,posted_delta,reserved_delta,now):
        # Caller holds the cash-book root for the entire enclosing transaction.
        row=conn.execute('SELECT shift_id,posted,reserved FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,drawer)).fetchone()
        if not row or row[0]!=shift:raise DomainError('CASH_SOURCE_CONFLICT')
        posted,reserved=row[1]+posted_delta,row[2]+reserved_delta
        if posted<0 or reserved>posted:raise DomainError('INSUFFICIENT_CASH')
        money(posted);money(reserved)
        conn.execute('UPDATE prsystem.cash_drawer SET posted=%s,reserved=%s WHERE tenant_id=%s AND id=%s',(posted,reserved,tenant,drawer))
        revision=conn.execute('UPDATE prsystem.cash_book SET revision=revision+1 WHERE tenant_id=%s RETURNING revision',(tenant,)).fetchone()[0]
        conn.execute('INSERT INTO prsystem.cash_event VALUES (%s,%s,0,%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,revision,kind,reference,drawer,shift,posted_delta,reserved_delta,actor,now))
        conn.execute("INSERT INTO prsystem.cash_outbox VALUES (%s,%s,'cash.changed',%s,%s)",(tenant,revision,Jsonb(dict(kind=kind,reference=reference,drawer_id=drawer,shift_id=shift)),now))
        return revision

    @staticmethod
    def receipt_balance(row):
        return available(row[0],row[4],row[1],row[2],row[3])

    @staticmethod
    def no_pending_correction(conn,tenant,receipt):
        if conn.execute("SELECT 1 FROM prsystem.guest_correction WHERE tenant_id=%s AND receipt_id=%s AND state='PENDING'",(tenant,receipt)).fetchone():
            raise DomainError('CORRECTION_PENDING')

    @staticmethod
    def load_receipt(conn,tenant,stay,receipt):
        row=conn.execute('''SELECT amount_mnt,allocated,refund_reserved,refunded,reversed,purpose,drawer_id,channel FROM prsystem.guest_receipt
            WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE''',(tenant,stay,receipt)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        return row

    @staticmethod
    def charge(conn,tenant,stay,charge,amount,*,excluding_intent=None):
        row=conn.execute('SELECT amount_mnt,paid_mnt FROM prsystem.guest_charge WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE',(tenant,stay,charge)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        held=conn.execute("SELECT coalesce(sum(amount_mnt),0) FROM prsystem.guest_payment_intent WHERE tenant_id=%s AND charge_id=%s AND state='PENDING' AND id IS DISTINCT FROM %s",(tenant,charge,excluding_intent)).fetchone()[0]
        if amount>row[0]-row[1]-held:raise DomainError('CHARGE_OVERPAYMENT')
        conn.execute('UPDATE prsystem.guest_charge SET paid_mnt=paid_mnt+%s WHERE tenant_id=%s AND id=%s',(amount,tenant,charge))

    def record_receipt(self,conn,tenant,stay,actor,shift,amount,purpose,now,*,post_cash=True,channel='CASH'):
        if channel not in {'CASH','MANUAL_POS','QPAY','KHAAN'} or (post_cash and channel!='CASH'):raise DomainError('INVALID_REQUEST')
        money(amount,positive=True)
        receipt=secrets.token_hex(16)
        conn.execute('''INSERT INTO prsystem.guest_receipt (tenant_id,stay_id,id,purpose,channel,amount_mnt,actor_id,shift_id,drawer_id,recorded_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,stay,receipt,purpose,channel,amount,actor,shift[0],shift[2],now))
        if post_cash:
            self.cash(conn,tenant,actor,shift[0],shift[2],'GUEST_DEPOSIT_RECEIVED' if purpose=='DEPOSIT' else 'GUEST_PAYMENT_RECEIVED',receipt,amount,0,now)
        return receipt

    def initial(self,conn,tenant,stay,actor,shift,deposit,charge_amount,now,channel='CASH'):
        conn.execute('INSERT INTO prsystem.guest_finance (tenant_id,stay_id,received) VALUES (%s,%s,%s)',(tenant,stay,deposit))
        charge=secrets.token_hex(16)
        conn.execute("INSERT INTO prsystem.guest_charge (tenant_id,stay_id,id,kind,source_id,amount_mnt,recorded_at) VALUES (%s,%s,%s,'ROOM',%s,%s,%s)",(tenant,stay,charge,stay,charge_amount,now))
        receipt=self.record_receipt(conn,tenant,stay,actor,shift,deposit,'DEPOSIT',now,post_cash=channel=='CASH',channel=channel)
        result=dict(deposit_receipt_id=receipt,room_charge_id=charge,finance_revision=1)
        self.audit(conn,tenant,stay,actor,'CHECK_IN_CASH_DEPOSIT' if channel=='CASH' else 'CHECK_IN_NON_CASH_DEPOSIT',receipt,dict(result,deposit_mnt=deposit,room_charge_mnt=charge_amount,shift_id=shift[0],channel=channel),1,now)
        return result

    def receive(self,bearer,tenant,stay,purpose,amount,charge,revision,key):
        money(amount,positive=True)
        # After check-in, top-ups pay a concrete existing charge. A generic
        # deposit receipt must not manufacture new obligations after expiry.
        if purpose!='PAYMENT' or charge is None:raise DomainError('INVALID_REQUEST')
        command=dict(action='GUEST_CASH_RECEIPT',stay_id=stay,purpose=purpose,amount_mnt=amount,charge_id=charge,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before=self.lock(conn,tenant,stay,revision,active=True);after=dict(before)
            shift=StayService._shift(conn,tenant,actor)
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            self.charge(conn,tenant,stay,charge,amount)
            receipt=self.record_receipt(conn,tenant,stay,actor,shift,amount,purpose,now)
            conn.execute('UPDATE prsystem.guest_receipt SET allocated=%s WHERE tenant_id=%s AND id=%s',(amount,tenant,receipt))
            conn.execute('INSERT INTO prsystem.guest_allocation VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,secrets.token_hex(16),receipt,charge,amount,actor,now))
            balance=self.save(conn,tenant,stay,before,after,actor,'GUEST_CASH_RECEIVED',receipt,dict(amount_mnt=amount,purpose=purpose,charge_id=charge,shift_id=shift[0]),now)
            result=dict(receipt_id=receipt,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def allocate(self,bearer,tenant,stay,receipt,charge,amount,revision,key):
        money(amount,positive=True)
        command=dict(action='DEPOSIT_ALLOCATE',stay_id=stay,receipt_id=receipt,charge_id=charge,amount_mnt=amount,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before=self.lock(conn,tenant,stay,revision,active=True);after=dict(before)
            StayService._shift(conn,tenant,actor)
            self.no_pending_correction(conn,tenant,receipt)
            funding=self.load_receipt(conn,tenant,stay,receipt)
            if funding[5]!='DEPOSIT':raise DomainError('INVALID_FINANCIAL_SOURCE')
            require_available(amount,self.receipt_balance(funding));require_available(amount,self.balance(before)['available'])
            self.charge(conn,tenant,stay,charge,amount)
            conn.execute('UPDATE prsystem.guest_receipt SET allocated=allocated+%s WHERE tenant_id=%s AND id=%s',(amount,tenant,receipt))
            allocation=secrets.token_hex(16);now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute('INSERT INTO prsystem.guest_allocation VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,allocation,receipt,charge,amount,actor,now))
            after['allocated']+=amount
            balance=self.save(conn,tenant,stay,before,after,actor,'DEPOSIT_ALLOCATED',allocation,dict(receipt_id=receipt,charge_id=charge,amount_mnt=amount),now)
            result=dict(allocation_id=allocation,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def reserve_refund(self,bearer,tenant,stay,receipt,amount,revision,key):
        money(amount,positive=True)
        command=dict(action='RESERVE_CASH_REFUND',stay_id=stay,receipt_id=receipt,amount_mnt=amount,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,action=Action.REFUND)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before=self.lock(conn,tenant,stay,revision);after=dict(before)
            shift=StayService._shift(conn,tenant,actor)
            self.no_pending_correction(conn,tenant,receipt)
            funding=self.load_receipt(conn,tenant,stay,receipt)
            if funding[5]!='DEPOSIT':raise DomainError('INVALID_FINANCIAL_SOURCE')
            if funding[7]!='CASH':raise DomainError('INVALID_FINANCIAL_SOURCE')
            if funding[6]!=shift[2]:raise DomainError('ORIGINAL_CASH_DRAWER_REQUIRED')
            require_available(amount,self.receipt_balance(funding));require_available(amount,self.balance(before)['available'])
            refund=secrets.token_hex(16);now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute("""INSERT INTO prsystem.guest_refund (tenant_id,stay_id,id,receipt_id,amount_mnt,channel,state,actor_id,shift_id,drawer_id,recorded_at)
                VALUES (%s,%s,%s,%s,%s,'CASH','RESERVED',%s,%s,%s,%s)""",(tenant,stay,refund,receipt,amount,actor,shift[0],shift[2],now))
            conn.execute('UPDATE prsystem.guest_receipt SET refund_reserved=refund_reserved+%s WHERE tenant_id=%s AND id=%s',(amount,tenant,receipt))
            # The existing shift close/takeover pending guard also sees cash refunds.
            conn.execute("INSERT INTO prsystem.shift_obligation (tenant_id,id,shift_id,provider_reference,state) VALUES (%s,%s,%s,%s,'PENDING')",(tenant,refund,shift[0],'guest-cash-refund:'+refund))
            self.cash(conn,tenant,actor,shift[0],shift[2],'GUEST_REFUND_RESERVED',refund,0,amount,now)
            after['refund_reserved']+=amount
            balance=self.save(conn,tenant,stay,before,after,actor,'CASH_REFUND_RESERVED',refund,dict(receipt_id=receipt,amount_mnt=amount,shift_id=shift[0]),now)
            result=dict(refund_id=refund,state='RESERVED',balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def finish_refund(self,bearer,tenant,stay,refund,revision,key,confirmation,*,release=False):
        confirmation=self._text(confirmation,1000)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=release,action=Action.REFUND)
            if self.vault is None:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
            command=dict(action='RELEASE_CASH_REFUND' if release else 'COMPLETE_CASH_REFUND',stay_id=stay,refund_id=refund,revision=revision,
                         confirmation_fingerprint=self.vault.fingerprint('cash-refund-confirmation',[tenant,stay,refund,confirmation]))
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before=self.lock(conn,tenant,stay,revision);after=dict(before)
            row=conn.execute('SELECT receipt_id,amount_mnt,state,shift_id,drawer_id FROM prsystem.guest_refund WHERE tenant_id=%s AND stay_id=%s AND id=%s FOR UPDATE',(tenant,stay,refund)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[2]!='RESERVED':raise DomainError('REFUND_TERMINAL')
            if conn.execute('SELECT 1 FROM prsystem.guest_refund_route WHERE tenant_id=%s AND refund_id=%s',(tenant,refund)).fetchone():raise DomainError('INVALID_FINANCIAL_SOURCE')
            if not release:
                shift=StayService._shift(conn,tenant,actor)
                if (shift[0],shift[2])!=(row[3],row[4]):raise DomainError('ORIGINAL_CASH_DRAWER_REQUIRED')
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            funding=self.load_receipt(conn,tenant,stay,row[0])
            if row[1]>funding[2] or row[1]>before['refund_reserved']:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
            state='RELEASED' if release else 'COMPLETED'
            envelope=self.vault.seal(dict(confirmation=confirmation,actor_id=actor),tenant,stay,'cash-refund:'+refund)
            conn.execute('''UPDATE prsystem.guest_refund SET state=%s,completed_at=%s,released_at=%s,confirmation_envelope=%s
                WHERE tenant_id=%s AND id=%s''',(state,None if release else now,now if release else None,Jsonb(envelope),tenant,refund))
            conn.execute('UPDATE prsystem.guest_receipt SET refund_reserved=refund_reserved-%s,refunded=refunded+%s WHERE tenant_id=%s AND id=%s',(row[1],0 if release else row[1],tenant,row[0]))
            conn.execute('UPDATE prsystem.shift_obligation SET state=%s WHERE tenant_id=%s AND id=%s',('FAILED' if release else 'SUCCEEDED',tenant,refund))
            self.cash(conn,tenant,actor,row[3],row[4],'GUEST_REFUND_RELEASED' if release else 'GUEST_REFUND_PAID',refund,0 if release else -row[1],-row[1],now)
            after['refund_reserved']-=row[1]
            if not release:after['refunded']+=row[1]
            balance=self.save(conn,tenant,stay,before,after,actor,'CASH_REFUND_'+state,refund,dict(amount_mnt=row[1],receipt_id=row[0],cash_not_handed=release,self_approved=actor==conn.execute('SELECT actor_id FROM prsystem.guest_refund WHERE tenant_id=%s AND id=%s',(tenant,refund)).fetchone()[0]),now)
            result=dict(refund_id=refund,state=state,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def read_actor(self,conn,bearer,tenant,stay):
        self._actors(conn,bearer,tenant)
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        package=conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()[0]
        return self.actor(conn,bearer,tenant,stay,manager=self._manager(principal['roles'],package),action=Action.DETAIL)

    def timeline(self,bearer,tenant,stay,after=0,through=None,limit=50):
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=100 or (through is not None and (type(through) is not int or through<0)):
            raise DomainError('INVALID_REQUEST')
        with transaction(self.auth.dsn) as conn:
            self.read_actor(conn,bearer,tenant,stay)
            ShiftService._book(conn,tenant)
            balance=self.lock(conn,tenant,stay,allow_frozen=True)
            watermark=min(through,balance['revision']) if through is not None else balance['revision']
            rows=conn.execute('''SELECT revision,kind,source_id,actor_id,details,recorded_at FROM prsystem.guest_finance_event
                WHERE tenant_id=%s AND stay_id=%s AND revision>%s AND revision<=%s ORDER BY revision LIMIT %s''',(tenant,stay,after,watermark,limit+1)).fetchall()
            items=[dict(zip(('revision','kind','source_id','actor_id','details','recorded_at'),r)) for r in rows[:limit]]
            return dict(items=items,through_revision=watermark,next_after_revision=items[-1]['revision'] if len(rows)>limit else None)

    def statement(self,bearer,tenant,stay):
        with transaction(self.auth.dsn) as conn:
            self.read_actor(conn,bearer,tenant,stay)
            ShiftService._book(conn,tenant)
            balance=self.lock(conn,tenant,stay,allow_frozen=True)
            totals=conn.execute('SELECT coalesce(sum(amount_mnt),0),coalesce(sum(paid_mnt),0) FROM prsystem.guest_charge WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone()
            charges=conn.execute('SELECT id,kind,amount_mnt,paid_mnt FROM prsystem.guest_charge WHERE tenant_id=%s AND stay_id=%s ORDER BY id LIMIT 100',(tenant,stay)).fetchall()
            receipts=conn.execute('SELECT id,purpose,channel,amount_mnt,allocated,refund_reserved,refunded,reversed FROM prsystem.guest_receipt WHERE tenant_id=%s AND stay_id=%s ORDER BY id LIMIT 100',(tenant,stay)).fetchall()
            refunds=conn.execute('SELECT id,receipt_id,amount_mnt,state FROM prsystem.guest_refund WHERE tenant_id=%s AND stay_id=%s ORDER BY id LIMIT 100',(tenant,stay)).fetchall()
            corrections=conn.execute('''SELECT id,receipt_id,replacement_amount_mnt,state,requester_id,reason,decider_id,decision_reason,requested_at,decided_at
                FROM prsystem.guest_correction WHERE tenant_id=%s AND stay_id=%s ORDER BY requested_at,id LIMIT 100''',(tenant,stay)).fetchall()
            reversals=conn.execute('''SELECT id,correction_id,receipt_id,replacement_receipt_id,amount_mnt,recorded_at
                FROM prsystem.guest_receipt_reversal WHERE tenant_id=%s AND stay_id=%s ORDER BY recorded_at,id LIMIT 100''',(tenant,stay)).fetchall()
            intents=conn.execute('''SELECT id,charge_id,provider,amount_mnt,state,last_provider_state,invoice_id,receipt_id
                FROM prsystem.guest_payment_intent WHERE tenant_id=%s AND stay_id=%s ORDER BY recorded_at,id LIMIT 100''',(tenant,stay)).fetchall()
            pending=conn.execute('''SELECT coalesce(sum(amount_mnt),0) FROM prsystem.guest_payment_intent
                WHERE tenant_id=%s AND stay_id=%s AND state='PENDING' ''',(tenant,stay)).fetchone()[0]
            return dict(balance=self.balance(balance),charge_total_mnt=int(totals[0]),charge_paid_mnt=int(totals[1]),charge_unpaid_mnt=int(totals[0]-totals[1]),pending_payment_mnt=int(pending),item_limit=100,
                        corrections=[dict(zip(('id','receipt_id','replacement_amount_mnt','state','requester_id','reason','decider_id','decision_reason','requested_at','decided_at'),r)) for r in corrections],
                        reversals=[dict(zip(('id','correction_id','receipt_id','replacement_receipt_id','amount_mnt','recorded_at'),r)) for r in reversals],
                        payment_intents=[dict(zip(('id','charge_id','provider','amount_mnt','state','last_provider_state','invoice_id','receipt_id'),r)) for r in intents],
                        charges=[dict(zip(('id','kind','amount_mnt','paid_mnt'),r)) for r in charges],
                        receipts=[dict(zip(('id','purpose','channel','amount_mnt','allocated','refund_reserved','refunded','reversed'),r)) for r in receipts],
                        refunds=[dict(zip(('id','receipt_id','amount_mnt','state'),r)) for r in refunds])
