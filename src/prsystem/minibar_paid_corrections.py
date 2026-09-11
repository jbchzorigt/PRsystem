"""Atomic paid report replacement, payment reallocation and refundable credit."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.minibar_guest import MinibarGuest
from prsystem.shifts import ShiftService
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction


class MinibarPaidCorrections(MinibarGuest):
    def correct(self,bearer,tenant,stay,counts,revision,finance_revision,reason,key):
        reason=self._text(reason,1000)
        command=dict(action='PAID_MINIBAR_CORRECTION',stay_id=stay,counts=counts,revision=revision,finance_revision=finance_revision,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=True,action=Action.CHECKOUT_REPORT)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            package=conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            if package not in (25000,30000):raise DomainError('PACKAGE_REQUIRED')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);self._catalog_lock(conn,tenant)
            room=conn.execute('SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()
            if not room:raise DomainError('WORK_SOURCE_NOT_FOUND')
            conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,room[0])).fetchone()
            before=self.lock(conn,tenant,stay,finance_revision,active=True)
            inspection=conn.execute('SELECT state,revision FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s FOR UPDATE',(tenant,stay)).fetchone()
            if not inspection or inspection[0]!='REPORTED':raise DomainError('WORK_NOT_OPEN')
            if inspection[1]!=revision:raise DomainError('REVISION_CONFLICT')
            if not conn.execute('SELECT 1 FROM prsystem.minibar_guest_report WHERE tenant_id=%s AND stay_id=%s AND revision=%s',(tenant,stay,revision)).fetchone():raise DomainError('MINIBAR_REPORT_REQUIRED')
            old=conn.execute('SELECT charge_id,items FROM prsystem.reception_minibar_report WHERE tenant_id=%s AND stay_id=%s AND revision=%s',(tenant,stay,revision)).fetchone()
            if not old or not old[0]:raise DomainError('INVALID_FINANCIAL_SOURCE')
            if set(counts)!={i['product_id'] for i in old[1]}:raise DomainError('INVALID_REQUEST')
            if counts=={i['product_id']:i['actual_count'] for i in old[1]}:raise DomainError('CORRECTION_HAS_NO_CHANGE')
            if conn.execute("SELECT 1 FROM prsystem.guest_payment_intent p JOIN prsystem.guest_charge c ON(c.tenant_id,c.id)=(p.tenant_id,p.charge_id) WHERE c.tenant_id=%s AND c.stay_id=%s AND c.kind='MINIBAR' AND p.state='PENDING'",(tenant,stay)).fetchone():raise DomainError('MINIBAR_REPORT_LOCKED')
            paid=conn.execute('SELECT paid_mnt FROM prsystem.guest_charge WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,old[0])).fetchone()[0]
            if paid<=0:raise DomainError('INVALID_FINANCIAL_SOURCE')
            allocations=conn.execute('''SELECT a.id,a.receipt_id,a.amount_mnt FROM prsystem.guest_allocation a
                WHERE a.tenant_id=%s AND a.stay_id=%s AND a.charge_id=%s
                AND NOT EXISTS(SELECT 1 FROM prsystem.guest_allocation_reversal x WHERE x.tenant_id=a.tenant_id AND x.allocation_id=a.id)
                AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_paid_release x WHERE x.tenant_id=a.tenant_id AND x.allocation_id=a.id)
                ORDER BY a.receipt_id,a.id''',(tenant,stay,old[0])).fetchall()
            if sum(a[2] for a in allocations)!=paid:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
            correction=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.minibar_paid_correction(tenant_id,stay_id,id,original_revision,replacement_revision,original_charge_id,paid_mnt,actor_id,reason,counts) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,correction,revision,revision+1,old[0],paid,actor,reason,Jsonb(counts)))
            for allocation,receipt,amount in allocations:
                self.no_pending_correction(conn,tenant,receipt)
                funding=self.load_receipt(conn,tenant,stay,receipt)
                if funding[1]<amount:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
                conn.execute('INSERT INTO prsystem.minibar_paid_release(tenant_id,stay_id,correction_id,allocation_id,receipt_id,amount_mnt) VALUES(%s,%s,%s,%s,%s,%s)',(tenant,stay,correction,allocation,receipt,amount))
                conn.execute('UPDATE prsystem.guest_receipt SET allocated=allocated-%s WHERE tenant_id=%s AND id=%s',(amount,tenant,receipt))
            conn.execute('UPDATE prsystem.guest_charge SET paid_mnt=0 WHERE tenant_id=%s AND id=%s',(tenant,old[0]))
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            after=dict(before,allocated=before['allocated']-paid)
            self.save(conn,tenant,stay,before,after,actor,'MINIBAR_PAYMENT_RELEASED',correction,dict(original_charge_id=old[0],amount_mnt=paid),now)
            conn.execute("UPDATE prsystem.reception_minibar_inspection SET state='REQUESTED' WHERE tenant_id=%s AND stay_id=%s",(tenant,stay))
            self.ensure_source(conn,tenant,stay,revision)
            book=conn.execute("SELECT snapshot->'minibar_snapshot' FROM prsystem.stay WHERE tenant_id=%s AND id=%s",(tenant,stay)).fetchone()[0]
            total=0
            for item in book['items']:
                actual=counts[item['product_id']]
                availability=conn.execute('SELECT prsystem.minibar_stay_availability(%s,%s,%s)',(tenant,stay,item['product_id'])).fetchone()[0]
                if type(actual) is not int or not 0<=actual<=availability['physical_quantity']:raise DomainError('INVALID_REQUEST')
                total+=max(0,availability['available_quantity']-actual)*item['unit_price']
            report=self.report(bearer,tenant,stay,None,None,counts,total==0,revision,'paid-report:'+correction,exception_reason=reason,_connection=conn)
            before=self.lock(conn,tenant,stay);after=dict(before);remaining=min(paid,report['amount_mnt']);credits=[]
            for _,receipt,amount in allocations:
                take=min(amount,remaining);remaining-=take
                if take:
                    self.charge(conn,tenant,stay,report['charge_id'],take)
                    allocation=secrets.token_hex(16)
                    conn.execute('UPDATE prsystem.guest_receipt SET allocated=allocated+%s WHERE tenant_id=%s AND id=%s',(take,tenant,receipt))
                    conn.execute('INSERT INTO prsystem.guest_allocation VALUES(%s,%s,%s,%s,%s,%s,%s,clock_timestamp())',(tenant,stay,allocation,receipt,report['charge_id'],take,actor))
                    conn.execute('INSERT INTO prsystem.minibar_paid_reallocation(tenant_id,stay_id,correction_id,allocation_id,receipt_id,amount_mnt) VALUES(%s,%s,%s,%s,%s,%s)',(tenant,stay,correction,allocation,receipt,take))
                    after['allocated']+=take
                if amount>take:credits.append(dict(receipt_id=receipt,amount_mnt=amount-take))
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            balance=self.save(conn,tenant,stay,before,after,actor,'PAID_MINIBAR_CORRECTED',correction,dict(original_revision=revision,replacement_revision=revision+1,refundable_credits=credits,charge_id=report['charge_id']),now)
            result=dict(correction_id=correction,report_revision=revision+1,charge_id=report['charge_id'],amount_mnt=report['amount_mnt'],reallocated_mnt=min(paid,report['amount_mnt']),new_receivable_mnt=max(0,report['amount_mnt']-paid),refundable_credits=credits,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result
