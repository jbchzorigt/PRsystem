"""Canonical minibar-OFF room readiness; cleaning sources cannot assert past time."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError
from prsystem.rooms import RoomService
from prsystem.postgres.connection import transaction


class ReadinessService(RoomService):
    @staticmethod
    def _room(conn, tenant, room):
        row = conn.execute('SELECT cleaning_state,status,minibar_mode,revision,category_id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant, room)).fetchone()
        if not row:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        if row[1] != 'ACTIVE' or row[2] != 'OFF':
            raise DomainError('ROOM_NOT_READY')
        if conn.execute("SELECT 1 FROM prsystem.stay WHERE tenant_id=%s AND room_id=%s AND state='ACTIVE'", (tenant, room)).fetchone():
            raise DomainError('ROOM_OCCUPIED')
        return row

    def request(self, bearer, tenant, room, assignee, revision, key):
        command = dict(action='REQUEST_ROOM_CLEANING', room=room, assignee=assignee, revision=revision)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn, bearer, tenant, assignee)
            actor = self._queue_actor(conn, bearer, tenant)
            self._cleaner(conn, tenant, assignee)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            self._catalog_lock(conn, tenant)
            row = self._room(conn, tenant, room)
            if row[3] != revision:
                raise DomainError('REVISION_CONFLICT')
            if row[0] != 'DIRTY' or conn.execute("SELECT 1 FROM prsystem.room_cleaning_request WHERE tenant_id=%s AND room_id=%s AND state='OPEN'", (tenant, room)).fetchone():
                raise DomainError('WORK_SOURCE_CONFLICT')
            source, action = secrets.token_hex(16), secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.cleaning_source (tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                VALUES (%s,%s,%s,%s,%s,'CONFIGURATION',%s,%s)''', (tenant, source, room, room, row[3], 'initial-room:'+room+':'+source, Jsonb(dict(minibar_mode='OFF',room_revision=row[3],category_id=row[4]))))
            conn.execute("INSERT INTO prsystem.cleaning_action (tenant_id,source_id,id,kind,quantity) VALUES (%s,%s,%s,'CLEAN',1)", (tenant, source, action))
            conn.execute('INSERT INTO prsystem.room_cleaning_request (tenant_id,source_id,room_id) VALUES (%s,%s,%s)', (tenant, source, room))
            task = self.assign_source(conn, tenant, source, assignee)
            result = dict(task_id=task, source_id=source, action_id=action, assignment_version=0, room_id=room)
            self.event(conn, tenant, actor, 'ROOM_CLEANING_REQUESTED', room, result)
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def manager_clean(self, bearer, tenant, room, revision, key):
        command = dict(action='MANAGER_ROOM_CLEAN', room=room, revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor = self._queue_actor(conn, bearer, tenant)
            package = conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s', (tenant,)).fetchone()[0]
            if package != 20000:
                raise DomainError('FORBIDDEN')
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            self._catalog_lock(conn, tenant)
            row = self._room(conn, tenant, room)
            if row[3] != revision:
                raise DomainError('REVISION_CONFLICT')
            if row[0] != 'DIRTY' or conn.execute("SELECT 1 FROM prsystem.room_cleaning_request WHERE tenant_id=%s AND room_id=%s AND state='OPEN'", (tenant, room)).fetchone():
                raise DomainError('WORK_SOURCE_CONFLICT')
            conn.execute("UPDATE prsystem.room SET cleaning_state='CLEAN',revision=revision+1 WHERE tenant_id=%s AND id=%s", (tenant, room))
            result = dict(room_id=room, cleaning_state='CLEAN', revision=revision+1)
            self.event(conn, tenant, actor, 'MANAGER_ROOM_CLEANED', room, result)
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def start(self, bearer, tenant, task, revision, key):
        command = dict(action='START_ROOM_CLEANING', task=task, revision=revision)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn, bearer, tenant)
            principal, _ = self.auth._authenticate(conn, bearer, tenant)
            actor = principal['account_id']
            self._cleaner(conn, tenant, actor)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            bridge = conn.execute('''SELECT b.room_id,b.source_id FROM prsystem.room_cleaning_request b
                JOIN prsystem.cleaning_task t ON (t.tenant_id,t.source_id)=(b.tenant_id,b.source_id)
                WHERE t.tenant_id=%s AND t.id=%s AND b.state='OPEN' ''', (tenant, task)).fetchone()
            if not bridge:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            row = self._room(conn, tenant, bridge[0])
            conn.execute('SELECT id FROM prsystem.cleaning_source WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant, bridge[1])).fetchone()
            owner = conn.execute("""SELECT t.assignee_id,t.assignment_version,t.state,w.state FROM prsystem.cleaning_task t
                JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
                WHERE t.tenant_id=%s AND t.id=%s FOR UPDATE OF t,w""", (tenant, task)).fetchone()
            if not owner or owner[0] != actor:
                raise DomainError('FORBIDDEN')
            if owner[1] != revision:
                raise DomainError('REVISION_CONFLICT')
            if owner[2:] != ('OPEN', 'OPEN') or row[0] not in {'DIRTY', 'CLEANING'}:
                raise DomainError('WORK_NOT_OPEN')
            conn.execute("UPDATE prsystem.room SET cleaning_state='CLEANING',revision=revision+1 WHERE tenant_id=%s AND id=%s AND cleaning_state='DIRTY'", (tenant, bridge[0]))
            conn.execute('UPDATE prsystem.cleaning_task SET started_at=coalesce(started_at,clock_timestamp()) WHERE tenant_id=%s AND id=%s', (tenant, task))
            result = dict(room_id=bridge[0], task_id=task, cleaning_state='CLEANING')
            self.event(conn, tenant, actor, 'ROOM_CLEANING_STARTED', bridge[0], result)
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result
