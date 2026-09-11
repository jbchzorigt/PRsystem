"""Assigned counts and full-plan atomic transfers/apply; no partial stock posts.

Variance requires a current Manager decision; its adjustment posts atomically
with completion. Shortages block completion. Legacy mock stock stays separate.
"""
import secrets
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.common import DomainError
from prsystem.minibar_configuration import MinibarConfiguration
from prsystem.minibar_adjustments import MinibarAdjustments
from prsystem.postgres.connection import transaction
from prsystem.room_lifecycle import RoomLifecycle


class MinibarReconciliation(MinibarConfiguration):
    @staticmethod
    def close_tasks(conn,tenant,request):
        tasks=conn.execute("""SELECT t.id FROM prsystem.minibar_reconciliation e JOIN prsystem.cleaning_task t
            ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id) WHERE e.tenant_id=%s AND e.request_id=%s AND t.state='OPEN' FOR UPDATE OF t""",(tenant,request)).fetchall()
        for (task,) in tasks:
            conn.execute("UPDATE prsystem.cleaning_task SET state='DONE' WHERE tenant_id=%s AND id=%s",(tenant,task))
            conn.execute("UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=%s AND source_id=%s AND kind='CLEANING_TASK'",(tenant,task))

    def lock_request(self,conn,tenant,request,revision=None):
        before=self.request_data(conn,tenant,request)
        self._catalog_lock(conn,tenant)
        room=conn.execute('SELECT minibar_mode,status FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,before['room_id'])).fetchone()
        conn.execute('SELECT id FROM prsystem.minibar_configuration_request WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,request)).fetchone()
        data=self.request_data(conn,tenant,request)
        if revision is not None and data['revision']!=revision:raise DomainError('REVISION_CONFLICT')
        if data['state'] in {'CANCELLED','APPLIED'}:raise DomainError('CONFIGURATION_TERMINAL')
        if room[0]=='MOCK_ON':raise DomainError('MOCK_INVENTORY_NOT_SUPPORTED')
        if room[1]=='INACTIVE':raise DomainError('ROOM_NOT_READY')
        return data

    @staticmethod
    def safe(conn,tenant,request,source=None):
        if not conn.execute('SELECT prsystem.minibar_safe_room(%s,%s,%s)',(tenant,request['room_id'],source)).fetchone()[0]:
            raise DomainError('RECONCILIATION_NOT_READY')

    def target(self,conn,tenant,request):
        if request['target_mode']=='ON':
            row=conn.execute('''SELECT r.status,c.status FROM prsystem.room r JOIN prsystem.room_category c
                ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id) WHERE r.tenant_id=%s AND r.id=%s''',(tenant,request['room_id'])).fetchone()
            if row!=('ACTIVE','ACTIVE'):raise DomainError('ROOM_NOT_READY')
            template=self.template(conn,tenant,request['target_template_id'])
            if template['status']!='ACTIVE':raise DomainError('TEMPLATE_NOT_ACTIVE')
            if self.version(conn,tenant,request['target_template_id'],request['target_version_id'])['state']!='PUBLISHED':raise DomainError('TEMPLATE_NOT_PUBLISHED')
            self.validate_items(conn,tenant,request['target_snapshot']['items'])

    @staticmethod
    def execution(conn,tenant,request):
        return conn.execute('SELECT source_id,baseline FROM prsystem.minibar_reconciliation WHERE tenant_id=%s AND request_id=%s',(tenant,request)).fetchone()

    def prepare(self,bearer,tenant,request,revision,assignee,key):
        command=dict(action='PREPARE_MINIBAR_RECONCILIATION',request_id=request,revision=revision,assignee_id=assignee)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant,assignee)
            actor,roles,package=self.actor(conn,bearer,tenant)
            self._cleaner(conn,tenant,assignee)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            data=self.lock_request(conn,tenant,request,revision)
            execution=self.execution(conn,tenant,request)
            if execution and data['request_kind'] not in('ROLLOUT','NEXT_STAY'):
                raise DomainError('WORK_SOURCE_CONFLICT')
            # The pre-created rollout count is this request's work, not a
            # preceding dependency. Keep every other source in the safe gate.
            self.safe(conn,tenant,data,execution[0] if execution else None)
            self.target(conn,tenant,data)
            if execution:
                source,baseline=execution
            else:
                source=secrets.token_hex(16)
                baseline=conn.execute('SELECT prsystem.minibar_configuration_baseline(%s,%s)',(tenant,request)).fetchone()[0]
                if not baseline:raise DomainError('RECONCILIATION_NOT_READY')
                conn.execute('''INSERT INTO prsystem.cleaning_source(tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                    VALUES(%s,%s,%s,%s,%s,'CONFIGURATION',%s,%s)''',(tenant,source,data['room_id'],request,data['revision'],'canonical-config:'+request,Jsonb(dict(canonical_minibar=True,request_id=request,target=data['target_snapshot'],baseline=baseline))))
                conn.execute('INSERT INTO prsystem.minibar_reconciliation(tenant_id,request_id,source_id,baseline,created_by) VALUES(%s,%s,%s,%s,%s)',(tenant,request,source,Jsonb(baseline),actor))
                for item in baseline:
                    conn.execute("INSERT INTO prsystem.cleaning_action(tenant_id,source_id,id,kind,product_id,quantity) VALUES(%s,%s,%s,'COUNT',%s,1)",(tenant,source,secrets.token_hex(16),item['product_id']))
            task=self.assign_source(conn,tenant,source,assignee)
            conn.execute("UPDATE prsystem.minibar_configuration_request SET state='IN_PROGRESS',revision=revision+1 WHERE tenant_id=%s AND id=%s",(tenant,request))
            result=dict(request_id=request,task_id=task,source_id=source,assignment_version=0,revision=revision+1,state='IN_PROGRESS')
            self.event(conn,tenant,actor,'MINIBAR_RECONCILIATION_PREPARED',request,dict(result,baseline=baseline,actor_roles=roles,package_mnt=package))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def task_actor(self,conn,bearer,tenant,task,assignment=None):
        self._actors(conn,bearer,tenant)
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        actor=principal['account_id'];self._cleaner(conn,tenant,actor)
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        row=conn.execute('''SELECT e.request_id,e.source_id,t.assignment_version,t.state,w.state,t.assignee_id
            FROM prsystem.minibar_reconciliation e JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id)
            JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
            WHERE t.tenant_id=%s AND t.id=%s''',(tenant,task)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        if row[5]!=actor:raise DomainError('FORBIDDEN')
        if assignment is not None and row[2]!=assignment:raise DomainError('REVISION_CONFLICT')
        return actor,row

    @staticmethod
    def task_lock(conn,tenant,task,source):
        conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,source)).fetchone()
        row=conn.execute("""SELECT t.state,w.state FROM prsystem.cleaning_task t JOIN prsystem.staff_open_work w
            ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK' WHERE t.tenant_id=%s AND t.id=%s FOR UPDATE OF t,w""",(tenant,task)).fetchone()
        if row!=('OPEN','OPEN'):raise DomainError('WORK_NOT_OPEN')

    def plan(self,conn,tenant,data):
        execution=self.execution(conn,tenant,data['request_id'])
        if not execution:return None
        source,baseline=execution
        targets={i['product_id']:i['target_quantity'] for i in data['target_snapshot']['items']}
        lines=[]
        for item in baseline:
            product=item['product_id'];current=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s,%s)',(tenant,product,data['room_id'])).fetchone()[0]
            stock=self.stock(conn,tenant,product)
            warehouse=stock[1]-conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s)',(tenant,product)).fetchone()[0]
            count=conn.execute('''SELECT a.id,p.actual_count,p.id FROM prsystem.cleaning_action a LEFT JOIN prsystem.cleaning_posting p
                ON(p.tenant_id,p.source_id,p.action_id)=(a.tenant_id,a.source_id,a.id) WHERE a.tenant_id=%s AND a.source_id=%s AND a.product_id=%s''',(tenant,source,product)).fetchone()
            decision=self.count_resolution(conn,tenant,data['request_id'],product)
            valid=decision and decision['ready'];posted=decision and decision['posted']
            natural=count[1] is not None and count[1]==item['quantity']==current
            matched=bool(natural or valid or posted)
            planned=count[1] if valid else current
            target=targets.get(product,0);delta=target-planned
            lines.append(dict(item,baseline_quantity=item['quantity'],current_quantity=current,target_quantity=target,warehouse_quantity=warehouse,
                action_id=count[0],actual_count=count[1],posting_id=count[2],stock_revision=stock[0],zero_stock=stock[1]==0,
                count_matches=matched,resolution={k:v for k,v in decision.items() if k not in {'unit_cost_mnt'}} if decision else None,
                direction='REFILL' if delta>0 else 'RETURN' if delta<0 else None,quantity=abs(delta),shortage=max(0,delta-warehouse)))
        return dict(source_id=source,lines=lines,
            counts_complete=all(i['actual_count'] is not None for i in lines),
            counts_match=all(i['count_matches'] for i in lines),shortage=any(i['shortage'] for i in lines))

    @staticmethod
    def count_resolution(conn,tenant,request,product):
        row=conn.execute('''SELECT v.id,v.kind,v.reason,v.actor_id,v.actor_label,v.recorded_at,v.unit_cost_mnt,
            prsystem.minibar_count_resolution_ready(v.tenant_id,v.id),
            EXISTS(SELECT 1 FROM prsystem.minibar_count_resolution_posting x WHERE x.tenant_id=v.tenant_id AND x.resolution_id=v.id)
            FROM prsystem.minibar_count_resolution v WHERE v.tenant_id=%s AND v.request_id=%s AND v.product_id=%s
            ORDER BY v.request_revision DESC LIMIT 1''',(tenant,request,product)).fetchone()
        return dict(zip(('resolution_id','kind','reason','actor_id','actor_label','recorded_at','unit_cost_mnt','ready','posted'),row)) if row else None

    def resolve_count(self,bearer,tenant,request,product,data,key):
        data=dict(data,reason=self._text(data['reason'],1000))
        command=dict(action='RESOLVE_MINIBAR_COUNT',request_id=request,product_id=product,data=data)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);actor,roles,package=self.actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            req=self.lock_request(conn,tenant,request,data['expected_revision'])
            execution=self.execution(conn,tenant,request)
            if not execution:raise DomainError('COUNT_REQUIRED')
            self.safe(conn,tenant,req,execution[0]);self.target(conn,tenant,req)
            plan=self.plan(conn,tenant,req)
            if not plan['counts_complete']:raise DomainError('COUNT_REQUIRED')
            line=next((i for i in plan['lines'] if i['product_id']==product),None)
            if not line:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if (line['stock_revision']!=data['expected_stock_revision'] or line['current_quantity']!=data['expected_physical_quantity']):raise DomainError('REVISION_CONFLICT')
            if line['count_matches']:raise DomainError('COUNT_VARIANCE_NOT_FOUND')
            delta=line['actual_count']-line['current_quantity']
            if not 0<=line['actual_count']<=1000000 or(data['kind']=='WASTE' and delta>=0):raise DomainError('INVALID_REQUEST')
            if (delta>0 and line['zero_stock'])!=(data.get('unit_cost_mnt') is not None):raise DomainError('INVALID_REQUEST')
            identity=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.minibar_count_resolution(tenant_id,id,request_id,source_id,product_id,room_id,posting_id,
                request_revision,stock_revision,baseline_quantity,physical_quantity,actual_count,kind,unit_cost_mnt,actor_id,actor_label,reason)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'',%s)''',
                (tenant,identity,request,execution[0],product,req['room_id'],line['posting_id'],req['revision'],line['stock_revision'],
                 line['baseline_quantity'],line['current_quantity'],line['actual_count'],data['kind'],data.get('unit_cost_mnt'),actor,data['reason']))
            plan=self.plan(conn,tenant,req)
            state='BLOCKED_VARIANCE' if not plan['counts_match'] else 'BLOCKED_STOCK' if plan['shortage'] else 'IN_PROGRESS'
            conn.execute('UPDATE prsystem.minibar_configuration_request SET state=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',(state,tenant,request))
            result=dict(resolution_id=identity,request_id=request,state=state,revision=req['revision']+1,product_id=product,quantity_delta=delta)
            self.event(conn,tenant,actor,'MINIBAR_COUNT_RESOLVED',request,dict(result,reason=data['reason'],kind=data['kind'],actor_roles=roles,package_mnt=package))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def lock_count_actors(self,conn,bearer,tenant,task):
        principal=conn.execute('SELECT account_id FROM prsystem.staff_session WHERE token_hash=%s',(digest(bearer),)).fetchone()
        if not principal:raise DomainError('UNAUTHENTICATED')
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        rows=conn.execute('''SELECT DISTINCT ON(v.product_id) v.actor_id FROM prsystem.minibar_count_resolution v
            JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(v.tenant_id,v.source_id)
            WHERE v.tenant_id=%s AND t.id=%s ORDER BY v.product_id,v.request_revision DESC''',(tenant,task)).fetchall()
        actors={principal[0],*(r[0] for r in rows)}
        self._lock_accounts(conn,actors)
        conn.execute('SELECT account_id FROM prsystem.staff_membership WHERE tenant_id=%s AND account_id=ANY(%s) ORDER BY account_id FOR SHARE',(tenant,list(actors))).fetchall()
        return actors

    def post_count_resolutions(self,conn,tenant,data,plan,task,assignment,cleaner,locked_actors):
        changes=MinibarAdjustments(self.auth);results=[]
        for line in plan['lines']:
            decision=self.count_resolution(conn,tenant,data['request_id'],line['product_id'])
            if not decision or not decision['ready']:continue
            if decision['actor_id'] not in locked_actors:raise DomainError('REVISION_CONFLICT')
            before=changes.context(conn,tenant,line['product_id'],data['room_id'])
            if before['stay_id'] is not None:raise DomainError('RECONCILIATION_NOT_READY')
            delta=line['actual_count']-before['physical_quantity'];identity=secrets.token_hex(16) if delta else None
            conn.execute('''INSERT INTO prsystem.minibar_count_resolution_posting(tenant_id,resolution_id,request_id,product_id,adjustment_id,task_id,actor_id,assignment_version)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,decision['resolution_id'],data['request_id'],line['product_id'],identity,task,cleaner,assignment))
            if delta:
                roles,package=conn.execute('SELECT m.roles,h.package_mnt FROM prsystem.staff_membership m JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id WHERE m.tenant_id=%s AND m.account_id=%s',(tenant,decision['actor_id'])).fetchone()
                change=dict(kind='WASTE' if decision['kind']=='WASTE' else 'COUNT_PLUS' if delta>0 else 'COUNT_MINUS',quantity=abs(delta),reason=decision['reason'],unit_cost_mnt=decision['unit_cost_mnt'])
                changes.post(conn,tenant,line['product_id'],change,before,decision['actor_id'],roles,package,identity=identity)
            results.append(dict(resolution_id=decision['resolution_id'],adjustment_id=identity))
        return results

    def count(self,bearer,tenant,task,assignment,action,actual,key):
        command=dict(action='COUNT_MINIBAR_CONFIGURATION',task_id=task,assignment=assignment,action_id=action,actual=actual)
        with transaction(self.auth.dsn) as conn:
            actor,taskrow=self.task_actor(conn,bearer,tenant,task,assignment)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            data=self.lock_request(conn,tenant,taskrow[0]);self.task_lock(conn,tenant,task,taskrow[1]);self.safe(conn,tenant,data,taskrow[1])
            row=conn.execute("SELECT product_id,completed FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s AND id=%s AND kind='COUNT' FOR UPDATE",(tenant,taskrow[1],action)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[1]:raise DomainError('REMAINING_ACTION_EXCEEDED')
            conn.execute('''INSERT INTO prsystem.cleaning_posting(id,tenant_id,task_id,source_id,action_id,assignment_version,actor_id,quantity,actual_count)
                VALUES(%s,%s,%s,%s,%s,%s,%s,1,%s)''',(secrets.token_hex(16),tenant,task,taskrow[1],action,assignment,actor,actual))
            conn.execute('UPDATE prsystem.cleaning_action SET completed=1 WHERE tenant_id=%s AND source_id=%s AND id=%s',(tenant,taskrow[1],action))
            conn.execute('UPDATE prsystem.cleaning_task SET started_at=coalesce(started_at,clock_timestamp()) WHERE tenant_id=%s AND id=%s',(tenant,task))
            plan=self.plan(conn,tenant,data)
            state='BLOCKED_VARIANCE' if plan['counts_complete'] and not plan['counts_match'] else 'BLOCKED_STOCK' if plan['counts_complete'] and plan['shortage'] else 'IN_PROGRESS'
            conn.execute('UPDATE prsystem.minibar_configuration_request SET state=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',(state,tenant,data['request_id']))
            result=dict(request_id=data['request_id'],state=state,revision=data['revision']+1)
            self.event(conn,tenant,actor,'MINIBAR_CONFIGURATION_COUNTED',data['request_id'],dict(result,task_id=task,action_id=action,actual=actual))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def apply(self,bearer,tenant,task,assignment,revision,key):
        command=dict(action='APPLY_MINIBAR_CONFIGURATION',task_id=task,assignment=assignment,revision=revision)
        with transaction(self.auth.dsn) as conn:
            locked_actors=self.lock_count_actors(conn,bearer,tenant,task)
            actor,taskrow=self.task_actor(conn,bearer,tenant,task,assignment)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            data=self.lock_request(conn,tenant,taskrow[0],revision);self.task_lock(conn,tenant,task,taskrow[1])
            self.safe(conn,tenant,data,taskrow[1]);self.target(conn,tenant,data)
            plan=self.plan(conn,tenant,data)
            if not plan['counts_complete']:raise DomainError('COUNT_REQUIRED')
            if not plan['counts_match']:raise DomainError('COUNT_VARIANCE')
            if plan['shortage']:raise DomainError('INSUFFICIENT_STOCK')
            resolutions=self.post_count_resolutions(conn,tenant,data,plan,task,assignment,actor,locked_actors)
            movements=[]
            for line in plan['lines']:
                if not line['quantity']:continue
                stock=self.stock(conn,tenant,line['product_id']);move=secrets.token_hex(16)
                conn.execute('''INSERT INTO prsystem.minibar_transfer(tenant_id,id,request_id,source_id,task_id,product_id,room_id,actor_id,
                    direction,quantity,warehouse_after,room_after,cost_value,cost_quantity,cost_denominator) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (tenant,move,data['request_id'],taskrow[1],task,line['product_id'],data['room_id'],actor,line['direction'],line['quantity'],
                     line['warehouse_quantity']+(line['quantity'] if line['direction']=='RETURN' else -line['quantity']),line['target_quantity'],stock[2].numerator,stock[1],stock[2].denominator))
                movements.append(move)
            conn.execute('''INSERT INTO prsystem.minibar_configuration_application(tenant_id,request_id,room_id,source_id,task_id,actor_id,assignment_version)
                VALUES(%s,%s,%s,%s,%s,%s,%s)''',(tenant,data['request_id'],data['room_id'],taskrow[1],task,actor,assignment))
            RoomLifecycle.sweep(conn,tenant)
            result=dict(request_id=data['request_id'],state='APPLIED',revision=revision+1,movement_ids=movements,count_resolutions=resolutions)
            self.event(conn,tenant,actor,'MINIBAR_CONFIGURATION_APPLIED',data['request_id'],dict(result,task_id=task,room_id=data['room_id'],target=data['target_snapshot']))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def detail(self,bearer,tenant,request):
        with transaction(self.auth.dsn) as conn:
            self.reader(conn,bearer,tenant);self._catalog_lock(conn,tenant)
            data=self.request_data(conn,tenant,request)
            return dict(request=data,plan=self.plan(conn,tenant,data))

    def tasks(self,bearer,tenant,after='',limit=20):
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);principal,_=self.auth._authenticate(conn,bearer,tenant)
            self._cleaner(conn,tenant,principal['account_id']);conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            self._catalog_lock(conn,tenant)
            rows=conn.execute('''SELECT t.id,t.assignment_version,e.request_id,r.number,w.state,t.assignee_id IS NULL FROM prsystem.cleaning_task t
                JOIN prsystem.minibar_reconciliation e ON(e.tenant_id,e.source_id)=(t.tenant_id,t.source_id)
                JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
                JOIN prsystem.room r ON(r.tenant_id,r.id)=(q.tenant_id,q.room_id)
                LEFT JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
                WHERE t.tenant_id=%s AND(t.assignee_id=%s OR(t.assignee_id IS NULL AND q.request_kind='NEXT_STAY')) AND t.state='OPEN' AND t.id>%s ORDER BY t.id LIMIT %s''',(tenant,principal['account_id'],after,limit+1)).fetchall()
            items=[]
            for task,assignment,request,room,state,claimable in rows[:limit]:
                data=self.request_data(conn,tenant,request)
                items.append(dict(task_id=task,assignment_version=assignment,room_number=room,work_state=state,claimable=claimable,request=data,plan=self.plan(conn,tenant,data)))
            return dict(items=items,next_after=items[-1]['task_id'] if len(rows)>limit else None)

    def claim_next_stay(self,bearer,tenant,task,revision,key):
        command=dict(action='CLAIM_NEXT_STAY_MINIBAR',task_id=task,revision=revision)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);principal,_=self.auth._authenticate(conn,bearer,tenant)
            actor=principal['account_id'];self._cleaner(conn,tenant,actor)
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            source=conn.execute("""SELECT e.request_id,e.source_id,q.request_kind,t.assignee_id FROM prsystem.minibar_reconciliation e
                JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id)
                JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
                WHERE t.tenant_id=%s AND t.id=%s""",(tenant,task)).fetchone()
            if not source or source[2]!='NEXT_STAY':raise DomainError('WORK_SOURCE_NOT_FOUND')
            if source[3] is not None and source[3]!=actor:raise DomainError('FORBIDDEN')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            data=self.lock_request(conn,tenant,source[0],revision)
            self.safe(conn,tenant,data,source[1]);self.target(conn,tenant,data)
            claimed=self.assign_source(conn,tenant,source[1],actor)
            if claimed!=task:raise DomainError('WORK_SOURCE_CONFLICT')
            conn.execute("UPDATE prsystem.minibar_configuration_request SET state='IN_PROGRESS',revision=revision+1 WHERE tenant_id=%s AND id=%s",(tenant,source[0]))
            result=dict(task_id=task,source_id=source[1],request_id=source[0],assignment_version=0,revision=revision+1,state='IN_PROGRESS')
            self.event(conn,tenant,actor,'MINIBAR_NEXT_STAY_CLAIMED',source[0],result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result
