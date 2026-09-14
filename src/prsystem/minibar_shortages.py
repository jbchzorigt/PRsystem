"""Manager's reviewed physical plan and one-use next-stay opening permission."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.common import DomainError
from prsystem.minibar_configuration import MinibarConfiguration
from prsystem.postgres.connection import transaction


class MinibarShortages(MinibarConfiguration):
    @staticmethod
    def preview(conn,tenant,request):
        row=conn.execute('SELECT p,md5(p::text) FROM (SELECT prsystem.minibar_shortage_plan(%s,%s) p) x',(tenant,request)).fetchone()
        return dict(plan=row[0],token=row[1]) if row[0] else None

    @staticmethod
    def latest(conn,tenant,request):
        row=conn.execute('''SELECT a.id,a.actor_id,a.actor_label,a.reason,a.recorded_at,a.plan,
            prsystem.minibar_shortage_approval_ready(a.tenant_id,a.id),
            EXISTS(SELECT 1 FROM prsystem.minibar_shortage_posting s WHERE s.tenant_id=a.tenant_id AND s.approval_id=a.id)
            FROM prsystem.minibar_shortage_approval a WHERE a.tenant_id=%s AND a.request_id=%s ORDER BY a.request_revision DESC LIMIT 1''',(tenant,request)).fetchone()
        return dict(zip(('approval_id','actor_id','actor_label','reason','recorded_at','plan','ready','posted'),row)) if row else None

    def approve(self,bearer,tenant,request,data,key):
        from prsystem.minibar_reconciliation import MinibarReconciliation
        data=dict(data,reason=self._text(data['reason'],1000));command=dict(action='APPROVE_MINIBAR_SHORTAGE',request_id=request,data=data)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);actor,roles,package=self.actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            reconciliation=MinibarReconciliation(self.auth)
            req=reconciliation.lock_request(conn,tenant,request,data['expected_revision'])
            preview=self.preview(conn,tenant,request)
            if not preview:raise DomainError('SHORTAGE_APPROVAL_NOT_READY')
            if preview['token']!=data['expected_preview']:raise DomainError('REVISION_CONFLICT')
            identity=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.minibar_shortage_approval(tenant_id,id,request_id,request_revision,plan,actor_id,actor_label,reason)
                VALUES(%s,%s,%s,%s,%s,%s,'',%s)''',(tenant,identity,request,req['revision'],Jsonb(preview['plan']),actor,data['reason']))
            conn.execute("UPDATE prsystem.minibar_configuration_request SET state='BLOCKED_STOCK',revision=revision+1 WHERE tenant_id=%s AND id=%s",(tenant,request))
            result=dict(approval_id=identity,request_id=request,revision=req['revision']+1,state='BLOCKED_STOCK')
            self.event(conn,tenant,actor,'MINIBAR_SHORTAGE_APPROVED',request,dict(result,reason=data['reason'],plan=preview['plan'],actor_roles=roles,package_mnt=package))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    @classmethod
    def lock_opening_actors(cls,conn,bearer,tenant,room):
        # Follow account -> catalog -> room ordering, including the Manager whose
        # current permission the stay trigger rechecks. A changed actor retries.
        principal=conn.execute('SELECT account_id FROM prsystem.staff_session WHERE token_hash=%s',(digest(bearer),)).fetchone()
        if not principal:raise DomainError('UNAUTHENTICATED')
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        rows=conn.execute('''SELECT a.actor_id FROM prsystem.minibar_shortage_approval a JOIN prsystem.minibar_shortage_permit p
            ON(p.tenant_id,p.id)=(a.tenant_id,a.id) JOIN prsystem.room r ON(r.tenant_id,r.id,r.minibar_application_id)=(p.tenant_id,p.room_id,a.request_id)
            WHERE r.tenant_id=%s AND r.id=%s''',(tenant,room)).fetchall()
        actors={principal[0],*(r[0] for r in rows)};cls._lock_accounts(conn,actors)
        conn.execute('SELECT account_id FROM prsystem.staff_membership WHERE tenant_id=%s AND account_id=ANY(%s) ORDER BY account_id FOR SHARE',(tenant,list(actors))).fetchall()
        return actors
