import hashlib
import json
import tempfile
import unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from prsystem.release_readiness import assess,GATES,PROVIDERS


class ReleaseEvidenceTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name);self.now=datetime.now(timezone.utc);self.sha='a'*40
        self.document=dict(source_revision=self.sha,runtime_mode='production',police_tracking_enabled=False,gates={})
        self.report=dict(status='PASS',source_revision=self.sha,recorded_at=self.now.isoformat(),expires_at=(self.now+timedelta(days=1)).isoformat(),reviewer_reference='FIXTURE-NOT-REAL-APPROVAL',tests=1,skipped=0,
            suites=1,api_commands=1,accessibility_findings=0,data_equal=True,migration_checksums_equal=True,roles_verified=True,key_recovery_verified=True,
            approved_target_reference='FIXTURE',errors=0,samples=100,p95_ms=10,budget_p95_ms=100,policy_reference='FIXTURE',legal_holds_verified=True,deletion_and_backup_expiry_verified=True,
            critical_findings=0,high_findings=0,secret_rotation_verified=True,providers={name:dict(mode='LIVE',contract_reference='FIXTURE',acceptance_reference='FIXTURE') for name in PROVIDERS})
        for gate in GATES:self.write(gate,self.report)

    def write(self,gate,report):
        data=json.dumps(report).encode();(self.root/(gate+'.json')).write_bytes(data)
        self.document['gates'][gate]=dict(artifact=gate+'.json',sha256=hashlib.sha256(data).hexdigest())

    def test_complete_fixture_evidence_is_validated(self):self.assertEqual(assess(self.document,self.sha,self.root,self.now)['status'],'PASS')
    def test_missing_changed_or_wrong_revision_evidence_blocks(self):
        for change in ['missing','changed','revision']:
            with self.subTest(change=change):
                if change=='missing':(self.root/'postgres.json').unlink()
                elif change=='changed':(self.root/'postgres.json').write_text('{}')
                else:self.write('postgres',{**self.report,'source_revision':'b'*40})
                self.assertIn('POSTGRES_EVIDENCE_REQUIRED',assess(self.document,self.sha,self.root,self.now)['issues'])
    def test_skips_and_expired_proofs_cannot_pass(self):
        self.write('postgres',{**self.report,'skipped':1});self.write('security',{**self.report,'expires_at':self.now.isoformat()})
        issues=assess(self.document,self.sha,self.root,self.now)['issues'];self.assertIn('POSTGRES_EVIDENCE_REQUIRED',issues);self.assertIn('SECURITY_EVIDENCE_REQUIRED',issues)
    def test_mock_provider_cannot_satisfy_live_acceptance(self):
        providers={**self.report['providers'],'sms':dict(mode='MOCK_ONLY',contract_reference='x',acceptance_reference='x')}
        self.write('providers',{**self.report,'providers':providers});self.assertIn('PROVIDERS_EVIDENCE_REQUIRED',assess(self.document,self.sha,self.root,self.now)['issues'])
    def test_restore_without_key_or_role_recovery_is_incomplete(self):
        self.write('restore',{**self.report,'roles_verified':False});self.assertIn('RESTORE_EVIDENCE_REQUIRED',assess(self.document,self.sha,self.root,self.now)['issues'])
    def test_paths_outside_evidence_root_are_rejected(self):
        self.document['gates']['postgres']['artifact']='../postgres.json';self.assertIn('POSTGRES_EVIDENCE_REQUIRED',assess(self.document,self.sha,self.root,self.now)['issues'])
    def test_unapproved_retention_and_tracking_enablement_block(self):
        self.document['police_tracking_enabled']=True;self.write('retention',{**self.report,'policy_reference':None})
        issues=assess(self.document,self.sha,self.root,self.now)['issues'];self.assertIn('RETENTION_EVIDENCE_REQUIRED',issues);self.assertIn('POLICE_TRACKING_MUST_REMAIN_DISABLED',issues)

    def test_false_strings_boolean_counts_and_nonfinite_measurements_fail_closed(self):
        for gate,field,value in [('restore','roles_verified','false'),('security','secret_rotation_verified','false'),('retention','legal_holds_verified','false'),('postgres','tests',True),('browser','suites',True),('load','p95_ms',float('nan'))]:
            with self.subTest(gate=gate,field=field):
                self.write(gate,{**self.report,field:value})
                self.assertIn(gate.upper()+'_EVIDENCE_REQUIRED',assess(self.document,self.sha,self.root,self.now)['issues'])

    def test_malformed_manifest_and_report_shapes_return_blocked(self):
        self.assertEqual(assess([],self.sha,self.root,self.now)['status'],'BLOCKED')
        self.write('postgres',[])
        self.assertIn('POSTGRES_EVIDENCE_REQUIRED',assess(self.document,self.sha,self.root,self.now)['issues'])
        self.document['gates']=None
        self.assertEqual(assess(self.document,self.sha,self.root,self.now)['status'],'BLOCKED')
