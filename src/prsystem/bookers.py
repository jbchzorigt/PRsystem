"""Mock phone possession for the independent booking customer realm."""
import re
import secrets
from datetime import timedelta
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.common import DomainError
from prsystem.postgres.connection import transaction
from prsystem.mock_providers import MockPhoneGateway


class Bookers:
    def __init__(self,booking,phone):self.booking,self.auth,self.phone=booking,booking.auth,phone
    def ready(self):
        self.booking.mock()
        if not isinstance(self.phone,MockPhoneGateway):raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
    @staticmethod
    def phone_number(value):
        value=value.strip().replace(' ','')
        if re.fullmatch(r'[0-9]{8}',value):value='+976'+value
        if not re.fullmatch(r'\+976[0-9]{8}',value):raise DomainError('INVALID_REQUEST')
        return value
    def event(self,conn,actor,kind):conn.execute('INSERT INTO prsystem.booker_event(id,account_id,kind) VALUES(%s,%s,%s)',(secrets.token_hex(16),actor,kind))
    def challenge(self,phone,purpose,device,peer):
        self.ready();phone=self.phone_number(phone)
        if purpose not in {'REGISTER','RESET'}:raise DomainError('INVALID_REQUEST')
        self.auth._rate_limit(phone,peer,'booker-phone');self.auth._rate_limit(device,peer,'booker-device')
        identity=secrets.token_hex(16)
        with transaction(self.auth.dsn) as conn:
            conn.execute("INSERT INTO prsystem.booker_challenge(id,phone_hash,phone_envelope,purpose,expires_at) VALUES(%s,%s,%s,%s,clock_timestamp()+interval '5 minutes')",(identity,self.booking.vault.fingerprint('booker-phone',phone),Jsonb(self.booking.vault.seal(phone,'BOOKER',identity,'phone')),purpose))
        self.phone.request(phone,identity)
        return dict(challenge_id=identity,mode='MOCK_ONLY',expires_in=300)
    def complete(self,challenge,code,password,peer):
        self.ready();self.auth._rate_limit(challenge,peer,'booker-verify')
        if not isinstance(password,str) or not 12<=len(password)<=128:raise DomainError('INVALID_PASSWORD')
        encoded=self.auth.passwords.hash(password)
        with transaction(self.auth.dsn) as conn:
            row=conn.execute('SELECT phone_hash,phone_envelope,purpose,expires_at,consumed_at FROM prsystem.booker_challenge WHERE id=%s FOR UPDATE',(challenge,)).fetchone()
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if not row or row[4] or now>=row[3] or not self.phone.verify(challenge,code):raise DomainError('INVALID_CREDENTIALS')
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('booker-phone:'+row[0],))
            old=conn.execute('SELECT id,active FROM prsystem.booker_account WHERE phone_hash=%s FOR UPDATE',(row[0],)).fetchone()
            if (row[2]=='REGISTER' and old) or (row[2]=='RESET' and (not old or not old[1])):raise DomainError('INVALID_CREDENTIALS')
            if old:
                actor=old[0];conn.execute('UPDATE prsystem.booker_account SET password_hash=%s,revision=revision+1 WHERE id=%s',(encoded,actor))
            else:
                actor=secrets.token_hex(16);phone=self.booking.vault.open(row[1],'BOOKER',challenge,'phone')
                conn.execute('INSERT INTO prsystem.booker_account(id,phone_hash,phone_envelope,password_hash) VALUES(%s,%s,%s,%s)',(actor,row[0],Jsonb(self.booking.vault.seal(phone,'BOOKER',actor,'phone')),encoded))
            conn.execute('UPDATE prsystem.booker_challenge SET consumed_at=clock_timestamp() WHERE id=%s',(challenge,));self.event(conn,actor,row[2])
        return dict(status='READY_TO_LOGIN',mode='MOCK_ONLY')
    def login(self,phone,password,peer):
        self.ready();phone=self.phone_number(phone);self.auth._rate_limit(phone,peer,'booker-login')
        with transaction(self.auth.dsn) as conn:
            row=conn.execute('SELECT id,password_hash,active,revision FROM prsystem.booker_account WHERE phone_hash=%s FOR UPDATE',(self.booking.vault.fingerprint('booker-phone',phone),)).fetchone()
            valid=self.auth._verify(self.auth.passwords,row[1] if row else self.auth._dummy_hash,password)
            if not row or not valid or not row[2]:raise DomainError('INVALID_CREDENTIALS')
            token=secrets.token_urlsafe(32);expires=conn.execute('SELECT clock_timestamp()').fetchone()[0]+timedelta(seconds=self.auth.settings.absolute_seconds)
            conn.execute('INSERT INTO prsystem.booker_session(token_hash,account_id,revision,expires_at) VALUES(%s,%s,%s,%s)',(digest(token),row[0],row[3],expires));self.event(conn,row[0],'LOGIN')
            return dict(access_token=token,expires_at=expires,phone=phone,assurance='MOCK_PHONE_POSSESSION',mode='MOCK_ONLY')
    def authenticate(self,conn,token):
        self.ready()
        actor=conn.execute('SELECT account_id FROM prsystem.booker_session WHERE token_hash=%s',(digest(token),)).fetchone()
        if not actor:raise DomainError('UNAUTHENTICATED')
        account=conn.execute('SELECT active,revision FROM prsystem.booker_account WHERE id=%s FOR UPDATE',actor).fetchone()
        session=conn.execute('SELECT revision,expires_at,revoked_at FROM prsystem.booker_session WHERE token_hash=%s FOR UPDATE',(digest(token),)).fetchone()
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        if not account or not account[0] or session[0]!=account[1] or session[2] or now>=session[1]:raise DomainError('UNAUTHENTICATED')
        return actor[0]
    def logout(self,token):
        with transaction(self.auth.dsn) as conn:
            actor=self.authenticate(conn,token);conn.execute('UPDATE prsystem.booker_session SET revoked_at=clock_timestamp() WHERE token_hash=%s',(digest(token),));self.event(conn,actor,'LOGOUT')
        return dict(status='SIGNED_OUT')
