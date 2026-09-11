"""Product/template retirement preserves existing obligations and all snapshots."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.minibar import MinibarWarehouse
from prsystem.common import DomainError
from prsystem.postgres.connection import transaction


class MinibarLifecycle(MinibarWarehouse):
    @staticmethod
    def entity(conn, tenant, kind, identity):
        if kind not in {'product', 'template'}:
            raise DomainError('INVALID_REQUEST')
        row = conn.execute('SELECT name,status,revision FROM prsystem.minibar_'+kind+
                           ' WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant, identity)).fetchone()
        if not row:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        return dict(entity_id=identity, kind=kind, name=row[0], status=row[1], revision=row[2])

    @staticmethod
    def blockers(conn, tenant, kind, identity):
        rows = conn.execute('SELECT kind,count(*) FROM prsystem.minibar_entity_blockers(%s,%s,%s) GROUP BY kind ORDER BY kind',
                            (tenant, kind, identity)).fetchall()
        return [dict(kind=r[0], count=r[1]) for r in rows]

    def preview(self, bearer, tenant, kind, identity):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn, bearer, tenant)
            entity = self.entity(conn, tenant, kind, identity)
            return dict(entity, blockers=self.blockers(conn, tenant, kind, identity),
                        can_delete=conn.execute('SELECT prsystem.minibar_entity_unused(%s,%s,%s)',(tenant,kind,identity)).fetchone()[0])

    def change(self, bearer, tenant, kind, identity, action, revision, reason, key):
        if action not in {'DEACTIVATE','CANCEL_RETIRING','REACTIVATE','HARD_DELETE'}:
            raise DomainError('INVALID_REQUEST')
        reason = self._text(reason, 1000)
        command = dict(action='MINIBAR_ENTITY_LIFECYCLE', kind=kind, entity_id=identity,
                       transition=action, expected_revision=revision, reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor, roles, package = self.actor(conn, bearer, tenant)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            self._catalog_lock(conn, tenant)
            before = self.entity(conn, tenant, kind, identity)
            if before['revision'] != revision:
                raise DomainError('REVISION_CONFLICT')
            if action == 'HARD_DELETE':
                if not conn.execute('SELECT prsystem.minibar_entity_unused(%s,%s,%s)',(tenant,kind,identity)).fetchone()[0]:
                    raise DomainError('LIFECYCLE_BLOCKED')
                conn.execute('DELETE FROM prsystem.minibar_'+kind+' WHERE tenant_id=%s AND id=%s',(tenant,identity))
                result=dict(before,status='DELETED',revision=revision+1,blockers=[])
                event=secrets.token_hex(16)
                conn.execute('''INSERT INTO prsystem.minibar_lifecycle_intent
                    (tenant_id,id,kind,entity_id,actor_id,action,reason,before_snapshot,after_snapshot)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (tenant,event,kind,identity,actor,action,reason,Jsonb(before),Jsonb(result)))
                self.event(conn,tenant,actor,'MINIBAR_ENTITY_DELETED',identity,dict(intent_id=event,before=before,reason=reason))
                self._save_receipt(conn,tenant,key,actor,command,result)
                return result
            expected = {'DEACTIVATE':'ACTIVE','CANCEL_RETIRING':'RETIRING','REACTIVATE':'INACTIVE'}[action]
            if before['status'] != expected:
                raise DomainError('INVALID_LIFECYCLE_TRANSITION')
            blockers = self.blockers(conn, tenant, kind, identity)
            status = ('RETIRING' if blockers else 'INACTIVE') if action == 'DEACTIVATE' else 'ACTIVE'
            if status == 'ACTIVE' and kind == 'template':
                if conn.execute('''SELECT 1 FROM prsystem.minibar_template_item i
                    JOIN prsystem.minibar_product p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
                    WHERE i.tenant_id=%s AND i.template_id=%s AND p.status<>'ACTIVE' LIMIT 1''', (tenant,identity)).fetchone():
                    raise DomainError('PRODUCT_NOT_ACTIVE')
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if kind == 'product':
                conn.execute('''UPDATE prsystem.minibar_product SET status=%s,revision=revision+1,
                    deactivation_requested_at=%s WHERE tenant_id=%s AND id=%s''',
                    (status, now if action=='DEACTIVATE' else None, tenant, identity))
            else:
                conn.execute('UPDATE prsystem.minibar_template SET status=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',
                             (status, tenant, identity))
            result = dict(before, status=status, revision=revision+1, blockers=blockers)
            event = secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.minibar_lifecycle_intent
                (tenant_id,id,kind,entity_id,actor_id,action,reason,before_snapshot,after_snapshot)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,event,kind,identity,actor,action,reason,Jsonb(before),Jsonb(result)))
            conn.execute('SELECT prsystem.complete_minibar_retirement(%s)', (tenant,))
            self.event(conn, tenant, actor, 'MINIBAR_ENTITY_LIFECYCLE', identity,
                       dict(intent_id=event,before=before,after=result,reason=reason,actor_roles=roles,package_mnt=package))
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result
