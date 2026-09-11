"""Bounded room rollout groups with immutable results and independent children."""
import hashlib
import secrets

from psycopg.types.json import Jsonb
from prsystem.common import DomainError, identifier
from prsystem.minibar_rollout import MinibarRollout
from prsystem.postgres.connection import transaction


from prsystem.minibar_batch_policy import TERMINAL, progress

ROOM_REJECTIONS = {'WORK_SOURCE_NOT_FOUND','REVISION_CONFLICT','CONFIGURATION_PENDING',
                   'ROOM_NOT_READY','ROLLOUT_REQUIRES_MINIBAR','ROLLOUT_TEMPLATE_MISMATCH',
                   'ROLLOUT_UNCHANGED'}


class MinibarBatches(MinibarRollout):
    @staticmethod
    def selection(rooms, retry_of=None):
        if not isinstance(rooms,list) or not (1 if retry_of else 2) <= len(rooms) <= 100:
            raise DomainError('INVALID_REQUEST')
        if len(set(rooms)) != len(rooms):
            raise DomainError('INVALID_REQUEST')
        for room in rooms:
            identifier(room)
            if len(room)>128:raise DomainError('INVALID_REQUEST')
        return sorted(rooms)

    def target(self,conn,tenant,template,version):
        parent=self.template(conn,tenant,template)
        target=self.version(conn,tenant,template,version)
        if parent['status']!='ACTIVE':raise DomainError('TEMPLATE_NOT_ACTIVE')
        if target['state']!='PUBLISHED':raise DomainError('TEMPLATE_NOT_PUBLISHED')
        self.validate_items(conn,tenant,target['items'])
        return dict(template_id=template,template_name=parent['name'],version_id=version,
                    version_number=target['version_number'],items=target['items'])

    def data(self,conn,tenant,batch):
        row=conn.execute('''SELECT b.template_id,b.version_id,b.retry_of_batch_id,b.target_snapshot,
            b.requested_by,b.reason,b.recorded_at FROM prsystem.minibar_rollout_batch b
            JOIN prsystem.minibar_rollout_seal s ON(s.tenant_id,s.batch_id)=(b.tenant_id,b.id)
            WHERE b.tenant_id=%s AND b.id=%s''',(tenant,batch)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        rows=conn.execute('''SELECT r.room_id,r.child_id,r.disposition,r.code,r.initial_state,r.room_snapshot,
            q.state,q.revision FROM prsystem.minibar_rollout_result r
            LEFT JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(r.tenant_id,r.child_id)
            WHERE r.tenant_id=%s AND r.batch_id=%s ORDER BY r.room_id''',(tenant,batch)).fetchall()
        items=[dict(room_id=r[0],request_id=r[1],disposition=r[2],code=r[3],initial_state=r[4],
                    room_number=r[5]['room_number'],expected_room_revision=r[5]['expected_room_revision'],
                    state=r[6] if r[1] else 'SKIPPED',revision=r[7] if r[1] else 0) for r in rows]
        return dict(batch_id=batch,template_id=row[0],version_id=row[1],retry_of_batch_id=row[2],
                    target=row[3],requested_by=row[4],reason=row[5],recorded_at=row[6].isoformat(),
                    items=items,**progress(items))

    def check_retry(self,conn,tenant,retry_of,template,version,rooms):
        if not retry_of:return
        source=self.data(conn,tenant,retry_of)
        allowed={i['room_id'] for i in source['items'] if i['state'] in {'SKIPPED','CANCELLED','ROLLED_BACK'}}
        if (source['template_id'],source['version_id'])!=(template,version) or not set(rooms)<=allowed:
            raise DomainError('BATCH_RETRY_NOT_READY')

    def room_preview(self,conn,tenant,room,template,version):
        try:return self.eligibility(conn,tenant,room,template,version)
        except DomainError as exc:
            if str(exc)!='WORK_SOURCE_NOT_FOUND':raise
            return dict(room_id=room,room_number=None,room_revision=0,eligible=False,
                        code='WORK_SOURCE_NOT_FOUND',disposition='INELIGIBLE')

    def preview_batch(self,bearer,tenant,template,version,rooms,retry_of=None):
        rooms=self.selection(rooms,retry_of)
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant);self._catalog_lock(conn,tenant)
            target=self.target(conn,tenant,template,version)
            self.check_retry(conn,tenant,retry_of,template,version,rooms)
            items=[self.room_preview(conn,tenant,r,template,version) for r in rooms]
            return dict(target=target,items=items,retry_of_batch_id=retry_of,
                        previewed_at=conn.execute('SELECT clock_timestamp()').fetchone()[0].isoformat())

    def confirm_batch(self,bearer,tenant,template,version,rooms,reason,key,retry_of=None):
        ids=self.selection([r['room_id'] for r in rooms],retry_of)
        for r in rooms:
            rev=r['expected_room_revision']
            if type(rev) is not int or not 0<=rev<=2**63-1:raise DomainError('INVALID_REQUEST')
        rooms=sorted(rooms,key=lambda r:r['room_id']);reason=self._text(reason,1000)
        command=dict(action='MINIBAR_ROLLOUT_BATCH_CONFIRM',template_id=template,version_id=version,
                     rooms=rooms,reason=reason,retry_of_batch_id=retry_of)
        with transaction(self.auth.dsn) as conn:
            actor,roles,package=self.actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant);self.target(conn,tenant,template,version)
            # Stable lock ordering also serializes automatic safe-point transitions.
            conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=ANY(%s) ORDER BY id FOR UPDATE',(tenant,ids)).fetchall()
            self.check_retry(conn,tenant,retry_of,template,version,ids)
            batch=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.minibar_rollout_batch
                (tenant_id,id,template_id,version_id,retry_of_batch_id,selection,target_snapshot,requested_by,reason,command_key)
                VALUES(%s,%s,%s,%s,%s,%s,'{}',%s,%s,%s)''',
                (tenant,batch,template,version,retry_of,Jsonb(rooms),actor,reason,key))
            for room in rooms:
                child=None;code=None
                try:
                    # Only known eligibility failures become SKIPPED. Infrastructure
                    # failures abort an unpublished confirmation and remain retryable.
                    with conn.transaction():
                        child=self._request_on_connection(conn,bearer,tenant,room['room_id'],
                            dict(target_mode='ON',target_template_id=template,target_version_id=version,
                                 expected_room_revision=room['expected_room_revision'],reason=reason),
                            'batch-child:'+batch+':'+hashlib.sha256(room['room_id'].encode()).hexdigest()[:16],
                            rollout=True,batch_id=batch)
                except DomainError as exc:
                    if str(exc) not in ROOM_REJECTIONS:raise
                    code=str(exc)
                conn.execute('''INSERT INTO prsystem.minibar_rollout_result
                    (tenant_id,batch_id,room_id,child_id,disposition,code,room_snapshot)
                    VALUES(%s,%s,%s,%s,%s,%s,'{}')''',
                    (tenant,batch,room['room_id'],child['request_id'] if child else None,
                     'ACCEPTED' if child else 'SKIPPED',code))
            conn.execute('INSERT INTO prsystem.minibar_rollout_seal(tenant_id,batch_id) VALUES(%s,%s)',(tenant,batch))
            result=self.data(conn,tenant,batch)
            self.event(conn,tenant,actor,'MINIBAR_ROLLOUT_BATCH_CONFIRMED',batch,
                       dict(result,actor_roles=roles,package_mnt=package,idempotency_key=key))
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def read_batch(self,bearer,tenant,batch):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant);self._catalog_lock(conn,tenant)
            return self.data(conn,tenant,batch)

    def list_batches(self,bearer,tenant,template,version,after='',limit=20):
        if type(limit) is not int or not 1<=limit<=50:raise DomainError('INVALID_REQUEST')
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant);self._catalog_lock(conn,tenant)
            self.template(conn,tenant,template);self.version(conn,tenant,template,version)
            rows=conn.execute('''SELECT b.id FROM prsystem.minibar_rollout_batch b
                JOIN prsystem.minibar_rollout_seal s ON(s.tenant_id,s.batch_id)=(b.tenant_id,b.id)
                WHERE b.tenant_id=%s AND b.template_id=%s AND b.version_id=%s AND b.id>%s ORDER BY b.id LIMIT %s''',
                (tenant,template,version,after,limit+1)).fetchall()
            return dict(items=[self.data(conn,tenant,r[0]) for r in rows[:limit]],next_after=rows[limit-1][0] if len(rows)>limit else None)

    def cancel_remaining(self,bearer,tenant,batch,revision,reason,key):
        reason=self._text(reason,1000)
        command=dict(action='MINIBAR_ROLLOUT_BATCH_CANCEL',batch_id=batch,revision=revision,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor,roles,package=self.actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            before=self.data(conn,tenant,batch)
            conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=ANY(%s) ORDER BY id FOR UPDATE',
                         (tenant,[i['room_id'] for i in before['items']])).fetchall()
            before=self.data(conn,tenant,batch)
            if before['revision']!=revision:raise DomainError('REVISION_CONFLICT')
            cancelled=[]
            for item in before['items']:
                if item['state'] in TERMINAL|{'SKIPPED'}:continue
                # Migration 046's deferred proof disallows committed partial transfers.
                if conn.execute('SELECT 1 FROM prsystem.minibar_transfer WHERE tenant_id=%s AND request_id=%s',
                                (tenant,item['request_id'])).fetchone():
                    raise DomainError('RECONCILIATION_NOT_READY')
                self._cancel_on_connection(conn,bearer,tenant,item['request_id'],item['revision'],reason,
                    'batch-cancel:'+secrets.token_hex(24))
                cancelled.append(item['request_id'])
            result=self.data(conn,tenant,batch)
            self.event(conn,tenant,actor,'MINIBAR_ROLLOUT_BATCH_CANCELLED',batch,
                       dict(before=before,after=result,cancelled=cancelled,reason=reason,actor_roles=roles,package_mnt=package))
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result
