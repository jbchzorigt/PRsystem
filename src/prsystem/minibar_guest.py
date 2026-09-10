"""Canonical stay inspection, assigned physical count and immutable consumption.

Prices come only from the stay. Cost is the exact weighted average at posting;
an unpaid correction reverses the preceding consumption at its original cost.
"""
import secrets
from fractions import Fraction
from psycopg.types.json import Jsonb
from prsystem.common import DomainError, money
from prsystem.minibar import MinibarWarehouse
from prsystem.minibar_reconciliation import MinibarReconciliation
from prsystem.reception_dependencies import ReceptionDependencies
from prsystem.shifts import ShiftService
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction


class MinibarGuest(ReceptionDependencies):
    @staticmethod
    def ensure_source(conn,tenant,stay,revision):
        existing=conn.execute('SELECT source_id FROM prsystem.minibar_guest_inspection WHERE tenant_id=%s AND stay_id=%s AND revision=%s',(tenant,stay,revision+1)).fetchone()
        if existing:return existing[0]
        room,snapshot=conn.execute('SELECT room_id,snapshot FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()
        book=snapshot.get('minibar_snapshot')
        if snapshot['minibar_mode']!='ON' or not book or book.get('mode')!='CANONICAL':raise DomainError('ROOM_NOT_READY')
        source=secrets.token_hex(16)
        conn.execute('''INSERT INTO prsystem.cleaning_source(tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
            VALUES(%s,%s,%s,%s,%s,'CHECKOUT',%s,%s)''',(tenant,source,room,book['application_id'],revision+1,'minibar-report:'+stay+':'+str(revision+1),Jsonb(dict(canonical_minibar=True,canonical_guest=True,stay_id=stay,price_book=book))))
        conn.execute('INSERT INTO prsystem.minibar_guest_inspection VALUES(%s,%s,%s,%s)',(tenant,stay,revision+1,source))
        for item in book['items']:
            conn.execute("INSERT INTO prsystem.cleaning_action(tenant_id,source_id,id,kind,product_id,quantity) VALUES(%s,%s,%s,'COUNT',%s,1)",(tenant,source,secrets.token_hex(16),item['product_id']))
        return source

    def cleaner_actor(self,conn,bearer,tenant,stay):
        self._actors(conn,bearer,tenant)
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        actor=principal['account_id']
        self._cleaner(conn,tenant,actor,action=Action.CHECKOUT_REPORT,obligation=self.root(conn,tenant,stay))
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        return actor,principal['roles']

    def lock_inspection(self,conn,tenant,stay,revision):
        ShiftService._book(conn,tenant);self._catalog_lock(conn,tenant)
        room=conn.execute('SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()
        if not room:raise DomainError('WORK_SOURCE_NOT_FOUND')
        conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,room[0])).fetchone()
        before=self.lock(conn,tenant,stay,active=True)
        row=conn.execute('SELECT state,revision FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s FOR UPDATE',(tenant,stay)).fetchone()
        if not row or row[0]!='REQUESTED':raise DomainError('WORK_NOT_OPEN')
        if row[1]!=revision:raise DomainError('REVISION_CONFLICT')
        self.report_unpaid(conn,tenant,stay)
        return room[0],before

    def claim(self,bearer,tenant,stay,revision,key):
        command=dict(action='CLAIM_MINIBAR_INSPECTION',stay_id=stay,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.cleaner_actor(conn,bearer,tenant,stay)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self.lock_inspection(conn,tenant,stay,revision)
            source=conn.execute('SELECT source_id FROM prsystem.minibar_guest_inspection WHERE tenant_id=%s AND stay_id=%s AND revision=%s',(tenant,stay,revision+1)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
            conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,source[0])).fetchone()
            if conn.execute('SELECT 1 FROM prsystem.cleaning_task WHERE tenant_id=%s AND source_id=%s',(tenant,source[0])).fetchone():raise DomainError('WORK_SOURCE_CONFLICT')
            task=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.cleaning_task(tenant_id,id,source_id,assignee_id) VALUES(%s,%s,%s,%s)',(tenant,task,source[0],actor))
            self.register_open_work(conn,tenant,actor,'CLEANING_TASK',task,inspection_stay=stay)
            result=dict(stay_id=stay,source_id=source[0],task_id=task,assignment_version=0,report_revision=revision)
            self.event(conn,tenant,actor,'MINIBAR_INSPECTION_CLAIMED',stay,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    @staticmethod
    def movement(conn,tenant,room,stay,revision,product,quantity,actor,roles,original=None):
        conn.execute('SELECT id FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,product)).fetchone()
        stock_revision,total,value=MinibarWarehouse.stock(conn,tenant,product)
        cost=Fraction(int(original[1]),int(original[2])) if original else value/total
        after=value+quantity*cost
        in_rooms=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s)',(tenant,product)).fetchone()[0]
        snapshot=conn.execute("SELECT jsonb_build_object('name',name,'category',category,'unit',unit,'selling_price_mnt',selling_price_mnt,'revision',revision) FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s",(tenant,product)).fetchone()[0]
        label=conn.execute("SELECT coalesce(nullif(display_name,''),email) FROM prsystem.staff_account WHERE id=%s",(actor,)).fetchone()[0]
        package=conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]
        identity=secrets.token_hex(16)
        conn.execute('''INSERT INTO prsystem.minibar_receipt(tenant_id,id,product_id,stock_revision,kind,quantity,unit_cost_mnt,warehouse_after,
            inventory_value_after,inventory_value_denominator,cost_numerator,cost_denominator,room_id,report_stay_id,report_revision,original_receipt_id,
            actor_id,actor_label,actor_roles,package_mnt,product_snapshot,reference)
            VALUES(%s,%s,%s,%s,%s,%s,0,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
            (tenant,identity,product,stock_revision+1,'CONSUMPTION_REVERSAL' if original else 'CONSUMPTION',quantity,total-in_rooms,
             after.numerator,after.denominator,cost.numerator,cost.denominator,room,stay,revision,original[0] if original else None,
             actor,label,roles,package,Jsonb(snapshot),'Stay minibar report '+str(revision)))
        return identity

    def report(self,bearer,tenant,stay,task,assignment,counts,no_consumption,revision,key):
        command=dict(action='CANONICAL_MINIBAR_REPORT',stay_id=stay,task_id=task,assignment_version=assignment,counts=counts,no_consumption=no_consumption,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor,roles=self.cleaner_actor(conn,bearer,tenant,stay)
            assigned=conn.execute('''SELECT t.assignee_id,t.assignment_version,e.source_id FROM prsystem.minibar_guest_inspection e
                JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id)
                WHERE e.tenant_id=%s AND e.stay_id=%s AND e.revision=%s AND t.id=%s''',(tenant,stay,revision+1,task)).fetchone()
            if not assigned:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if assigned[0]!=actor:raise DomainError('FORBIDDEN')
            if assigned[1]!=assignment:raise DomainError('REVISION_CONFLICT')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            room,before=self.lock_inspection(conn,tenant,stay,revision)
            MinibarReconciliation.task_lock(conn,tenant,task,assigned[2])
            book=conn.execute("SELECT snapshot->'minibar_snapshot' FROM prsystem.stay WHERE tenant_id=%s AND id=%s",(tenant,stay)).fetchone()[0]
            if not book or book.get('mode')!='CANONICAL':raise DomainError('MINIBAR_REPORT_REQUIRED')
            if set(counts)!={i['product_id'] for i in book['items']}:raise DomainError('INVALID_REQUEST')
            lines=[];total=0
            for item in book['items']:
                availability=conn.execute('SELECT prsystem.minibar_stay_availability(%s,%s,%s)',(tenant,stay,item['product_id'])).fetchone()[0]
                actual=counts[item['product_id']]
                if type(actual) is not int or not 0<=actual<=availability['available_quantity']:raise DomainError('INVALID_REQUEST')
                used=availability['available_quantity']-actual;amount=used*item['unit_price'];total+=amount;money(total)
                lines.append(dict(item,**availability,actual_count=actual,used_quantity=used,line_amount=amount))
            if no_consumption!=(total==0):raise DomainError('INVALID_REQUEST')
            movements=[]
            # Restore the complete old version before recomputing the new one.
            for product,identity,numerator,denominator,quantity in conn.execute("SELECT product_id,id,cost_numerator,cost_denominator,quantity FROM prsystem.minibar_receipt WHERE tenant_id=%s AND report_stay_id=%s AND report_revision=%s AND kind='CONSUMPTION' ORDER BY product_id",(tenant,stay,revision)).fetchall():
                movements.append(self.movement(conn,tenant,room,stay,revision+1,product,-quantity,actor,roles,(identity,numerator,denominator)))
            for line in lines:
                product=line['product_id']
                current=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s,%s)',(tenant,product,room)).fetchone()[0]
                if current!=line['available_quantity']:raise DomainError('COUNT_VARIANCE')
                if line['used_quantity']:movements.append(self.movement(conn,tenant,room,stay,revision+1,product,-line['used_quantity'],actor,roles))
                action=conn.execute("SELECT id FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s AND product_id=%s AND kind='COUNT'",(tenant,assigned[2],product)).fetchone()
                if not action:raise DomainError('WORK_SOURCE_NOT_FOUND')
                conn.execute('''INSERT INTO prsystem.cleaning_posting(id,tenant_id,task_id,source_id,action_id,assignment_version,actor_id,quantity,actual_count)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,1,%s)''',(secrets.token_hex(16),tenant,task,assigned[2],action[0],assignment,actor,line['actual_count']))
            self.credit_previous(conn,tenant,stay,actor,'Corrected canonical minibar report')
            charge=secrets.token_hex(16) if total else None;now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if charge:conn.execute("INSERT INTO prsystem.guest_charge(tenant_id,stay_id,id,kind,source_id,amount_mnt,recorded_at) VALUES(%s,%s,%s,'MINIBAR',%s,%s,%s)",(tenant,stay,charge,stay+':'+str(revision+1),total,now))
            conn.execute('INSERT INTO prsystem.reception_minibar_report(tenant_id,stay_id,revision,actor_id,items,amount_mnt,charge_id) VALUES(%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,revision+1,actor,Jsonb(lines),total,charge))
            conn.execute('''INSERT INTO prsystem.minibar_guest_report(tenant_id,stay_id,revision,source_id,task_id,assignment_version,actor_id,no_consumption)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,stay,revision+1,assigned[2],task,assignment,actor,no_consumption))
            balance=self.save(conn,tenant,stay,before,before,actor,'CANONICAL_MINIBAR_REPORTED',stay,dict(report_revision=revision+1,amount_mnt=total,charge_id=charge,movement_ids=movements,task_id=task),now)
            result=dict(stay_id=stay,report_revision=revision+1,charge_id=charge,amount_mnt=total,balance=balance,mode='CANONICAL',movement_ids=movements)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def queue(self,bearer,tenant,after='',limit=50):
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant)
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            if 'CLEANER' not in principal['roles']:raise DomainError('FORBIDDEN')
            package,suspended=conn.execute('SELECT package_mnt,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
            if suspended:raise DomainError('SECURITY_SUSPENDED')
            if package not in (25000,30000):raise DomainError('PACKAGE_REQUIRED')
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            rows=conn.execute('''SELECT e.stay_id,s.snapshot->>'room_number',i.revision,e.source_id,t.id,t.assignment_version,t.assignee_id,
                s.snapshot->'minibar_snapshot',w.state FROM prsystem.minibar_guest_inspection e JOIN prsystem.stay s ON(s.tenant_id,s.id)=(e.tenant_id,e.stay_id)
                JOIN prsystem.reception_minibar_inspection i ON(i.tenant_id,i.stay_id)=(e.tenant_id,e.stay_id)
                LEFT JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id) AND t.state='OPEN'
                LEFT JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
                WHERE e.tenant_id=%s AND e.stay_id>%s AND s.state='ACTIVE' AND i.state='REQUESTED' AND e.revision=i.revision+1
                AND(t.assignee_id IS NULL OR t.assignee_id=%s) ORDER BY e.stay_id LIMIT %s''',(tenant,after,principal['account_id'],limit+1)).fetchall()
            items=[]
            for r in rows[:limit]:
                try:self._cleaner(conn,tenant,principal['account_id'],action=Action.DETAIL,obligation=self.root(conn,tenant,r[0]))
                except DomainError as exc:
                    if str(exc) in {'SUBSCRIPTION_EXPIRED','SUBSCRIPTION_LOCKED'}:continue
                    raise
                entry=dict(zip(('stay_id','room_number','report_revision','source_id','task_id','assignment_version','assignee_id','price_book','work_state'),r))
                entry['availability']={i['product_id']:conn.execute('SELECT prsystem.minibar_stay_availability(%s,%s,%s)',(tenant,r[0],i['product_id'])).fetchone()[0] for i in entry['price_book']['items']}
                items.append(entry)
            return dict(items=items,next_after=rows[limit-1][0] if len(rows)>limit else None)
