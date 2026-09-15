import tempfile
import unittest
from datetime import datetime,timezone
from pathlib import Path
from uuid import uuid4
from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.auth import StaffAuth
    from prsystem.platform import PlatformService
    from prsystem.operation_dashboard import OperationDashboard
    from prsystem.mock_providers import MockStore,MockSMSGateway,MockEbarimtGateway
    from prsystem.mfa import totp


from operation_support import OperationCase


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class OperationDashboardTests(OperationCase):
    def test_dashboard_masking_current_packages_and_keyset_page(self):
        r=self.ok(self.oc.get('/platform/operation',params={'query':'Operation '+self.tenant,'limit':1},headers=self.headers(self.ot)))
        self.assertEqual(len(r['items']),1);self.assertEqual(r['items'][0]['package_mnt'],30000)
        self.assertNotIn(self.email,str(r));self.assertNotIn('99112233',str(r));self.assertEqual(r['total'],sum(r['statuses'].values()))
        self.assertEqual(r['total'],sum(r['packages'].values()))

    def test_sms_preview_dedup_confirm_and_double_send(self):
        p=self.preview();self.assertEqual(p['quote']['recipient_count'],1);self.assertEqual(p['deduplicated'],1)
        key=uuid4().hex;a=self.ok(self.command('sms/'+p['draft_id']+'/send',dict(reviewed=True),key),202)
        self.assertEqual(self.ok(self.command('sms/'+p['draft_id']+'/send',dict(reviewed=True),key),202),a)
        self.assertEqual(self.command('sms/'+p['draft_id']+'/send',dict(reviewed=True)).status_code,409)

    def test_changed_contact_invalidates_preview(self):
        p=self.preview()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.subscription_owner SET original_contact=jsonb_set(original_contact,'{phone}','\"88112233\"') WHERE id=(SELECT owner_id FROM prsystem.hotel_subscription WHERE tenant_id=%s)",(self.tenant,))
        self.assertEqual(self.command('sms/'+p['draft_id']+'/send',dict(reviewed=True)).json()['code'],'SMS_PREVIEW_STALE')

    def test_changed_status_invalidates_preview(self):
        p=self.preview()
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.command('sms/'+p['draft_id']+'/send',dict(reviewed=True)).json()['code'],'SMS_PREVIEW_STALE')

    def test_unknown_delivery_reconciles_without_second_send(self):
        _,rid=self.queued();original=self.sms.send
        def uncertain(*args):original(*args);raise TimeoutError()
        self.sms.send=uncertain
        self.assertEqual(self.service._sms_one(rid)['state'],'UNKNOWN')
        self.assertEqual(self.command('sms/recipients/'+rid+'/retry',dict(expected_revision=2)).status_code,409)
        self.sms.send=lambda *args: (_ for _ in ()).throw(AssertionError('must not resend'))
        self.assertEqual(self.service._sms_one(rid)['state'],'SENT')
        with self.store.connect() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM mock_sms').fetchone()[0],1)

    def test_delivery_isolates_confirmed_failure_and_manual_retry(self):
        _,rid=self.queued();self.service._sms_one(rid);self.sms.set_status(rid,1,'FAILED');self.service._sms_one(rid)
        self.ok(self.command('sms/recipients/'+rid+'/retry',dict(expected_revision=3)))
        self.assertEqual(self.service._sms_one(rid)['state'],'SENT')
        self.assertEqual(self.sms.lookup(rid,2)['attempt'],2)

    def test_cancel_queued_delivery_never_sends(self):
        _,rid=self.queued();self.ok(self.command('sms/recipients/'+rid+'/cancel',dict(expected_revision=0)))
        self.assertEqual(self.service._sms_one(rid)['state'],'SKIPPED')
        with self.store.connect() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM mock_sms').fetchone()[0],0)

    def test_recent_mfa_and_staff_realm_are_required(self):
        p=self.preview()
        self.assertEqual(self.command('sms/'+p['draft_id']+'/send',dict(reviewed=True),token=self.token()).status_code,401)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.platform_session SET mfa_at=now()-interval '10 minutes' WHERE account_id=%s",(self.pid,))
        self.assertEqual(self.command('sms/'+p['draft_id']+'/send',dict(reviewed=True)).json()['code'],'MFA_REQUIRED')

    def test_idle_session_expires(self):
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.platform_session SET last_seen_at=now()-interval '30 minutes' WHERE account_id=%s",(self.pid,))
        self.assertEqual(self.oc.get('/platform/operation',headers=self.headers(self.ot)).status_code,401)

    def test_reset_uses_canonical_primary_email_only(self):
        r=self.ok(self.command('hotels/'+self.tenant+'/password-reset',dict(reviewed=True)),202)
        self.assertNotIn(self.email,str(r))
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.password_reset_request WHERE email=%s',(self.email,)).fetchone()[0],1)
        self.assertEqual(self.command('hotels/'+self.tenant+'/password-reset',dict(reviewed=True,email='attacker@example.test')).status_code,422)

    def test_mock_receipt_is_source_bound_and_retry_uses_same_job(self):
        body=dict(source_kind='ONBOARDING',source_id=self.attempt,reason='Баримт дахин шалгах')
        job=self.ok(self.command('billing/ebarimt',body),202)['job_id']
        self.service.billing_once()
        retry=self.ok(self.command('billing/ebarimt',body),202);self.assertEqual(retry['job_id'],job)
        self.service.billing_once()
        with self.store.connect() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM mock_ebarimt').fetchone()[0],1)
        with psycopg.connect(self.owner_dsn) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.operation_billing_result WHERE job_id=%s',(job,)).fetchone()[0],2)

    def test_current_permission_removal_revokes_session(self):
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.platform_account SET permissions='{}' WHERE id=%s",(self.pid,))
        self.assertEqual(self.oc.get('/platform/operation',headers=self.headers(self.ot)).status_code,401)

    def test_concurrent_dashboard_reads_do_not_serialize_on_snapshot_activity(self):
        from concurrent.futures import ThreadPoolExecutor
        def read(_):return self.oc.get('/platform/operation',headers=self.headers(self.ot)).status_code
        with ThreadPoolExecutor(max_workers=4) as pool:self.assertEqual(list(pool.map(read,range(8))),[200]*8)
