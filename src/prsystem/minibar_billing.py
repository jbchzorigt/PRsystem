"""Snapshot-priced historical billing; never rewinds physical room inventory."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError, money
from prsystem.guest_finance import GuestFinance
from prsystem.shifts import ShiftService
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction


class MinibarBilling(GuestFinance):
    @staticmethod
    def basis(conn,tenant,stay):
        return conn.execute('SELECT prsystem.minibar_billing_basis(%s,%s)',(tenant,stay)).fetchone()[0]

    def read(self,bearer,tenant,stay,after=0,limit=25):
        with transaction(self.auth.dsn) as conn:
            self.read_actor(conn,bearer,tenant,stay)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            ShiftService._book(conn,tenant)
            balance=self.lock(conn,tenant,stay,allow_frozen=True)
            basis=self.basis(conn,tenant,stay)
            if not basis:raise DomainError('MINIBAR_BILLING_NOT_READY')
            rows=conn.execute('''SELECT id,billing_revision,original_revision,previous_id,original_charge_id,charge_id,paid_mnt,amount_mnt,items,actor_label,reason,recorded_at
                FROM prsystem.minibar_billing_correction WHERE tenant_id=%s AND stay_id=%s AND billing_revision>%s ORDER BY billing_revision LIMIT %s''',(tenant,stay,after,limit+1)).fetchall()
            history=[dict(zip(('correction_id','billing_revision','original_revision','previous_id','original_charge_id','charge_id','paid_mnt','amount_mnt','items','actor_label','reason','recorded_at'),r)) for r in rows[:limit]]
            pending=bool(conn.execute('''SELECT 1 FROM prsystem.guest_payment_intent p JOIN prsystem.guest_charge c ON(c.tenant_id,c.id)=(p.tenant_id,p.charge_id)
                WHERE p.tenant_id=%s AND p.stay_id=%s AND c.kind='MINIBAR' AND p.state='PENDING'
                UNION ALL SELECT 1 FROM prsystem.guest_correction WHERE tenant_id=%s AND stay_id=%s AND state='PENDING' LIMIT 1''',(tenant,stay,tenant,stay)).fetchone())
            return dict(basis=basis,balance=self.balance(balance),blocked=balance['frozen'] or pending,history=history,next_after=history[-1]['billing_revision'] if len(rows)>limit else None)

    def stays(self,bearer,tenant,after='',limit=25):
        with transaction(self.auth.dsn) as conn:
            self._reader(conn,bearer,tenant)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            rows=conn.execute('''SELECT s.id,s.room_id,s.snapshot->>'room_number',s.check_in_recorded_at,s.actual_checkout_at
                FROM prsystem.stay s WHERE s.tenant_id=%s AND s.id>%s AND s.state='CLOSED'
                AND EXISTS(SELECT 1 FROM prsystem.minibar_guest_report g WHERE g.tenant_id=s.tenant_id AND g.stay_id=s.id)
                ORDER BY s.id LIMIT %s''',(tenant,after,limit+1)).fetchall()
            items=[dict(zip(('stay_id','room_id','room_number','check_in_recorded_at','actual_checkout_at'),r)) for r in rows[:limit]]
            return dict(items=items,next_after=items[-1]['stay_id'] if len(rows)>limit else None)

    def correct(self,bearer,tenant,stay,quantities,revision,report_revision,finance_revision,reason,key):
        reason=self._text(reason,1000)
        command=dict(action='HISTORICAL_MINIBAR_BILLING',stay_id=stay,quantities=quantities,revision=revision,report_revision=report_revision,finance_revision=finance_revision,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=True,action=Action.SETTLE_STAY)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            if conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0] not in (25000,30000):raise DomainError('PACKAGE_REQUIRED')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            before=self.lock(conn,tenant,stay,finance_revision)
            basis=self.basis(conn,tenant,stay)
            if not basis:raise DomainError('MINIBAR_BILLING_NOT_READY')
            if (basis['billing_revision'],basis['original_revision'])!=(revision,report_revision):raise DomainError('REVISION_CONFLICT')
            if set(quantities)!={i['product_id'] for i in basis['items']}:raise DomainError('INVALID_REQUEST')
            items=[];total=0
            for item in basis['items']:
                n=quantities[item['product_id']]
                if type(n) is not int or not 0<=n<=min(1000000,item['billable_limit']):raise DomainError('INVALID_REQUEST')
                total+=n*item['unit_price'];money(total)
                items.append(dict(item,quantity=n,line_amount=n*item['unit_price']))
            if items==basis['items']:raise DomainError('CORRECTION_HAS_NO_CHANGE')
            if conn.execute('''SELECT 1 FROM prsystem.guest_payment_intent p JOIN prsystem.guest_charge c ON(c.tenant_id,c.id)=(p.tenant_id,p.charge_id)
                WHERE p.tenant_id=%s AND p.stay_id=%s AND c.kind='MINIBAR' AND p.state='PENDING' ''',(tenant,stay)).fetchone():raise DomainError('MINIBAR_REPORT_LOCKED')
            if conn.execute("SELECT 1 FROM prsystem.guest_correction WHERE tenant_id=%s AND stay_id=%s AND state='PENDING'",(tenant,stay)).fetchone():raise DomainError('CORRECTION_PENDING')
            old=basis['charge_id'];paid=0
            if old:paid=conn.execute('SELECT paid_mnt FROM prsystem.guest_charge WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,old)).fetchone()[0]
            allocations=conn.execute('''SELECT a.id,a.receipt_id,a.amount_mnt FROM prsystem.guest_allocation a WHERE a.tenant_id=%s AND a.stay_id=%s AND a.charge_id=%s
                AND NOT prsystem.minibar_allocation_released(a.tenant_id,a.id)
                AND NOT EXISTS(SELECT 1 FROM prsystem.guest_allocation_reversal v WHERE v.tenant_id=a.tenant_id AND v.allocation_id=a.id)
                ORDER BY a.receipt_id,a.id''',(tenant,stay,old)).fetchall()
            if sum(a[2] for a in allocations)!=paid:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
            identity=secrets.token_hex(16);charge=secrets.token_hex(16) if total else None
            conn.execute('''INSERT INTO prsystem.minibar_billing_correction(tenant_id,stay_id,id,billing_revision,original_revision,previous_id,original_charge_id,charge_id,finance_revision,paid_mnt,amount_mnt,items,actor_id,actor_label,reason)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'',%s)''',(tenant,stay,identity,revision+1,report_revision,basis['previous_id'],old,charge,finance_revision,paid,total,Jsonb(items),actor,reason))
            after=dict(before);purposes={}
            for allocation,receipt,amount in allocations:
                funding=self.load_receipt(conn,tenant,stay,receipt);self.no_pending_correction(conn,tenant,receipt)
                purposes[receipt]=funding[5]
                if funding[1]<amount:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
                conn.execute('INSERT INTO prsystem.minibar_billing_release(tenant_id,stay_id,correction_id,allocation_id,receipt_id,amount_mnt) VALUES(%s,%s,%s,%s,%s,%s)',(tenant,stay,identity,allocation,receipt,amount))
                conn.execute('UPDATE prsystem.guest_receipt SET allocated=allocated-%s WHERE tenant_id=%s AND id=%s',(amount,tenant,receipt))
                if funding[5]=='DEPOSIT':after['allocated']-=amount
                else:after['service_credit']+=amount
            if old:
                conn.execute('UPDATE prsystem.guest_charge SET paid_mnt=0 WHERE tenant_id=%s AND id=%s',(tenant,old))
                if basis['amount_mnt']:
                    conn.execute('INSERT INTO prsystem.guest_charge_adjustment(tenant_id,charge_id,id,amount_mnt,reason,actor_id) VALUES(%s,%s,%s,%s,%s,%s)',(tenant,old,identity,-basis['amount_mnt'],reason,actor))
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if charge:conn.execute("INSERT INTO prsystem.guest_charge(tenant_id,stay_id,id,kind,source_id,amount_mnt,recorded_at) VALUES(%s,%s,%s,'MINIBAR',%s,%s,%s)",(tenant,stay,charge,'billing:'+identity,total,now))
            remaining=min(paid,total);credits=[]
            for _,receipt,amount in allocations:
                take=min(amount,remaining);remaining-=take
                if take:
                    self.charge(conn,tenant,stay,charge,take);allocation=secrets.token_hex(16)
                    conn.execute('UPDATE prsystem.guest_receipt SET allocated=allocated+%s WHERE tenant_id=%s AND id=%s',(take,tenant,receipt))
                    conn.execute('INSERT INTO prsystem.guest_allocation VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,allocation,receipt,charge,take,actor,now))
                    conn.execute('INSERT INTO prsystem.minibar_billing_reallocation(tenant_id,stay_id,correction_id,allocation_id,receipt_id,amount_mnt) VALUES(%s,%s,%s,%s,%s,%s)',(tenant,stay,identity,allocation,receipt,take))
                    if purposes[receipt]=='DEPOSIT':after['allocated']+=take
                    else:after['service_credit']-=take
                if amount>take:credits.append(dict(receipt_id=receipt,amount_mnt=amount-take))
            details=dict(original_revision=report_revision,billing_revision=revision+1,previous_id=basis['previous_id'],original_charge_id=old,charge_id=charge,items=items,reason=reason,refundable_credits=credits,inventory_changed=False)
            balance=self.save(conn,tenant,stay,before,after,actor,'HISTORICAL_MINIBAR_BILLING_CORRECTED',identity,details,now)
            result=dict(correction_id=identity,billing_revision=revision+1,charge_id=charge,amount_mnt=total,reallocated_mnt=min(paid,total),new_receivable_mnt=max(0,total-paid),refundable_credits=credits,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result
