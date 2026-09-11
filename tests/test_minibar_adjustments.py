import unittest
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from minibar_configuration_support import MinibarConfigurationCase
from postgres_support import ADMIN_DSN
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    import test_minibar_guest as guest_support


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class MinibarAdjustmentTests(MinibarConfigurationCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT INSERT ON prsystem.minibar_adjustment TO {}',
                'GRANT SELECT,INSERT ON prsystem.minibar_adjustment_correction TO {}',
                'GRANT INSERT ON prsystem.minibar_reconciliation,prsystem.minibar_transfer,prsystem.minibar_configuration_application TO {}',
                'GRANT UPDATE(minibar_application_id) ON prsystem.room TO {}',
                'GRANT INSERT ON prsystem.minibar_guest_inspection,prsystem.minibar_guest_report TO {}',
            ):conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def preview(self,room=None):
        return self.assert_status(self.api(f'minibar/products/{self.product}/adjustment-preview'+('?room_id='+room if room else ''),method='get'),200)

    def adjust(self,kind='WASTE',quantity=1,room=None,token=None,**extra):
        c=self.preview(room)
        data=dict(kind=kind,quantity=quantity,room_id=room,expected_stay_id=c['stay_id'],expected_revision=c['stock_revision'],expected_physical_quantity=c['physical_quantity'],reason='Бодит тооллогын шалтгаан')
        data.update(extra)
        return self.api(f'minibar/products/{self.product}/adjustments',data,token)

    def history(self):
        return self.api(f'minibar/products/{self.product}/adjustments',method='get').json()['items']

    def guest(self):
        guest_support.MinibarGuestTests.configured(self);self.start()

    def report(self,actual,no_consumption):
        self.assert_status(guest_support.MinibarGuestTests.begin(self),200)
        self.task=self.assert_status(guest_support.MinibarGuestTests.claim(self),201)
        return guest_support.MinibarGuestTests.report(self,actual=actual,no_consumption=no_consumption)

    def test_warehouse_waste_reduces_quantity_and_exact_value_without_finance(self):
        r=self.assert_status(self.adjust(quantity=3),201)
        self.assertEqual((r['warehouse_quantity'],r['total_quantity'],r['inventory_value_mnt']),(7,7,'7000'))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.guest_charge WHERE tenant_id=%s AND kind='MINIBAR'",(self.tenant,)).fetchone()[0],0)
        self.assertEqual(self.history()[0]['reason'],'Бодит тооллогын шалтгаан')

    def test_room_return_preserves_hotel_quantity_and_value(self):
        self.guest();r=self.assert_status(self.adjust('RETURN',room=self.room),201)
        self.assertEqual((r['warehouse_quantity'],r['room_quantity'],r['total_quantity'],r['inventory_value_mnt']),(9,1,10,'10000'))
        report=self.assert_status(self.report(1,True),201)
        self.assertEqual(report['amount_mnt'],0)

    def test_room_waste_is_not_guest_consumption(self):
        self.guest();self.assert_status(self.adjust(room=self.room),201)
        r=self.assert_status(self.report(0,False),201);self.assertEqual(r['amount_mnt'],3000)
        with psycopg.connect(self.owner_dsn) as conn:
            line=conn.execute('SELECT items FROM prsystem.reception_minibar_report WHERE tenant_id=%s',(self.tenant,)).fetchone()[0][0]
            self.assertEqual((line['non_guest_delta'],line['available_quantity'],line['used_quantity']),(-1,1,1))
            self.assertEqual(len(line['adjustment_ids']),1)

    def test_positive_room_adjustment_does_not_add_billable_quantity(self):
        self.guest();self.assert_status(self.adjust('COUNT_PLUS',room=self.room),201)
        self.assertEqual(self.assert_status(self.report(3,True),201)['amount_mnt'],0)

    def test_unexplained_loss_of_generic_extra_requires_manager_adjustment(self):
        self.guest();self.assert_status(self.adjust('COUNT_PLUS',room=self.room),201)
        self.assertEqual(self.report(2,True).json()['code'],'COUNT_VARIANCE')
        self.assert_status(self.adjust('COUNT_MINUS',room=self.room),201)
        self.assert_status(guest_support.MinibarGuestTests.report(self,actual=2,no_consumption=True),201)

    def test_zero_stock_positive_adjustment_requires_explicit_cost(self):
        self.assert_status(self.adjust(quantity=10),201)
        self.assert_status(self.adjust('COUNT_PLUS'),422)
        r=self.assert_status(self.adjust('COUNT_PLUS',quantity=2,unit_cost_mnt=1500),201)
        self.assertEqual(r['inventory_value_mnt'],'3000')

    def test_existing_average_cannot_be_overridden(self):
        self.assert_status(self.adjust('COUNT_PLUS',unit_cost_mnt=1),422)
        self.assertEqual(self.preview()['total_quantity'],10)

    def test_fractional_average_and_original_reversal_cost(self):
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=5,unit_cost_mnt=2000,expected_revision=1)),201)
        r=self.assert_status(self.adjust(quantity=1),201)
        self.assertEqual(r['inventory_value_exact'],dict(numerator='56000',denominator='3'))
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=3000,expected_revision=3)),201)
        x=self.assert_status(self.adjust('REVERSAL',original_id=r['adjustment_id']),201)
        self.assertEqual(x['inventory_value_exact'],dict(numerator='23000',denominator='1'))
        self.assertEqual(x['total_quantity'],16)

    def test_return_reversal_restores_room_and_billable_availability(self):
        self.guest();r=self.assert_status(self.adjust('RETURN',room=self.room),201)
        self.assert_status(self.adjust('REVERSAL',room=self.room,original_id=r['adjustment_id']),201)
        self.assertEqual(self.assert_status(self.report(1,False),201)['amount_mnt'],3000)

    def test_reversal_once_and_reversal_of_reversal_forbidden(self):
        r=self.assert_status(self.adjust(),201)
        x=self.assert_status(self.adjust('REVERSAL',original_id=r['adjustment_id']),201)
        self.assert_status(self.adjust('REVERSAL',original_id=r['adjustment_id']),409)
        self.assert_status(self.adjust('REVERSAL',original_id=x['adjustment_id']),409)

    def test_warehouse_cannot_spend_stock_in_rooms(self):
        self.guest();self.assert_status(self.adjust(quantity=9),409)
        self.assertEqual(self.preview()['total_quantity'],10)

    def test_wrong_stay_and_room_quantity_are_rejected(self):
        self.guest();self.assert_status(self.adjust(room=self.room,expected_stay_id='wrong'),409)
        self.assert_status(self.adjust(room=self.room,quantity=3),409)
        self.assertEqual(self.preview(self.room)['physical_quantity'],2)

    def test_posted_report_locks_further_adjustments(self):
        self.guest();self.assert_status(self.report(1,False),201)
        self.assertEqual(self.adjust(room=self.room).json()['code'],'STOCK_ADJUSTMENT_LOCKED')

    def test_current_manager_authority_and_package_required_before_retry(self):
        key=uuid4().hex;r=self.assert_status(self.adjust(idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.adjust(expected_revision=1,expected_physical_quantity=10,idempotency_key=key),201),r)
        self.assert_status(self.adjust(expected_revision=1,expected_physical_quantity=10,idempotency_key=key,token=self.worker_token),403)
        self.assert_status(self.adjust(token=self.admin),403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=20000 WHERE tenant_id=%s',(self.tenant,))
        self.assert_status(self.api(f'minibar/products/{self.product}/adjustments',dict(kind='WASTE',quantity=1,expected_revision=1,expected_physical_quantity=9,reason='Reason')),403)

    def test_reason_direction_and_payload_validation(self):
        for extra in (dict(reason=''),dict(quantity=0),dict(quantity=True),dict(kind='OTHER')):
            self.assert_status(self.adjust(**extra),422)
        self.assert_status(self.adjust('RETURN'),422)
        self.assert_status(self.adjust(original_id='foreign'),422)
        self.assertEqual(self.preview()['total_quantity'],10)

    def test_current_product_inactive_allows_controlled_stock_out(self):
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.minibar_product SET status='INACTIVE' WHERE tenant_id=%s AND id=%s",(self.tenant,self.product))
        self.assert_status(self.adjust(),201)

    def test_concurrent_stock_changes_have_one_revision_winner(self):
        gate=Barrier(2)
        def command():
            gate.wait()
            return self.api(f'minibar/products/{self.product}/adjustments',dict(kind='WASTE',quantity=6,expected_revision=1,expected_physical_quantity=10,reason='Concurrent'))
        with ThreadPoolExecutor(2) as pool:r=[f.result() for f in(pool.submit(command),pool.submit(command))]
        self.assertEqual(sorted(x.status_code for x in r),[201,409]);self.assertEqual(self.preview()['total_quantity'],4)

    def test_history_is_tenant_scoped_immutable_and_bounded(self):
        self.assert_status(self.adjust(),201);self.assert_status(self.adjust(),201)
        with psycopg.connect(self.app_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_adjustment').fetchone()[0],0)
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):conn.execute("UPDATE prsystem.minibar_adjustment SET reason='changed' WHERE tenant_id=%s",(self.tenant,))
        first=self.api(f'minibar/products/{self.product}/adjustments?limit=1',method='get').json()
        second=self.api(f'minibar/products/{self.product}/adjustments?limit=1&after='+first['next_after'],method='get').json()
        self.assertEqual(len(first['items'])+len(second['items']),2)
        self.assertNotEqual(first['items'][0]['adjustment_id'],second['items'][0]['adjustment_id'])

    def test_deferred_failure_rolls_back_inventory_and_receipt_for_retry(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_adjustment AFTER INSERT ON prsystem.minibar_adjustment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_adjustment()').format(sql.Literal(self.tenant)))
        key=uuid4().hex
        try:self.assert_status(self.adjust(idempotency_key=key),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_adjustment ON prsystem.minibar_adjustment');conn.execute('DROP FUNCTION prsystem.fail_adjustment()')
        self.assertEqual(self.preview()['total_quantity'],10)
        self.assert_status(self.adjust(idempotency_key=key),201)

    def test_database_rejects_adjustment_without_matching_receipt(self):
        with psycopg.connect(self.owner_dsn) as conn:
            receipt=conn.execute('SELECT id,actor_id FROM prsystem.minibar_receipt WHERE tenant_id=%s AND product_id=%s',(self.tenant,self.product)).fetchone()
            with self.assertRaises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    conn.execute("INSERT INTO prsystem.minibar_adjustment(tenant_id,id,product_id,kind,quantity,hotel_delta,room_delta,billable_delta,receipt_id,actor_id,actor_roles,package_mnt,reason) VALUES(%s,%s,%s,'WASTE',1,-1,0,0,%s,%s,ARRAY['MANAGER'],30000,'Direct forged source')",(self.tenant,uuid4().hex,self.product,receipt[0],receipt[1]))
                    conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
        self.assertEqual(self.preview()['total_quantity'],10)

    def test_original_cost_reversal_cannot_strand_value_at_zero_stock(self):
        original=self.assert_status(self.adjust('COUNT_PLUS',quantity=2),201)
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=1,unit_cost_mnt=2000,expected_revision=2)),201)
        self.assert_status(self.adjust(quantity=11),201)
        before=self.preview()
        self.assertEqual(self.adjust('REVERSAL',quantity=2,original_id=original['adjustment_id']).json()['code'],'ADJUSTMENT_COST_CONFLICT')
        self.assertEqual(self.preview(),before)

    def test_physical_preview_stale_after_transfer_is_rejected(self):
        before=self.preview()
        guest_support.MinibarGuestTests.configured(self)
        current=self.preview()
        self.assertEqual(before['stock_revision'],current['stock_revision'])
        self.assertNotEqual(before['physical_quantity'],current['physical_quantity'])
        r=self.adjust(expected_physical_quantity=before['physical_quantity'])
        self.assertEqual(r.json()['code'],'REVISION_CONFLICT')
        self.assertEqual(self.preview(),current)

    def correct(self,original,kind='WASTE',quantity=1,room=None,token=None,**extra):
        c=self.preview(room)
        data=dict(kind=kind,quantity=quantity,room_id=room,expected_stay_id=c['stay_id'],expected_revision=c['stock_revision'],expected_physical_quantity=c['physical_quantity'],original_id=original['adjustment_id'],reason='Буруу хөдөлгөөнийг зөвөөр солих')
        data.update(extra)
        return self.api(f'minibar/products/{self.product}/adjustment-corrections',data,token)

    def test_atomic_replacement_preserves_original_and_links_both_movements(self):
        original=self.assert_status(self.adjust(quantity=3),201)
        r=self.assert_status(self.correct(original,quantity=2),201)
        self.assertEqual(r['replacement']['total_quantity'],8)
        self.assertEqual(r['replacement']['inventory_value_mnt'],'8000')
        items=self.history();self.assertEqual(len(items),3)
        self.assertEqual(len([i for i in items if i['correction_id']==r['correction_id']]),2)
        self.assertTrue(next(i for i in items if i['adjustment_id']==original['adjustment_id'])['reversed'])
        self.assert_status(self.correct(original),409)
        # A later correction can target the replacement, retaining the chain.
        second=self.assert_status(self.correct(r['replacement']),201)
        self.assertEqual(second['replacement']['total_quantity'],9)

    def test_replacement_failure_rolls_back_reversal_and_allows_exact_retry(self):
        original=self.assert_status(self.adjust(quantity=3),201);before=self.preview()
        r=self.correct(original,quantity=11)
        self.assertEqual(r.json()['code'],'INSUFFICIENT_STOCK');self.assertEqual(self.preview(),before)
        self.assertEqual(len(self.history()),1)
        self.assert_status(self.correct(original,quantity=2),201)

    def test_atomic_correction_uses_original_reversal_and_restored_average(self):
        original=self.assert_status(self.adjust(quantity=2),201)
        self.assert_status(self.api(f'minibar/products/{self.product}/receipts',dict(quantity=2,unit_cost_mnt=2000,expected_revision=2)),201)
        r=self.assert_status(self.correct(original,quantity=3),201)
        self.assertEqual(r['replacement']['inventory_value_exact'],dict(numerator='10500',denominator='1'))
        with psycopg.connect(self.owner_dsn) as conn:
            cost=conn.execute('SELECT cost_numerator,cost_denominator FROM prsystem.minibar_receipt WHERE tenant_id=%s AND id=%s',(self.tenant,r['reversal']['receipt_id'])).fetchone()
            self.assertEqual(cost,(1000,1))

    def test_atomic_room_reclassification_preserves_non_guest_exclusion(self):
        self.guest();original=self.assert_status(self.adjust(room=self.room),201)
        r=self.assert_status(self.correct(original,kind='RETURN',room=self.room),201)
        self.assertEqual((r['replacement']['total_quantity'],r['replacement']['room_quantity']),(10,1))
        self.assertEqual(self.assert_status(self.report(1,True),201)['amount_mnt'],0)
        self.assertEqual(self.correct(r['replacement'],room=self.room).json()['code'],'STOCK_ADJUSTMENT_LOCKED')

    def test_atomic_correction_idempotency_current_authority_and_stale_preview(self):
        original=self.assert_status(self.adjust(quantity=3),201);key=uuid4().hex
        r=self.assert_status(self.correct(original,quantity=2,idempotency_key=key),201)
        self.assertEqual(self.assert_status(self.correct(original,quantity=2,expected_revision=2,expected_physical_quantity=7,idempotency_key=key),201),r)
        self.assert_status(self.correct(original,quantity=2,idempotency_key=key,token=self.worker_token),403)
        self.assertEqual(self.correct(r['replacement'],expected_revision=2).json()['code'],'REVISION_CONFLICT')
        self.assert_status(self.correct(r['replacement'],kind='REVERSAL'),422)

    def test_concurrent_atomic_corrections_have_one_winner(self):
        original=self.assert_status(self.adjust(quantity=3),201);gate=Barrier(2)
        def send():
            gate.wait()
            return self.correct(original,quantity=2,expected_revision=2,expected_physical_quantity=7)
        with ThreadPoolExecutor(2) as pool:r=[f.result() for f in(pool.submit(send),pool.submit(send))]
        self.assertEqual(sorted(x.status_code for x in r),[201,409]);self.assertEqual(len(self.history()),3)

    def test_correction_proof_and_history_are_tenant_scoped_and_immutable(self):
        original=self.assert_status(self.adjust(),201)
        r=self.assert_status(self.correct(original,quantity=2),201)
        with psycopg.connect(self.app_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.minibar_adjustment_correction').fetchone()[0],0)
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute("UPDATE prsystem.minibar_adjustment_correction SET reason='Changed' WHERE tenant_id=%s",(self.tenant,))
        with psycopg.connect(self.owner_dsn) as conn:
            actor=conn.execute('SELECT actor_id FROM prsystem.minibar_adjustment WHERE tenant_id=%s AND id=%s',(self.tenant,original['adjustment_id'])).fetchone()[0]
            with self.assertRaises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    conn.execute('INSERT INTO prsystem.minibar_adjustment_correction(tenant_id,id,original_id,reversal_id,replacement_id,actor_id,reason) VALUES(%s,%s,%s,%s,%s,%s,%s)',(self.tenant,uuid4().hex,r['replacement']['adjustment_id'],uuid4().hex,uuid4().hex,actor,'Unmatched source'))
                    # Run the proof ahead of missing-reference FK checks.
                    conn.execute('SET CONSTRAINTS prsystem.prove_correction IMMEDIATE')

    def test_deferred_correction_failure_rolls_back_both_movements_and_receipt(self):
        original=self.assert_status(self.adjust(quantity=3),201);before=self.preview();key=uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END; $$")
            conn.execute(sql.SQL('CREATE CONSTRAINT TRIGGER fail_correction AFTER INSERT ON prsystem.minibar_adjustment_correction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.tenant_id={}) EXECUTE FUNCTION prsystem.fail_correction()').format(sql.Literal(self.tenant)))
        try:self.assert_status(self.correct(original,quantity=2,idempotency_key=key),503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_correction ON prsystem.minibar_adjustment_correction');conn.execute('DROP FUNCTION prsystem.fail_correction()')
        self.assertEqual(self.preview(),before);self.assertEqual(len(self.history()),1)
        self.assert_status(self.correct(original,quantity=2,idempotency_key=key),201)
