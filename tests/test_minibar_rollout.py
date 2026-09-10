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
class MinibarRolloutTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            conn.execute(sql.SQL('GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}').format(sql.Identifier(cls.role)))
            conn.execute(sql.SQL('GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}').format(sql.Identifier(cls.role)))

    def configure_room(self,request=None):
        import test_minibar_archive
        return test_minibar_archive.MinibarArchiveTests.configure_room(self,request)

    def another(self):
        import test_minibar_archive
        return test_minibar_archive.MinibarArchiveTests.another(self)

    def prepared_room(self):
        self.configure_room();self.target=self.another()

    def rollout(self,token=None,key=None,revision=None,version=None,template=None,room=None):
        return self.api(f'minibar/templates/{template or self.template}/versions/{version or self.target}/rollout/{room or self.room}',
            dict(expected_room_revision=self.revision() if revision is None else revision,reason='Бүрдлийг шинэ хувилбарт шилжүүлэх',idempotency_key=key or uuid4().hex),token)

    def preview(self,token=None,version=None,template=None):
        return self.api(f'minibar/templates/{template or self.template}/versions/{version or self.target}/rollout/{self.room}/preview',token=token,method='get')

    def execution(self,request):
        with psycopg.connect(self.owner_dsn) as conn:
            return conn.execute('''SELECT t.id,t.assignee_id,t.state FROM prsystem.cleaning_task t JOIN prsystem.minibar_reconciliation e
                ON(e.tenant_id,e.source_id)=(t.tenant_id,t.source_id) WHERE e.tenant_id=%s AND e.request_id=%s''',(self.tenant,request['request_id'])).fetchall()

    def test_preview_noop_off_and_ready_are_read_only(self):
        self.target=self.version
        self.assertEqual(self.preview().json()['code'],'ROLLOUT_REQUIRES_MINIBAR')
        self.configure_room()
        self.assertEqual(self.preview().json()['code'],'ROLLOUT_UNCHANGED')
        self.target=self.another();before=self.read().json()
        preview=self.assert_status(self.preview(),200);self.assertEqual(preview['disposition'],'READY_NOW')
        self.assertEqual(self.read().json(),before)
        self.assertIsNone(before['pending'])
        self.assertEqual(self.rollout(version=self.version).json()['code'],'ROLLOUT_UNCHANGED')

    def test_confirm_creates_exact_unassigned_task_and_blocker_without_stock_switch(self):
        self.prepared_room();before=self.read().json()['current'];revision=self.revision()
        q=self.assert_status(self.rollout(key='rollout',revision=revision),201)
        self.assertEqual(q,self.rollout(key='rollout',revision=revision).json())
        self.assertEqual((q['request_kind'],q['state'],q['target_version_id']),('ROLLOUT','READY_FOR_RECONCILIATION',self.target))
        self.assertEqual(len(self.execution(q)),1);self.assertIsNone(self.execution(q)[0][1])
        after=self.read().json();self.assertEqual(after['current']['application_id'],before['application_id'])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_transfer WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)
            self.assertEqual(conn.execute("SELECT state FROM prsystem.reception_dependency_blocker WHERE tenant_id=%s AND source_id=%s",(self.tenant,q['request_id'])).fetchone()[0],'OPEN')
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_open_work WHERE tenant_id=%s AND source_id=%s",(self.tenant,self.execution(q)[0][0])).fetchone()[0],0)
        self.assertEqual(self.rollout().json()['code'],'CONFIGURATION_PENDING')

    def test_assign_count_apply_reuses_task_and_preserves_target(self):
        self.prepared_room();q=self.assert_status(self.rollout(),201);task=self.execution(q)[0][0]
        self.configure_room(q)
        self.assertEqual(self.execution(q),[(task,self.worker,'DONE')])
        self.assertEqual(self.read().json()['current']['configuration']['version_id'],self.target)
        self.assertIsNone(self.read().json()['pending'])

    def test_cancel_closes_unassigned_work_and_allows_fresh_rollout(self):
        self.prepared_room();q=self.assert_status(self.rollout(),201)
        self.assert_status(self.cancel(q),200);self.assertEqual(self.execution(q)[0][2],'DONE')
        next_q=self.assert_status(self.rollout(),201);self.assertNotEqual(q['request_id'],next_q['request_id'])
        self.assertEqual(len(self.execution(next_q)),1)

    def test_pending_refill_delays_task_and_terminal_action_wakes_exactly_once(self):
        self.prepared_room()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('''INSERT INTO prsystem.cleaning_source(tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                VALUES(%s,'prior-refill',%s,'prior',1,'REFILL','prior-refill','{}')''',(self.tenant,self.room))
            conn.execute("INSERT INTO prsystem.cleaning_action(tenant_id,source_id,id,kind,product_id,quantity) VALUES(%s,'prior-refill','refill','REFILL',%s,1)",(self.tenant,self.product))
        self.assertEqual(self.preview().json()['disposition'],'SCHEDULE_AFTER_STAY')
        q=self.assert_status(self.rollout(),201);self.assertEqual(q['state'],'SCHEDULED_AFTER_STAY');self.assertEqual(self.execution(q),[])
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.cleaning_action SET completed=1 WHERE tenant_id=%s AND source_id='prior-refill'",(self.tenant,))
            conn.execute('SELECT prsystem.advance_minibar_rollout(%s,%s)',(self.tenant,self.room))
        current=self.read().json()['pending'];self.assertEqual(current['state'],'READY_FOR_RECONCILIATION');self.assertEqual(current['revision'],2)
        self.assertEqual(len(self.execution(q)),1)

    def test_unfinished_checkout_count_blocks_early_assignment(self):
        self.prepared_room()
        with psycopg.connect(self.owner_dsn) as conn:
            # Historical checkout dependency fixture: persisted source, no guest API bypass.
            conn.execute('''INSERT INTO prsystem.cleaning_source(tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                VALUES(%s,'unfinished',%s,'prior',1,'CHECKOUT','unfinished','{}')''',(self.tenant,self.room))
            conn.execute("INSERT INTO prsystem.cleaning_action(tenant_id,source_id,id,kind,product_id,quantity) VALUES(%s,'unfinished','count','COUNT',%s,1)",(self.tenant,self.product))
        q=self.assert_status(self.rollout(),201)
        self.assertEqual(self.api(f'minibar/configuration-requests/{q["request_id"]}/prepare',dict(expected_revision=q['revision'],assignee_id=self.worker)).json()['code'],'RECONCILIATION_NOT_READY')
        self.assertEqual(self.execution(q),[])

    def test_current_roles_package_and_tenant_are_checked_before_retry(self):
        self.prepared_room();revision=self.revision();self.assert_status(self.rollout(key='same',revision=revision),201)
        self.assert_status(self.preview(token=self.worker_token),403)
        self.assert_status(self.rollout(token=self.worker_token),403)
        self.assert_status(self.preview(token=self.admin),403)
        self.assert_status(self.rollout(room=uuid4().hex),404)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.rollout(key='same',revision=revision),403)

    def test_cross_template_draft_and_inactive_targets_rejected(self):
        self.prepared_room()
        other=self.assert_status(self.api('minibar/templates',dict(name='Өөр загвар')),201)
        self.assertEqual(self.rollout(template=other['template_id']).status_code,404)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.minibar_product SET status='INACTIVE' WHERE tenant_id=%s AND id=%s",(self.tenant,self.product))
        self.assertEqual(self.preview().json()['code'],'PRODUCT_NOT_ACTIVE');self.assertEqual(self.rollout().json()['code'],'PRODUCT_NOT_ACTIVE')
        self.assertIsNone(self.read().json()['pending'])

    def test_room_revision_and_idempotency_payload_conflicts(self):
        self.prepared_room();revision=self.revision()
        self.assertEqual(self.rollout(revision=revision-1).json()['code'],'REVISION_CONFLICT')
        self.assert_status(self.rollout(key='same',revision=revision),201)
        self.assert_status(self.rollout(key='same',revision=revision+1),409)

    def test_concurrent_confirm_only_one_pending_task(self):
        self.prepared_room();revision=self.revision();barrier=Barrier(2)
        def post(_):barrier.wait();return self.rollout(revision=revision).status_code
        with ThreadPoolExecutor(2) as pool:self.assertEqual(sorted(pool.map(post,range(2))),[201,409])
        self.assertEqual(len(self.execution(self.read().json()['pending'])),1)

    def test_database_rejects_forged_rollout_lineage_and_unassigned_generic_task(self):
        self.target=self.version
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation),conn.transaction():
                conn.execute('''INSERT INTO prsystem.minibar_configuration_request(tenant_id,id,room_id,target_mode,target_template_id,target_version_id,source_snapshot,target_snapshot,state,requested_by,reason,request_kind)
                 VALUES(%s,'forged',%s,'ON',%s,%s,'{}','{}','READY_FOR_RECONCILIATION',%s,'forged','ROLLOUT')''',(self.tenant,self.room,self.template,self.version,self.manager))
            conn.execute('''INSERT INTO prsystem.cleaning_source(tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
                VALUES(%s,'generic',%s,'prior',1,'REFILL','generic','{}')''',(self.tenant,self.room))
            with self.assertRaises(psycopg.errors.CheckViolation),conn.transaction():
                conn.execute("INSERT INTO prsystem.cleaning_task(tenant_id,id,source_id) VALUES(%s,'generic','generic')",(self.tenant,))

    def test_commit_failure_rolls_back_request_blocker_task_and_receipt(self):
        self.prepared_room()
        from unittest.mock import patch
        from contextlib import contextmanager
        from prsystem.postgres.connection import transaction
        @contextmanager
        def broken(dsn):
            with transaction(dsn) as conn:
                yield conn
                raise psycopg.OperationalError('commit unavailable')
        with patch('prsystem.minibar_configuration.transaction',broken):self.assert_status(self.rollout(key='commit'),503)
        self.assertIsNone(self.read().json()['pending'])
        q=self.assert_status(self.rollout(key='commit'),201);self.assertEqual(len(self.execution(q)),1)
