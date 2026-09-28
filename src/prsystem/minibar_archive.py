"""Terminal version archive with exact live-reference blockers and immutable proof."""
from prsystem.common import DomainError
from prsystem.minibar_templates import MinibarTemplates
from prsystem.postgres.connection import transaction


class MinibarArchive(MinibarTemplates):
    @staticmethod
    def blockers(conn,tenant,template,version):
        # Counts keep a large hotel's preview bounded and avoid exposing guest IDs.
        return [dict(kind=r[0],count=r[1]) for r in conn.execute(
            'SELECT kind,count(*) FROM prsystem.minibar_version_archive_blockers(%s,%s,%s) GROUP BY kind ORDER BY kind',
            (tenant,template,version)).fetchall()]

    def preview(self,bearer,tenant,template,version):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant);self._catalog_lock(conn,tenant)
            parent=self.template(conn,tenant,template);data=self.version(conn,tenant,template,version)
            blockers=self.blockers(conn,tenant,template,version)
            history=conn.execute('SELECT actor_id,reason,recorded_at FROM prsystem.minibar_version_archive WHERE tenant_id=%s AND template_id=%s AND version_id=%s',(tenant,template,version)).fetchone()
            return dict(template_id=template,version_id=version,revision=parent['revision'],state=data['state'],blockers=blockers,
                eligible=data['state']=='PUBLISHED' and not blockers,
                archive=dict(actor_id=history[0],reason=history[1],recorded_at=history[2]) if history else None)

    def archive(self,bearer,tenant,template,version,revision,reason,key):
        reason=self._text(reason,1000)
        command=dict(action='MINIBAR_VERSION_ARCHIVE',template_id=template,version_id=version,revision=revision,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor,roles,package=self.actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            before=self.template(conn,tenant,template,revision);old=self.version(conn,tenant,template,version)
            if old['state']!='PUBLISHED':raise DomainError('TEMPLATE_NOT_PUBLISHED')
            if self.blockers(conn,tenant,template,version):raise DomainError('TEMPLATE_ARCHIVE_BLOCKED')
            conn.execute('INSERT INTO prsystem.minibar_version_archive(tenant_id,template_id,version_id,actor_id,reason) VALUES(%s,%s,%s,%s,%s)',(tenant,template,version,actor,reason))
            conn.execute('UPDATE prsystem.minibar_template SET revision=revision+1 WHERE tenant_id=%s AND id=%s',(tenant,template))
            result=dict(self.template(conn,tenant,template),version=self.version(conn,tenant,template,version))
            self.event(conn,tenant,actor,'MINIBAR_VERSION_ARCHIVED',version,dict(template_id=template,before=old,after=result,actor_roles=roles,package_mnt=package,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result);return result
