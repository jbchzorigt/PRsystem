"""Primary-admin contact changes require fresh proofs of both phone numbers."""
import secrets
from datetime import timedelta
from prsystem.auth import digest
from prsystem.common import DomainError
from prsystem.operation_policy import phone,masked
from prsystem.postgres.connection import transaction
from prsystem.staff_commands import StaffCommands


class SubscriptionContact(StaffCommands):
    def __init__(self,auth,platform,phone_gateway,notice_gateway=None):
        super().__init__(auth);self.platform,self.phone,self.notices=platform,phone_gateway,notice_gateway

    def primary(self,conn,token,tenant):
        principal,_=self.auth._authenticate(conn,token,tenant)
        actor=principal['account_id']
        row=conn.execute('''SELECT a.password_hash,a.email FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
            JOIN prsystem.hotel_subscription s ON s.tenant_id=m.tenant_id WHERE m.tenant_id=%s AND m.account_id=%s AND m.is_primary FOR SHARE OF m,a''',(tenant,actor)).fetchone()
        if not row:raise DomainError('FORBIDDEN')
        conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('subscription-contact:'+tenant,))
        return actor,row

    @staticmethod
    def request(conn,tenant,identity,actor=None):
        row=conn.execute('''SELECT actor_id,expected_revision,old_phone,new_phone,email,state FROM prsystem.subscription_contact_change
            WHERE tenant_id=%s AND id=%s''',(tenant,identity)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        if actor is not None and row[0]!=actor:raise DomainError('FORBIDDEN')
        return row

    def read(self,token,tenant):
        with transaction(self.auth.dsn) as conn:
            actor,_=self.primary(conn,token,tenant)
            current=conn.execute('SELECT prsystem.subscription_contact_phone(%s),coalesce((SELECT max(revision) FROM prsystem.subscription_contact WHERE tenant_id=%s),0)',(tenant,tenant)).fetchone()
            q=conn.execute("SELECT id,old_phone,new_phone FROM prsystem.subscription_contact_change WHERE tenant_id=%s AND actor_id=%s AND state='OPEN'",(tenant,actor)).fetchone()
            pending=None
            if q:
                states=conn.execute('''SELECT DISTINCT ON(c.side) c.side,c.expires_at,v.challenge_id IS NOT NULL FROM prsystem.subscription_contact_challenge c
                    LEFT JOIN prsystem.subscription_contact_verified v ON(v.tenant_id,v.challenge_id)=(c.tenant_id,c.id)
                    WHERE c.tenant_id=%s AND c.request_id=%s ORDER BY c.side,c.created_at DESC,c.id DESC''',(tenant,q[0])).fetchall()
                exception=conn.execute('SELECT 1 FROM prsystem.subscription_contact_exception WHERE tenant_id=%s AND request_id=%s',(tenant,q[0])).fetchone()
                pending=dict(request_id=q[0],old_phone=masked(q[1]),new_phone=masked(q[2]),exception_approved=bool(exception),proofs=[dict(side=r[0],expires_at=r[1].isoformat(),verified=r[2] and r[1]>conn.execute('SELECT clock_timestamp()').fetchone()[0]) for r in states])
            return dict(phone=masked(current[0]),revision=current[1],pending=pending,available=self.phone is not None)

    def start(self,token,tenant,new_phone,password,key,peer):
        new_phone=phone(new_phone)
        if new_phone is None:raise DomainError('INVALID_REQUEST')
        if self.phone is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        self.auth._rate_limit(digest(token),peer,'contact-start')
        command=dict(action='CONTACT_CHANGE_START',new_phone=new_phone)
        with transaction(self.auth.dsn) as conn:
            actor,account=self.primary(conn,token,tenant)
            if not self.auth._verify(self.auth.passwords,account[0],password):raise DomainError('INVALID_CREDENTIALS')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            old=phone(conn.execute('SELECT prsystem.subscription_contact_phone(%s)',(tenant,)).fetchone()[0])
            if old==new_phone:raise DomainError('INVALID_REQUEST')
            revision=conn.execute('SELECT coalesce(max(revision),0) FROM prsystem.subscription_contact WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            conn.execute("UPDATE prsystem.subscription_contact_change SET state='CANCELLED' WHERE tenant_id=%s AND state='OPEN'",(tenant,))
            identity=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.subscription_contact_change(tenant_id,id,actor_id,expected_revision,old_phone,new_phone,email) VALUES(%s,%s,%s,%s,%s,%s,%s)',(tenant,identity,actor,revision,old,new_phone,account[1]))
            result=dict(request_id=identity,state='OPEN',old_phone=masked(old),new_phone=masked(new_phone))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def challenge(self,token,tenant,identity,side,key,peer):
        if self.phone is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        self.auth._rate_limit(digest(token),peer,'contact-otp-send')
        command=dict(action='CONTACT_CHALLENGE',request_id=identity,side=side)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.primary(conn,token,tenant);q=self.request(conn,tenant,identity,actor)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:challenge=replay['challenge_id'];number=q[2 if side=='OLD' else 3]
            else:
                if q[5]!='OPEN':raise DomainError('WORK_NOT_OPEN')
                number=q[2 if side=='OLD' else 3]
                if not number:raise DomainError('PHONE_PROOF_REQUIRED')
                self.auth._rate_limit(number,peer,'contact-phone-send')
                previous=conn.execute('SELECT created_at FROM prsystem.subscription_contact_challenge WHERE tenant_id=%s AND request_id=%s AND side=%s ORDER BY created_at DESC LIMIT 1',(tenant,identity,side)).fetchone()
                now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
                if previous and previous[0]+timedelta(seconds=60)>now:raise DomainError('RATE_LIMITED')
                challenge=secrets.token_hex(16)
                conn.execute('INSERT INTO prsystem.subscription_contact_challenge(tenant_id,request_id,id,side,expires_at) VALUES(%s,%s,%s,%s,%s)',(tenant,identity,challenge,side,now+timedelta(minutes=5)))
                replay=dict(challenge_id=challenge,state='QUEUED',side=side)
                self._save_receipt(conn,tenant,key,actor,command,replay)
        # Provider deduplicates by this persisted challenge ID; no OTP in API.
        self.phone.request(number,challenge)
        return replay

    def verify(self,token,tenant,identity,side,code,peer):
        if self.phone is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        if len(code)!=6 or not code.isascii() or not code.isdigit():raise DomainError('INVALID_REQUEST')
        self.auth._rate_limit(digest(token),peer,'contact-otp-verify')
        with transaction(self.auth.dsn) as conn:
            actor,_=self.primary(conn,token,tenant);q=self.request(conn,tenant,identity,actor)
            if q[5]!='OPEN':raise DomainError('WORK_NOT_OPEN')
            row=conn.execute('SELECT id,expires_at,clock_timestamp() FROM prsystem.subscription_contact_challenge WHERE tenant_id=%s AND request_id=%s AND side=%s ORDER BY created_at DESC,id DESC LIMIT 1',(tenant,identity,side)).fetchone()
            if not row or row[1]<=row[2]:raise DomainError('PHONE_PROOF_REQUIRED')
            if conn.execute('SELECT 1 FROM prsystem.subscription_contact_verified WHERE tenant_id=%s AND challenge_id=%s',(tenant,row[0])).fetchone():return dict(state='VERIFIED',side=side)
            # Five-attempt / consumed-proof enforcement belongs to the injected
            # OTP adapter. The mock is durable and uses the same strict limit.
            if not self.phone.verify(row[0],code):raise DomainError('INVALID_CREDENTIALS')
            conn.execute('INSERT INTO prsystem.subscription_contact_verified(tenant_id,challenge_id) VALUES(%s,%s)',(tenant,row[0]))
            return dict(state='VERIFIED',side=side)

    def complete(self,token,tenant,identity,key):
        command=dict(action='CONTACT_CHANGE_COMPLETE',request_id=identity)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.primary(conn,token,tenant);q=self.request(conn,tenant,identity,actor)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            if q[5]!='OPEN':raise DomainError('WORK_NOT_OPEN')
            for side in ('OLD','NEW'):
                if side=='OLD' and conn.execute('SELECT 1 FROM prsystem.subscription_contact_exception WHERE tenant_id=%s AND request_id=%s',(tenant,identity)).fetchone():continue
                verified=conn.execute('''SELECT c.expires_at>clock_timestamp() AND v.challenge_id IS NOT NULL FROM prsystem.subscription_contact_challenge c
                    LEFT JOIN prsystem.subscription_contact_verified v ON(v.tenant_id,v.challenge_id)=(c.tenant_id,c.id)
                    WHERE c.tenant_id=%s AND c.request_id=%s AND c.side=%s ORDER BY c.created_at DESC,c.id DESC LIMIT 1''',(tenant,identity,side)).fetchone()
                if not verified or not verified[0]:raise DomainError('PHONE_PROOF_REQUIRED')
            current=conn.execute('SELECT coalesce(max(revision),0) FROM prsystem.subscription_contact WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            if current!=q[1]:raise DomainError('REVISION_CONFLICT')
            conn.execute('INSERT INTO prsystem.subscription_contact(tenant_id,revision,phone,request_id) VALUES(%s,%s,%s,%s)',(tenant,current+1,q[3],identity))
            conn.execute("UPDATE prsystem.subscription_contact_change SET state='APPLIED' WHERE tenant_id=%s AND id=%s",(tenant,identity))
            for channel,recipient in [('EMAIL',q[4]),('SMS',q[2])]:
                if recipient:conn.execute('INSERT INTO prsystem.subscription_contact_notice(tenant_id,id,request_id,channel,recipient) VALUES(%s,%s,%s,%s,%s)',(tenant,secrets.token_hex(16),identity,channel,recipient))
            result=dict(state='APPLIED',revision=current+1,phone=masked(q[3]))
            self.auth._audit(conn,'SUBSCRIPTION_CONTACT_CHANGED',actor,tenant)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def exception(self,token,tenant,identity,reason,reference,key):
        from prsystem.operation_dashboard import OperationDashboard
        reason=reason.strip();reference=reference.strip()
        if not reason or not reference:raise DomainError('INVALID_REQUEST')
        command=dict(action='SUBSCRIPTION_CONTACT_CHANGE_APPROVE',request_id=identity,tenant_id=tenant,reason=reason,reference=reference)
        with transaction(self.auth.dsn) as conn:
            actor,_=OperationDashboard(self.auth,self.platform).actor(conn,token,command['action'],write=True)
            replay=self.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('subscription-contact:'+tenant,))
            q=self.request(conn,tenant,identity)
            if q[5]!='OPEN':raise DomainError('WORK_NOT_OPEN')
            if not conn.execute('SELECT 1 FROM prsystem.subscription_contact_exception WHERE tenant_id=%s AND request_id=%s',(tenant,identity)).fetchone():
                conn.execute('INSERT INTO prsystem.subscription_contact_exception(tenant_id,request_id,actor_id,reason,reference) VALUES(%s,%s,%s,%s,%s)',(tenant,identity,actor,reason,reference))
            result=dict(state='OLD_PHONE_EXCEPTION_APPROVED',new_phone_verification_required=True)
            self.platform._event(conn,actor,command['action'],identity,dict(reason=reason,reference=reference,old_phone=masked(q[2]),new_phone=masked(q[3])))
            self.platform.save(conn,key,actor,command,result);return result

    def support(self,token,tenant):
        from prsystem.operation_dashboard import OperationDashboard
        with transaction(self.auth.dsn) as conn:
            OperationDashboard(self.auth,self.platform).actor(conn,token)
            row=conn.execute("SELECT id,old_phone,new_phone FROM prsystem.subscription_contact_change WHERE tenant_id=%s AND state='OPEN'",(tenant,)).fetchone()
            return dict(pending=dict(request_id=row[0],old_phone=masked(row[1]),new_phone=masked(row[2])) if row else None)

    def notice_once(self,tenant,limit=25):
        if type(limit) is not int or not 1<=limit<=100:raise ValueError('limit must be 1..100')
        if self.notices is None:raise DomainError('OPERATION_PROVIDER_UNAVAILABLE')
        results=[]
        with transaction(self.auth.dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            rows=conn.execute('''SELECT n.id,n.channel,n.recipient FROM prsystem.subscription_contact_notice n
                LEFT JOIN prsystem.subscription_contact_notice_result r ON(r.tenant_id,r.notice_id)=(n.tenant_id,n.id)
                WHERE n.tenant_id=%s AND r.notice_id IS NULL ORDER BY n.recorded_at,n.id LIMIT %s''',(tenant,limit)).fetchall()
        for identity,channel,recipient in rows:
            try:evidence=self.notices.send(identity,channel,recipient)
            except (OSError,TimeoutError):continue
            if evidence.get('notice_id')!=identity or evidence.get('channel')!=channel or evidence.get('recipient')!=recipient or not evidence.get('provider_id'):raise DomainError('PROVIDER_EVIDENCE_INVALID')
            with transaction(self.auth.dsn) as conn:
                conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
                conn.execute('INSERT INTO prsystem.subscription_contact_notice_result(tenant_id,notice_id,provider_id) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING',(tenant,identity,evidence['provider_id']))
            results.append(dict(notice_id=identity,state='SENT'))
        return results
