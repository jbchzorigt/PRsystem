import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_guest as guest_support


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarLifecycleTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT,INSERT ON prsystem.minibar_lifecycle_intent,prsystem.minibar_lifecycle_completion TO {}',
                'GRANT UPDATE(status,revision,deactivation_requested_at) ON prsystem.minibar_product TO {}',
                'GRANT UPDATE(status,revision) ON prsystem.minibar_template TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
                'GRANT INSERT ON prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def preview(self,kind='products',identity=None,token=None):
        return self.api(f'minibar/{kind}/{identity or self.product}/lifecycle',token=token,method='get')

    def change(self,kind='products',identity=None,action='DEACTIVATE',revision=None,token=None,**extra):
        identity=identity or self.product
        if revision is None:revision=self.assert_status(self.preview(kind,identity),200)['revision']
        return self.api(f'minibar/{kind}/{identity}/lifecycle',dict(action=action,expected_revision=revision,reason='Бүрдлээс гаргах',**extra),token)

    def test_product_retirement_blocks_new_template_and_receipt_but_retains_stock(self):
        before=self.api('minibar/products',method='get').json()['items'][0]
        result=self.assert_status(self.change(),200)
        self.assertEqual(result['status'],'RETIRING')
        self.assertIn('ACTIVE_TEMPLATE',[b['kind'] for b in result['blockers']])
        after=self.api('minibar/products',method='get').json()['items'][0]
        self.assertEqual((after['total_quantity'],after['inventory_value_exact']),(before['total_quantity'],before['inventory_value_exact']))
        self.assertEqual(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=1000,expected_revision=1)).json()['code'],'PRODUCT_NOT_ACTIVE')

    def test_template_deactivation_resolves_waiting_product_and_preserves_published_history(self):
        self.assert_status(self.change(),200)
        self.assertEqual(self.assert_status(self.change('templates',self.template),200)['status'],'INACTIVE')
        self.assertEqual(self.preview().json()['status'],'INACTIVE')
        self.assertEqual(self.api(self.version_path(),method='get').json()['version']['state'],'PUBLISHED')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_lifecycle_completion WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],1)

    def test_reactivation_requires_active_template_products(self):
        self.assert_status(self.change(),200);self.assert_status(self.change('templates',self.template),200)
        self.assertEqual(self.change('templates',self.template,action='REACTIVATE').json()['code'],'PRODUCT_NOT_ACTIVE')
        self.assert_status(self.change(action='REACTIVATE'),200)
        self.assertEqual(self.assert_status(self.change('templates',self.template,action='REACTIVATE'),200)['status'],'ACTIVE')

    def test_cancel_retirement_restores_new_work_without_rewriting_intent(self):
        self.assert_status(self.change(),200)
        self.assertEqual(self.assert_status(self.change(action='CANCEL_RETIRING'),200)['status'],'ACTIVE')
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=1000,expected_revision=1)),201)
        with psycopg.connect(self.owner_dsn) as conn:
            events=conn.execute('SELECT after_snapshot FROM prsystem.minibar_lifecycle_intent WHERE tenant_id=%s ORDER BY recorded_at',(self.tenant,)).fetchall()
            self.assertEqual([r[0]['status'] for r in events],['RETIRING','ACTIVE'])

    def test_replay_cas_conflict_and_current_authority(self):
        key=uuid4().hex
        first=self.assert_status(self.change(revision=1,idempotency_key=key),200)
        self.assertEqual(self.assert_status(self.change(revision=1,idempotency_key=key),200),first)
        self.assert_status(self.change(action='CANCEL_RETIRING',revision=1),409)
        self.assert_status(self.change(revision=1,idempotency_key=key,reason='Changed reason'),409)
        self.assert_status(self.change(revision=1,token=self.worker_token,idempotency_key=key),403)

    def test_cross_tenant_or_unknown_entity_cannot_be_changed(self):
        self.assert_status(self.preview(identity='missing'),404)
        other=self.client.post(f'/hotels/other/minibar/products/{self.product}/lifecycle',headers=self.headers(self.manager_token),json=dict(action='DEACTIVATE',expected_revision=1,reason='Other hotel',idempotency_key=uuid4().hex))
        self.assert_status(other,403)
        self.assertEqual(self.preview().json()['status'],'ACTIVE')

    def test_reason_and_transition_are_mandatory(self):
        self.assert_status(self.change(reason=''),422)
        self.assert_status(self.change(action='RETIRING'),422)
        self.assert_status(self.change(action='REACTIVATE'),409)
        self.assertEqual(self.preview().json()['status'],'ACTIVE')

    def test_manager_plus_obeys_package_intersection(self):
        _,token=self.add_staff(['MANAGER_PLUS'])
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=25000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.change(token=token,revision=1),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=30000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.change(token=token,revision=1),200)

    def test_hotel_admin_without_manager_cannot_change_lifecycle(self):
        _,token=self.add_staff(['HOTEL_ADMIN'])
        self.assert_status(self.change(token=token,revision=1),403)

    def test_concurrent_deactivation_and_cancel_have_one_revision_winner(self):
        gate=Barrier(2)
        def change():gate.wait();return self.change(revision=1)
        with ThreadPoolExecutor(2) as pool:results=[r.result() for r in(pool.submit(change),pool.submit(change))]
        self.assertEqual(sorted(r.status_code for r in results),[200,409])

    def test_deferred_failure_rolls_back_status_and_audit_then_retry_succeeds(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_lifecycle AFTER INSERT ON prsystem.minibar_lifecycle_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_lifecycle()').format(sql.Literal(self.tenant)))
        key=uuid4().hex
        try:self.assert_status(self.change(revision=1,idempotency_key=key),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_lifecycle ON prsystem.minibar_lifecycle_intent');conn.execute('DROP FUNCTION prsystem.fail_lifecycle()')
        self.assertEqual(self.preview().json()['status'],'ACTIVE')
        self.assert_status(self.change(revision=1,idempotency_key=key),200)

    def test_history_is_immutable_and_tenant_scoped(self):
        self.assert_status(self.change(),200)
        with psycopg.connect(self.app_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_lifecycle_intent').fetchone()[0],0)
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):conn.execute("UPDATE prsystem.minibar_lifecycle_intent SET reason='changed' WHERE tenant_id=%s",(self.tenant,))

    def test_room_stock_and_current_assignment_preserve_retiring_template_until_off_applies(self):
        guest_support.MinibarGuestTests.configured(self)
        state=self.assert_status(self.change('templates',self.template),200)
        self.assertEqual(state['status'],'RETIRING')
        q=self.assert_status(self.request(target_mode='OFF',target_template_id=None,target_version_id=None),201)
        task=self.assert_status(self.api(f'minibar/configuration-requests/{q["request_id"]}/prepare',dict(expected_revision=q['revision'],assignee_id=self.worker)),201)
        detail=self.api('minibar/reconciliation/tasks',token=self.worker_token,method='get').json()['items'][0]
        for line in detail['plan']['lines']:
            self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/count',dict(assignment_version=0,action_id=line['action_id'],actual_count=line['baseline_quantity']),self.worker_token),200)
        detail=self.api('minibar/reconciliation/tasks',token=self.worker_token,method='get').json()['items'][0]
        self.assert_status(self.api(f'minibar/reconciliation/tasks/{task["task_id"]}/apply',dict(assignment_version=0,expected_revision=detail['request']['revision'],physical_transfers_confirmed=True),self.worker_token),200)
        self.assertEqual(self.preview('templates',self.template).json()['status'],'INACTIVE')
        self.assertEqual(self.api('minibar/products',method='get').json()['items'][0]['total_quantity'],10)

    def test_active_stay_keeps_locked_book_when_product_is_retiring(self):
        guest_support.MinibarGuestTests.configured(self);self.start()
        book=self.stay['snapshot']['minibar_snapshot']
        self.assertEqual(self.assert_status(self.change(),200)['status'],'RETIRING')
        self.assert_status(guest_support.MinibarGuestTests.begin(self),200)
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201)
        report=self.assert_status(guest_support.MinibarGuestTests.report(self),201)
        self.assertEqual(report['amount_mnt'],book['items'][0]['unit_price'])

    def test_template_initial_inactive_must_be_activated_before_authoring(self):
        template=self.assert_status(self.api('minibar/templates',dict(name='Дараа ашиглах',status='INACTIVE')),201)
        self.assertEqual(template['status'],'INACTIVE')
        self.assertEqual(self.api(f'minibar/templates/{template["template_id"]}/versions',dict(expected_revision=1)).json()['code'],'TEMPLATE_NOT_ACTIVE')
        self.assert_status(self.change('templates',template['template_id'],action='REACTIVATE'),200)
        self.assert_status(self.api(f'minibar/templates/{template["template_id"]}/versions',dict(expected_revision=2)),201)
