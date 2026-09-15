import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarTemplateTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT ON prsystem.minibar_refill_request,prsystem.minibar_refill_result,prsystem.minibar_transfer,prsystem.minibar_reconciliation,prsystem.minibar_configuration_application TO {}',
                'GRANT SELECT,INSERT ON prsystem.minibar_product,prsystem.minibar_receipt,prsystem.staff_command_receipt,prsystem.minibar_template,prsystem.minibar_template_version,prsystem.minibar_template_item TO {}',
                'GRANT UPDATE(revision) ON prsystem.minibar_product TO {}',
                'GRANT UPDATE(revision,default_version_id) ON prsystem.minibar_template TO {}',
                'GRANT UPDATE(state) ON prsystem.minibar_template_version TO {}',
                'GRANT DELETE ON prsystem.minibar_template_item TO {}',
                'GRANT INSERT ON prsystem.operational_event TO {}',
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.update_membership(roles=['HOTEL_ADMIN','MANAGER'])
        self.bearer = self.token()
        r = self.client.post(f'/hotels/{self.tenant}/minibar/products', headers=self.headers(self.bearer), json=dict(
            name='Ус',category='Ундаа',unit='ш',selling_price_mnt=3000,unit_cost_mnt=1000,
            opening_quantity=10,idempotency_key='product'))
        self.product = self.ok(r,201)['product_id']

    def call(self, suffix='', data=None, method='post', tenant=None):
        kwargs = dict(headers=self.headers(self.bearer))
        if data is not None:
            kwargs['json'] = data
        return getattr(self.client,method)(f'/hotels/{tenant or self.tenant}/minibar/templates'+suffix, **kwargs)

    def ok(self, r, status=200):
        self.assertEqual(r.status_code,status,r.text)
        return r.json()

    def create(self, key='template'):
        return self.ok(self.call(data=dict(name='Стандарт',idempotency_key=key)),201)

    def draft(self, t, source=None, key='draft'):
        return self.ok(self.call('/'+t['template_id']+'/versions',dict(expected_revision=t['revision'],source_version_id=source,idempotency_key=key)),201)

    def act(self, t, action, key=None, **data):
        return self.call('/'+t['template_id']+'/versions/'+t['version']['version_id']+('/'+action if action else ''),
                         dict(expected_revision=t['revision'],idempotency_key=key or action or 'save',**data),
                         'post' if action else 'put')

    def ready(self):
        t=self.draft(self.create())
        return self.ok(self.act(t,'',items=[dict(product_id=self.product,target_quantity=2)]))

    def test_first_publish_default_and_exact_retry(self):
        t=self.ready()
        result=self.ok(self.act(t,'publish'))
        self.assertEqual(self.ok(self.act(t,'publish')),result)
        self.assertEqual(result['default_version_id'],t['version']['version_id'])
        self.assertEqual(result['version']['state'],'PUBLISHED')
        self.assertEqual(result['version']['items'][0]['target_quantity'],2)
        self.assertIsNotNone(result['version']['published_at'])
        self.assertEqual(self.act(t,'publish',expected='client').status_code,422)
        self.assertEqual(self.act(dict(t,revision=999),'publish').json()['code'],'IDEMPOTENCY_CONFLICT')

    def test_clone_new_publish_preserves_previous_default_and_snapshot(self):
        first=self.ok(self.act(self.ready(),'publish'))
        t=self.draft(first,first['version']['version_id'],'clone')
        self.assertEqual([{k:v for k,v in i.items() if k!='product_status'} for i in t['version']['items']],first['version']['items'])
        t=self.ok(self.act(t,'','change',items=[dict(product_id=self.product,target_quantity=5)]))
        second=self.ok(self.act(t,'publish','publish2'))
        self.assertEqual(second['default_version_id'],first['version']['version_id'])
        chosen=self.ok(self.act(second,'default'))
        self.assertEqual(chosen['default_version_id'],second['version']['version_id'])
        self.assertEqual(self.ok(self.act(second,'default')),chosen)
        original=self.ok(self.call('/'+first['template_id']+'/versions/'+first['version']['version_id'],method='get'))
        self.assertEqual(original['version'],first['version'])

    def test_empty_inactive_and_duplicate_cannot_publish(self):
        t=self.draft(self.create())
        self.assertEqual(self.act(t,'publish').json()['code'],'TEMPLATE_EMPTY')
        item=dict(product_id=self.product,target_quantity=2)
        self.assertEqual(self.act(t,'',items=[item,item]).status_code,422)
        t=self.ok(self.act(t,'',items=[item]))
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_product SET status='INACTIVE' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.act(t,'publish').json()['code'],'PRODUCT_NOT_ACTIVE')
        detail=self.ok(self.call('/'+t['template_id']+'/versions/'+t['version']['version_id'],method='get'))
        self.assertEqual(detail['version']['state'],'DRAFT')
        self.assertIsNone(detail['default_version_id'])
        self.assertEqual(detail['revision'],t['revision'])

    def test_draft_not_default_and_published_not_editable(self):
        t=self.ready()
        self.assertEqual(self.act(t,'default').json()['code'],'TEMPLATE_NOT_PUBLISHED')
        t=self.ok(self.act(t,'publish'))
        self.assertEqual(self.act(t,'','badedit',items=[]).json()['code'],'TEMPLATE_VERSION_IMMUTABLE')
        self.assertEqual(self.act(t,'publish','again').json()['code'],'TEMPLATE_VERSION_IMMUTABLE')

    def test_current_template_status_blocks_actions(self):
        t=self.ready()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_template SET status='RETIRING' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.act(t,'publish').json()['code'],'TEMPLATE_NOT_ACTIVE')
        self.assertEqual(self.act(t,'','retiring-edit',items=[]).json()['code'],'TEMPLATE_NOT_ACTIVE')

    def test_product_labels_are_frozen_at_publish(self):
        t=self.ok(self.act(self.ready(),'publish'))
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_product SET name='Өөр нэр',selling_price_mnt=9000 WHERE tenant_id=%s",(self.tenant,))
        v=self.ok(self.call('/'+t['template_id']+'/versions/'+t['version']['version_id'],method='get'))['version']
        self.assertEqual(v,t['version'])
        self.assertNotIn('selling_price_mnt',v['items'][0])  # check-in price book owns selling price

    def test_concurrent_publish_and_edit_have_one_winner(self):
        t=self.ready();barrier=Barrier(2)
        def run(action):
            barrier.wait()
            return self.act(t,action,'race-'+action,**({'items':[dict(product_id=self.product,target_quantity=7)]} if not action else {}))
        with ThreadPoolExecutor(2) as pool:
            replies=list(pool.map(run,('publish','')))
        self.assertEqual(sorted(r.status_code for r in replies),[200,409])
        self.assertEqual(next(r for r in replies if r.status_code==409).json()['code'],'REVISION_CONFLICT')

    def test_concurrent_first_publishes_keep_one_default(self):
        a=self.ready();b=self.draft(a,a['version']['version_id'],'second-draft')
        a=dict(a,revision=b['revision']);barrier=Barrier(2)
        def run(pair):
            key,t=pair;barrier.wait();return self.act(t,'publish',key)
        with ThreadPoolExecutor(2) as pool:
            replies=list(pool.map(run,(('a',a),('b',b))))
        self.assertEqual(sorted(r.status_code for r in replies),[200,409])
        winner=next(r.json() for r in replies if r.status_code==200)
        self.assertEqual(winner['default_version_id'],winner['version']['version_id'])

    def test_role_package_and_revocation_are_checked_before_replay(self):
        t=self.ready();published=self.ok(self.act(t,'publish'))
        for package,roles,allowed in ((20000,['HOTEL_ADMIN','MANAGER'],False),(25000,['HOTEL_ADMIN','MANAGER_PLUS'],False),
             (25000,['HOTEL_ADMIN','MANAGER'],True),(30000,['HOTEL_ADMIN','MANAGER_PLUS'],True),
             (30000,['HOTEL_ADMIN'],False),(30000,['HOTEL_ADMIN','RECEPTION'],False),(30000,['HOTEL_ADMIN','CLEANER'],False)):
            self.update_membership(roles=roles)
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('UPDATE prsystem.hotel_access SET package_mnt=%s WHERE tenant_id=%s',(package,self.tenant))
            self.bearer=self.token()
            self.assertEqual(self.call(method='get').status_code,200 if allowed else 403)
            self.assertEqual(self.act(t,'publish').status_code,200 if allowed else 403)
            reply=self.act(published,'default','default-'+str(package)+'-'+roles[-1])
            self.assertEqual(reply.status_code,200 if allowed else 403)
            if allowed: published=reply.json()
        self.update_membership(status='SUSPENDED')
        self.assertIn(self.act(t,'publish').status_code,(401,403))

    def test_expiry_and_security_block_authoring_and_replay(self):
        t=self.ready();self.ok(self.act(t,'publish'))
        for update in ("security_suspended=true", "security_suspended=false,expires_at=now()-interval '49 hours'"):
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('UPDATE prsystem.hotel_access SET '+update+' WHERE tenant_id=%s',(self.tenant,))
            self.assertEqual(self.act(t,'publish').status_code,403)
            self.assertEqual(self.call(method='get').status_code,403)

    def test_cross_tenant_and_cross_template_sources_are_rejected(self):
        t=self.ready();other=self.create('other-template')
        self.assertEqual(self.call('/'+other['template_id']+'/versions',dict(expected_revision=1,source_version_id=t['version']['version_id'],idempotency_key='badclone')).status_code,404)
        self.assertEqual(self.call(tenant=self.other,method='get').status_code,403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_membership SET roles=ARRAY['HOTEL_ADMIN','MANAGER'] WHERE tenant_id=%s AND account_id=%s",(self.other,self.account))
        self.bearer=self.token(self.other)
        self.assertEqual(self.call('/'+t['template_id']+'/versions',method='get',tenant=self.other).status_code,404)
        foreign=self.ok(self.call(data=dict(name='Other',idempotency_key='other'),tenant=self.other),201)
        d=self.ok(self.call('/'+foreign['template_id']+'/versions',dict(expected_revision=1,idempotency_key='d'),tenant=self.other),201)
        self.assertEqual(self.call('/'+foreign['template_id']+'/versions/'+d['version']['version_id'],dict(expected_revision=2,idempotency_key='save',items=[dict(product_id=self.product,target_quantity=1)]),'put',self.other).status_code,404)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.other,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_template WHERE id=%s',(t['template_id'],)).fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_template_item').fetchone()[0],0)

    def test_strict_items_and_pagination(self):
        t=self.ready()
        for qty in (0,-1,True,1.5,2**63):
            self.assertEqual(self.act(t,'','invalid',items=[dict(product_id=self.product,target_quantity=qty)]).status_code,422)
        self.assertEqual(self.act(t,'','invalid',items=[dict(product_id=self.product,target_quantity=1,unit_cost_mnt=2)]).status_code,422)
        for n in range(3):
            t=self.draft(t,key='draft-'+str(n))
        path='/'+t['template_id']+'/versions'
        first=self.ok(self.call(path+'?limit=2',method='get'))
        second=self.ok(self.call(path+'?limit=2&after='+str(first['next_after']),method='get'))
        self.assertEqual([v['version_number'] for v in first['items']+second['items']],[1,2,3,4])
        self.assertIsNone(second['next_after'])
        self.create('second');self.create('third')
        page=self.ok(self.call('?limit=2',method='get'))
        last=self.ok(self.call('?limit=2&after='+page['next_after'],method='get'))
        self.assertEqual(len({x['template_id'] for x in page['items']+last['items']}),3)

    def test_database_guards_protect_items_version_and_default(self):
        t=self.ok(self.act(self.ready(),'publish'))
        for query in ("UPDATE prsystem.minibar_template_item SET target_quantity=99 WHERE tenant_id=%s",
                      "DELETE FROM prsystem.minibar_template_item WHERE tenant_id=%s",
                      "UPDATE prsystem.minibar_template_version SET state='DRAFT' WHERE tenant_id=%s",
                      "DELETE FROM prsystem.minibar_template_version WHERE tenant_id=%s",
                      "UPDATE prsystem.minibar_template SET default_version_id=NULL WHERE tenant_id=%s"):
            with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
                conn.execute(query,(self.tenant,))
        draft=self.draft(t,t['version']['version_id'],'clone')
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.minibar_template SET default_version_id=%s WHERE tenant_id=%s',(draft['version']['version_id'],self.tenant))

    def test_publish_has_no_operational_or_stock_side_effect(self):
        t=self.ready()
        tables=('minibar_receipt','cash_event','staff_open_work','room','stay','cleaning_stock')
        def counts():
            with psycopg.connect(self.owner_dsn) as conn:
                return {tab:conn.execute('SELECT count(*) FROM prsystem.'+tab+' WHERE tenant_id=%s',(self.tenant,)).fetchone()[0] for tab in tables}
        before=counts();t=self.ok(self.act(t,'publish'));self.ok(self.act(t,'default'))
        self.assertEqual(counts(),before)

    def test_commit_failure_rolls_back_publish_default_audit_and_receipt(self):
        t=self.ready()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_template_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_template_commit AFTER UPDATE ON prsystem.minibar_template_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_template_commit()').format(sql.Literal(self.tenant)))
        try:
            self.assertEqual(self.act(t,'publish').status_code,503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_template_commit ON prsystem.minibar_template_version')
                conn.execute('DROP FUNCTION prsystem.fail_template_commit()')
        detail=self.ok(self.call('/'+t['template_id']+'/versions/'+t['version']['version_id'],method='get'))
        self.assertEqual(detail,t)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.operational_event WHERE tenant_id=%s AND kind='MINIBAR_TEMPLATE_PUBLISH'",(self.tenant,)).fetchone()[0],0)
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_command_receipt WHERE tenant_id=%s AND key='publish'",(self.tenant,)).fetchone()[0],0)
        self.ok(self.act(t,'publish'))
