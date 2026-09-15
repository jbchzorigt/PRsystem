"""Read-only, tenant-scoped retention inventory. Never emits guest identities."""
import argparse
import json
import os
from pathlib import Path
from prsystem.postgres.connection import transaction


def inventory(dsn,tenant,policy):
    with transaction(dsn,isolation='repeatable read') as conn:
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        row=conn.execute('''SELECT count(*),count(*) FILTER(WHERE s.state='CLOSED' AND s.actual_checkout_at<=%s-interval '365 days')
            FROM prsystem.stay_guest_identity i JOIN prsystem.stay s ON(s.tenant_id,s.id)=(i.tenant_id,i.stay_id) WHERE i.tenant_id=%s''',(now,tenant)).fetchone()
        envelopes=conn.execute('''SELECT c.table_name,c.column_name FROM information_schema.columns c
            WHERE c.table_schema='prsystem' AND(c.column_name LIKE '%%envelope%%' OR c.column_name='lookup_token') ORDER BY 1,2''').fetchall()
    return dict(status='REVIEW_REQUIRED',recorded_at=now.isoformat(),dry_run=True,identity_records=row[0],closed_identities_older_than_product_default=row[1],
        visible_encrypted_or_lookup_columns=[dict(table=t,column=c) for t,c in envelopes],policy_status=policy.get('status'),
        blockers=['Approved class-specific retention and legal-hold matrix','Verified deletion or cryptographic erasure for all linked copies','Verified encrypted backup expiry and restore suppression of erased data'],
        warning='Age is an inventory signal, never permission to delete financial or immutable history.')


def main():
    p=argparse.ArgumentParser();p.add_argument('--tenant',required=True);p.add_argument('--policy',type=Path,default=Path('deploy/retention-matrix.json'));p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();result=inventory(os.environ['PRSYSTEM_APP_DSN'],a.tenant,json.loads(a.policy.read_text()));a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(result['status'])


if __name__=='__main__':main()
