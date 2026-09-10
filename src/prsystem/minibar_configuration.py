"""Exact pinned configuration requests and pre-movement cancellation.

The reconciliation adapter owns counts and full-plan atomic transfers/apply.
Cancellation is available only before application; history remains immutable.
"""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.minibar_templates import MinibarTemplates
from prsystem.postgres.connection import transaction
from prsystem.subscription import AccessFacts, Action, subscription_gate


class MinibarConfiguration(MinibarTemplates):
    @staticmethod
    def pending(conn, tenant, room):
        return conn.execute("""SELECT source_id FROM prsystem.reception_dependency_blocker
            WHERE tenant_id=%s AND room_id=%s AND source_kind='MINIBAR_CONFIGURATION' AND state='OPEN'""",
            (tenant, room)).fetchone()

    def reader(self, conn, bearer, tenant):
        principal, _ = self.auth._authenticate(conn, bearer, tenant)
        package, expiry, suspended = conn.execute('SELECT package_mnt,expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE', (tenant,)).fetchone()
        allowed = bool(set(principal['roles']) & {'HOTEL_ADMIN','RECEPTION'}) or self._manager(principal['roles'],package)
        gate = subscription_gate(Action.CONFIGURE, AccessFacts(tenant,True,True,True,allowed,
            package in (25000,30000),True,True,suspended),expiry,conn.execute('SELECT clock_timestamp()').fetchone()[0])
        if not gate.allowed:
            raise DomainError(gate.code)
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))

    @staticmethod
    def request_data(conn, tenant, request):
        r = conn.execute('''SELECT id,room_id,target_mode,target_template_id,target_version_id,source_snapshot,
            target_snapshot,active_stay_id,state,revision,reason,requested_by,recorded_at,cancelled_by,cancel_reason,cancelled_at,request_kind
            FROM prsystem.minibar_configuration_request WHERE tenant_id=%s AND id=%s''',(tenant,request)).fetchone()
        if not r:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        fields=('request_id','room_id','target_mode','target_template_id','target_version_id','source_snapshot',
                'target_snapshot','active_stay_id','state','revision','reason','requested_by','recorded_at',
                'cancelled_by','cancel_reason','cancelled_at','request_kind')
        return dict(zip(fields,[v.isoformat() if hasattr(v,'isoformat') else v for v in r]))

    def request(self, bearer, tenant, room, data, key, *, rollout=False):
        with transaction(self.auth.dsn) as conn:
            return self._request_on_connection(conn, bearer, tenant, room, data, key, rollout=rollout)

    def _request_on_connection(self, conn, bearer, tenant, room, data, key, *, rollout=False, batch_id=None):
        data = dict(data, reason=self._text(data['reason'],1000))
        command = dict(action='MINIBAR_ROLLOUT' if rollout else 'MINIBAR_CONFIGURATION_REQUEST',room_id=room,data=data)
        actor, roles, package = self.actor(conn,bearer,tenant)
        replay = self._receipt(conn,tenant,key,actor,command)
        if replay is not None:
            return replay
        self._catalog_lock(conn,tenant)
        row = conn.execute('''SELECT r.revision,r.status,r.minibar_mode,c.status FROM prsystem.room r
            JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id)
            WHERE r.tenant_id=%s AND r.id=%s FOR UPDATE OF r''',(tenant,room)).fetchone()
        if not row:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        if row[0]!=data['expected_room_revision']:
            raise DomainError('REVISION_CONFLICT')
        if self.pending(conn,tenant,room):
            raise DomainError('CONFIGURATION_PENDING')
        if row[1]=='INACTIVE' or (data['target_mode']=='ON' and (row[1]!='ACTIVE' or row[3]!='ACTIVE')):
            raise DomainError('ROOM_NOT_READY')
        if data['target_mode']=='OFF' and row[2]=='OFF':
            raise DomainError('CONFIGURATION_UNCHANGED')
        if data['target_mode']=='ON':
            parent = self.template(conn,tenant,data['target_template_id'])
            version = self.version(conn,tenant,data['target_template_id'],data['target_version_id'])
            if parent['status']!='ACTIVE':
                raise DomainError('TEMPLATE_NOT_ACTIVE')
            if version['state']!='PUBLISHED':
                raise DomainError('TEMPLATE_NOT_PUBLISHED')
            self.validate_items(conn,tenant,version['items'])
        if rollout:
            from prsystem.minibar_rollout import MinibarRollout
            preview=MinibarRollout.eligibility(self,conn,tenant,room,data['target_template_id'],data['target_version_id'])
            if not preview['eligible']:raise DomainError(preview['code'])
        request = secrets.token_hex(16)
        conn.execute('''INSERT INTO prsystem.minibar_configuration_request
            (tenant_id,id,room_id,target_mode,target_template_id,target_version_id,source_snapshot,target_snapshot,state,requested_by,reason,request_kind,rollout_batch_id)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'READY_FOR_RECONCILIATION',%s,%s,%s,%s)''',
            (tenant,request,room,data['target_mode'],data.get('target_template_id'),data.get('target_version_id'),Jsonb({}),Jsonb({}),actor,data['reason'],'ROLLOUT' if rollout else 'CONFIGURATION',batch_id))
        conn.execute('UPDATE prsystem.room SET revision=revision+1 WHERE tenant_id=%s AND id=%s',(tenant,room))
        result = self.request_data(conn,tenant,request)
        self.event(conn,tenant,actor,'MINIBAR_CONFIGURATION_REQUESTED',request,dict(result,actor_roles=roles,package_mnt=package))
        self._save_receipt(conn,tenant,key,actor,command,result)
        return result


    def cancel(self, bearer, tenant, request, revision, reason, key):
        with transaction(self.auth.dsn) as conn:
            return self._cancel_on_connection(conn, bearer, tenant, request, revision, reason, key)

    def _cancel_on_connection(self, conn, bearer, tenant, request, revision, reason, key):
        reason = self._text(reason,1000)
        command = dict(action='MINIBAR_CONFIGURATION_CANCEL',request_id=request,revision=revision,reason=reason)
        actor, roles, package = self.actor(conn,bearer,tenant)
        replay = self._receipt(conn,tenant,key,actor,command)
        if replay is not None:
            return replay
        self._catalog_lock(conn,tenant)
        before = self.request_data(conn,tenant,request)
        conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,before['room_id'])).fetchone()
        conn.execute('SELECT id FROM prsystem.minibar_configuration_request WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,request)).fetchone()
        before = self.request_data(conn,tenant,request)
        if before['revision']!=revision:
            raise DomainError('REVISION_CONFLICT')
        if before['state'] in {'CANCELLED','APPLIED'}:
            raise DomainError('CONFIGURATION_TERMINAL')
        # This adapter commits every transfer together with APPLIED.
        # Pending requests therefore have no committed stock movements.
        from prsystem.minibar_reconciliation import MinibarReconciliation
        MinibarReconciliation.close_tasks(conn,tenant,request)
        conn.execute("""UPDATE prsystem.minibar_configuration_request SET state='CANCELLED',revision=revision+1,
            cancelled_by=%s,cancel_reason=%s,cancelled_at=clock_timestamp() WHERE tenant_id=%s AND id=%s""",
            (actor,reason,tenant,request))
        conn.execute('UPDATE prsystem.room SET revision=revision+1 WHERE tenant_id=%s AND id=%s',(tenant,before['room_id']))
        from prsystem.room_lifecycle import RoomLifecycle
        RoomLifecycle.sweep(conn,tenant)
        result = self.request_data(conn,tenant,request)
        self.event(conn,tenant,actor,'MINIBAR_CONFIGURATION_CANCELLED',request,dict(before=before,after=result,actor_roles=roles,package_mnt=package))
        self._save_receipt(conn,tenant,key,actor,command,result)
        return result


    def room_configuration(self, bearer, tenant, room, after='', limit=20):
        with transaction(self.auth.dsn) as conn:
            self.reader(conn,bearer,tenant)
            self._catalog_lock(conn,tenant)
            row = conn.execute('SELECT minibar_mode,revision,number,minibar_application_id FROM prsystem.room WHERE tenant_id=%s AND id=%s',(tenant,room)).fetchone()
            if not row:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            pending = self.pending(conn,tenant,room)
            history = conn.execute('SELECT id FROM prsystem.minibar_configuration_request WHERE tenant_id=%s AND room_id=%s AND id>%s ORDER BY id LIMIT %s',(tenant,room,after,limit+1)).fetchall()
            items = [self.request_data(conn,tenant,r[0]) for r in history[:limit]]
            return dict(room_id=room,room_number=row[2],current=dict(mode=row[0],room_revision=row[1],application_id=row[3],
                configuration=self.request_data(conn,tenant,row[3])['target_snapshot'] if row[3] else None),
                pending=self.request_data(conn,tenant,pending[0]) if pending else None,items=items,
                next_after=items[-1]['request_id'] if len(history)>limit else None)
