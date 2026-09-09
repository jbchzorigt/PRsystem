"""Exact template authoring; room assignment and inventory are separate commands."""
import secrets

from prsystem.common import DomainError, money
from prsystem.minibar import MinibarWarehouse
from prsystem.postgres.connection import transaction


class MinibarTemplates(MinibarWarehouse):
    @staticmethod
    def template(conn, tenant, template, revision=None):
        row = conn.execute('''SELECT name,status,revision,default_version_id
            FROM prsystem.minibar_template WHERE tenant_id=%s AND id=%s FOR UPDATE''',
            (tenant, template)).fetchone()
        if not row:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        if revision is not None and row[2] != revision:
            raise DomainError('REVISION_CONFLICT')
        return dict(template_id=template, name=row[0], status=row[1], revision=row[2], default_version_id=row[3])

    @staticmethod
    def version(conn, tenant, template, version):
        row = conn.execute('''SELECT version_number,state,cloned_from_id,published_items,published_at
            FROM prsystem.minibar_template_version WHERE tenant_id=%s AND template_id=%s AND id=%s''',
            (tenant, template, version)).fetchone()
        if not row:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        items = row[3]
        if items is None:
            items = [dict(product_id=r[0], target_quantity=r[1], name=r[2], unit=r[3], product_status=r[4]) for r in conn.execute('''
                SELECT i.product_id,i.target_quantity,p.name,p.unit,p.status FROM prsystem.minibar_template_item i
                JOIN prsystem.minibar_product p ON p.tenant_id=i.tenant_id AND p.id=i.product_id
                WHERE i.tenant_id=%s AND i.template_id=%s AND i.version_id=%s ORDER BY i.product_id''',
                (tenant, template, version)).fetchall()]
        return dict(version_id=version, version_number=row[0], state=row[1], cloned_from_id=row[2],
                    items=items, published_at=row[4].isoformat() if row[4] else None)

    @staticmethod
    def validate_items(conn, tenant, items, active=True):
        if len(items)>100 or len({i['product_id'] for i in items}) != len(items):
            raise DomainError('INVALID_REQUEST')
        for item in sorted(items, key=lambda i: i['product_id']):
            money(item['target_quantity'], positive=True)
            row = conn.execute('SELECT status FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s FOR SHARE',
                               (tenant, item['product_id'])).fetchone()
            if not row:
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            if active and row[0] != 'ACTIVE':
                raise DomainError('PRODUCT_NOT_ACTIVE')

    def create_template(self, bearer, tenant, name, key):
        name = self._text(name)
        command = dict(action='MINIBAR_TEMPLATE_CREATE', name=name)
        with transaction(self.auth.dsn) as conn:
            actor, roles, package = self.actor(conn, bearer, tenant)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            self._catalog_lock(conn, tenant)
            template = secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.minibar_template(tenant_id,id,name) VALUES(%s,%s,%s)',
                         (tenant, template, name))
            result = self.template(conn, tenant, template)
            self.event(conn, tenant, actor, command['action'], template,
                       dict(result, actor_roles=roles, package_mnt=package))
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def change(self, bearer, tenant, template, action, data, key, version=None):
        command = dict(action='MINIBAR_TEMPLATE_'+action, template_id=template, version_id=version, data=data)
        with transaction(self.auth.dsn) as conn:
            actor, roles, package = self.actor(conn, bearer, tenant)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            self._catalog_lock(conn, tenant)
            before = self.template(conn, tenant, template, data['expected_revision'])
            if before['status'] != 'ACTIVE':
                raise DomainError('TEMPLATE_NOT_ACTIVE')
            old_version = None
            if action == 'DRAFT_CREATE':
                source = data.get('source_version_id')
                items = self.version(conn, tenant, template, source)['items'] if source else []
                version = secrets.token_hex(16)
                number = conn.execute('''SELECT coalesce(max(version_number),0)+1 FROM prsystem.minibar_template_version
                    WHERE tenant_id=%s AND template_id=%s''', (tenant, template)).fetchone()[0]
                conn.execute('''INSERT INTO prsystem.minibar_template_version
                    (tenant_id,template_id,id,version_number,cloned_from_id) VALUES(%s,%s,%s,%s,%s)''',
                    (tenant, template, version, number, source))
                # A clone preserves source membership, even if a product later became
                # inactive. It stays a draft until the current publish gate passes.
                for item in items:
                    conn.execute('''INSERT INTO prsystem.minibar_template_item
                        (tenant_id,template_id,version_id,product_id,target_quantity) VALUES(%s,%s,%s,%s,%s)''',
                        (tenant, template, version, item['product_id'], item['target_quantity']))
            elif action in {'DRAFT_SAVE','PUBLISH','DEFAULT'}:
                old_version = self.version(conn, tenant, template, version)
                if action in {'DRAFT_SAVE','PUBLISH'} and old_version['state'] != 'DRAFT':
                    raise DomainError('TEMPLATE_VERSION_IMMUTABLE')
                if action == 'DRAFT_SAVE':
                    self.validate_items(conn, tenant, data['items'])
                    conn.execute('DELETE FROM prsystem.minibar_template_item WHERE tenant_id=%s AND template_id=%s AND version_id=%s',
                                 (tenant, template, version))
                    for item in data['items']:
                        conn.execute('''INSERT INTO prsystem.minibar_template_item
                            (tenant_id,template_id,version_id,product_id,target_quantity) VALUES(%s,%s,%s,%s,%s)''',
                            (tenant, template, version, item['product_id'], item['target_quantity']))
                else:
                    if not old_version['items']:
                        raise DomainError('TEMPLATE_EMPTY')
                    self.validate_items(conn, tenant, old_version['items'])
                    if action == 'PUBLISH':
                        conn.execute("UPDATE prsystem.minibar_template_version SET state='PUBLISHED' WHERE tenant_id=%s AND template_id=%s AND id=%s",
                                     (tenant, template, version))
                        if before['default_version_id'] is None:
                            conn.execute('UPDATE prsystem.minibar_template SET default_version_id=%s WHERE tenant_id=%s AND id=%s',
                                         (version, tenant, template))
                    else:
                        if old_version['state'] != 'PUBLISHED':
                            raise DomainError('TEMPLATE_NOT_PUBLISHED')
                        conn.execute('UPDATE prsystem.minibar_template SET default_version_id=%s WHERE tenant_id=%s AND id=%s',
                                     (version, tenant, template))
            else:
                raise DomainError('INVALID_REQUEST')
            conn.execute('UPDATE prsystem.minibar_template SET revision=revision+1 WHERE tenant_id=%s AND id=%s', (tenant, template))
            result = dict(self.template(conn, tenant, template), version=self.version(conn, tenant, template, version))
            self.event(conn, tenant, actor, command['action'], template,
                       dict(before=before, before_version=old_version, after=result, actor_roles=roles, package_mnt=package))
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def templates(self, bearer, tenant, after='', limit=50):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn, bearer, tenant)
            rows = conn.execute('''SELECT id,name,status,revision,default_version_id FROM prsystem.minibar_template
                WHERE tenant_id=%s AND id>%s ORDER BY id LIMIT %s''', (tenant, after, limit+1)).fetchall()
            items = [dict(template_id=r[0], name=r[1], status=r[2], revision=r[3], default_version_id=r[4]) for r in rows[:limit]]
            return dict(items=items, next_after=items[-1]['template_id'] if len(rows)>limit else None)

    def versions(self, bearer, tenant, template, after=0, limit=50):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn, bearer, tenant)
            parent = self.template(conn, tenant, template)
            rows = conn.execute('''SELECT id,version_number,state,cloned_from_id,published_at
                FROM prsystem.minibar_template_version WHERE tenant_id=%s AND template_id=%s AND version_number>%s
                ORDER BY version_number LIMIT %s''', (tenant, template, after, limit+1)).fetchall()
            items = [dict(version_id=r[0], version_number=r[1], state=r[2], cloned_from_id=r[3], published_at=r[4]) for r in rows[:limit]]
            return dict(parent, items=items, next_after=items[-1]['version_number'] if len(rows)>limit else None)

    def detail(self, bearer, tenant, template, version):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn, bearer, tenant)
            return dict(self.template(conn, tenant, template), version=self.version(conn, tenant, template, version))
