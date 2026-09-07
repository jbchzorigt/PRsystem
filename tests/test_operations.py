import unittest
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase

@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class OperationsTests(GuestFinanceCase):
    def get(self,path,token=None):
        return self.client.get(f'/hotels/{self.tenant}/'+path,headers=self.headers(token or self.worker_token))

    def test_overview_has_no_blind_cash_or_private_guest_data(self):
        self.start()
        data=self.assert_status(self.get('operations'),200)
        self.assertTrue(data['drawers']);self.assertTrue(data['shifts'])
        for forbidden in ('expected_float','posted','opening_actual','document_number','envelope','token_hash'):
            self.assertNotIn(forbidden,str(data))
        cleaner,token=self.add_staff(['CLEANER'])
        data=self.assert_status(self.get('operations',token),200)
        for forbidden in ('staff','shifts','drawers','funding'):self.assertNotIn(forbidden,data)

    def test_shift_report_scopes_and_separates_deposit_cash_from_revenue(self):
        self.start()
        data=self.assert_status(self.get(f'shifts/{self.shift}/report'),200)
        self.assertEqual(data['gross_receipts'],[dict(purpose='DEPOSIT',channel='CASH',amount_mnt=60000)])
        self.assertEqual(data['note'],'SOURCE_SHIFT_TOTALS_NOT_REVENUE')
        self.assert_status(self.get(f'shifts/{self.shift}/report',self.replacement_token),403)
        self.assert_status(self.get(f'shifts/{self.shift}/report',self.admin_token),200)

    def test_manager_receiver_cannot_bypass_blind_handover_with_report(self):
        self.start()
        r=self.client.post(f'/hotels/{self.tenant}/handovers',headers=self.headers(self.worker_token),json=dict(actual=60000,receiver_id=self.manager,reason='Reception unavailable; manager takes custody',idempotency_key='submit'))
        self.assert_status(r,201)
        denied=self.get(f'shifts/{self.shift}/report',self.manager_token)
        self.assertEqual(denied.json()['code'],'PHYSICAL_COUNT_REQUIRED')
        r=self.client.post(f'/hotels/{self.tenant}/handovers/{r.json()["handover_id"]}/counts',headers=self.headers(self.manager_token),json=dict(actual=60000,idempotency_key='count'))
        self.assert_status(r,201)
        self.assert_status(self.get(f'shifts/{self.shift}/report',self.manager_token),200)

    def test_guest_detail_is_active_scoped_minimal_and_audited(self):
        self.start()
        data=self.assert_status(self.get(f'stays/{self.stay["stay_id"]}/guest'),200)
        self.assertEqual(set(data['guest']),{'family_name','given_name','identity_type'})
        _,token=self.add_staff(['CLEANER'])
        self.assert_status(self.get(f'stays/{self.stay["stay_id"]}/guest',token),403)
        self.assert_status(self.client.get('/hotels/foreign/operations',headers=self.headers(self.worker_token)),403)

    def test_console_served_with_private_csp_and_assets(self):
        r=self.client.get('/reception');self.assertEqual(r.status_code,200)
        self.assertIn("frame-ancestors 'none'",r.headers['content-security-policy'])
        self.assertEqual(r.headers['cache-control'],'no-store')
        for asset in ('reception.js','reception.css'):
            self.assertEqual(self.client.get('/staff/assets/'+asset).status_code,200)
