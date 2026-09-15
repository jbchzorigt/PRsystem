"""Incremental physical work on the original assigned, source-bound task.

Rollback restores the original room baseline using new warehouse transfers.
Reasoned waste/count corrections remain real inventory history; no fake stock
is created to cancel a request. Missing usable stock keeps the room blocked.
"""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.minibar_reconciliation import MinibarReconciliation
from prsystem.postgres.connection import transaction
from prsystem.room_lifecycle import RoomLifecycle


class MinibarPartial(MinibarReconciliation):
    def rollback_plan(self,conn,tenant,data):
        source,baseline=self.execution(conn,tenant,data['request_id'])
        lines=[]
        for item in baseline:
            product=item['product_id'];stock=self.stock(conn,tenant,product)
            current=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s,%s)',(tenant,product,data['room_id'])).fetchone()[0]
            warehouse=stock[1]-conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s)',(tenant,product)).fetchone()[0]
            delta=item['quantity']-current
            lines.append(dict(item,baseline_quantity=item['quantity'],current_quantity=current,target_quantity=item['quantity'],
                warehouse_quantity=warehouse,stock_revision=stock[0],direction='REFILL' if delta>0 else 'RETURN' if delta<0 else None,
                quantity=abs(delta),shortage=max(0,delta-warehouse),actual_count=None,count_matches=False))
        return dict(source_id=source,rollback=True,lines=lines,counts_complete=False,counts_match=False,
                    shortage=any(i['shortage'] for i in lines),ready_to_complete=all(not i['quantity'] for i in lines))

    def transfer(self,bearer,tenant,task,data,key,*,rollback=False):
        command=dict(action='ROLLBACK_MINIBAR_TRANSFER' if rollback else 'PARTIAL_MINIBAR_TRANSFER',task_id=task,data=data)
        with transaction(self.auth.dsn) as conn:
            locked=self.lock_count_actors(conn,bearer,tenant,task)
            actor,row=self.task_actor(conn,bearer,tenant,task,data['assignment_version'])
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            req=self.lock_request(conn,tenant,row[0],data['expected_revision'],rollback=rollback)
            self.task_lock(conn,tenant,task,row[1]);self.safe(conn,tenant,req,row[1])
            if not rollback:self.target(conn,tenant,req)
            plan=self.plan(conn,tenant,req)
            original_line=next((i for i in plan['lines'] if i['product_id']==data['product_id']),None)
            if not original_line:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if original_line['stock_revision']!=data['expected_stock_revision']:raise DomainError('REVISION_CONFLICT')
            if not rollback:
                if not plan['counts_complete']:raise DomainError('COUNT_REQUIRED')
                if not plan['counts_match']:raise DomainError('COUNT_VARIANCE')
                # Post approved count corrections with this actual movement.
                self.post_count_resolutions(conn,tenant,req,plan,task,data['assignment_version'],actor,locked)
                plan=self.plan(conn,tenant,req)
            line=next((i for i in plan['lines'] if i['product_id']==data['product_id']),None)
            if not line:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if rollback and data['actual_count']!=line['current_quantity']:raise DomainError('COUNT_VARIANCE')
            quantity=data['quantity']
            # Partial work always targets the pinned full version; shortage
            # approval is consumed only by the final application transaction.
            delta=line['target_quantity']-line['current_quantity']
            if not 0<quantity<=abs(delta):raise DomainError('REMAINING_ACTION_EXCEEDED')
            direction='REFILL' if delta>0 else 'RETURN'
            if direction=='REFILL' and quantity>line['warehouse_quantity']:raise DomainError('INSUFFICIENT_STOCK')
            step=secrets.token_hex(16);phase='ROLLBACK' if rollback else 'PARTIAL'
            conn.execute('''INSERT INTO prsystem.minibar_execution_step(tenant_id,id,request_id,task_id,actor_id,
                assignment_version,request_revision,kind,observed_counts) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,step,req['request_id'],task,actor,data['assignment_version'],req['revision'],phase,
                 Jsonb({data['product_id']:data['actual_count']} if rollback else {})))
            stock=self.stock(conn,tenant,data['product_id']);move=secrets.token_hex(16)
            room_after=line['current_quantity']+(quantity if direction=='REFILL' else -quantity)
            warehouse_after=line['warehouse_quantity']+(-quantity if direction=='REFILL' else quantity)
            conn.execute('''INSERT INTO prsystem.minibar_transfer(tenant_id,id,request_id,source_id,task_id,product_id,room_id,actor_id,
                direction,quantity,warehouse_after,room_after,cost_value,cost_quantity,cost_denominator,phase,execution_step_id)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,move,req['request_id'],row[1],task,data['product_id'],req['room_id'],actor,direction,quantity,
                 warehouse_after,room_after,stock[2].numerator,stock[1],stock[2].denominator,phase,step))
            state='ROLLBACK_REQUIRED' if rollback else 'IN_PROGRESS'
            conn.execute('UPDATE prsystem.minibar_configuration_request SET state=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',(state,tenant,req['request_id']))
            result=dict(request_id=req['request_id'],revision=req['revision']+1,state=state,movement_id=move,phase=phase,
                        direction=direction,quantity=quantity,room_after=room_after,warehouse_after=warehouse_after)
            self.event(conn,tenant,actor,'MINIBAR_'+phase+'_TRANSFER',req['request_id'],result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def complete(self,bearer,tenant,task,data,key):
        command=dict(action='COMPLETE_MINIBAR_ROLLBACK',task_id=task,data=data)
        with transaction(self.auth.dsn) as conn:
            actor,row=self.task_actor(conn,bearer,tenant,task,data['assignment_version'])
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            req=self.lock_request(conn,tenant,row[0],data['expected_revision'],rollback=True)
            self.task_lock(conn,tenant,task,row[1]);self.safe(conn,tenant,req,row[1])
            plan=self.rollback_plan(conn,tenant,req)
            expected={i['product_id']:i['baseline_quantity'] for i in plan['lines']}
            if data['observed_counts']!=expected or not plan['ready_to_complete']:raise DomainError('COUNT_VARIANCE')
            conn.execute('''INSERT INTO prsystem.minibar_execution_step(tenant_id,id,request_id,task_id,actor_id,
                assignment_version,request_revision,kind,observed_counts) VALUES(%s,%s,%s,%s,%s,%s,%s,'ROLLBACK_COMPLETE',%s)''',
                (tenant,secrets.token_hex(16),req['request_id'],task,actor,data['assignment_version'],req['revision'],Jsonb(data['observed_counts'])))
            conn.execute("UPDATE prsystem.minibar_configuration_request SET state='ROLLED_BACK',revision=revision+1 WHERE tenant_id=%s AND id=%s",(tenant,req['request_id']))
            self.close_tasks(conn,tenant,req['request_id'])
            conn.execute('UPDATE prsystem.room SET revision=revision+1 WHERE tenant_id=%s AND id=%s',(tenant,req['room_id']))
            RoomLifecycle.sweep(conn,tenant)
            result=dict(request_id=req['request_id'],state='ROLLED_BACK',revision=req['revision']+1)
            self.event(conn,tenant,actor,'MINIBAR_ROLLED_BACK',req['request_id'],dict(result,observed_counts=data['observed_counts']))
            self._save_receipt(conn,tenant,key,actor,command,result);return result
