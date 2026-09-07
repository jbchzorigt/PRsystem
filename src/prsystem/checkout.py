"""Minibar-OFF checkout and claimable canonical cleaning source.

No client-supplied checkout time, paid flag, balance or retention policy.
"""
import secrets
from datetime import timedelta
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.guest_finance import GuestFinance
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction


class CheckoutService(GuestFinance):
    def close(self,bearer,tenant,stay,revision,key,choices=None,guest_informed=False):
        command=dict(action='CHECKOUT_STAY',stay_id=stay,revision=revision)
        if choices or guest_informed:command.update(restaurant_choices=choices,guest_informed=guest_informed)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,action=Action.CHECKOUT)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant)
            self._catalog_lock(conn,tenant)
            source=conn.execute('SELECT room_id,planned_checkout_at,cleaning_buffer_minutes FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
            room=conn.execute('SELECT revision,status,minibar_mode,category_id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,source[0])).fetchone()
            if not room or room[1] not in {'ACTIVE','RETIRING'} or (room[2]!='OFF' and self.mode=='CASH_LEDGER'):raise DomainError('CHECKOUT_SOURCE_NOT_READY')
            before=self.lock(conn,tenant,stay,revision,active=True)
            if conn.execute("SELECT 1 FROM prsystem.stay_time_amendment WHERE tenant_id=%s AND stay_id=%s AND state='PENDING'",(tenant,stay)).fetchone():raise DomainError('AMENDMENT_PENDING')
            shift=StayService._shift(conn,tenant,actor)
            from prsystem.reception_dependencies import ReceptionDependencies
            ReceptionDependencies.final(conn,tenant,stay,actor,choices or [],guest_informed,'production' if self.mode=='CASH_LEDGER' else 'test')
            if before['refund_reserved'] or self.balance(before)['available']:
                raise DomainError('CHECKOUT_FINANCE_PENDING')
            if conn.execute('SELECT 1 FROM prsystem.guest_charge c WHERE tenant_id=%s AND stay_id=%s AND paid_mnt<>amount_mnt+coalesce((SELECT sum(a.amount_mnt) FROM prsystem.guest_charge_adjustment a WHERE a.tenant_id=c.tenant_id AND a.charge_id=c.id),0)',(tenant,stay)).fetchone():
                raise DomainError('CHECKOUT_FINANCE_PENDING')
            if conn.execute("SELECT 1 FROM prsystem.guest_correction WHERE tenant_id=%s AND stay_id=%s AND state='PENDING'",(tenant,stay)).fetchone() or conn.execute("SELECT 1 FROM prsystem.guest_payment_intent WHERE tenant_id=%s AND stay_id=%s AND state='PENDING'",(tenant,stay)).fetchone():
                raise DomainError('CHECKOUT_FINANCE_PENDING')
            if conn.execute("SELECT 1 FROM prsystem.room_cleaning_request WHERE tenant_id=%s AND room_id=%s AND state='OPEN'",(tenant,source[0])).fetchone():
                raise DomainError('CHECKOUT_SOURCE_NOT_READY')
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            conn.execute("UPDATE prsystem.stay SET state='CLOSED',actual_checkout_at=%s WHERE tenant_id=%s AND id=%s",(now,tenant,stay))
            conn.execute("UPDATE prsystem.room SET cleaning_state='DIRTY',revision=revision+1 WHERE tenant_id=%s AND id=%s",(tenant,source[0]))
            conn.execute('UPDATE prsystem.stay_guest_code SET revoked_at=coalesce(revoked_at,%s) WHERE tenant_id=%s AND stay_id=%s',(now,tenant,stay))
            conn.execute('UPDATE prsystem.guest_session SET revoked_at=coalesce(revoked_at,%s) WHERE tenant_id=%s AND stay_id=%s',(now,tenant,stay))
            package=conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            cleaning_source=action=None
            if package>=25000:
                cleaning_source,action=secrets.token_hex(16),secrets.token_hex(16)
                conn.execute('''INSERT INTO prsystem.cleaning_source
                    (tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                    VALUES (%s,%s,%s,%s,%s,'CHECKOUT',%s,%s)''',
                    (tenant,cleaning_source,source[0],source[0],room[0]+1,'checkout:'+stay,
                     Jsonb(dict(stay_id=stay,minibar_mode=room[2],category_id=room[3],room_revision=room[0]+1,actual_checkout_at=now.isoformat(),cleaning_buffer_minutes=source[2]))))
                conn.execute("INSERT INTO prsystem.cleaning_action (tenant_id,source_id,id,kind,quantity) VALUES (%s,%s,%s,'CLEAN',1)",(tenant,cleaning_source,action))
                if room[2]=='MOCK_ON':
                    report=conn.execute('SELECT items FROM prsystem.reception_minibar_report WHERE tenant_id=%s AND stay_id=%s ORDER BY revision DESC LIMIT 1',(tenant,stay)).fetchone()
                    for item in report[0]:
                        if item['used_quantity']:conn.execute("INSERT INTO prsystem.cleaning_action(tenant_id,source_id,id,kind,product_id,quantity) VALUES(%s,%s,%s,'REFILL',%s,%s)",(tenant,cleaning_source,secrets.token_hex(16),'mock:'+source[0]+':'+item['product_id'],item['used_quantity']))
                conn.execute('INSERT INTO prsystem.room_cleaning_request (tenant_id,source_id,room_id) VALUES (%s,%s,%s)',(tenant,cleaning_source,source[0]))
            balance=self.save(conn,tenant,stay,before,before,actor,'STAY_CHECKED_OUT',stay,dict(room_id=source[0],cleaning_source_id=cleaning_source),now)
            conn.execute('INSERT INTO prsystem.stay_checkout VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,365,%s)',
                         (tenant,stay,actor,shift[0],source[0],now,balance['revision'],Jsonb(balance),cleaning_source,'MVP-365-v1',now+timedelta(days=365)))
            result=dict(stay_id=stay,state='CLOSED',actual_checkout_at=now.isoformat(),planned_checkout_at=source[1].isoformat(),
                        earliest_ready_at=(now+timedelta(minutes=source[2])).isoformat(),cleaning_state='DIRTY',room_revision=room[0]+1,
                        cleaning_source_id=cleaning_source,cleaning_action_id=action,finance_revision=balance['revision'])
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def claim_cleaning(self,bearer,tenant,stay,key):
        command=dict(action='CLAIM_CHECKOUT_CLEANING',stay_id=stay)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant)
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            actor=principal['account_id']
            self._cleaner(conn,tenant,actor,action=Action.CHECKOUT_REPORT,obligation=self.root(conn,tenant,stay))
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            checkout=conn.execute('SELECT room_id,cleaning_source_id FROM prsystem.stay_checkout WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone()
            if not checkout or not checkout[1]:raise DomainError('WORK_SOURCE_NOT_FOUND')
            room=conn.execute('SELECT status,cleaning_state FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,checkout[0])).fetchone()
            if not room or room[0] not in {'ACTIVE','RETIRING'} or room[1]!='DIRTY':raise DomainError('ROOM_NOT_READY')
            conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,checkout[1])).fetchone()
            if conn.execute('SELECT 1 FROM prsystem.cleaning_task WHERE tenant_id=%s AND source_id=%s',(tenant,checkout[1])).fetchone():raise DomainError('WORK_SOURCE_CONFLICT')
            task=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.cleaning_task (tenant_id,id,source_id,assignee_id) VALUES (%s,%s,%s,%s)',(tenant,task,checkout[1],actor))
            self.register_open_work(conn,tenant,actor,'CLEANING_TASK',task,checkout_stay=stay)
            action=conn.execute("SELECT id FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s AND kind='CLEAN'",(tenant,checkout[1])).fetchone()[0]
            result=dict(task_id=task,source_id=checkout[1],room_id=checkout[0],action_id=action,assignment_version=0)
            self.event(conn,tenant,actor,'CHECKOUT_CLEANING_CLAIMED',stay,result)
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def cleaning_queue(self,bearer,tenant,limit=50,after=''):
        if type(limit) is not int or not 1<=limit<=100:raise DomainError('INVALID_REQUEST')
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant)
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            actor=principal['account_id']
            expired=False
            try:self._cleaner(conn,tenant,actor)
            except DomainError as exc:
                if str(exc)!='SUBSCRIPTION_EXPIRED':raise
                expired=True
            rows=conn.execute("""SELECT c.stay_id,c.room_id,c.cleaning_source_id,t.id,t.assignment_version,a.id
                FROM prsystem.stay_checkout c JOIN prsystem.stay s ON (s.tenant_id,s.id)=(c.tenant_id,c.stay_id)
                JOIN prsystem.hotel_access h ON h.tenant_id=c.tenant_id
                JOIN prsystem.room_cleaning_request b ON (b.tenant_id,b.source_id)=(c.tenant_id,c.cleaning_source_id)
                JOIN prsystem.cleaning_action a ON (a.tenant_id,a.source_id)=(b.tenant_id,b.source_id) AND a.kind='CLEAN'
                LEFT JOIN prsystem.cleaning_task t ON (t.tenant_id,t.source_id)=(c.tenant_id,c.cleaning_source_id) AND t.state='OPEN'
                WHERE c.tenant_id=%s AND c.stay_id>%s AND b.state='OPEN' AND (t.id IS NULL OR t.assignee_id=%s)
                AND (NOT %s OR s.check_in_recorded_at<h.expires_at+interval '48 hours')
                ORDER BY c.stay_id LIMIT %s""",(tenant,after,actor,expired,limit)).fetchall()
            return [dict(zip(('stay_id','room_id','source_id','task_id','assignment_version','action_id'),r)) for r in rows]

    def manager_clean(self,bearer,tenant,stay,revision,key):
        command=dict(action='MANAGER_CHECKOUT_CLEAN',stay_id=stay,room_revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=True,action=Action.CHECKOUT_REPORT)
            if conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]!=20000:
                raise DomainError('FORBIDDEN')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            checkout=conn.execute('SELECT room_id,cleaning_source_id FROM prsystem.stay_checkout WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone()
            if not checkout or checkout[1] is not None:raise DomainError('WORK_SOURCE_NOT_FOUND')
            room=conn.execute('SELECT revision,status,cleaning_state,minibar_mode FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,checkout[0])).fetchone()
            if type(revision) is not int or room[0]!=revision:raise DomainError('REVISION_CONFLICT')
            latest=conn.execute('SELECT id,state FROM prsystem.stay WHERE tenant_id=%s AND room_id=%s ORDER BY check_in_recorded_at DESC,id DESC LIMIT 1',(tenant,checkout[0])).fetchone()
            if latest!=(stay,'CLOSED') or room[1] not in {'ACTIVE','RETIRING'} or room[2:]!=('DIRTY','OFF'):
                raise DomainError('WORK_SOURCE_CONFLICT')
            if conn.execute("SELECT 1 FROM prsystem.room_cleaning_request WHERE tenant_id=%s AND room_id=%s AND state='OPEN'",(tenant,checkout[0])).fetchone():raise DomainError('WORK_SOURCE_CONFLICT')
            conn.execute("UPDATE prsystem.room SET cleaning_state='CLEAN',revision=revision+1 WHERE tenant_id=%s AND id=%s",(tenant,checkout[0]))
            from prsystem.room_lifecycle import RoomLifecycle
            RoomLifecycle.sweep(conn,tenant)
            result=dict(stay_id=stay,room_id=checkout[0],cleaning_state='CLEAN',room_revision=revision+1)
            self.event(conn,tenant,actor,'MANAGER_CHECKOUT_CLEANED',stay,result)
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result
