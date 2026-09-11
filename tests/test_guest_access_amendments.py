import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta
from threading import Barrier
from postgres_support import ADMIN_DSN
from guest_finance_support import GuestFinanceCase
if ADMIN_DSN:
    import psycopg


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class GuestAccessAmendmentTests(GuestFinanceCase):
    def qr(self,revision=0,key='qr'):
        return self.client.post(f'/hotels/{self.tenant}/rooms/{self.room}/guest-qr',headers=self.headers(self.manager_token),json=dict(expected_revision=revision,idempotency_key=key,reason='Replace reception QR'))

    def redeem(self,qr,code):
        return self.client.post('/guest/access',json=dict(qr_token=qr,code=code))

    def access(self):
        qr=self.assert_status(self.qr(),200)['qr_token'];self.start()
        return qr,self.stay['guest_access_code']

    def test_one_use_code_session_and_rotation_revoke(self):
        qr,code=self.access()
        token=self.assert_status(self.redeem(qr,code),200)['access_token']
        self.assert_status(self.redeem(qr,code),401)
        self.assertEqual(self.client.get('/guest/session',headers=self.headers(token)).json()['room_number'],'101')
        rotated=self.assert_status(self.qr(1,'rotate'),200)
        self.assertNotEqual(rotated['qr_token'],qr)
        self.assert_status(self.client.get('/guest/session',headers=self.headers(token)),401)
        self.assert_status(self.qr(),409)
        with psycopg.connect(self.owner_dsn) as conn:
            audit=str(conn.execute('SELECT result FROM prsystem.staff_command_receipt WHERE tenant_id=%s',(self.tenant,)).fetchall())
            self.assertNotIn(qr,audit);self.assertNotIn(token,audit);self.assertNotIn(code,audit)

    def test_codes_and_sessions_share_capacity_and_revoke(self):
        qr,code=self.access();self.assert_status(self.redeem(qr,code),200)
        for i in range(4):self.assert_status(self.command('guest-codes',dict(idempotency_key='code-'+str(i))),201)
        self.assert_status(self.command('guest-codes',dict(idempotency_key='overflow')),409)
        self.assert_status(self.command('guest-access/revoke',dict(idempotency_key='revoke')),200)
        issued=self.assert_status(self.command('guest-codes',dict(idempotency_key='new')),201)
        self.assert_status(self.redeem(qr,issued['code']),200)

    def test_failed_attempts_commit_and_throttle(self):
        qr,code=self.access();wrong='000000' if code!='000000' else '111111'
        for _ in range(5):self.assert_status(self.redeem(qr,wrong),401)
        self.assert_status(self.redeem(qr,code),429)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT failures FROM prsystem.room_guest_qr WHERE tenant_id=%s',(self.tenant,)).fetchone()[0],5)

    def test_concurrent_redemption_only_one_session(self):
        qr,code=self.access();barrier=Barrier(2)
        def redeem(_):barrier.wait();return self.redeem(qr,code)
        with ThreadPoolExecutor(max_workers=2) as pool:responses=list(pool.map(redeem,range(2)))
        self.assertEqual(sorted(r.status_code for r in responses),[200,401])

    def amendment(self,actual=None,key='amend'):
        return self.command('time-amendments',dict(actual_checkin_at=actual or self.stay['actual_checkin_at'],reason='Correct recorded arrival',idempotency_key=key))

    def decision(self,amendment,approve=True,token=None,key='decide'):
        return self.command('time-amendments/'+amendment+'/decision',dict(approve=approve,reason='Reviewed arrival evidence',idempotency_key=key),token or self.manager_token)

    def test_amendment_pending_blocks_checkout_manager_decides_original_immutable(self):
        self.start();request=self.assert_status(self.amendment(),201)
        self.assertEqual(self.amendment().json(),request)
        self.assert_status(self.amendment(key='second'),409)
        self.assertEqual(self.command('checkout',dict(expected_revision=1,idempotency_key='close')).json()['code'],'AMENDMENT_PENDING')
        self.assert_status(self.decision(request['amendment_id'],token=self.admin),403)
        self.assert_status(self.decision(request['amendment_id']),200)
        self.assert_status(self.decision(request['amendment_id'],key='again'),409)
        with psycopg.connect(self.owner_dsn) as conn:
            original=conn.execute('SELECT actual_checkin_at,amount_mnt FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(self.tenant,self.stay['stay_id'])).fetchone()
            self.assertEqual(original,(datetime.fromisoformat(self.stay['actual_checkin_at']),80000))
        with self.assertRaises(psycopg.errors.CheckViolation),psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.stay_time_amendment SET state='REJECTED' WHERE tenant_id=%s",(self.tenant,))

    def test_time_bounds_and_rejection(self):
        self.start()
        bad=(datetime.fromisoformat(self.stay['check_in_recorded_at'])-timedelta(hours=3)).isoformat()
        self.assert_status(self.amendment(bad),422)
        request=self.assert_status(self.amendment(),201)
        self.assert_status(self.decision(request['amendment_id'],approve=False),200)
        self.assert_status(self.amendment(key='retry'),201)

    def test_printable_qr_card_is_manager_only_and_uses_configured_origin(self):
        from unittest.mock import patch
        self.qr()
        url=f'/hotels/{self.tenant}/rooms/{self.room}/guest-qr/card'
        with patch.dict('os.environ',{'PRSYSTEM_PUBLIC_ORIGIN':'https://hotel.example.com'}):
            data=self.assert_status(self.client.get(url,headers=self.headers(self.manager_token)),200)
            self.assertEqual(data['room_number'],'101');self.assertGreater(len(data['matrix']),20)
            self.assertEqual(set(data),{'room_number','revision','matrix'})
            self.assert_status(self.client.get(url,headers=self.headers(self.worker_token)),403)
        with patch.dict('os.environ',{'PRSYSTEM_PUBLIC_ORIGIN':'https://evil.example/path?token=x'}):
            response=self.client.get(url,headers=self.headers(self.manager_token))
            self.assertEqual(response.status_code,503)
            self.assertEqual(response.json(),{'code':'SERVICE_UNAVAILABLE'})
