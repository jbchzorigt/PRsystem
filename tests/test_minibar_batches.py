import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarBatchTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            conn.execute(sql.SQL('GRANT SELECT,INSERT ON prsystem.minibar_rollout_batch,prsystem.minibar_rollout_result,prsystem.minibar_rollout_seal,prsystem.minibar_version_archive,prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}').format(sql.Identifier(cls.role)))
            conn.execute(sql.SQL('GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}').format(sql.Identifier(cls.role)))

    def configure_room(self,request=None):
        from test_minibar_archive import MinibarArchiveTests
        return MinibarArchiveTests.configure_room(self,request)

    def setUp(self):
        super().setUp()
        self.configure_room()
        self.room2=self.assert_status(self.api('rooms',dict(number='102',floor='1',category_id=self.category)),201)['room_id']
        first=self.room
        try:
            self.room=self.room2;self.configure_room()
        finally:self.room=first
        from test_minibar_archive import MinibarArchiveTests
        self.target=MinibarArchiveTests.another(self)

    def batch_path(self):
        return f'minibar/templates/{self.template}/versions/{self.target}/rollout-batches'

    def selected(self,ids=None):
        with psycopg.connect(self.owner_dsn) as conn:
            rows=dict(conn.execute('SELECT id,revision FROM prsystem.room WHERE tenant_id=%s',(self.tenant,)).fetchall())
        return [dict(room_id=r,expected_room_revision=rows.get(r,0)) for r in (ids or [self.room,self.room2])]

    def confirm(self,rooms=None,token=None,**extra):
        return self.api(self.batch_path(),dict(rooms=self.selected() if rooms is None else rooms,**{'reason':'Бүлгээр шинэчлэх',**extra}),token)

    def preview_batch(self,ids=None,token=None,**extra):
        return self.client.post(f'/hotels/{self.tenant}/'+self.batch_path()+'/preview',headers=self.headers(token or self.manager_token),json=dict(room_ids=ids or [self.room,self.room2],**extra))

    def batch_read(self,batch,token=None,tenant=None):
        return self.api(f'minibar/rollout-batches/{batch["batch_id"]}',token=token,tenant=tenant,method='get')

    def batch_cancel(self,batch,**extra):
        return self.api(f'minibar/rollout-batches/{batch["batch_id"]}/cancel-remaining',dict(expected_revision=batch['revision'],reason='Үлдсэнийг цуцлах',**extra))

    def apply_child(self,batch,room):
        item=next(i for i in batch['items'] if i['room_id']==room)
        self.configure_room(dict(request_id=item['request_id'],revision=item['revision']))

    def database_count(self,table):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,)).fetchone()[0]

    def test_preview_is_read_only_and_explains_missing_rooms(self):
        before=self.database_count('minibar_configuration_request')
        p=self.assert_status(self.preview_batch([self.room,self.room2,'unavailable']),200)
        self.assertEqual(sum(i['eligible'] for i in p['items']),2)
        absent=next(i for i in p['items'] if i['room_id']=='unavailable')
        self.assertIsNone(absent['room_number']);self.assertEqual(absent['code'],'WORK_SOURCE_NOT_FOUND')
        self.assertEqual(self.database_count('minibar_rollout_batch'),0)
        self.assertEqual(self.database_count('minibar_configuration_request'),before)

    def test_confirm_partial_success_seals_results_and_does_not_move_stock(self):
        before=self.database_count('minibar_transfer')
        b=self.assert_status(self.confirm(self.selected([self.room,self.room2,'unavailable'])),201)
        self.assertEqual((b['state'],b['counts']['accepted'],b['counts']['SKIPPED']),('IN_PROGRESS',2,1))
        self.assertEqual(self.database_count('minibar_rollout_seal'),1)
        self.assertEqual(self.database_count('minibar_transfer'),before)
        self.assertIsNotNone(self.read().json()['pending'])
        self.assertEqual(self.read().json()['current']['configuration']['version_id'],self.version)

    def test_stale_room_is_skipped_while_other_room_is_accepted(self):
        rooms=self.selected();rooms[0]['expected_room_revision']-=1
        b=self.assert_status(self.confirm(rooms),201)
        self.assertEqual(b['counts']['accepted'],1)
        self.assertEqual(next(i for i in b['items'] if i['room_id']==self.room)['code'],'REVISION_CONFLICT')
        self.assertIsNone(self.read().json()['pending'])

    def test_children_apply_independently_and_cancel_preserves_applied(self):
        b=self.assert_status(self.confirm(),201);self.apply_child(b,self.room)
        current=self.batch_read(b).json();self.assertEqual(current['counts']['APPLIED'],1)
        self.assertEqual(self.batch_cancel(b).json()['code'],'REVISION_CONFLICT')
        after=self.assert_status(self.batch_cancel(current),200)
        self.assertEqual((after['state'],after['counts']['APPLIED'],after['counts']['CANCELLED']),('PARTIALLY_COMPLETED',1,1))
        self.assertEqual(self.read().json()['current']['configuration']['version_id'],self.target)
        self.assertIsNone(self.read().json()['pending'])

    def test_all_children_applied_is_completed(self):
        b=self.assert_status(self.confirm(),201)
        self.apply_child(b,self.room);self.apply_child(b,self.room2)
        self.assertEqual(self.batch_read(b).json()['state'],'COMPLETED')

    def test_cancel_remaining_is_idempotent_and_finishes_assigned_unmoved_work(self):
        b=self.assert_status(self.confirm(),201);item=b['items'][0]
        self.assert_status(self.api(f'minibar/configuration-requests/{item["request_id"]}/prepare',dict(expected_revision=item['revision'],assignee_id=self.worker)),201)
        b=self.batch_read(b).json()
        first=self.assert_status(self.batch_cancel(b,idempotency_key='cancel'),200)
        self.assertEqual(first,self.batch_cancel(b,idempotency_key='cancel').json())
        self.assertEqual(first['state'],'CANCELLED')
        self.assertEqual(self.api('minibar/reconciliation/tasks',token=self.worker_token,method='get').json()['items'],[])

    def test_retry_creates_new_linked_history_and_can_retry_one_failed_child(self):
        b=self.assert_status(self.confirm(),201);self.apply_child(b,self.room)
        old=self.assert_status(self.batch_cancel(self.batch_read(b).json()),200)
        retry=self.assert_status(self.confirm(self.selected([self.room2]),retry_of_batch_id=b['batch_id']),201)
        self.assertNotEqual(retry['batch_id'],b['batch_id']);self.assertEqual(retry['retry_of_batch_id'],b['batch_id'])
        self.assertEqual(self.batch_read(b).json(),old)
        self.assertEqual(self.confirm(self.selected([self.room]),retry_of_batch_id=b['batch_id']).json()['code'],'BATCH_RETRY_NOT_READY')

    def test_retry_rejects_nonterminal_and_unselected_rooms(self):
        b=self.assert_status(self.confirm(),201)
        self.assertEqual(self.confirm(retry_of_batch_id=b['batch_id']).json()['code'],'BATCH_RETRY_NOT_READY')
        self.assertEqual(self.confirm(self.selected(['other']),retry_of_batch_id=b['batch_id']).json()['code'],'BATCH_RETRY_NOT_READY')

    def test_zero_accepted_manifest_does_not_add_archive_blockers(self):
        b=self.assert_status(self.confirm(self.selected(['missing-a','missing-b'])),201)
        self.assertEqual(b['state'],'FAILED_VALIDATION')
        with psycopg.connect(self.owner_dsn) as conn:
            blockers=conn.execute('SELECT kind FROM prsystem.minibar_version_archive_blockers(%s,%s,%s)',(self.tenant,self.template,self.target)).fetchall()
        self.assertEqual(blockers,[('DEFAULT',)])

    def test_target_pinned_and_pending_children_block_archive(self):
        b=self.assert_status(self.confirm(),201)
        detail=self.api(self.version_path(),method='get').json()
        self.assert_status(self.api(self.version_path()+'/default',dict(expected_revision=detail['revision'])),200)
        preview=self.api(f'minibar/templates/{self.template}/versions/{self.target}/archive-preview',method='get').json()
        self.assertIn('PENDING_TARGET',[x['kind'] for x in preview['blockers']])
        self.assertEqual(self.batch_read(b).json()['target'],b['target'])
        self.assert_status(self.batch_cancel(b),200)
        preview=self.api(f'minibar/templates/{self.template}/versions/{self.target}/archive-preview',method='get').json()
        self.assertTrue(preview['eligible'])
        self.assert_status(self.api(f'minibar/templates/{self.template}/versions/{self.target}/archive',dict(expected_revision=preview['revision'],reason='Хэрэглээгүй хувилбар')),200)
        self.assertEqual(self.confirm(retry_of_batch_id=b['batch_id']).json()['code'],'TEMPLATE_NOT_PUBLISHED')
        self.assertEqual(self.batch_read(b).json()['target'],b['target'])

    def test_roles_tenant_and_current_package_precede_replay(self):
        rooms=self.selected();b=self.assert_status(self.confirm(rooms,idempotency_key='same'),201)
        for token in (self.worker_token,self.admin,self.replacement_token):
            self.assert_status(self.preview_batch(token=token),403)
            self.assert_status(self.batch_read(b,token),403)
        self.assert_status(self.batch_read(b,tenant=self.other),403)
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(self.other,))
            for table in ('minibar_rollout_batch','minibar_rollout_result','minibar_rollout_seal'):
                self.assertEqual(conn.execute(sql.SQL('SELECT count(*) FROM prsystem.{}').format(sql.Identifier(table))).fetchone()[0],0)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=20000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.confirm(rooms,idempotency_key='same'),403)

    def test_duplicate_concurrent_confirm_and_payload_conflict(self):
        rooms=self.selected();barrier=Barrier(2)
        def post(_):barrier.wait();return self.confirm(rooms,idempotency_key='same')
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(post,range(2)))
        self.assert_status(responses[0],201);self.assertEqual(responses[0].json(),responses[1].json())
        self.assertEqual(self.database_count('minibar_rollout_batch'),1)
        self.assertEqual(self.confirm(rooms,idempotency_key='same',reason='Өөр шалтгаан').json()['code'],'IDEMPOTENCY_CONFLICT')

    def test_competing_batches_keep_one_pending_per_room(self):
        rooms=self.selected();barrier=Barrier(2)
        def post(_):barrier.wait();return self.confirm(rooms).json()
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(post,range(2)))
        self.assertEqual(sorted(b['counts']['accepted'] for b in results),[0,2])
        self.assertEqual(sorted(b['state'] for b in results),['FAILED_VALIDATION','IN_PROGRESS'])

    def test_validation_duplicate_single_and_oversized_selection(self):
        self.assert_status(self.confirm(self.selected([self.room])),422)
        self.assert_status(self.confirm(self.selected([self.room,self.room])),422)
        self.assert_status(self.preview_batch([str(n) for n in range(101)]),422)
        self.assert_status(self.confirm(reason='   '),422)
        self.assertEqual(self.database_count('minibar_rollout_batch'),0)

    def test_history_is_immutable_and_sealed_parent_rejects_new_children(self):
        b=self.assert_status(self.confirm(),201)
        for table in ('minibar_rollout_batch','minibar_rollout_result','minibar_rollout_seal'):
            with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
                conn.execute(sql.SQL('DELETE FROM prsystem.{} WHERE tenant_id=%s').format(sql.Identifier(table)),(self.tenant,))
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute('''INSERT INTO prsystem.minibar_configuration_request
                (tenant_id,id,room_id,target_mode,target_template_id,target_version_id,source_snapshot,target_snapshot,state,requested_by,reason,request_kind,rollout_batch_id)
                VALUES(%s,'forged',%s,'ON',%s,%s,'{}','{}','READY_FOR_RECONCILIATION',%s,'forged','ROLLOUT',%s)''',
                (self.tenant,self.room,self.template,self.target,self.manager,b['batch_id']))

    def test_database_rejects_incomplete_confirmation_at_commit(self):
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute('''INSERT INTO prsystem.minibar_rollout_batch
                (tenant_id,id,template_id,version_id,selection,target_snapshot,requested_by,reason,command_key)
                VALUES(%s,'incomplete',%s,%s,%s,'{}',%s,'direct','direct')''',
                (self.tenant,self.template,self.target,Jsonb(self.selected()),self.manager))
        self.assertEqual(self.database_count('minibar_rollout_batch'),0)

    def test_commit_failure_leaves_no_manifest_children_or_receipt(self):
        from unittest.mock import patch
        from contextlib import contextmanager
        from prsystem.postgres.connection import transaction
        @contextmanager
        def broken(dsn):
            with transaction(dsn) as conn:
                yield conn
                raise psycopg.OperationalError('commit unavailable')
        rooms=self.selected();before=self.database_count('minibar_configuration_request')
        with patch('prsystem.minibar_batches.transaction',broken):self.assert_status(self.confirm(rooms,idempotency_key='commit'),503)
        self.assertEqual(self.database_count('minibar_rollout_batch'),0)
        self.assertEqual(self.database_count('minibar_configuration_request'),before)
        self.assert_status(self.confirm(rooms,idempotency_key='commit'),201)

    def test_bounded_history_lists_immutable_results(self):
        first=self.assert_status(self.confirm(self.selected(['missing-a','missing-b'])),201)
        second=self.assert_status(self.confirm(self.selected(['missing-c','missing-d'])),201)
        p=self.assert_status(self.api(self.batch_path()+'?limit=1',method='get'),200)
        q=self.assert_status(self.api(self.batch_path()+'?limit=1&after='+p['next_after'],method='get'),200)
        self.assertEqual({p['items'][0]['batch_id'],q['items'][0]['batch_id']},{first['batch_id'],second['batch_id']})
        self.assertIsNone(q['next_after'])
