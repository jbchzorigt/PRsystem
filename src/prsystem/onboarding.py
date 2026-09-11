"""Paid provisioning; external OTP/payment gateways are explicit fail-closed ports.

Gateways are deployment-owned objects, never request payloads. No caller can
post a paid flag, OTP-verified flag, provider evidence, price or owner proof.
"""
import math
import secrets
from datetime import timedelta
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.billing import quote,add_months
from prsystem.common import DomainError,timestamp
from prsystem.postgres.connection import transaction
from prsystem.staff_lifecycle import normalized_email


class OnboardingService:
    def __init__(self,auth,links,*,phone_gateway=None,payment_gateways=None):
        self.auth,self.links=auth,links
        self.phone=phone_gateway
        self.gateways=payment_gateways or {}

    @staticmethod
    def _event(conn,app,action,details=None):
        conn.execute('INSERT INTO prsystem.onboarding_event VALUES (%s,%s,%s,%s,clock_timestamp())',(secrets.token_hex(16),app,action,Jsonb(details or {})))

    @staticmethod
    def _app(conn,app,access,lock=True):
        row=conn.execute('SELECT payload,email,owner_kind,owner_identifier,package_mnt,months,state,phone_verified_at,proof_account_id,paid_attempt_id,tenant_id FROM prsystem.onboarding_application WHERE id=%s AND access_hash=%s'+(' FOR UPDATE' if lock else ''),(app,digest(access))).fetchone()
        if not row: raise DomainError('UNAUTHENTICATED')
        return row

    def create(self,payload,peer):
        fields={'owner_kind','owner_identifier','first_name','last_name','company_name','position','phone','email','contact_phone','hotel_name','hotel_phone','district','ward','address','latitude','longitude','package_mnt','months'}
        if set(payload)-fields: raise DomainError('INVALID_REQUEST')
        required=fields-{'company_name','position'}
        if not required<=set(payload): raise DomainError('INVALID_REQUEST')
        if payload['owner_kind'] not in {'INDIVIDUAL','COMPANY'}: raise DomainError('INVALID_REQUEST')
        if payload['owner_kind']=='COMPANY' and not {'company_name','position'}<=set(payload): raise DomainError('INVALID_REQUEST')
        for name,value in payload.items():
            if name not in {'latitude','longitude','package_mnt','months'} and (not isinstance(value,str) or not value.strip() or len(value)>500): raise DomainError('INVALID_REQUEST')
        identifier=payload['owner_identifier'].strip().upper()
        if not 5<=len(identifier)<=20 or not identifier.isalnum(): raise DomainError('INVALID_REQUEST')
        for name in ('phone','contact_phone','hotel_phone'):
            phone=payload[name]
            if not phone.removeprefix('+').isascii() or not phone.removeprefix('+').isdigit() or not 8<=len(phone.removeprefix('+'))<=15: raise DomainError('INVALID_REQUEST')
        for name,limit in [('latitude',90),('longitude',180)]:
            value=payload[name]
            if type(value) not in (float,int) or not math.isfinite(value) or not -limit<=value<=limit: raise DomainError('INVALID_REQUEST')
        amount=quote(payload['package_mnt'],payload['months']);email=normalized_email(payload['email'])
        self.auth._rate_limit(email,peer,'onboarding-create')
        app,access=secrets.token_hex(16),secrets.token_urlsafe(32)
        normalized=dict(payload,email=email,owner_identifier=identifier)
        with transaction(self.auth.dsn) as conn:
            conn.execute('INSERT INTO prsystem.onboarding_application (id,access_hash,payload,email,owner_kind,owner_identifier,package_mnt,months) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',(app,digest(access),Jsonb(normalized),email,payload['owner_kind'],identifier,payload['package_mnt'],payload['months']))
            self._event(conn,app,'CREATED',dict(amount=amount,currency='MNT'))
        return dict(application_id=app,access_token=access,amount=amount,currency='MNT',state='DRAFT')

    def request_phone(self,app,access,peer):
        if self.phone is None: raise DomainError('ONBOARDING_UNAVAILABLE')
        self.auth._rate_limit(app,peer,'onboarding-otp-send')
        with transaction(self.auth.dsn) as conn:
            row=self._app(conn,app,access)
            if row[9] or row[7]: raise DomainError('INVALID_MEMBERSHIP_TRANSITION')
            challenge=secrets.token_hex(16)
            conn.execute('UPDATE prsystem.onboarding_application SET phone_challenge=%s WHERE id=%s',(challenge,app))
        # Gateway must deduplicate delivery by challenge ID; no raw OTP returned.
        self.phone.request(row[0]['phone'],challenge)
        return dict(status='QUEUED')

    def verify_phone(self,app,access,code,peer):
        if self.phone is None: raise DomainError('ONBOARDING_UNAVAILABLE')
        if not isinstance(code,str) or not code.isascii() or not code.isdigit() or not 4<=len(code)<=8: raise DomainError('INVALID_REQUEST')
        self.auth._rate_limit(app,peer,'onboarding-otp-verify')
        with transaction(self.auth.dsn) as conn:
            self._app(conn,app,access)
            challenge=conn.execute('SELECT phone_challenge FROM prsystem.onboarding_application WHERE id=%s',(app,)).fetchone()[0]
        if not challenge or self.phone.verify(challenge,code) is not True: raise DomainError('INVALID_CREDENTIALS')
        with transaction(self.auth.dsn) as conn:
            self._app(conn,app,access)
            result=conn.execute('UPDATE prsystem.onboarding_application SET phone_verified_at=clock_timestamp() WHERE id=%s AND phone_challenge=%s RETURNING id',(app,challenge)).fetchone()
            if not result: raise DomainError('REVISION_CONFLICT')
            self._event(conn,app,'PHONE_VERIFIED')
        return dict(status='VERIFIED')

    def prove_account(self,app,access,bearer):
        with transaction(self.auth.dsn) as conn:
            principal,_=self.auth._authenticate(conn,bearer)
            account=conn.execute('SELECT email FROM prsystem.staff_account WHERE id=%s',(principal['account_id'],)).fetchone()
            row=self._app(conn,app,access)
            if account[0]!=row[1]: raise DomainError('FORBIDDEN')
            conn.execute('UPDATE prsystem.onboarding_application SET proof_account_id=%s WHERE id=%s',(principal['account_id'],app))
            if row[9] and row[6]=='PAID_OWNER_VERIFICATION_REQUIRED':
                conn.execute("UPDATE prsystem.onboarding_application SET state='PAID_PENDING_PROVISIONING' WHERE id=%s",(app,))
            self._event(conn,app,'ACCOUNT_PROVED',dict(account_id=principal['account_id']))
            return dict(status='VERIFIED')

    @staticmethod
    def _proof(conn,row,app):
        account=conn.execute('SELECT id,status,verified_at FROM prsystem.staff_account WHERE email=%s',(row[1],)).fetchone()
        owner=conn.execute('SELECT id,account_id FROM prsystem.subscription_owner WHERE kind=%s AND identifier=%s',(row[2],row[3])).fetchone()
        owner_proved = not owner or owner[1]==row[8] or conn.execute(
            'SELECT 1 FROM prsystem.onboarding_owner_proof WHERE application_id=%s AND owner_id=%s AND verified_at IS NOT NULL', (app,owner[0])).fetchone()
        return bool((not account or (account[0]==row[8] and account[1]=='ACTIVE' and account[2] is not None)) and owner_proved)

    def invoice(self,app,access,provider):
        gateway=self.gateways.get(provider)
        if gateway is None or self.links is None: raise DomainError('ONBOARDING_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            row=self._app(conn,app,access)
            if row[9]: raise DomainError('APPLICATION_ALREADY_PAID')
            if not row[7]: raise DomainError('PHONE_PROOF_REQUIRED')
            if not self._proof(conn,row,app):
                conn.execute("UPDATE prsystem.onboarding_application SET state='OWNER_VERIFICATION_REQUIRED' WHERE id=%s",(app,))
                return dict(state='OWNER_VERIFICATION_REQUIRED')
            previous=conn.execute("SELECT id,state,invoice_id FROM prsystem.onboarding_attempt WHERE application_id=%s AND state IN ('PENDING','UNCERTAIN')",(app,)).fetchone()
            if previous: return dict(attempt_id=previous[0],state=previous[1],invoice_id=previous[2])
            attempt=secrets.token_hex(16);amount=quote(row[4],row[5])
            conn.execute('INSERT INTO prsystem.onboarding_attempt (id,application_id,provider,merchant_id,amount) VALUES (%s,%s,%s,%s,%s)',(attempt,app,provider,gateway.merchant_id,amount))
            conn.execute("UPDATE prsystem.onboarding_application SET state='PAYMENT_UNCERTAIN' WHERE id=%s",(app,))
        # A failed response leaves UNCERTAIN; never create a second invoice until
        # the provider resolves the first attempt by its stable client reference.
        invoice=gateway.create_invoice(attempt,amount,'MNT')
        if not isinstance(invoice,str) or not invoice or len(invoice)>200: raise DomainError('PROVIDER_EVIDENCE_INVALID')
        with transaction(self.auth.dsn) as conn:
            row=self._app(conn,app,access)
            conn.execute("UPDATE prsystem.onboarding_attempt SET invoice_id=%s,state=CASE WHEN state='UNCERTAIN' THEN 'PENDING' ELSE state END WHERE id=%s",(invoice,attempt))
            if not row[9]:conn.execute("UPDATE prsystem.onboarding_application SET state='PENDING_PAYMENT' WHERE id=%s",(app,))
            self._event(conn,app,'INVOICE_CREATED',dict(attempt_id=attempt))
        return dict(attempt_id=attempt,invoice_id=invoice,state='PENDING')

    def reconcile(self,attempt):
        """Internal bounded worker only: query provider; callback body is never authority."""
        with transaction(self.auth.dsn) as conn:
            row=conn.execute('SELECT application_id,provider,merchant_id,invoice_id,amount FROM prsystem.onboarding_attempt WHERE id=%s',(attempt,)).fetchone()
        if not row: raise DomainError('WORK_SOURCE_NOT_FOUND')
        gateway=self.gateways.get(row[1])
        if gateway is None: raise DomainError('ONBOARDING_UNAVAILABLE')
        evidence=gateway.payment(attempt,row[3])
        if evidence['status'] not in {'PENDING','FAILED','EXPIRED','SUCCEEDED'}: raise DomainError('PROVIDER_EVIDENCE_INVALID')
        if evidence.get('merchant_id')!=row[2] or evidence.get('currency')!='MNT' or type(evidence.get('amount')) is not int or evidence['amount']!=row[4] or (row[3] is not None and evidence.get('invoice_id')!=row[3]): raise DomainError('PROVIDER_EVIDENCE_INVALID')
        with transaction(self.auth.dsn) as conn:
            app=conn.execute('SELECT paid_attempt_id FROM prsystem.onboarding_application WHERE id=%s FOR UPDATE',(row[0],)).fetchone()
            current=conn.execute('SELECT state FROM prsystem.onboarding_attempt WHERE id=%s FOR UPDATE',(attempt,)).fetchone()[0]
            if current in {'PAID','RECONCILE'}: return current
            if evidence['status']=='PENDING':return 'PENDING'
            if evidence['status']!='SUCCEEDED':
                state=evidence['status'];conn.execute('UPDATE prsystem.onboarding_attempt SET state=%s WHERE id=%s',(state,attempt))
                if not app[0] and not conn.execute("SELECT 1 FROM prsystem.onboarding_attempt WHERE application_id=%s AND state IN ('PENDING','UNCERTAIN')",(row[0],)).fetchone():conn.execute('UPDATE prsystem.onboarding_application SET state=%s WHERE id=%s',('PAYMENT_'+state,row[0]))
                return state
            paid_at=evidence['confirmed_at'];timestamp(paid_at)
            if paid_at>conn.execute('SELECT clock_timestamp()').fetchone()[0] or not isinstance(evidence.get('payment_id'),str) or not evidence['payment_id'] or not evidence.get('invoice_id'): raise DomainError('PROVIDER_EVIDENCE_INVALID')
            conn.execute('INSERT INTO prsystem.onboarding_payment (provider,merchant_id,payment_id,attempt_id,amount,confirmed_at) VALUES (%s,%s,%s,%s,%s,%s)',(row[1],row[2],evidence['payment_id'],attempt,row[4],paid_at))
            state='RECONCILE' if app[0] else 'PAID'
            conn.execute('UPDATE prsystem.onboarding_attempt SET state=%s,invoice_id=%s WHERE id=%s',(state,evidence['invoice_id'],attempt))
            if not app[0]:
                conn.execute("UPDATE prsystem.onboarding_attempt SET state='SUPERSEDED' WHERE application_id=%s AND id<>%s AND state IN ('PENDING','UNCERTAIN')",(row[0],attempt))
                conn.execute("UPDATE prsystem.onboarding_application SET paid_attempt_id=%s,state='PAID_PENDING_PROVISIONING' WHERE id=%s",(attempt,row[0]))
                conn.execute('INSERT INTO prsystem.onboarding_job(application_id) VALUES (%s) ON CONFLICT DO NOTHING',(row[0],))
            self._event(conn,row[0],'PAYMENT_'+state,dict(attempt_id=attempt))
            return state

    def provision(self,app,*,lease_token=None):
        """All entities and activation intent commit together; failures use same job."""
        if self.links is None: raise DomainError('ONBOARDING_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            # Same email lock as staff invitations; owner lock prevents double owner.
            identity=conn.execute('SELECT email,owner_kind,owner_identifier FROM prsystem.onboarding_application WHERE id=%s',(app,)).fetchone()
            if not identity: raise DomainError('WORK_SOURCE_NOT_FOUND')
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('staff-email:'+identity[0],))
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('owner:'+identity[1]+':'+identity[2],))
            account=conn.execute('SELECT id FROM prsystem.staff_account WHERE email=%s FOR UPDATE',(identity[0],)).fetchone()
            row=conn.execute('SELECT payload,email,owner_kind,owner_identifier,package_mnt,months,state,phone_verified_at,proof_account_id,paid_attempt_id,tenant_id FROM prsystem.onboarding_application WHERE id=%s FOR UPDATE',(app,)).fetchone()
            if row[6]=='PROVISIONED':return dict(tenant_id=row[10],state='PROVISIONED')
            job=conn.execute('SELECT attempts,next_attempt_at,lease_token,lease_until FROM prsystem.onboarding_job WHERE application_id=%s AND completed_at IS NULL FOR UPDATE',(app,)).fetchone()
            if not row[9] or not job:raise DomainError('PAYMENT_REQUIRED')
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if lease_token is None:
                if job[0]>=5 or job[1]>now or (job[2] and job[3]>now):raise DomainError('PROVISION_RETRY_BLOCKED')
            elif job[2]!=lease_token or job[3]<=now or job[0]>5:
                raise DomainError('PROVISION_RETRY_BLOCKED')
            if not self._proof(conn,row,app):
                conn.execute("UPDATE prsystem.onboarding_application SET state='PAID_OWNER_VERIFICATION_REQUIRED' WHERE id=%s",(app,))
                return dict(state='PAID_OWNER_VERIFICATION_REQUIRED')
            payment=conn.execute('SELECT confirmed_at FROM prsystem.onboarding_payment WHERE attempt_id=%s',(row[9],)).fetchone()
            if not payment:raise DomainError('PAYMENT_REQUIRED')
            tenant,owner=secrets.token_hex(16),secrets.token_hex(16)
            expires=add_months(payment[0],row[5])
            account_id=account[0] if account else secrets.token_hex(16)
            if not account:conn.execute('INSERT INTO prsystem.staff_account (id,email,password_hash,display_name) VALUES (%s,%s,%s,%s)',(account_id,row[1],'!',row[0]['first_name']))
            existing=conn.execute('SELECT id FROM prsystem.subscription_owner WHERE kind=%s AND identifier=%s',(row[2],row[3])).fetchone()
            if existing:owner=existing[0]
            else:conn.execute('INSERT INTO prsystem.subscription_owner VALUES (%s,%s,%s,%s,%s)',(owner,row[2],row[3],account_id,Jsonb(dict(phone=row[0]['phone'],email=row[1]))))
            conn.execute('INSERT INTO prsystem.hotel_access VALUES (%s,%s,%s,false)',(tenant,row[4],expires))
            conn.execute('INSERT INTO prsystem.hotel_subscription (tenant_id,owner_id,application_id,starts_at,expires_at,package_floor) VALUES (%s,%s,%s,%s,%s,%s)',(tenant,owner,app,payment[0],expires,row[4]))
            conn.execute("INSERT INTO prsystem.staff_membership (tenant_id,account_id,status,roles,is_primary) VALUES (%s,%s,%s,ARRAY['HOTEL_ADMIN'],true)",(tenant,account_id,'ACTIVE' if account else 'PENDING'))
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            conn.execute('INSERT INTO prsystem.cash_book(tenant_id) VALUES (%s)',(tenant,))
            conn.execute("INSERT INTO prsystem.cash_drawer VALUES (%s,'default',%s,0,0)",(tenant,'unopened:'+tenant))
            if not account:self.links._issue(conn,'ADMIN_ACTIVATION',account_id,0,tenant,revision=0)
            conn.execute("UPDATE prsystem.onboarding_application SET state='PROVISIONED',tenant_id=%s WHERE id=%s",(tenant,app))
            conn.execute('UPDATE prsystem.onboarding_job SET completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE application_id=%s',(app,))
            self._event(conn,app,'PROVISIONED',dict(tenant_id=tenant,account_id=account_id))
            return dict(tenant_id=tenant,state='PROVISIONED')

    def accept(self,token,password,peer):
        if self.links is None:raise DomainError('ONBOARDING_UNAVAILABLE')
        if not 12<=len(password)<=128:raise DomainError('INVALID_PASSWORD')
        self.auth._rate_limit(digest(token),peer,'admin-activation')
        with transaction(self.auth.dsn) as conn:
            link=self.links._link(conn,token,'ADMIN_ACTIVATION')
            self.links._lock_accounts(conn,{link[1]})
            link=self.links._link(conn,token,'ADMIN_ACTIVATION')
            member=conn.execute('SELECT status,revision,is_primary FROM prsystem.staff_membership WHERE tenant_id=%s AND account_id=%s FOR UPDATE',(link[2],link[1])).fetchone()
            account=conn.execute('SELECT verified_at,auth_epoch,status FROM prsystem.staff_account WHERE id=%s',(link[1],)).fetchone()
            if member!=('PENDING',link[4],True) or account!=(None,link[5],'ACTIVE'):raise DomainError('INVALID_LINK')
            app=conn.execute("SELECT id FROM prsystem.onboarding_application WHERE tenant_id=%s AND state='PROVISIONED' AND paid_attempt_id IS NOT NULL",(link[2],)).fetchone()
            if not app:raise DomainError('INVALID_LINK')
            conn.execute('UPDATE prsystem.staff_account SET password_hash=%s,verified_at=clock_timestamp() WHERE id=%s',(self.auth.passwords.hash(password),link[1]))
            conn.execute("UPDATE prsystem.staff_membership SET status='ACTIVE' WHERE tenant_id=%s AND account_id=%s",(link[2],link[1]))
            self.links._consume(conn,link[0]);self._event(conn,app[0],'ADMIN_ACTIVATED',dict(account_id=link[1]))
            return dict(state='ACTIVE',tenant_id=link[2])

    def run_job(self,app):
        import psycopg
        lease=secrets.token_hex(16)
        with transaction(self.auth.dsn) as conn:
            row=conn.execute('SELECT state FROM prsystem.onboarding_application WHERE id=%s FOR UPDATE',(app,)).fetchone()
            if not row or row[0] in {'PROVISIONED','PAID_OWNER_VERIFICATION_REQUIRED'}:return dict(state=row[0] if row else 'NOT_FOUND')
            job=conn.execute("""UPDATE prsystem.onboarding_job SET lease_token=%s,
                lease_until=clock_timestamp()+interval '5 minutes',attempts=attempts+1
                WHERE application_id=%s AND attempts<5 AND completed_at IS NULL AND next_attempt_at<=clock_timestamp()
                AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING attempts""",(lease,app)).fetchone()
            if not job:return dict(state='WAITING')
            conn.execute("UPDATE prsystem.onboarding_application SET state='PROVISIONING' WHERE id=%s",(app,))
        try:
            result=self.provision(app,lease_token=lease)
            with transaction(self.auth.dsn) as conn:
                conn.execute('UPDATE prsystem.onboarding_job SET lease_token=NULL,lease_until=NULL WHERE application_id=%s AND lease_token=%s',(app,lease))
            return result
        except psycopg.Error:
            with transaction(self.auth.dsn) as conn:
                conn.execute('SELECT id FROM prsystem.onboarding_application WHERE id=%s FOR UPDATE',(app,)).fetchone()
                updated=conn.execute("""UPDATE prsystem.onboarding_job SET next_attempt_at=clock_timestamp()+%s,
                    lease_token=NULL,lease_until=NULL,last_error_code='DATABASE_FAILURE'
                    WHERE application_id=%s AND lease_token=%s AND completed_at IS NULL RETURNING attempts""",
                    (timedelta(seconds=min(3600,30*2**job[0])),app,lease)).fetchone()
                if updated:
                    conn.execute("UPDATE prsystem.onboarding_application SET state='PROVISIONING_FAILED' WHERE id=%s AND tenant_id IS NULL",(app,))
                    self._event(conn,app,'PROVISIONING_FAILED',dict(attempt=job[0],code='DATABASE_FAILURE'))
            return dict(state='PROVISIONING_FAILED')

    def manual_retry(self,platform,bearer,app,key,reason,reference):
        if not reason.strip() or not reference.strip():raise DomainError('INVALID_REQUEST')
        command=dict(action='ONBOARDING_PROVISION_RETRY',application_id=app,reason=reason,reference=reference)
        with transaction(self.auth.dsn) as conn:
            actor,_=platform.authenticate(conn,bearer,'ONBOARDING_PROVISION_RETRY')
            replay=platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            row=conn.execute('SELECT paid_attempt_id,state FROM prsystem.onboarding_application WHERE id=%s FOR UPDATE',(app,)).fetchone()
            if not row or not row[0] or row[1]!='PROVISIONING_FAILED':raise DomainError('PROVISION_RETRY_BLOCKED')
            conn.execute('UPDATE prsystem.onboarding_job SET attempts=0,next_attempt_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE application_id=%s AND completed_at IS NULL',(app,))
            result=dict(state='QUEUED')
            platform._event(conn,actor,'ONBOARDING_PROVISION_RETRY',app,dict(reason=reason,reference=reference))
            platform.save(conn,key,actor,command,result);return result

    def once(self,limit=25):
        if type(limit) is not int or not 1<=limit<=100:raise ValueError('limit must be 1..100')
        with transaction(self.auth.dsn) as conn:
            conn.execute("""UPDATE prsystem.onboarding_application a SET state='PROVISIONING_FAILED'
                FROM prsystem.onboarding_job j WHERE j.application_id=a.id AND j.completed_at IS NULL
                AND j.attempts>=5 AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
                AND a.state='PROVISIONING'""")
            jobs=conn.execute('''SELECT j.application_id FROM prsystem.onboarding_job j
                JOIN prsystem.onboarding_application a ON a.id=j.application_id
                WHERE j.completed_at IS NULL AND j.attempts<5 AND j.next_attempt_at<=clock_timestamp()
                AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
                AND a.state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','PROVISIONING')
                ORDER BY j.next_attempt_at,j.application_id LIMIT %s''',(limit,)).fetchall()
        return [self.run_job(app) for (app,) in jobs]

    def request_owner(self,app,access,peer):
        if self.phone is None:raise DomainError('ONBOARDING_UNAVAILABLE')
        self.auth._rate_limit(app,peer,'onboarding-owner-send')
        with transaction(self.auth.dsn) as conn:
            row=self._app(conn,app,access)
            if row[6]=='PROVISIONED':raise DomainError('APPLICATION_ALREADY_PAID')
            owner=conn.execute('SELECT id,original_contact FROM prsystem.subscription_owner WHERE kind=%s AND identifier=%s',(row[2],row[3])).fetchone()
            if not owner:raise DomainError('WORK_SOURCE_NOT_FOUND')
            challenge=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.onboarding_owner_proof(application_id,owner_id,challenge_id) VALUES (%s,%s,%s)
                ON CONFLICT(application_id) DO UPDATE SET challenge_id=excluded.challenge_id,verified_at=NULL''',(app,owner[0],challenge))
        self.phone.request(owner[1]['phone'],challenge)
        return dict(status='QUEUED')

    def verify_owner(self,app,access,code,peer):
        if self.phone is None:raise DomainError('ONBOARDING_UNAVAILABLE')
        if not isinstance(code,str) or not code.isascii() or not code.isdigit() or not 4<=len(code)<=8:raise DomainError('INVALID_REQUEST')
        self.auth._rate_limit(app,peer,'onboarding-owner-verify')
        with transaction(self.auth.dsn) as conn:
            self._app(conn,app,access)
            proof=conn.execute('SELECT challenge_id FROM prsystem.onboarding_owner_proof WHERE application_id=%s',(app,)).fetchone()
        if not proof or self.phone.verify(proof[0],code) is not True:raise DomainError('INVALID_CREDENTIALS')
        with transaction(self.auth.dsn) as conn:
            row=self._app(conn,app,access)
            updated=conn.execute('UPDATE prsystem.onboarding_owner_proof SET verified_at=clock_timestamp() WHERE application_id=%s AND challenge_id=%s RETURNING owner_id',(app,proof[0])).fetchone()
            if not updated:raise DomainError('REVISION_CONFLICT')
            if row[9] and row[6]=='PAID_OWNER_VERIFICATION_REQUIRED' and self._proof(conn,row,app):
                conn.execute("UPDATE prsystem.onboarding_application SET state='PAID_PENDING_PROVISIONING' WHERE id=%s",(app,))
            self._event(conn,app,'OWNER_PROVED',dict(owner_id=updated[0]))
            return dict(status='VERIFIED')

    def status(self,app,access):
        with transaction(self.auth.dsn) as conn:
            row=self._app(conn,app,access,lock=False)
            attempt=conn.execute('SELECT id,state,invoice_id FROM prsystem.onboarding_attempt WHERE application_id=%s ORDER BY created_at DESC,id DESC LIMIT 1',(app,)).fetchone()
            return dict(state=row[6],tenant_id=row[10],amount=quote(row[4],row[5]),currency='MNT',
                attempt=None if not attempt else dict(id=attempt[0],state=attempt[1],invoice_id=attempt[2]))
