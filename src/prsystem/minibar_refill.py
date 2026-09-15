"""Stay-owned physical refill. Request and task payloads never carry prices."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.minibar import MinibarWarehouse
from prsystem.minibar_guest import MinibarGuest
from prsystem.minibar_reconciliation import MinibarReconciliation
from prsystem.shifts import ShiftService
from prsystem.subscription import Action, AccessFacts, subscription_gate
from prsystem.postgres.connection import transaction


class MinibarRefill(MinibarGuest):
    def authority(self,conn,bearer,tenant,stay=None,*,cleaner=False,completion=False):
        self._actors(conn,bearer,tenant)
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        package,expiry,suspended=conn.execute('SELECT package_mnt,expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        allowed='CLEANER' in principal['roles'] if cleaner else ('RECEPTION' in principal['roles'] or self._manager(principal['roles'],package))
        action=Action.CHECKOUT_REPORT if completion else Action.CONFIGURE
        decision=subscription_gate(action,AccessFacts(tenant,True,True,True,allowed,package in(25000,30000),True,True,suspended),expiry,conn.execute('SELECT clock_timestamp()').fetchone()[0],self.root(conn,tenant,stay) if completion else None)
        if not decision.allowed:raise DomainError(decision.code)
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        return principal['account_id']

    def lock_stay(self,conn,tenant,stay):
        ShiftService._book(conn,tenant);self._catalog_lock(conn,tenant)
        row=conn.execute('SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        room=conn.execute('SELECT status FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,row[0])).fetchone()
        self.lock(conn,tenant,stay,active=True)
        book=conn.execute("SELECT snapshot->'minibar_snapshot' FROM prsystem.stay WHERE tenant_id=%s AND id=%s",(tenant,stay)).fetchone()[0]
        if not book or book.get('mode')!='CANONICAL' or room[0] not in('ACTIVE','RETIRING'):raise DomainError('ROOM_NOT_READY')
        if conn.execute('SELECT 1 FROM prsystem.reception_checkout_intent WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone():raise DomainError('MINIBAR_REFILL_LOCKED')
        return row[0],book

    @staticmethod
    def request_data(conn,tenant,request):
        row=conn.execute('''SELECT q.id,q.stay_id,q.room_id,q.product_id,q.source_id,q.requester_id,q.quantity,q.product_snapshot,
            q.recorded_at,coalesce(x.state,'PENDING'),x.quantity,x.reason,t.id,t.assignment_version,t.assignee_id,w.state
            FROM prsystem.minibar_refill_request q LEFT JOIN prsystem.minibar_refill_result x ON(x.tenant_id,x.request_id)=(q.tenant_id,q.id)
            LEFT JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(q.tenant_id,q.source_id) AND t.state='OPEN'
            LEFT JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
            WHERE q.tenant_id=%s AND q.id=%s''',(tenant,request)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        result=dict(zip(('request_id','stay_id','room_id','product_id','source_id','requester_id','requested_quantity','product','recorded_at','state','actual_quantity','reason','task_id','assignment_version','assignee_id','work_state'),row))
        result['recorded_at']=result['recorded_at'].isoformat();result['revision']=0 if result['state']=='PENDING' else 1
        return result

    def create(self,bearer,tenant,stay,product,quantity,key):
        if type(quantity) is not int or not 1<=quantity<=1000000:raise DomainError('INVALID_REQUEST')
        command=dict(action='REQUEST_STAY_REFILL',stay_id=stay,product_id=product,quantity=quantity)
        with transaction(self.auth.dsn) as conn:
            actor=self.authority(conn,bearer,tenant,stay)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            room,book=self.lock_stay(conn,tenant,stay)
            item=next((i for i in book['items'] if i['product_id']==product),None)
            state=conn.execute('SELECT status FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,product)).fetchone()
            if not item or not state or state[0]!='ACTIVE':raise DomainError('PRODUCT_NOT_ACTIVE')
            available=conn.execute('SELECT prsystem.minibar_stay_availability(%s,%s,%s)',(tenant,stay,product)).fetchone()[0]['available_quantity']
            if available+quantity>1000000:raise DomainError('INVALID_REQUEST')
            request=secrets.token_hex(16);source=secrets.token_hex(16)
            product_snapshot={k:item[k] for k in('product_id','name','unit')}
            snapshot=dict(canonical_minibar=True,canonical_refill=True,stay_id=stay,request_id=request,product=product_snapshot,quantity=quantity)
            conn.execute('''INSERT INTO prsystem.cleaning_source(tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                VALUES(%s,%s,%s,%s,1,'REFILL',%s,%s)''',(tenant,source,room,book['application_id'],'minibar-refill:'+request,Jsonb(snapshot)))
            conn.execute('''INSERT INTO prsystem.minibar_refill_request(tenant_id,id,stay_id,room_id,product_id,source_id,requester_id,quantity,product_snapshot)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,request,stay,room,product,source,actor,quantity,Jsonb(product_snapshot)))
            conn.execute("INSERT INTO prsystem.cleaning_action(tenant_id,source_id,id,kind,product_id,quantity) VALUES(%s,%s,%s,'REFILL',%s,%s)",(tenant,source,secrets.token_hex(16),product,quantity))
            result=self.request_data(conn,tenant,request)
            self.event(conn,tenant,actor,'MINIBAR_REFILL_REQUESTED',request,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def claim_refill(self,bearer,tenant,request,revision,key):
        command=dict(action='CLAIM_STAY_REFILL',request_id=request,revision=revision)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);self.auth._authenticate(conn,bearer,tenant)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            q=self.request_data(conn,tenant,request)
            actor=self.authority(conn,bearer,tenant,q['stay_id'],cleaner=True,completion=True)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self.lock_stay(conn,tenant,q['stay_id'])
            conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,q['source_id'])).fetchone()
            q=self.request_data(conn,tenant,request)
            if revision!=q['revision']:raise DomainError('REVISION_CONFLICT')
            if q['state']!='PENDING' or q['task_id']:raise DomainError('WORK_NOT_OPEN')
            task=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.cleaning_task(tenant_id,id,source_id,assignee_id) VALUES(%s,%s,%s,%s)',(tenant,task,q['source_id'],actor))
            self.register_open_work(conn,tenant,actor,'CLEANING_TASK',task,refill_stay=q['stay_id'])
            result=self.request_data(conn,tenant,request)
            self.event(conn,tenant,actor,'MINIBAR_REFILL_CLAIMED',request,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def resolve(self,bearer,tenant,request,state,quantity,reason,revision,key,task=None,assignment=None):
        if state not in('COMPLETED','CANCELLED','UNAVAILABLE'):raise DomainError('INVALID_REQUEST')
        if state=='COMPLETED':
            if type(quantity) is not int or not 1<=quantity<=1000000 or reason is not None:raise DomainError('INVALID_REQUEST')
        else:
            if quantity!=0:raise DomainError('INVALID_REQUEST')
            reason=self._text(reason,1000)
        command=dict(action='RESOLVE_STAY_REFILL',request_id=request,state=state,quantity=quantity,reason=reason,revision=revision,task_id=task,assignment_version=assignment)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);self.auth._authenticate(conn,bearer,tenant)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            q=self.request_data(conn,tenant,request)
            actor=self.authority(conn,bearer,tenant,q['stay_id'],cleaner=state!='CANCELLED',completion=True)
            if state!='CANCELLED':
                assigned=conn.execute('SELECT assignee_id,assignment_version FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s AND source_id=%s',(tenant,task,q['source_id'])).fetchone()
                if not assigned:raise DomainError('WORK_SOURCE_NOT_FOUND')
                if assigned[0]!=actor:raise DomainError('FORBIDDEN')
                if assigned[1]!=assignment:raise DomainError('REVISION_CONFLICT')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self.lock_stay(conn,tenant,q['stay_id'])
            conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,q['source_id'])).fetchone()
            q=self.request_data(conn,tenant,request)
            if q['revision']!=revision:raise DomainError('REVISION_CONFLICT')
            if q['state']!='PENDING':raise DomainError('WORK_NOT_OPEN')
            if state!='CANCELLED':MinibarReconciliation.task_lock(conn,tenant,task,q['source_id'])
            warehouse=room=numerator=denominator=total=None
            if state=='COMPLETED':
                if quantity>q['requested_quantity']:raise DomainError('INVALID_REQUEST')
                product=conn.execute('SELECT status,deactivation_requested_at FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,q['product_id'])).fetchone()
                from datetime import datetime
                if not(product[0]=='ACTIVE' or(product[0]=='RETIRING' and product[1] and datetime.fromisoformat(q['recorded_at'])<product[1])):raise DomainError('PRODUCT_NOT_ACTIVE')
                _,total,value=MinibarWarehouse.stock(conn,tenant,q['product_id'])
                in_rooms=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s)',(tenant,q['product_id'])).fetchone()[0]
                warehouse=total-in_rooms-quantity
                if warehouse<0:raise DomainError('INSUFFICIENT_STOCK')
                room=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s,%s)',(tenant,q['product_id'],q['room_id'])).fetchone()[0]+quantity
                if room>1000000:raise DomainError('INVALID_REQUEST')
                numerator,denominator=value.numerator,value.denominator
            conn.execute('''INSERT INTO prsystem.minibar_refill_result(tenant_id,request_id,state,actor_id,task_id,assignment_version,quantity,reason,
                warehouse_after,room_after,cost_value,cost_denominator,cost_quantity) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,request,state,actor,task,assignment,quantity,reason,warehouse,room,numerator,denominator,total))
            result=self.request_data(conn,tenant,request)
            self.event(conn,tenant,actor,'MINIBAR_REFILL_'+state,request,dict(result,task_id=task,assignment_version=assignment))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def list_refills(self,bearer,tenant,stay=None,after='',limit=50):
        with transaction(self.auth.dsn) as conn:
            if stay:
                self.authority(conn,bearer,tenant,stay,completion=True)
                ids=conn.execute('SELECT id FROM prsystem.minibar_refill_request WHERE tenant_id=%s AND stay_id=%s AND id>%s ORDER BY id LIMIT %s',(tenant,stay,after,limit+1)).fetchall()
            else:
                # Current Cleaner authority is checked for each source's completion root.
                self._actors(conn,bearer,tenant)
                principal,_=self.auth._authenticate(conn,bearer,tenant)
                if 'CLEANER' not in principal['roles']:raise DomainError('FORBIDDEN')
                package,suspended=conn.execute('SELECT package_mnt,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
                if suspended:raise DomainError('SECURITY_SUSPENDED')
                if package not in(25000,30000):raise DomainError('PACKAGE_REQUIRED')
                conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
                ids=conn.execute('''SELECT q.id FROM prsystem.minibar_refill_request q
                    LEFT JOIN prsystem.minibar_refill_result x ON(x.tenant_id,x.request_id)=(q.tenant_id,q.id)
                    LEFT JOIN prsystem.cleaning_task task ON(task.tenant_id,task.source_id)=(q.tenant_id,q.source_id) AND task.state='OPEN'
                    WHERE q.tenant_id=%s AND q.id>%s AND x.request_id IS NULL AND(task.assignee_id IS NULL OR task.assignee_id=%s)
                    ORDER BY q.id LIMIT %s''',(tenant,after,principal['account_id'],limit+1)).fetchall()
            items=[]
            for identity, in ids[:limit]:
                q=self.request_data(conn,tenant,identity)
                self.authority(conn,bearer,tenant,q['stay_id'],cleaner=stay is None,completion=True)
                q['room_number']=conn.execute('SELECT number FROM prsystem.room WHERE tenant_id=%s AND id=%s',(tenant,q['room_id'])).fetchone()[0]
                items.append(q)
            return dict(items=items,next_after=ids[limit-1][0] if len(ids)>limit else None)
