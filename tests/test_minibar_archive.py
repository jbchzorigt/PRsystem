import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarArchiveTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            conn.execute(sql.SQL('GRANT SELECT,INSERT ON prsystem.minibar_version_archive,prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}').format(sql.Identifier(cls.role)))
            conn.execute(sql.SQL('GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}').format(sql.Identifier(cls.role)))

    def preview(self,version=None,token=None):
        return self.api(f'minibar/templates/{self.template}/versions/{version or self.version}/archive-preview',method='get',token=token)

    def archive(self,version=None,revision=None,token=None,key=None,reason='Хуучин бүрдлийг архивлах'):
        if revision is None:
            with psycopg.connect(self.owner_dsn) as conn:
                revision=conn.execute('SELECT revision FROM prsystem.minibar_template WHERE tenant_id=%s AND id=%s',(self.tenant,self.template)).fetchone()[0]
        return self.api(f'minibar/templates/{self.template}/versions/{version or self.version}/archive',dict(expected_revision=revision,reason=reason,idempotency_key=key or uuid4().hex),token)

    def another(self):
        with psycopg.connect(self.owner_dsn) as conn:
            revision=conn.execute('SELECT revision FROM prsystem.minibar_template WHERE tenant_id=%s AND id=%s',(self.tenant,self.template)).fetchone()[0]
        d=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=revision,source_version_id=self.version)),201)
        v=d['version']['version_id']
        p=self.assert_status(self.api(f'minibar/templates/{self.template}/versions/{v}/publish',dict(expected_revision=d['revision'])),200)
        self.assert_status(self.api(f'minibar/templates/{self.template}/versions/{v}/default',dict(expected_revision=p['revision'])),200)
        return v

    def configure_room(self,request=None):
        q=request or self.assert_status(self.request(),201)
        task=self.assert_status(self.api(f'minibar/configuration-requests/{q["request_id"]}/prepare',dict(expected_revision=q['revision'],assignee_id=self.worker)),201)
        task_path=f'minibar/reconciliation/tasks/{task["task_id"]}'
        def detail():return next(i for i in self.api('minibar/reconciliation/tasks',method='get',token=self.worker_token).json()['items'] if i['task_id']==task['task_id'])
        for line in detail()['plan']['lines']:
            self.assert_status(self.api(task_path+'/count',dict(assignment_version=0,action_id=line['action_id'],actual_count=line['baseline_quantity']),self.worker_token),200)
        self.assert_status(self.api(task_path+'/apply',dict(assignment_version=0,expected_revision=detail()['request']['revision'],physical_transfers_confirmed=True),self.worker_token),200)
        return task

    def test_default_blocker_and_preview_are_read_only(self):
        before=self.preview().json();self.assertFalse(before['eligible']);self.assertEqual(before['blockers'],[dict(kind='DEFAULT',count=1)])
        self.assertEqual(self.archive().json()['code'],'TEMPLATE_ARCHIVE_BLOCKED')
        self.assertEqual(self.preview().json(),before)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_version_archive WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],0)

    def test_archive_retry_preserves_snapshot_and_has_no_operational_side_effects(self):
        chosen=self.another();before=self.api(self.version_path(),method='get').json();revision=before['revision']
        with psycopg.connect(self.owner_dsn) as conn:
            tables=['minibar_transfer','cleaning_task','minibar_configuration_request','reception_dependency_blocker','guest_charge','minibar_receipt']
            counts=[conn.execute('SELECT count(*) FROM prsystem.'+t+' WHERE tenant_id=%s',(self.tenant,)).fetchone()[0] for t in tables]
        result=self.assert_status(self.archive(revision=revision,key='archive'),200)
        self.assertEqual(result,self.archive(revision=revision,key='archive').json());self.assertEqual(result['version']['state'],'ARCHIVED')
        self.assertEqual({k:v for k,v in result['version'].items() if k!='state'},{k:v for k,v in before['version'].items() if k!='state'})
        self.assertEqual(result['default_version_id'],chosen)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(counts,[conn.execute('SELECT count(*) FROM prsystem.'+t+' WHERE tenant_id=%s',(self.tenant,)).fetchone()[0] for t in tables])
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.operational_event WHERE tenant_id=%s AND kind='MINIBAR_VERSION_ARCHIVED'",(self.tenant,)).fetchone()[0],1)
        self.assertEqual(self.preview().json()['archive']['reason'],'Хуучин бүрдлийг архивлах')

    def test_archived_terminal_default_publish_edit_target_denied_but_clone_allowed(self):
        self.another();r=self.assert_status(self.archive(),200)
        for action in ('publish','default'):
            self.assert_status(self.api(self.version_path()+'/'+action,dict(expected_revision=r['revision'])),409)
        self.assert_status(self.api(self.version_path(),dict(expected_revision=r['revision'],items=[]),method='put'),409)
        self.assert_status(self.request(),409)
        clone=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=r['revision'],source_version_id=self.version)),201)
        self.assertEqual(clone['version']['state'],'DRAFT');self.assertEqual(clone['version']['cloned_from_id'],self.version)
        self.assertEqual(clone['version']['items'][0]['target_quantity'],2)
        self.assert_status(self.archive(),409)

    def test_pending_target_cancel_releases_archive_blocker(self):
        self.another();q=self.assert_status(self.request(),201)
        self.assertIn('PENDING_TARGET',[b['kind'] for b in self.preview().json()['blockers']])
        self.assert_status(self.archive(),409);self.assert_status(self.cancel(q),200)
        self.assert_status(self.archive(),200)

    def test_current_room_and_pending_source_are_blockers(self):
        self.another();self.configure_room()
        self.assertIn('CURRENT_ROOM',[b['kind'] for b in self.preview().json()['blockers']])
        q=self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),201)
        kinds=[b['kind'] for b in self.preview().json()['blockers']];self.assertIn('PENDING_SOURCE',kinds)
        self.assert_status(self.archive(),409)
        self.configure_room(q);self.assert_status(self.archive(),200)
        # Previous ON application and movement remain historical references.
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_transfer WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],2)

    def test_open_cleaner_task_blocks_archive_and_cancel_closes_it(self):
        self.another();q=self.assert_status(self.request(),201)
        self.assert_status(self.api(f'minibar/configuration-requests/{q["request_id"]}/prepare',dict(expected_revision=q['revision'],assignee_id=self.worker)),201)
        self.assertIn('CLEANER_TASK',[b['kind'] for b in self.preview().json()['blockers']])
        self.assert_status(self.archive(),409)
        q=self.read().json()['pending'];self.assert_status(self.cancel(q),200);self.assert_status(self.archive(),200)

    def test_permission_package_and_current_authority_before_replay(self):
        self.another();revision=self.preview().json()['revision']
        for token in (self.worker_token,self.replacement_token,self.admin):
            self.assert_status(self.archive(revision=revision,token=token),403)
        self.assert_status(self.archive(revision=revision,key='accepted'),200)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=20000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.archive(revision=revision,key='accepted'),403)

    def test_cross_tenant_and_rls_history(self):
        self.another();self.assert_status(self.archive(),200)
        self.assert_status(self.api(f'minibar/templates/{self.template}/versions/{self.version}/archive-preview',method='get',tenant=self.other),403)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.other,))
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_version_archive').fetchone()[0],0)

    def test_race_with_pending_request_has_only_one_winner(self):
        self.another();barrier=Barrier(2)
        def go(action):barrier.wait();return self.archive() if action=='archive' else self.request()
        with ThreadPoolExecutor(2) as pool:result=list(pool.map(go,['archive','request']))
        self.assertEqual(sorted(r.status_code for r in result),[200,409] if result[0].status_code==200 else [201,409])

    def test_duplicate_concurrent_archive_is_exactly_once(self):
        self.another();revision=self.preview().json()['revision'];barrier=Barrier(2)
        def go(_):barrier.wait();return self.archive(revision=revision,key='same')
        with ThreadPoolExecutor(2) as pool:r=list(pool.map(go,range(2)))
        self.assert_status(r[0],200);self.assertEqual(r[0].json(),r[1].json())

    def test_commit_failure_rolls_back_state_proof_revision_audit_and_retry(self):
        self.another();before=self.preview().json();revision=before['revision']
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_archive AFTER INSERT ON prsystem.minibar_version_archive DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_archive()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.archive(revision=revision,key='retry'),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_archive ON prsystem.minibar_version_archive');conn.execute('DROP FUNCTION prsystem.fail_archive()')
        self.assertEqual(before,self.preview().json())
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.operational_event WHERE tenant_id=%s AND kind='MINIBAR_VERSION_ARCHIVED'",(self.tenant,)).fetchone()[0],0)
        self.assert_status(self.archive(revision=revision,key='retry'),200)

    def test_database_cannot_bypass_blockers_proof_or_archived_immutability(self):
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.minibar_version_archive VALUES(%s,%s,%s,%s,'direct',clock_timestamp())",(self.tenant,self.template,self.version,self.manager))
        draft=self.assert_status(self.api(f'minibar/templates/{self.template}/versions',dict(expected_revision=4,source_version_id=self.version)),201)
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_template_version SET state='ARCHIVED',published_at=clock_timestamp(),published_items='[]'::jsonb WHERE tenant_id=%s AND id=%s",(self.tenant,draft['version']['version_id']))
        self.another()
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_template_version SET state='ARCHIVED' WHERE tenant_id=%s AND id=%s",(self.tenant,self.version))
        self.assert_status(self.archive(),200)
        for query in ("UPDATE prsystem.minibar_template_version SET state='PUBLISHED' WHERE tenant_id=%s AND id=%s", "DELETE FROM prsystem.minibar_template_version WHERE tenant_id=%s AND id=%s"):
            with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:conn.execute(query,(self.tenant,self.version))
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:conn.execute('DELETE FROM prsystem.minibar_version_archive WHERE tenant_id=%s',(self.tenant,))

    def test_stale_revision_and_invalid_reason_do_not_archive(self):
        self.another();self.assertEqual(self.archive(revision=1).json()['code'],'REVISION_CONFLICT')
        self.assert_status(self.archive(reason=''),422);self.assert_status(self.archive(reason='  '),400)
        self.assertTrue(self.preview().json()['eligible'])

    def exact_stay_fixture(self):
        # Adapter-contract fixture only: public canonical check-in remains gated.
        self.start();new_id=uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.stay SET state='CLOSED',actual_checkout_at=planned_checkout_at WHERE tenant_id=%s AND id=%s",(self.tenant,self.stay['stay_id']))
            conn.execute("""INSERT INTO prsystem.stay SELECT (jsonb_populate_record(s,
                jsonb_build_object('id',%s::text,'state','ACTIVE','actual_checkout_at',NULL,
                'snapshot',s.snapshot||jsonb_build_object('minibar_snapshot',jsonb_build_object('template_id',%s::text,'version_id',%s::text))))).*
                FROM prsystem.stay s WHERE tenant_id=%s AND id=%s""",(new_id,self.template,self.version,self.tenant,self.stay['stay_id']))
        return new_id

    def test_active_exact_stay_reference_blocks_but_terminal_history_does_not(self):
        self.another();stay=self.exact_stay_fixture()
        self.assertIn('ACTIVE_STAY',[b['kind'] for b in self.preview().json()['blockers']]);self.assert_status(self.archive(),409)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.stay SET state='CLOSED',actual_checkout_at=planned_checkout_at WHERE tenant_id=%s AND id=%s",(self.tenant,stay))
        self.assert_status(self.archive(),200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT snapshot->'minibar_snapshot'->>'version_id' FROM prsystem.stay WHERE tenant_id=%s AND id=%s",(self.tenant,stay)).fetchone()[0],self.version)
        # A new live reference cannot race through the archived state.
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("""INSERT INTO prsystem.stay SELECT (jsonb_populate_record(s,
                jsonb_build_object('id',%s::text,'state','ACTIVE','actual_checkout_at',NULL))).*
                FROM prsystem.stay s WHERE tenant_id=%s AND id=%s""",(uuid4().hex,self.tenant,stay))

    def test_default_change_and_archive_share_revision_and_lock(self):
        self.another();revision=self.preview().json()['revision'];barrier=Barrier(2)
        def go(kind):
            barrier.wait()
            return self.archive(revision=revision) if kind=='archive' else self.api(self.version_path()+'/default',dict(expected_revision=revision))
        with ThreadPoolExecutor(2) as pool:r=list(pool.map(go,['archive','default']))
        self.assertEqual(sorted(x.status_code for x in r),[200,409])

    def test_manager_plus_package_intersection_and_security_suspension(self):
        self.another();plus,token=self.add_staff(['MANAGER_PLUS'])
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=25000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.archive(token=token),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=30000,security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.archive(token=token),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=false WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.archive(token=token),200)
