"""Immutable source-bound cleaning continuation and physical stock transfers.

Source registration is an internal adapter, never an HTTP authority payload.
Account locks -> source lock -> task/work -> stock is the common lock order.
"""
import secrets
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.common import DomainError, money
from prsystem.membership import MembershipService
from prsystem.postgres.connection import transaction
from prsystem.subscription import AccessFacts, Action, subscription_gate


class CleaningService(MembershipService):
    @staticmethod
    def event(conn, tenant, actor, kind, source, details):
        conn.execute("""INSERT INTO prsystem.operational_event
            (id, tenant_id, actor_id, kind, source_id, details) VALUES (%s,%s,%s,%s,%s,%s)""",
            (secrets.token_hex(16), tenant, actor, kind, source, Jsonb(details)))

    def _actors(self, conn, bearer, tenant, target=None):
        row = conn.execute('SELECT account_id FROM prsystem.staff_session WHERE token_hash=%s', (digest(bearer),)).fetchone()
        if not row:
            raise DomainError('UNAUTHENTICATED')
        self._lock_accounts(conn, {row[0], target} - {None})

    @staticmethod
    def _cleaner(conn, tenant, target, *, action=Action.CONFIGURE, obligation=None):
        row = conn.execute("""SELECT m.status,m.roles,a.status,a.verified_at,h.package_mnt,h.expires_at,h.security_suspended
            FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
            JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
            WHERE m.tenant_id=%s AND m.account_id=%s FOR SHARE OF m,h""", (tenant,target)).fetchone()
        if not row or row[0] != 'ACTIVE' or row[2] != 'ACTIVE' or row[3] is None:
            raise DomainError('ACCOUNT_NOT_ACTIVE_VERIFIED')
        decision = subscription_gate(action, AccessFacts(tenant,True,True,True,
            'CLEANER' in row[1],row[4]>=25000,True,True,row[6]),row[5],conn.execute('SELECT clock_timestamp()').fetchone()[0],obligation)
        if not decision.allowed:
            raise DomainError(decision.code)

    def task_cleaner(self,conn,tenant,actor,task):
        source=conn.execute('''SELECT s.source_kind,s.source_reference,s.id FROM prsystem.cleaning_source s
            JOIN prsystem.cleaning_task t ON (t.tenant_id,t.source_id)=(s.tenant_id,s.id)
            WHERE t.tenant_id=%s AND t.id=%s''',(tenant,task)).fetchone()
        if source and source[0]=='CHECKOUT' and source[1].startswith('checkout:'):
            from prsystem.guest_finance import GuestFinance
            stay=source[1][9:]
            if not conn.execute('SELECT 1 FROM prsystem.stay_checkout WHERE tenant_id=%s AND stay_id=%s AND cleaning_source_id=%s',(tenant,stay,source[2])).fetchone():raise DomainError('WORK_SOURCE_NOT_FOUND')
            self._cleaner(conn,tenant,actor,action=Action.CHECKOUT_REPORT,obligation=GuestFinance.root(conn,tenant,stay))
        else:self._cleaner(conn,tenant,actor)

    @classmethod
    def assign_source(cls, conn, tenant, source, assignee):
        """Called by a validated room/request transaction after source + actions exist.

        Source writer must atomically pin the exact room/config/version, allowed
        quantities, product lifecycle and original references. Unknown sources
        and empty plans fail closed; no request can invent remaining work.
        """
        cls._lock_accounts(conn, {assignee})
        cls._cleaner(conn, tenant, assignee)
        row = conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant,source)).fetchone()
        if not row or not conn.execute('SELECT 1 FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s', (tenant,source)).fetchone():
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        if conn.execute('SELECT 1 FROM prsystem.cleaning_task WHERE tenant_id=%s AND source_id=%s', (tenant,source)).fetchone():
            raise DomainError('WORK_SOURCE_CONFLICT')
        task = secrets.token_hex(16)
        conn.execute('INSERT INTO prsystem.cleaning_task (tenant_id,id,source_id,assignee_id) VALUES (%s,%s,%s,%s)', (tenant,task,source,assignee))
        cls.register_open_work(conn, tenant, assignee, 'CLEANING_TASK', task)
        return task

    def reassign(self, bearer, tenant, exception, revision, replacement, key, reason):
        if not isinstance(reason,str) or not reason.strip() or len(reason)>1000:
            raise DomainError('INVALID_REASON')
        command = dict(action='REASSIGN_CLEANING',exception=exception,revision=revision,replacement=replacement,reason=reason)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant,replacement)
            actor = self._queue_actor(conn,bearer,tenant)
            self._cleaner(conn,tenant,replacement)
            replay = self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            snapshot = conn.execute("""SELECT t.source_id FROM prsystem.staff_work_exception e
                JOIN prsystem.staff_open_work w ON (w.tenant_id,w.id)=(e.tenant_id,e.work_id)
                JOIN prsystem.cleaning_task t ON (t.tenant_id,t.id)=(w.tenant_id,w.source_id)
                WHERE e.tenant_id=%s AND e.id=%s AND w.kind='CLEANING_TASK'""", (tenant,exception)).fetchone()
            if not snapshot: raise DomainError('WORK_SOURCE_NOT_FOUND')
            conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant,snapshot[0])).fetchone()
            row = conn.execute("""SELECT e.claimant_id,e.revision,w.id,t.id,t.assignee_id,t.assignment_version,t.started_at,t.source_id
                FROM prsystem.staff_work_exception e JOIN prsystem.staff_open_work w ON (w.tenant_id,w.id)=(e.tenant_id,e.work_id)
                JOIN prsystem.cleaning_task t ON (t.tenant_id,t.id)=(w.tenant_id,w.source_id)
                WHERE e.tenant_id=%s AND e.id=%s AND w.kind='CLEANING_TASK' AND w.state='BLOCKED' AND t.state='OPEN'
                FOR UPDATE OF e,w,t""", (tenant,exception)).fetchone()
            if not row: raise DomainError('EXCEPTION_NOT_FOUND')
            if type(revision) is not int or row[1]!=revision: raise DomainError('REVISION_CONFLICT')
            if row[0]!=actor: raise DomainError('EXCEPTION_NOT_CLAIMED')
            if replacement==row[4]: raise DomainError('REPLACEMENT_REQUIRED')
            progressed = row[6] is not None or conn.execute('SELECT 1 FROM prsystem.cleaning_posting WHERE tenant_id=%s AND task_id=%s', (tenant,row[3])).fetchone()
            new_task, version, mode = row[3],row[5]+1,'REASSIGNED'
            if progressed:
                new_task,version,mode=secrets.token_hex(16),0,'CONTINUATION'
                conn.execute("UPDATE prsystem.cleaning_task SET state='CONTINUED' WHERE tenant_id=%s AND id=%s", (tenant,row[3]))
                conn.execute("UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=%s AND id=%s", (tenant,row[2]))
                conn.execute('INSERT INTO prsystem.cleaning_task (tenant_id,id,source_id,parent_id,assignee_id) VALUES (%s,%s,%s,%s,%s)',
                             (tenant,new_task,row[7],row[3],replacement))
                self.register_open_work(conn,tenant,replacement,'CLEANING_TASK',new_task)
            else:
                conn.execute('UPDATE prsystem.cleaning_task SET assignee_id=%s,assignment_version=%s WHERE tenant_id=%s AND id=%s', (replacement,version,tenant,new_task))
                conn.execute("UPDATE prsystem.staff_open_work SET owner_id=%s,assignment_version=%s,state='OPEN' WHERE tenant_id=%s AND id=%s", (replacement,version,tenant,row[2]))
                # Keep the resolved queue row. Future suspension reopens it via
                # membership.change's conflict-aware upsert, preserving events.
            conn.execute('UPDATE prsystem.staff_work_exception SET claimant_id=NULL,revision=revision+1 WHERE tenant_id=%s AND id=%s', (tenant,exception))
            result=dict(task_id=new_task,previous_task_id=row[3],source_id=row[7],assignment_version=version,mode=mode)
            self.event(conn,tenant,actor,'CLEANING_REASSIGNED',row[7],dict(result,previous_assignee=row[4],assignee=replacement,reason=reason,exception_id=exception))
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def post(self,bearer,tenant,task_id,revision,action_id,quantity,key,actual_count=None):
        money(quantity,positive=True)
        if actual_count is not None: money(actual_count)
        command=dict(action='POST_CLEANING',task=task_id,revision=revision,action_id=action_id,quantity=quantity,actual_count=actual_count)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant)
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            actor=principal['account_id']
            self.task_cleaner(conn,tenant,actor,task_id)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            source=conn.execute('SELECT source_id FROM prsystem.cleaning_task WHERE tenant_id=%s AND id=%s', (tenant,task_id)).fetchone()
            if not source: raise DomainError('WORK_SOURCE_NOT_FOUND')
            bridge=conn.execute('SELECT room_id,state FROM prsystem.room_cleaning_request WHERE tenant_id=%s AND source_id=%s',(tenant,source[0])).fetchone()
            if bridge:
                room=conn.execute('SELECT cleaning_state FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,bridge[0])).fetchone()
                if bridge[1]!='OPEN' or not room or room[0]!='CLEANING': raise DomainError('CLEANING_NOT_STARTED')
            source=conn.execute('SELECT id,room_id,configuration_id,configuration_version FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant,source[0])).fetchone()
            task=conn.execute("""SELECT t.assignee_id,t.assignment_version,t.state,w.state FROM prsystem.cleaning_task t
                JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
                WHERE t.tenant_id=%s AND t.id=%s FOR UPDATE OF t,w""", (tenant,task_id)).fetchone()
            if not task or task[0]!=actor: raise DomainError('FORBIDDEN')
            if type(revision) is not int or task[1]!=revision: raise DomainError('REVISION_CONFLICT')
            if task[2:]!=('OPEN','OPEN'): raise DomainError('WORK_NOT_OPEN')
            action=conn.execute('SELECT kind,product_id,quantity,completed FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s AND id=%s FOR UPDATE', (tenant,source[0],action_id)).fetchone()
            if not action or quantity>action[2]-action[3]: raise DomainError('REMAINING_ACTION_EXCEEDED')
            if (action[0]=='COUNT') != (actual_count is not None): raise DomainError('INVALID_REQUEST')
            from_location=to_location=None
            if action[0] in {'REFILL','RETURN'}:
                room='room:'+source[1]
                from_location,to_location=('warehouse',room) if action[0]=='REFILL' else (room,'warehouse')
                rows=conn.execute('SELECT location_id,quantity FROM prsystem.cleaning_stock WHERE tenant_id=%s AND product_id=%s AND location_id=ANY(%s) ORDER BY location_id FOR UPDATE', (tenant,action[1],[from_location,to_location])).fetchall()
                stock=dict(rows)
                if len(stock)!=2: raise DomainError('STOCK_SOURCE_NOT_FOUND')
                if stock[from_location]<quantity: raise DomainError('INSUFFICIENT_STOCK')
                money(stock[to_location]+quantity)
                conn.execute('UPDATE prsystem.cleaning_stock SET quantity=quantity-%s WHERE tenant_id=%s AND product_id=%s AND location_id=%s', (quantity,tenant,action[1],from_location))
                conn.execute('UPDATE prsystem.cleaning_stock SET quantity=quantity+%s WHERE tenant_id=%s AND product_id=%s AND location_id=%s', (quantity,tenant,action[1],to_location))
            posting=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.cleaning_posting
                (id,tenant_id,task_id,source_id,action_id,assignment_version,actor_id,quantity,actual_count,from_location,to_location)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (posting,tenant,task_id,source[0],action_id,revision,actor,quantity,actual_count,from_location,to_location))
            conn.execute('UPDATE prsystem.cleaning_action SET completed=completed+%s WHERE tenant_id=%s AND source_id=%s AND id=%s', (quantity,tenant,source[0],action_id))
            done=not conn.execute('SELECT 1 FROM prsystem.cleaning_action WHERE tenant_id=%s AND source_id=%s AND completed<quantity', (tenant,source[0])).fetchone()
            conn.execute("UPDATE prsystem.cleaning_task SET started_at=coalesce(started_at,clock_timestamp()),state=%s WHERE tenant_id=%s AND id=%s", ('DONE' if done else 'OPEN',tenant,task_id))
            if done: conn.execute("UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=%s AND kind='CLEANING_TASK' AND source_id=%s", (tenant,task_id))
            if done and bridge:
                conn.execute("UPDATE prsystem.room_cleaning_request SET state='DONE' WHERE tenant_id=%s AND source_id=%s",(tenant,source[0]))
                conn.execute("UPDATE prsystem.room SET cleaning_state='CLEAN',revision=revision+1 WHERE tenant_id=%s AND id=%s",(tenant,bridge[0]))
            result=dict(posting_id=posting,task_id=task_id,source_id=source[0],state='DONE' if done else 'OPEN',remaining=action[2]-action[3]-quantity)
            self.event(conn,tenant,actor,'CLEANING_POSTED',source[0],dict(result,room_id=source[1],configuration_id=source[2],configuration_version=source[3],action_id=action_id))
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result
