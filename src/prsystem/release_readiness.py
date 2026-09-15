"""Fail-closed deployment evidence checks; this does not approve a release."""
import argparse
import hashlib
import json
import math
import re
from datetime import datetime,timezone
from pathlib import Path


GATES=('postgres','browser','security','restore','load','retention','providers')
PROVIDERS=('identity_verification','payments','sms','email','bank_settlement','ebarimt')


def assess(document,source_revision,root,now=None):
    now=now or datetime.now(timezone.utc);root=Path(root).resolve();issues=[]
    if not isinstance(document,dict):document={};issues.append('INVALID_MANIFEST')
    if not re.fullmatch(r'[0-9a-f]{40}',source_revision):issues.append('INVALID_SOURCE_REVISION')
    if document.get('source_revision')!=source_revision:issues.append('SOURCE_REVISION_MISMATCH')
    if document.get('runtime_mode')!='production':issues.append('PRODUCTION_RUNTIME_REQUIRED')
    if document.get('police_tracking_enabled') is not False:issues.append('POLICE_TRACKING_MUST_REMAIN_DISABLED')
    for gate in GATES:
        try:
            evidence=document.get('gates',{}).get(gate,{})
            path=(root/evidence['artifact']).resolve()
            if not path.is_relative_to(root) or not path.is_file():raise ValueError()
            raw=path.read_bytes()
            if len(raw)>2_000_000 or hashlib.sha256(raw).hexdigest()!=evidence['sha256']:raise ValueError()
            report=json.loads(raw)
            at=datetime.fromisoformat(report['recorded_at']);expires=datetime.fromisoformat(report['expires_at'])
            if at.tzinfo is None or expires.tzinfo is None or not at<=now<expires:raise ValueError()
            if report.get('status')!='PASS' or report.get('source_revision')!=source_revision or not report.get('reviewer_reference'):raise ValueError()
            counts={'postgres':('tests','skipped'),'browser':('suites','api_commands','accessibility_findings'),'security':('critical_findings','high_findings'),'load':('samples','errors')}.get(gate,())
            if any(type(report.get(k)) is not int or report[k]<0 for k in counts):raise ValueError()
            if gate=='postgres' and (report['tests']<1 or report['skipped']!=0):raise ValueError()
            if gate=='browser' and (report['suites']<1 or report['api_commands']<1 or report['accessibility_findings']!=0):raise ValueError()
            if gate=='restore' and any(report.get(k) is not True for k in ('data_equal','migration_checksums_equal','roles_verified','key_recovery_verified')):raise ValueError()
            if gate=='load' and any(type(report.get(k)) not in (int,float) or not math.isfinite(report[k]) or report[k]<0 for k in ('samples','p95_ms','budget_p95_ms','errors')):raise ValueError()
            if gate=='load' and (not report.get('approved_target_reference') or report.get('errors')!=0 or report.get('samples',0)<1 or report.get('p95_ms',float('inf'))>report.get('budget_p95_ms',0)):raise ValueError()
            if gate=='retention' and (not report.get('policy_reference') or report.get('legal_holds_verified') is not True or report.get('deletion_and_backup_expiry_verified') is not True):raise ValueError()
            if gate=='security' and (report['critical_findings']!=0 or report['high_findings']!=0 or report.get('secret_rotation_verified') is not True):raise ValueError()
            if gate=='providers':
                for name in PROVIDERS:
                    provider=report.get('providers',{}).get(name,{})
                    if provider.get('mode')!='LIVE' or not provider.get('contract_reference') or not provider.get('acceptance_reference'):raise ValueError()
        except (AttributeError,KeyError,ValueError,TypeError,OSError):issues.append(gate.upper()+'_EVIDENCE_REQUIRED')
    return dict(status='BLOCKED' if issues else 'PASS',source_revision=source_revision,issues=issues,
                meaning='Evidence is validated for review; deployment still requires its authorized release action.')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('manifest',type=Path);parser.add_argument('--source-revision',required=True)
    args=parser.parse_args();result=assess(json.loads(args.manifest.read_text()),args.source_revision,args.manifest.parent)
    print(json.dumps(result,indent=2));return 0 if result['status']=='PASS' else 1


if __name__=='__main__':raise SystemExit(main())
