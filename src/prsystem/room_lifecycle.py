"""Room/category retirement keeps historical stays and pending tasks intact."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.rooms import RoomService
from prsystem.common import DomainError
from prsystem.postgres.connection import transaction


class RoomLifecycle(RoomService):
    @staticmethod
    def sweep(conn,tenant):
        if conn.execute("SELECT 1 FROM prsystem.room WHERE tenant_id=%s AND status='RETIRING' UNION ALL SELECT 1 FROM prsystem.room_category WHERE tenant_id=%s AND status='RETIRING' LIMIT 1",(tenant,tenant)).fetchone():
            conn.execute('SELECT prsystem.complete_room_retirement(%s)',(tenant,))

    @staticmethod
    def blockers(conn,tenant,kind,entity):
        function='room_blockers' if kind=='room' else 'category_blockers'
        return conn.execute('SELECT prsystem.'+function+'(%s,%s)',(tenant,entity)).fetchone()[0]

    def change(self,bearer,tenant,kind,entity,action,revision,reason,key,category=None):
        reason=self._text(reason,1000)
        if kind not in {'room','category'} or action not in {'DEACTIVATE','REACTIVATE','CANCEL_RETIRING','REASSIGN_CATEGORY'}:raise DomainError('INVALID_REQUEST')
        if (action=='REASSIGN_CATEGORY')!=(category is not None) or (category and kind!='room'):raise DomainError('INVALID_REQUEST')
        table='room' if kind=='room' else 'room_category'
        command=dict(action='ROOM_LIFECYCLE',kind=kind,entity=entity,transition=action,revision=revision,reason=reason,category=category)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            row=conn.execute('SELECT status,revision FROM prsystem.'+table+' WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,entity)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[1]!=revision:raise DomainError('REVISION_CONFLICT')
            blockers=self.blockers(conn,tenant,kind,entity)
            status=row[0]
            if action=='DEACTIVATE':
                if status!='ACTIVE':raise DomainError('INVALID_LIFECYCLE_TRANSITION')
                status='RETIRING' if blockers else 'INACTIVE'
            elif action in {'REACTIVATE','CANCEL_RETIRING'}:
                if row[0]!=('INACTIVE' if action=='REACTIVATE' else 'RETIRING'):raise DomainError('INVALID_LIFECYCLE_TRANSITION')
                status='ACTIVE'
            else:
                from prsystem.minibar_configuration import MinibarConfiguration
                if MinibarConfiguration.pending(conn,tenant,entity):raise DomainError('CONFIGURATION_PENDING')
                if conn.execute("SELECT 1 FROM prsystem.stay WHERE tenant_id=%s AND room_id=%s AND state='ACTIVE'",(tenant,entity)).fetchone():raise DomainError('LIFECYCLE_BLOCKED')
            if kind=='room' and (status=='ACTIVE' or category):
                target=category or conn.execute('SELECT category_id FROM prsystem.room WHERE tenant_id=%s AND id=%s',(tenant,entity)).fetchone()[0]
                if not conn.execute("SELECT 1 FROM prsystem.room_category WHERE tenant_id=%s AND id=%s AND status='ACTIVE'",(tenant,target)).fetchone():raise DomainError('CATEGORY_NOT_ACTIVE')
            if category:
                conn.execute('UPDATE prsystem.room SET category_id=%s,status=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',(category,status,tenant,entity))
            else:
                conn.execute('UPDATE prsystem.'+table+' SET status=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',(status,tenant,entity))
            result=dict(entity_id=entity,kind=kind,status=status,revision=revision+1,blockers=blockers)
            before=dict(status=row[0],revision=row[1],blockers=blockers)
            conn.execute('''INSERT INTO prsystem.room_lifecycle_intent(tenant_id,id,kind,entity_id,actor_id,action,reason,before_snapshot,after_snapshot)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,secrets.token_hex(16),kind,entity,actor,action,reason,Jsonb(before),Jsonb(result)))
            self.sweep(conn,tenant)
            self.event(conn,tenant,actor,'ROOM_LIFECYCLE_CHANGED',entity,dict(before=before,after=result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result);return result
