"""Explicit same-template, exact-version rollout; preview never writes business state."""
from prsystem.common import DomainError
from prsystem.minibar_configuration import MinibarConfiguration
from prsystem.postgres.connection import transaction


class MinibarRollout(MinibarConfiguration):
    def eligibility(self,conn,tenant,room,template,version):
        row=conn.execute('''SELECT r.revision,r.status,r.minibar_mode,c.status,q.target_template_id,q.target_version_id,r.number
            FROM prsystem.room r JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id)
            LEFT JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(r.tenant_id,r.minibar_application_id)
            WHERE r.tenant_id=%s AND r.id=%s''',(tenant,room)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        code=None
        if row[1]!='ACTIVE' or row[3]!='ACTIVE':code='ROOM_NOT_READY'
        elif row[2]!='ON':code='ROLLOUT_REQUIRES_MINIBAR'
        elif row[4]!=template:code='ROLLOUT_TEMPLATE_MISMATCH'
        elif row[5]==version:code='ROLLOUT_UNCHANGED'
        elif self.pending(conn,tenant,room):code='CONFIGURATION_PENDING'
        if not code:
            try:
                parent=self.template(conn,tenant,template)
                target=self.version(conn,tenant,template,version)
                if parent['status']!='ACTIVE':raise DomainError('TEMPLATE_NOT_ACTIVE')
                if target['state']!='PUBLISHED':raise DomainError('TEMPLATE_NOT_PUBLISHED')
                self.validate_items(conn,tenant,target['items'])
            except DomainError as exc:code=str(exc)
        safe=not code and conn.execute('SELECT prsystem.minibar_safe_room(%s,%s)',(tenant,room)).fetchone()[0]
        return dict(room_id=room,room_number=row[6],room_revision=row[0],current_version_id=row[5],
            target_template_id=template,target_version_id=version,eligible=code is None,code=code,
            disposition='INELIGIBLE' if code else 'READY_NOW' if safe else 'SCHEDULE_AFTER_STAY')

    def preview(self,bearer,tenant,room,template,version):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant);self._catalog_lock(conn,tenant)
            # Fail closed for a foreign/missing exact target without exposing its metadata.
            self.template(conn,tenant,template);self.version(conn,tenant,template,version)
            return self.eligibility(conn,tenant,room,template,version)

    def confirm(self,bearer,tenant,room,template,version,revision,reason,key):
        return self.request(bearer,tenant,room,dict(target_mode='ON',target_template_id=template,
            target_version_id=version,expected_room_revision=revision,reason=reason),key,rollout=True)
