"""Explicit Platform permissions, password + TOTP and audited security recovery."""
import hmac
import secrets
from datetime import timedelta
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.staff_lifecycle import normalized_email
from prsystem.common import DomainError, identifier
from prsystem.mfa import totp
from prsystem.postgres.connection import transaction


class PlatformService:
    def __init__(self,auth,secret_resolver):
        self.auth=auth
        self._secret=secret_resolver  # trusted deployment secret store; no HTTP setter

    @staticmethod
    def _event(conn,actor,action,target=None,details=None):
        conn.execute('INSERT INTO prsystem.platform_event (id,actor_id,action,target_id,details) VALUES (%s,%s,%s,%s,%s)',(secrets.token_hex(16),actor,action,target,Jsonb(details or {})))

    def _mfa(self,conn,account,key_ref,last_counter,code):
        if not isinstance(code,str) or len(code)!=6 or not code.isascii() or not code.isdigit(): raise DomainError('INVALID_CREDENTIALS')
        secret=self._secret(key_ref)
        if not isinstance(secret,bytes) or len(secret)<20: raise DomainError('PLATFORM_UNAVAILABLE')
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        counter=int(now.timestamp())//30
        accepted=[n for n in range(max(0,counter-1),counter+2) if hmac.compare_digest(totp(secret,n),code) and n>last_counter]
        if not accepted: raise DomainError('INVALID_CREDENTIALS')
        conn.execute('UPDATE prsystem.platform_account SET last_totp_counter=%s WHERE id=%s',(max(accepted),account))
        return now

    def login(self,email,password,code,peer):
        email=normalized_email(email)
        self.auth._rate_limit(email,peer,'platform-login')
        with transaction(self.auth.dsn) as conn:
            row=conn.execute('SELECT id,password_hash,active,mfa_key_ref,last_totp_counter,revision FROM prsystem.platform_account WHERE email=%s FOR UPDATE',(email,)).fetchone()
            if not row or not row[2]:
                self.auth._verify(self.auth.passwords,self.auth._dummy_hash,password)
                raise DomainError('INVALID_CREDENTIALS')
            if not self.auth._verify(self.auth.passwords,row[1],password): raise DomainError('INVALID_CREDENTIALS')
            now=self._mfa(conn,row[0],row[3],row[4],code)
            token=secrets.token_urlsafe(32)
            conn.execute('INSERT INTO prsystem.platform_session (token_hash,account_id,revision,mfa_at,expires_at) VALUES (%s,%s,%s,%s,%s)',(digest(token),row[0],row[5],now,now+timedelta(hours=1)))
            self._event(conn,row[0],'LOGIN')
            return dict(access_token=token,token_type='bearer',expires_in=3600)

    def authenticate(self,conn,token,permission=None,recent=True):
        session=conn.execute('SELECT account_id FROM prsystem.platform_session WHERE token_hash=%s',(digest(token),)).fetchone()
        if not session: raise DomainError('UNAUTHENTICATED')
        account=conn.execute('SELECT active,permissions,revision,mfa_key_ref,last_totp_counter FROM prsystem.platform_account WHERE id=%s FOR UPDATE',(session[0],)).fetchone()
        row=conn.execute('SELECT revision,mfa_at,expires_at,revoked_at FROM prsystem.platform_session WHERE token_hash=%s FOR UPDATE',(digest(token),)).fetchone()
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        if not account[0] or row[3] is not None or row[0]!=account[2] or now>=row[2]: raise DomainError('UNAUTHENTICATED')
        if permission and permission not in account[1]: raise DomainError('FORBIDDEN')
        if recent and (row[1]>now or now>=row[1]+timedelta(minutes=5)): raise DomainError('MFA_REQUIRED')
        return session[0],account

    def step_up(self,token,code,peer):
        self.auth._rate_limit(digest(token),peer,'platform-mfa')
        with transaction(self.auth.dsn) as conn:
            actor,account=self.authenticate(conn,token,recent=False)
            now=self._mfa(conn,actor,account[3],account[4],code)
            conn.execute('UPDATE prsystem.platform_session SET mfa_at=%s WHERE token_hash=%s',(now,digest(token)))
            self._event(conn,actor,'STEP_UP')
            return dict(status='VERIFIED')

    def receipt(self,conn,key,actor,command):
        identifier(key)
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('platform:'+key,))
        row=conn.execute('SELECT actor_id,command,result FROM prsystem.platform_receipt WHERE key=%s',(key,)).fetchone()
        if row:
            if row[:2]!=(actor,command): raise DomainError('IDEMPOTENCY_CONFLICT')
            return row[2]

    def save(self,conn,key,actor,command,result):
        conn.execute('INSERT INTO prsystem.platform_receipt VALUES (%s,%s,%s,%s)',(key,actor,Jsonb(command),Jsonb(result)))

    def hotel_security(self,token,tenant,suspend,key,reason,reference):
        if type(suspend) is not bool or not reason.strip() or len(reason)>1000 or not reference.strip() or len(reference)>200: raise DomainError('INVALID_REQUEST')
        command=dict(action='HOTEL_SECURITY',tenant=tenant,suspended=suspend,reason=reason,reference=reference)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.authenticate(conn,token,'SUBSCRIPTION_SUSPEND')
            replay=self.receipt(conn,key,actor,command)
            if replay is not None: return replay
            row=conn.execute('SELECT security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            if not row: raise DomainError('WORK_SOURCE_NOT_FOUND')
            conn.execute('UPDATE prsystem.hotel_access SET security_suspended=%s WHERE tenant_id=%s',(suspend,tenant))
            result=dict(tenant_id=tenant,security_suspended=suspend)
            self._event(conn,actor,'HOTEL_SECURITY_CHANGED',tenant,dict(before=row[0],after=suspend,reason=reason,reference=reference))
            self.save(conn,key,actor,command,result); return result

    def denial(self,token,action,code):
        with transaction(self.auth.dsn) as conn:
            actor=None
            if token:
                row=conn.execute('''SELECT s.account_id FROM prsystem.platform_session s JOIN prsystem.platform_account a ON a.id=s.account_id
                    WHERE s.token_hash=%s AND a.active AND s.revision=a.revision AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()''',(digest(token),)).fetchone()
                if row: actor=row[0]
            self._event(conn,actor,'DENIED',details=dict(action=action,code=code))
