"""Authoritative payment renewal; security suspension and package floor survive."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.billing import quote,renewal_window
from prsystem.common import DomainError,timestamp
from prsystem.postgres.connection import transaction
from prsystem.staff_commands import StaffCommands
from prsystem.subscription import AccessFacts,Action,subscription_gate


class RenewalService(StaffCommands):
    def __init__(self,auth,gateways=None):super().__init__(auth);self.gateways=gateways or {}

    @staticmethod
    def event(conn,tenant,action,details):
        conn.execute('INSERT INTO prsystem.billing_event VALUES (%s,%s,%s,%s,clock_timestamp())',(secrets.token_hex(16),tenant,action,Jsonb(details)))

    def invoice(self,bearer,tenant,package,months,provider,key):
        amount=quote(package,months)
        gateway=self.gateways.get(provider)
        if not gateway:raise DomainError('ONBOARDING_UNAVAILABLE')
        command=dict(action='RENEWAL_INVOICE',package=package,months=months,provider=provider)
        with transaction(self.auth.dsn) as conn:
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            actor=principal['account_id']
            hotel=conn.execute('SELECT expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            gate=subscription_gate(Action.RENEW,AccessFacts(tenant,True,True,True,'HOTEL_ADMIN' in principal['roles'],True,True,True,hotel[1]),hotel[0],conn.execute('SELECT clock_timestamp()').fetchone()[0])
            if not gate.allowed:raise DomainError(gate.code)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            subscription=conn.execute('SELECT expires_at,package_floor FROM prsystem.hotel_subscription WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            if not subscription:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if package<subscription[1]:raise DomainError('PACKAGE_DOWNGRADE_FORBIDDEN')
            pending=conn.execute("SELECT id FROM prsystem.subscription_renewal WHERE tenant_id=%s AND state IN ('PENDING','UNCERTAIN')",(tenant,)).fetchone()
            if pending:raise DomainError('PAYMENT_ALREADY_PENDING')
            renewal=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.subscription_renewal (id,tenant_id,actor_id,provider,merchant_id,package_mnt,months,amount,previous_expiry)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(renewal,tenant,actor,provider,gateway.merchant_id,package,months,amount,subscription[0]))
            result=dict(renewal_id=renewal,state='UNCERTAIN',amount=amount,currency='MNT')
            self._save_receipt(conn,tenant,key,actor,command,result)
        invoice=gateway.create_invoice(renewal,amount,'MNT')
        if not isinstance(invoice,str) or not invoice or len(invoice)>200:raise DomainError('PROVIDER_EVIDENCE_INVALID')
        with transaction(self.auth.dsn) as conn:
            conn.execute("UPDATE prsystem.subscription_renewal SET invoice_id=%s,state=CASE WHEN state='UNCERTAIN' THEN 'PENDING' ELSE state END WHERE id=%s",(invoice,renewal))
            self.event(conn,tenant,'RENEWAL_INVOICE_CREATED',dict(renewal_id=renewal,actor_id=actor))
        # Receipt is intentionally stable; GET status returns the latest invoice.
        return result

    def status(self,bearer,tenant,renewal):
        with transaction(self.auth.dsn) as conn:
            principal,_=self.auth._authenticate(conn,bearer,tenant)
            if 'HOTEL_ADMIN' not in principal['roles']:raise DomainError('FORBIDDEN')
            row=conn.execute('SELECT state,invoice_id,amount FROM prsystem.subscription_renewal WHERE tenant_id=%s AND id=%s',(tenant,renewal)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            return dict(state=row[0],invoice_id=row[1],amount=row[2],currency='MNT')

    def reconcile(self,renewal):
        with transaction(self.auth.dsn) as conn:
            snapshot=conn.execute('SELECT tenant_id,provider,merchant_id,invoice_id,amount FROM prsystem.subscription_renewal WHERE id=%s',(renewal,)).fetchone()
        if not snapshot:raise DomainError('WORK_SOURCE_NOT_FOUND')
        gateway=self.gateways.get(snapshot[1])
        if not gateway:raise DomainError('ONBOARDING_UNAVAILABLE')
        evidence=gateway.payment(renewal,snapshot[3])
        if evidence.get('status') not in {'PENDING','FAILED','EXPIRED','SUCCEEDED'} or evidence.get('merchant_id')!=snapshot[2] or evidence.get('currency')!='MNT' or type(evidence.get('amount')) is not int or evidence['amount']!=snapshot[4] or (snapshot[3] is not None and evidence.get('invoice_id')!=snapshot[3]):raise DomainError('PROVIDER_EVIDENCE_INVALID')
        tenant=snapshot[0]
        with transaction(self.auth.dsn) as conn:
            conn.execute('SELECT tenant_id FROM prsystem.hotel_access WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            subscription=conn.execute('SELECT expires_at,package_floor FROM prsystem.hotel_subscription WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            row=conn.execute('SELECT state,package_mnt,months,previous_expiry FROM prsystem.subscription_renewal WHERE id=%s FOR UPDATE',(renewal,)).fetchone()
            if row[0] in {'APPLIED','RECONCILE'}:return dict(state=row[0])
            if evidence['status']=='PENDING':return dict(state='PENDING')
            if evidence['status']!='SUCCEEDED':
                conn.execute('UPDATE prsystem.subscription_renewal SET state=%s WHERE id=%s',(evidence['status'],renewal));return dict(state=evidence['status'])
            confirmed=evidence['confirmed_at'];timestamp(confirmed)
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if confirmed>now or not evidence.get('payment_id') or not evidence.get('invoice_id'):raise DomainError('PROVIDER_EVIDENCE_INVALID')
            # One capture cannot pay both onboarding and renewal in this merchant.
            if conn.execute('SELECT 1 FROM prsystem.onboarding_payment WHERE provider=%s AND merchant_id=%s AND payment_id=%s',(snapshot[1],snapshot[2],evidence['payment_id'])).fetchone():raise DomainError('PROVIDER_EVIDENCE_INVALID')
            conn.execute('INSERT INTO prsystem.renewal_payment VALUES (%s,%s,%s,%s,%s,%s)',(snapshot[1],snapshot[2],evidence['payment_id'],renewal,confirmed,snapshot[4]))
            if subscription[0]!=row[3] or row[1]<subscription[1]:
                conn.execute("UPDATE prsystem.subscription_renewal SET state='RECONCILE' WHERE id=%s",(renewal,))
                self.event(conn,tenant,'RENEWAL_RECONCILE_REQUIRED',dict(renewal_id=renewal));return dict(state='RECONCILE')
            start,expires=renewal_window(subscription[0],confirmed,row[2]);effective=max(subscription[0],confirmed)
            conn.execute('UPDATE prsystem.hotel_subscription SET expires_at=%s,package_floor=%s WHERE tenant_id=%s',(expires,row[1],tenant))
            conn.execute('UPDATE prsystem.hotel_access SET expires_at=%s WHERE tenant_id=%s',(expires,tenant))
            conn.execute('INSERT INTO prsystem.package_entitlement VALUES (%s,%s,%s,%s,NULL)',(renewal,tenant,row[1],effective))
            if effective<=now:
                conn.execute('UPDATE prsystem.hotel_access SET package_mnt=greatest(package_mnt,%s) WHERE tenant_id=%s',(row[1],tenant))
                conn.execute('UPDATE prsystem.package_entitlement SET applied_at=clock_timestamp() WHERE renewal_id=%s',(renewal,))
            conn.execute("UPDATE prsystem.subscription_renewal SET state='APPLIED',invoice_id=%s WHERE id=%s",(evidence['invoice_id'],renewal))
            result=dict(state='APPLIED',starts_at=start.isoformat(),expires_at=expires.isoformat(),package_effective_at=effective.isoformat())
            self.event(conn,tenant,'RENEWAL_APPLIED',dict(result,renewal_id=renewal));return result

    def apply_due(self,limit=25):
        if type(limit) is not int or not 1<=limit<=100:raise ValueError('limit must be 1..100')
        with transaction(self.auth.dsn) as conn:
            tenants=conn.execute('SELECT DISTINCT tenant_id FROM prsystem.package_entitlement WHERE applied_at IS NULL AND effective_at<=clock_timestamp() ORDER BY tenant_id LIMIT %s',(limit,)).fetchall()
        applied=0
        for (tenant,) in tenants:
            with transaction(self.auth.dsn) as conn:
                conn.execute('SELECT tenant_id FROM prsystem.hotel_access WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
                rows=conn.execute('SELECT renewal_id,package_mnt FROM prsystem.package_entitlement WHERE tenant_id=%s AND applied_at IS NULL AND effective_at<=clock_timestamp() FOR UPDATE',(tenant,)).fetchall()
                if rows:
                    package=max(r[1] for r in rows)
                    conn.execute('UPDATE prsystem.hotel_access SET package_mnt=greatest(package_mnt,%s) WHERE tenant_id=%s',(package,tenant))
                    conn.execute('UPDATE prsystem.package_entitlement SET applied_at=clock_timestamp() WHERE renewal_id=ANY(%s)',([r[0] for r in rows],))
                    self.event(conn,tenant,'PACKAGE_EFFECTIVE',dict(package=package));applied+=len(rows)
        return applied
