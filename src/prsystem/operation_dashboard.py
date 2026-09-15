"""Platform Operation projections, reviewed outbox commands and bounded workers.

Only canonical subscription contacts can receive reminders. HTTP callers never
supply recipient addresses, paid flags, prices, credentials or provider results.
"""
import hashlib
import json
import secrets
from datetime import timedelta
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.common import DomainError
from prsystem.operation_policy import status,phone,masked,message,STATUSES
from prsystem.postgres.connection import transaction


class OperationDashboard:
    def __init__(self,auth,platform,*,sms=None,onboarding=None,renewals=None,ebarimt=None):
        self.auth,self.platform,self.sms,self.onboarding,self.renewals,self.ebarimt=auth,platform,sms,onboarding,renewals,ebarimt

    def actor(self,conn,token,permission='OPERATION_READ',*,write=False):
        if self.platform is None:raise DomainError('PLATFORM_UNAVAILABLE')
        actor,account=self.platform.authenticate(conn,token,permission,recent=False)
        if write:
            row=conn.execute('SELECT mfa_at,clock_timestamp() FROM prsystem.platform_session WHERE token_hash=%s',(digest(token),)).fetchone()
            if row[0]>row[1] or row[0]+timedelta(minutes=10)<=row[1]:raise DomainError('MFA_REQUIRED')
        return actor,account

    @staticmethod
    def _source(conn,as_of,filters,*,limit=501,after=None):
        # Applied hotel_access entitlements, never a future purchased package.
        rows=conn.execute('''SELECT s.tenant_id,a.payload->>'hotel_name',a.owner_kind,a.payload->>'address',
            prsystem.subscription_contact_phone(s.tenant_id),coalesce(primary_account.email,a.email),h.package_mnt,
            coalesce((SELECT n.months FROM prsystem.subscription_renewal n WHERE n.tenant_id=s.tenant_id AND n.state='APPLIED' ORDER BY n.created_at DESC,n.id DESC LIMIT 1),a.months),
            s.starts_at,h.expires_at,h.security_suspended
            FROM prsystem.hotel_subscription s JOIN prsystem.hotel_access h ON h.tenant_id=s.tenant_id
            JOIN prsystem.onboarding_application a ON a.id=s.application_id AND a.state='PROVISIONED'
            JOIN prsystem.subscription_owner o ON o.id=s.owner_id
            LEFT JOIN prsystem.staff_membership m ON m.tenant_id=s.tenant_id AND m.is_primary
            LEFT JOIN prsystem.staff_account primary_account ON primary_account.id=m.account_id
            WHERE (%s::int IS NULL OR h.package_mnt=%s) AND (%s::text[] IS NULL OR s.tenant_id=ANY(%s))
            AND (%s::int IS NULL OR h.expires_at<=%s+make_interval(days=>%s))
            AND (%s::text='' OR a.payload->>'hotel_name' ILIKE '%%'||%s||'%%')
            AND (%s::text[] IS NULL OR (CASE WHEN h.security_suspended THEN 'SUSPENDED'
              WHEN h.expires_at>%s+interval '168 hours' THEN 'ACTIVE' WHEN h.expires_at>%s THEN 'EXPIRING'
              WHEN h.expires_at>%s-interval '48 hours' THEN 'GRACE' ELSE 'EXPIRED' END)=ANY(%s))
            AND (%s::timestamptz IS NULL OR (h.expires_at,a.payload->>'hotel_name',s.tenant_id)>(%s::timestamptz,%s,%s))
            ORDER BY h.expires_at,a.payload->>'hotel_name',s.tenant_id LIMIT %s''',
            (filters.get('package_mnt'),filters.get('package_mnt'),filters.get('tenant_ids'),filters.get('tenant_ids'),
             filters.get('expires_within_days'),as_of,filters.get('expires_within_days'),filters.get('query',''),filters.get('query',''),filters.get('statuses') or None,as_of,as_of,as_of,filters.get('statuses') or None,
             after[0] if after else None,after[0] if after else None,after[1] if after else None,after[2] if after else None,limit)).fetchall()
        result=[]
        for r in rows:
            item=dict(zip(('tenant_id','name','owner_kind','address','phone','email','package_mnt','months','starts_at','expires_at','suspended'),r))
            item.update(status(r[9],as_of,r[10]))
            if filters.get('statuses') and item['status'] not in filters['statuses']:continue
            result.append(item)
            if len(result)>=limit:break
        return result

    @staticmethod
    def public(item):
        return {**{k:v.isoformat() if hasattr(v,'isoformat') else v for k,v in item.items() if k not in {'email','phone'}},
                'email':masked(item['email']),'phone':masked(item['phone'])}

    def overview(self,token,filters,after=None,limit=25):
        # Refresh idle activity in a short write transaction. The projection's
        # repeatable-read snapshot must not also contend on last_seen_at.
        with transaction(self.auth.dsn) as conn:
            actor,_=self.actor(conn,token)
        with transaction(self.auth.dsn,isolation='repeatable read') as conn:
            authorization=conn.execute('''SELECT a.permissions FROM prsystem.platform_session s JOIN prsystem.platform_account a ON a.id=s.account_id
                WHERE s.token_hash=%s AND s.account_id=%s AND a.active AND a.revision=s.revision AND s.revoked_at IS NULL
                AND s.expires_at>clock_timestamp() AND s.last_seen_at+interval '30 minutes'>clock_timestamp()
                AND s.created_at+interval '8 hours'>clock_timestamp() AND 'OPERATION_READ'=ANY(a.permissions)''',(digest(token),actor)).fetchone()
            if not authorization:raise DomainError('UNAUTHENTICATED')
            conn.execute("SELECT set_config('prsystem.platform_id',%s,true)",(actor,))
            account=(None,authorization[0])
            as_of=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            # KPI aggregate is independent of the paginated list.
            totals=conn.execute('''SELECT h.package_mnt,h.security_suspended,
              CASE WHEN h.expires_at>%s+interval '168 hours' THEN 'ACTIVE' WHEN h.expires_at>%s THEN 'EXPIRING'
              WHEN h.expires_at>%s-interval '48 hours' THEN 'GRACE' ELSE 'EXPIRED' END,count(*)
              FROM prsystem.hotel_subscription s JOIN prsystem.hotel_access h ON h.tenant_id=s.tenant_id
              JOIN prsystem.onboarding_application a ON a.id=s.application_id AND a.state='PROVISIONED'
              GROUP BY 1,2,3''',(as_of,as_of,as_of)).fetchall()
            states={s:0 for s in STATUSES};packages={str(p):0 for p in (20000,25000,30000)}
            for package,suspended,underlying,count in totals:states['SUSPENDED' if suspended else underlying]+=count;packages[str(package)]+=count
            sms=conn.execute('''SELECT d.state,count(*) FROM prsystem.operation_sms_delivery d JOIN prsystem.operation_sms_recipient r ON r.id=d.recipient_id
                JOIN prsystem.operation_sms_job j ON j.id=r.job_id WHERE j.created_at>=date_trunc('month',%s::timestamptz AT TIME ZONE 'Asia/Ulaanbaatar') AT TIME ZONE 'Asia/Ulaanbaatar'
                AND j.created_at<=%s AND d.state IN('SENT','DELIVERED','FAILED') GROUP BY d.state''',(as_of,as_of)).fetchall()
            pending=conn.execute("SELECT count(*) FROM prsystem.onboarding_application WHERE paid_attempt_id IS NOT NULL AND state<>'PROVISIONED'").fetchone()[0]
            rows=self._source(conn,as_of,filters,limit=limit+1,after=after)
            items=[self.public(i) for i in rows[:limit]]
            last=rows[limit-1] if len(rows)>limit else None
            return dict(as_of=as_of.isoformat(),timezone='Asia/Ulaanbaatar',permissions=account[1],total=sum(states.values()),statuses=states,packages=packages,
                not_activated=pending,sms_month=dict(sms),items=items,next_after=[last['expires_at'].isoformat(),last['name'],last['tenant_id']] if last else None,
                sms_available=self.sms is not None,mode='MOCK_ONLY' if getattr(self.sms,'is_mock',False) else 'LIVE')

    def _recipients(self,conn,filters,as_of,*,lock_contacts=False):
        rows=self._source(conn,as_of,filters,limit=501)
        if len(rows)>500:raise DomainError('SMS_BATCH_LIMIT')
        if lock_contacts:
            for tenant in sorted(r['tenant_id'] for r in rows):
                conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('subscription-contact:'+tenant,))
                conn.execute('SELECT tenant_id FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
            rows=self._source(conn,as_of,filters,limit=501)
            if len(rows)>500:raise DomainError('SMS_BATCH_LIMIT')
        grouped={};excluded=0;stamps=[]
        for row in rows:
            number=phone(row['phone']);stamps.append([row['tenant_id'],number,row['email'],row['expires_at'].isoformat(),row['package_mnt'],row['suspended']])
            if number is None:excluded+=1;continue
            grouped.setdefault(number,[]).append(row['tenant_id'])
        if len(grouped)>100:raise DomainError('SMS_BATCH_LIMIT')
        recipients=[dict(phone=p,tenant_ids=sorted(ids)) for p,ids in sorted(grouped.items())]
        fingerprint=hashlib.sha256(json.dumps(sorted(stamps),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        return recipients,fingerprint,excluded,len(rows)

    def preview(self,token,data,key):
        data=dict(data,message=message(data['message']));command=dict(action='SMS_PREVIEW',data=data)
        if self.sms is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            actor,_=self.actor(conn,token,'SUBSCRIPTION_REMINDER_SEND')
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            recipients,fingerprint,excluded,selected=self._recipients(conn,data['filters'],now)
            quote=self.sms.quote(data['message'],len(recipients));identity=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.operation_sms_draft(id,actor_id,filters,message,recipients,fingerprint,quote,expires_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''',(identity,actor,Jsonb(data['filters']),data['message'],Jsonb(recipients),fingerprint,Jsonb(quote),now+timedelta(minutes=10)))
            result=dict(draft_id=identity,message=data['message'],selected_hotels=selected,excluded_invalid_phone=excluded,deduplicated=selected-excluded-len(recipients),quote=quote,
                recipients=[dict(phone=masked(r['phone']),hotel_count=len(r['tenant_ids'])) for r in recipients],expires_at=(now+timedelta(minutes=10)).isoformat())
            self.platform._event(conn,actor,'SMS_PREVIEW',identity,dict(recipient_count=len(recipients),excluded=excluded))
            self.platform.save(conn,key,actor,command,result);return result

    def send(self,token,draft,key):
        if self.sms is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        command=dict(action='SMS_SEND',draft_id=draft)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.actor(conn,token,'SUBSCRIPTION_REMINDER_SEND',write=True)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            row=conn.execute('SELECT actor_id,filters,message,recipients,fingerprint,quote,expires_at FROM prsystem.operation_sms_draft WHERE id=%s',(draft,)).fetchone()
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if not row or row[0]!=actor:raise DomainError('FORBIDDEN')
            recipients,fingerprint,_,_=self._recipients(conn,row[1],now,lock_contacts=True)
            if row[6]<=now or fingerprint!=row[4] or recipients!=row[3] or self.sms.quote(row[2],len(recipients))!=row[5]:raise DomainError('SMS_PREVIEW_STALE')
            if not recipients:raise DomainError('SMS_NO_RECIPIENTS')
            if conn.execute('SELECT id FROM prsystem.operation_sms_job WHERE draft_id=%s',(draft,)).fetchone():raise DomainError('WORK_NOT_OPEN')
            job=secrets.token_hex(16);conn.execute('INSERT INTO prsystem.operation_sms_job(id,draft_id,actor_id) VALUES(%s,%s,%s)',(job,draft,actor))
            for recipient in recipients:
                rid=secrets.token_hex(16)
                conn.execute('INSERT INTO prsystem.operation_sms_recipient(id,job_id,phone,tenant_ids) VALUES(%s,%s,%s,%s)',(rid,job,recipient['phone'],Jsonb(recipient['tenant_ids'])))
                conn.execute('INSERT INTO prsystem.operation_sms_delivery(recipient_id) VALUES(%s)',(rid,))
                self._sms_event(conn,rid,0,'QUEUED',dict(actor_id=actor))
            result=dict(job_id=job,state='QUEUED',recipient_count=len(recipients),quote=row[5])
            self.platform._event(conn,actor,'SMS_SEND_CONFIRMED',job,dict(recipient_count=len(recipients),draft_id=draft))
            self.platform.save(conn,key,actor,command,result);return result

    @staticmethod
    def _sms_event(conn,rid,revision,state,details=None):
        conn.execute('INSERT INTO prsystem.operation_sms_event(id,recipient_id,revision,state,details) VALUES(%s,%s,%s,%s,%s)',(secrets.token_hex(16),rid,revision,state,Jsonb(details or {})))

    def _delivery(self,conn,rid,state,*,attempt=False,provider_id=None,error=None,details=None):
        revision=conn.execute('''UPDATE prsystem.operation_sms_delivery SET state=%s,revision=revision+1,attempts=attempts+%s,
            provider_id=coalesce(%s,provider_id),last_error_code=%s WHERE recipient_id=%s RETURNING revision''',(state,int(attempt),provider_id,error,rid)).fetchone()[0]
        self._sms_event(conn,rid,revision,state,details)

    def sms_history(self,token,after='',limit=25):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,token)
            rows=conn.execute('''SELECT j.id,j.created_at,d.message,d.quote FROM prsystem.operation_sms_job j JOIN prsystem.operation_sms_draft d ON d.id=j.draft_id
                WHERE j.id>%s ORDER BY j.id LIMIT %s''',(after,limit+1)).fetchall();items=[]
            for job,at,text,quote in rows[:limit]:
                recipients=conn.execute('''SELECT r.id,r.phone,d.state,d.attempts,d.revision,d.last_error_code FROM prsystem.operation_sms_recipient r
                    JOIN prsystem.operation_sms_delivery d ON d.recipient_id=r.id WHERE r.job_id=%s ORDER BY r.id''',(job,)).fetchall()
                items.append(dict(job_id=job,created_at=at.isoformat(),message=text,quote=quote,recipients=[dict(recipient_id=r[0],phone=masked(r[1]),state=r[2],attempts=r[3],revision=r[4],error_code=r[5]) for r in recipients]))
            return dict(items=items,next_after=items[-1]['job_id'] if len(rows)>limit else None)

    def delivery_command(self,token,rid,action,revision,key):
        command=dict(action='SMS_'+action,recipient_id=rid,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.actor(conn,token,'SUBSCRIPTION_REMINDER_SEND',write=True)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            row=conn.execute('SELECT state,attempts,revision FROM prsystem.operation_sms_delivery WHERE recipient_id=%s FOR UPDATE',(rid,)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if row[2]!=revision:raise DomainError('REVISION_CONFLICT')
            if action=='CANCEL' and row[0]=='QUEUED':state='CANCELLED'
            elif action=='RETRY' and row[0]=='FAILED' and row[1]<3:state='QUEUED'
            else:raise DomainError('WORK_NOT_OPEN')
            self._delivery(conn,rid,state,details=dict(actor_id=actor))
            result=dict(recipient_id=rid,state=state,revision=revision+1)
            self.platform._event(conn,actor,'SMS_'+action,rid,result);self.platform.save(conn,key,actor,command,result);return result

    def reset(self,token,tenant,key):
        command=dict(action='SUBSCRIPTION_PASSWORD_RESET_INITIATE',tenant_id=tenant)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.actor(conn,token,command['action'],write=True)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            row=conn.execute('''SELECT a.email FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
                JOIN prsystem.hotel_subscription s ON s.tenant_id=m.tenant_id WHERE m.tenant_id=%s AND m.is_primary FOR SHARE OF m,a''',(tenant,)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            conn.execute('INSERT INTO prsystem.password_reset_request(id,email) VALUES(%s,%s)',(secrets.token_hex(16),row[0]))
            result=dict(state='QUEUED',email=masked(row[0]));self.platform._event(conn,actor,command['action'],tenant,result)
            self.platform.save(conn,key,actor,command,result);return result

    def sms_once(self,limit=25):
        if type(limit) is not int or not 1<=limit<=100:raise ValueError('limit must be 1..100')
        if self.sms is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            rows=conn.execute("SELECT recipient_id FROM prsystem.operation_sms_delivery WHERE state IN('QUEUED','UNKNOWN','SENT') OR(state='SENDING' AND updated_at<clock_timestamp()-interval '5 minutes') ORDER BY updated_at,recipient_id LIMIT %s",(limit,)).fetchall()
        return [self._sms_one(rid) for (rid,) in rows]

    def _sms_one(self,rid):
        with transaction(self.auth.dsn) as conn:
            row=conn.execute('''SELECT d.state,r.phone,s.message,d.attempts FROM prsystem.operation_sms_delivery d JOIN prsystem.operation_sms_recipient r ON r.id=d.recipient_id
                JOIN prsystem.operation_sms_job j ON j.id=r.job_id JOIN prsystem.operation_sms_draft s ON s.id=j.draft_id
                WHERE d.recipient_id=%s FOR UPDATE OF d SKIP LOCKED''',(rid,)).fetchone()
            if not row or row[0] in {'DELIVERED','FAILED','CANCELLED'}:return dict(recipient_id=rid,state='SKIPPED')
            if row[0]=='SENDING':
                eligible=conn.execute("SELECT updated_at<clock_timestamp()-interval '5 minutes' FROM prsystem.operation_sms_delivery WHERE recipient_id=%s",(rid,)).fetchone()[0]
                if not eligible:return dict(recipient_id=rid,state='SKIPPED')
                self._delivery(conn,rid,'UNKNOWN',error='WORKER_INTERRUPTED')
            sending=row[0]=='QUEUED'
            if sending:self._delivery(conn,rid,'SENDING',attempt=True)
        # Send exactly once per claimed attempt. Unknown delivery is lookup-only.
        try:
            result=self.sms.send(rid,row[1],row[2],row[3]+1) if sending else self.sms.lookup(rid,row[3])
            if not isinstance(result,dict) or result.get('recipient_id')!=rid or result.get('attempt')!=(row[3]+int(sending)) or result.get('phone')!=row[1] or result.get('message')!=row[2] or result.get('state') not in {'SENT','DELIVERED','FAILED','UNKNOWN'}:
                raise DomainError('PROVIDER_EVIDENCE_INVALID')
            state=result['state'];error=None
        except (TimeoutError,OSError,DomainError):
            state='UNKNOWN';result={};error='PROVIDER_UNCERTAIN'
        with transaction(self.auth.dsn) as conn:
            current,current_attempt=conn.execute('SELECT state,attempts FROM prsystem.operation_sms_delivery WHERE recipient_id=%s FOR UPDATE',(rid,)).fetchone()
            # An old send/lookup response may arrive after a failed attempt was
            # manually retried. It cannot settle or annotate the newer attempt.
            if current_attempt!=row[3]+int(sending) or current in {'DELIVERED','FAILED','CANCELLED'}:return dict(recipient_id=rid,state=current)
            if current=='SENT' and state=='UNKNOWN':state='SENT'
            self._delivery(conn,rid,state,provider_id=result.get('provider_id'),error=error)
        return dict(recipient_id=rid,state=state)

    @staticmethod
    def _payment_snapshot(conn,kind,identity,paid_required=False):
        if kind=='ONBOARDING':
            row=conn.execute('''SELECT n.amount,a.email,p.payment_id,n.provider,n.merchant_id,n.invoice_id,a.id,a.payload->>'hotel_name',n.state
                FROM prsystem.onboarding_attempt n JOIN prsystem.onboarding_application a ON a.id=n.application_id
                LEFT JOIN prsystem.onboarding_payment p ON p.attempt_id=n.id WHERE n.id=%s''',(identity,)).fetchone()
        else:
            row=conn.execute('''SELECT n.amount,a.email,p.payment_id,n.provider,n.merchant_id,n.invoice_id,a.id,a.payload->>'hotel_name',n.state
                FROM prsystem.subscription_renewal n JOIN prsystem.hotel_subscription h ON h.tenant_id=n.tenant_id
                JOIN prsystem.onboarding_application a ON a.id=h.application_id
                LEFT JOIN prsystem.renewal_payment p ON p.renewal_id=n.id WHERE n.id=%s''',(identity,)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        if paid_required and row[2] is None:raise DomainError('PAYMENT_REQUIRED')
        return dict(source_kind=kind,source_id=identity,amount_mnt=row[0],currency='MNT',email=row[1],payment_id=row[2],provider=row[3],merchant_id=row[4],invoice_id=row[5],application_id=row[6],name=row[7],state=row[8])

    def billing_command(self,token,action,data,key):
        kind='EBARIMT' if action=='ebarimt' else 'PAYMENT_RECONCILE'
        permission='SUBSCRIPTION_EBARIMT_RETRY' if kind=='EBARIMT' else 'SUBSCRIPTION_PAYMENT_RECONCILE'
        if kind=='EBARIMT' and self.ebarimt is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        reason=data['reason'].strip()
        if not reason:raise DomainError('INVALID_REQUEST')
        command=dict(action=kind,data={**data,'reason':reason})
        with transaction(self.auth.dsn) as conn:
            actor,_=self.actor(conn,token,permission,write=True)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            snapshot=self._payment_snapshot(conn,data['source_kind'],data['source_id'],kind=='EBARIMT')
            # One idempotent billing intent per immutable payment/action. A
            # caller cannot create another tax receipt by choosing a new key.
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('operation-billing-source:'+kind+':'+data['source_kind']+':'+data['source_id'],))
            existing=conn.execute('SELECT id FROM prsystem.operation_billing_job WHERE kind=%s AND source_kind=%s AND source_id=%s',(kind,data['source_kind'],data['source_id'])).fetchone()
            if existing:
                conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('operation-billing:'+existing[0],))
                prior=conn.execute('SELECT state,attempt FROM prsystem.operation_billing_result WHERE job_id=%s ORDER BY attempt DESC LIMIT 1',(existing[0],)).fetchone()
                pending=conn.execute('SELECT coalesce(max(attempt),0) FROM prsystem.operation_billing_retry WHERE job_id=%s',(existing[0],)).fetchone()[0]
                if not prior or pending>prior[1]:result=dict(job_id=existing[0],state='QUEUED')
                elif prior[1]>=5:raise DomainError('PROVISION_RETRY_BLOCKED')
                else:
                    conn.execute('INSERT INTO prsystem.operation_billing_retry(job_id,attempt,actor_id,reason) VALUES(%s,%s,%s,%s)',(existing[0],prior[1]+1,actor,reason))
                    result=dict(job_id=existing[0],state='QUEUED',attempt=prior[1]+1)
            else:
                identity=secrets.token_hex(16)
                conn.execute('INSERT INTO prsystem.operation_billing_job(id,actor_id,kind,source_kind,source_id,snapshot) VALUES(%s,%s,%s,%s,%s,%s)',
                    (identity,actor,kind,data['source_kind'],data['source_id'],Jsonb(snapshot)))
                result=dict(job_id=identity,state='QUEUED')
            self.platform._event(conn,actor,permission,data['source_id'],dict(result,reason=reason,source_kind=data['source_kind']))
            self.platform.save(conn,key,actor,command,result);return result

    def billing_history(self,token,after='',limit=25):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,token)
            rows=conn.execute('''SELECT * FROM(
                SELECT 'ONBOARDING:'||n.id cursor,'ONBOARDING' kind,n.id source_id,a.payload->>'hotel_name' name,n.state,n.amount,p.payment_id IS NOT NULL paid
                FROM prsystem.onboarding_attempt n JOIN prsystem.onboarding_application a ON a.id=n.application_id LEFT JOIN prsystem.onboarding_payment p ON p.attempt_id=n.id
                UNION ALL SELECT 'RENEWAL:'||n.id,'RENEWAL',n.id,a.payload->>'hotel_name',n.state,n.amount,p.payment_id IS NOT NULL
                FROM prsystem.subscription_renewal n JOIN prsystem.hotel_subscription h ON h.tenant_id=n.tenant_id JOIN prsystem.onboarding_application a ON a.id=h.application_id LEFT JOIN prsystem.renewal_payment p ON p.renewal_id=n.id
                ) x WHERE cursor>%s ORDER BY cursor LIMIT %s''',(after,limit+1)).fetchall()
            items=[dict(zip(('cursor','source_kind','source_id','name','state','amount_mnt','paid'),r)) for r in rows[:limit]]
            jobs=conn.execute('''SELECT j.id,j.kind,j.source_kind,j.source_id,coalesce(r.state,'QUEUED'),r.result FROM prsystem.operation_billing_job j
                LEFT JOIN LATERAL(SELECT state,result FROM prsystem.operation_billing_result WHERE job_id=j.id ORDER BY attempt DESC LIMIT 1) r ON true ORDER BY j.created_at DESC,j.id DESC LIMIT %s''',(limit,)).fetchall()
            failed=conn.execute("SELECT id,payload->>'hotel_name',state FROM prsystem.onboarding_application WHERE state='PROVISIONING_FAILED' AND paid_attempt_id IS NOT NULL ORDER BY id LIMIT %s",(limit,)).fetchall()
            return dict(items=items,next_after=items[-1]['cursor'] if len(rows)>limit else None,
                jobs=[dict(job_id=r[0],kind=r[1],source_kind=r[2],source_id=r[3],state=r[4],result=r[5]) for r in jobs],
                failed_provisioning=[dict(application_id=r[0],name=r[1],state=r[2]) for r in failed],ebarimt_available=self.ebarimt is not None)

    def billing_once(self,limit=25):
        if type(limit) is not int or not 1<=limit<=100:raise ValueError('limit must be 1..100')
        with transaction(self.auth.dsn) as conn:
            jobs=conn.execute('''SELECT j.id,coalesce(x.attempt,0) FROM prsystem.operation_billing_job j
                LEFT JOIN LATERAL(SELECT max(attempt) attempt FROM prsystem.operation_billing_retry WHERE job_id=j.id) x ON true
                WHERE NOT EXISTS(SELECT 1 FROM prsystem.operation_billing_result r WHERE r.job_id=j.id AND r.attempt=coalesce(x.attempt,0)) ORDER BY j.created_at,j.id LIMIT %s''',(limit,)).fetchall()
        results=[]
        for job,attempt in jobs:
            # Advisory lock serializes workers, including after a provider timeout.
            # Provider issuance must deduplicate by immutable job ID.
            with transaction(self.auth.dsn) as conn:
                locked=conn.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0))',('operation-billing:'+job,)).fetchone()[0]
                if not locked or conn.execute('SELECT 1 FROM prsystem.operation_billing_result WHERE job_id=%s AND attempt=%s',(job,attempt)).fetchone():continue
                kind,source,identity,snapshot=conn.execute('SELECT kind,source_kind,source_id,snapshot FROM prsystem.operation_billing_job WHERE id=%s',(job,)).fetchone()
                try:
                    if kind=='EBARIMT':
                        if self.ebarimt is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
                        prior=conn.execute('SELECT state FROM prsystem.operation_billing_result WHERE job_id=%s ORDER BY attempt DESC LIMIT 1',(job,)).fetchone()
                        evidence=self.ebarimt.lookup(job) if prior and prior[0]=='UNKNOWN' else self.ebarimt.issue(job,snapshot)
                        if evidence.get('job_id')!=job or evidence.get('amount_mnt')!=snapshot['amount_mnt'] or evidence.get('currency')!='MNT' or evidence.get('email')!=snapshot['email'] or not evidence.get('receipt_id'):raise DomainError('PROVIDER_EVIDENCE_INVALID')
                        result=dict(receipt_id=evidence['receipt_id'],email=masked(snapshot['email']),mode=evidence.get('mode','LIVE'))
                    else:
                        port=self.onboarding if source=='ONBOARDING' else self.renewals
                        if port is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
                        evidence=port.reconcile(identity);result=dict(provider_state=evidence if isinstance(evidence,str) else evidence.get('state','RECONCILED'))
                    state='DONE'
                except (TimeoutError,OSError):state='UNKNOWN';result=dict(code='PROVIDER_UNCERTAIN')
                except DomainError as error:state='FAILED' if error.code=='OPERATION_PROVIDER_UNAVAILABLE' else 'UNKNOWN';result=dict(code=error.code)
                conn.execute('INSERT INTO prsystem.operation_billing_result(job_id,state,result,attempt) VALUES(%s,%s,%s,%s)',(job,state,Jsonb(result),attempt))
                results.append(dict(job_id=job,state=state))
        return results
