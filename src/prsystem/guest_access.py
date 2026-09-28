"""Opaque room QR + one-use code. All code/session capacity shares a stay lock."""
import secrets
from datetime import timedelta
from psycopg.types.json import Jsonb
from prsystem.auth import digest
from prsystem.common import DomainError
from prsystem.guest_finance import GuestFinance
from prsystem.postgres.connection import transaction


class GuestAccess(GuestFinance):
    @staticmethod
    def package(conn,tenant):
        row=conn.execute('SELECT package_mnt,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        if not row or row[0]!=30000 or row[1]:raise DomainError('FORBIDDEN')

    def qr(self,bearer,tenant,room,revision,key,reason):
        reason=self._text(reason,1000)
        command=dict(action='ROTATE_ROOM_QR',room=room,revision=revision,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant);self.package(conn,tenant)
            if self.vault is None:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
            replay=self._receipt(conn,tenant,key,actor,command)
            self._catalog_lock(conn,tenant)
            if not conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,room)).fetchone():raise DomainError('WORK_SOURCE_NOT_FOUND')
            old=conn.execute('SELECT revision,envelope FROM prsystem.room_guest_qr WHERE tenant_id=%s AND room_id=%s FOR UPDATE',(tenant,room)).fetchone()
            if replay is not None:
                # A rotated secret cannot be recovered using an older command.
                if not old or old[0]!=replay['revision']:raise DomainError('REVISION_CONFLICT')
                return dict(replay,qr_token=self.vault.open(old[1],tenant,room,'room-qr'))
            if revision!=(old[0] if old else 0):raise DomainError('REVISION_CONFLICT')
            # Same order as checkout: room, stay, then QR/session projections.
            conn.execute('SELECT id FROM prsystem.stay WHERE tenant_id=%s AND room_id=%s ORDER BY id FOR UPDATE',(tenant,room)).fetchall()
            token=secrets.token_urlsafe(32)
            conn.execute('''INSERT INTO prsystem.room_guest_qr(tenant_id,room_id,token_hash,envelope,revision) VALUES(%s,%s,%s,%s,%s)
                ON CONFLICT(tenant_id,room_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,envelope=EXCLUDED.envelope,
                revision=EXCLUDED.revision,failures=0,blocked_until=NULL''',(tenant,room,digest(token),Jsonb(self.vault.seal(token,tenant,room,'room-qr')),revision+1))
            conn.execute('UPDATE prsystem.guest_session SET revoked_at=clock_timestamp() WHERE tenant_id=%s AND room_id=%s AND revoked_at IS NULL',(tenant,room))
            conn.execute('''UPDATE prsystem.stay_guest_code c SET revoked_at=clock_timestamp() FROM prsystem.stay s
                WHERE (s.tenant_id,s.id)=(c.tenant_id,c.stay_id) AND s.tenant_id=%s AND s.room_id=%s AND c.revoked_at IS NULL''',(tenant,room))
            result=dict(room_id=room,revision=revision+1)
            self.event(conn,tenant,actor,'ROOM_QR_ROTATED',room,dict(result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result)
            return dict(result,qr_token=token)

    @staticmethod
    def capacity(conn,tenant,stay):
        return conn.execute('''SELECT (SELECT count(*) FROM prsystem.guest_session WHERE tenant_id=%s AND stay_id=%s AND revoked_at IS NULL)
            +(SELECT count(*) FROM prsystem.stay_guest_code WHERE tenant_id=%s AND stay_id=%s AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())''',(tenant,stay,tenant,stay)).fetchone()[0]

    def codes(self,bearer,tenant,stay,key,*,revoke=False):
        command=dict(action='REVOKE_GUEST_ACCESS' if revoke else 'ISSUE_GUEST_CODE',stay=stay)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay);self.package(conn,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            row=conn.execute('SELECT state FROM prsystem.stay WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,stay)).fetchone()
            if not row or row[0]!='ACTIVE':raise DomainError('WORK_NOT_OPEN')
            if replay is not None:
                if revoke:return replay
                code=conn.execute('''SELECT envelope FROM prsystem.stay_guest_code WHERE tenant_id=%s AND id=%s
                    AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()''',(tenant,replay['code_id'])).fetchone()
                return dict(replay,code=self.vault.open(code[0],tenant,stay,'guest-code') if code else None)
            if revoke:
                conn.execute('UPDATE prsystem.guest_session SET revoked_at=clock_timestamp() WHERE tenant_id=%s AND stay_id=%s AND revoked_at IS NULL',(tenant,stay))
                conn.execute('UPDATE prsystem.stay_guest_code SET revoked_at=clock_timestamp() WHERE tenant_id=%s AND stay_id=%s AND revoked_at IS NULL',(tenant,stay))
                result=dict(stay_id=stay,status='REVOKED')
            else:
                if self.vault is None:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
                if self.capacity(conn,tenant,stay)>=5:raise DomainError('GUEST_ACCESS_LIMIT')
                code=f'{secrets.randbelow(1000000):06d}';identity=secrets.token_hex(16)
                now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
                conn.execute('''INSERT INTO prsystem.stay_guest_code(tenant_id,stay_id,id,code_hash,envelope,created_at,expires_at)
                    VALUES(%s,%s,%s,%s,%s,%s,%s)''',(tenant,stay,identity,self.vault.fingerprint('guest-code',[tenant,stay,code]),Jsonb(self.vault.seal(code,tenant,stay,'guest-code')),now,now+timedelta(minutes=10)))
                result=dict(stay_id=stay,code_id=identity,expires_at=(now+timedelta(minutes=10)).isoformat())
            self.event(conn,tenant,actor,command['action'],stay,result)
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result if revoke else dict(result,code=code)

    def redeem(self,qr_token,code):
        failure='INVALID_GUEST_ACCESS';result=None
        with transaction(self.auth.dsn) as conn:
            qr=conn.execute('SELECT tenant_id,room_id FROM prsystem.room_guest_qr WHERE token_hash=%s',(digest(qr_token),)).fetchone()
            if qr:
                tenant,room=qr;self.package(conn,tenant)
                conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,room)).fetchone()
                stay=conn.execute("SELECT id FROM prsystem.stay WHERE tenant_id=%s AND room_id=%s AND state='ACTIVE' FOR UPDATE",(tenant,room)).fetchone()
                current=conn.execute('SELECT revision,failures,blocked_until FROM prsystem.room_guest_qr WHERE tenant_id=%s AND room_id=%s AND token_hash=%s FOR UPDATE',(tenant,room,digest(qr_token))).fetchone()
                now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
                if current and current[2] and current[2]>now:failure='RATE_LIMITED'
                elif current and stay and self.vault:
                    item=conn.execute('''SELECT id FROM prsystem.stay_guest_code WHERE tenant_id=%s AND stay_id=%s AND code_hash=%s
                        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>%s ORDER BY created_at,id LIMIT 1 FOR UPDATE''',(tenant,stay[0],self.vault.fingerprint('guest-code',[tenant,stay[0],code]),now)).fetchone()
                    if item and self.capacity(conn,tenant,stay[0])<=5:
                        token=secrets.token_urlsafe(32)
                        conn.execute('UPDATE prsystem.stay_guest_code SET consumed_at=%s WHERE tenant_id=%s AND id=%s',(now,tenant,item[0]))
                        conn.execute('INSERT INTO prsystem.guest_session(token_hash,tenant_id,room_id,stay_id,qr_revision) VALUES(%s,%s,%s,%s,%s)',(digest(token),tenant,room,stay[0],current[0]))
                        conn.execute('UPDATE prsystem.room_guest_qr SET failures=0,blocked_until=NULL WHERE tenant_id=%s AND room_id=%s',(tenant,room))
                        result=dict(access_token=token,token_type='Bearer')
                    else:
                        failures=(0 if current[2] else current[1])+1
                        conn.execute('UPDATE prsystem.room_guest_qr SET failures=%s,blocked_until=%s WHERE tenant_id=%s AND room_id=%s',(failures,now+timedelta(minutes=10) if failures>=5 else None,tenant,room))
                # Commit failed attempts before returning the generic failure.
        if result is None:raise DomainError(failure)
        return result

    def session(self,bearer):
        with transaction(self.auth.dsn) as conn:
            row=conn.execute('''SELECT s.tenant_id,r.number,s.planned_checkout_at FROM prsystem.guest_session g
                JOIN prsystem.stay s ON(s.tenant_id,s.id)=(g.tenant_id,g.stay_id)
                JOIN prsystem.room r ON(r.tenant_id,r.id)=(g.tenant_id,g.room_id)
                JOIN prsystem.room_guest_qr q ON(q.tenant_id,q.room_id,q.revision)=(g.tenant_id,g.room_id,g.qr_revision)
                WHERE g.token_hash=%s AND g.revoked_at IS NULL AND s.state='ACTIVE' ''',(digest(bearer),)).fetchone()
            if not row:raise DomainError('INVALID_GUEST_ACCESS')
            self.package(conn,row[0])
            return dict(room_number=row[1],planned_checkout_at=row[2])

    def devices(self,bearer,tenant,stay,session=None,key=None):
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay);self.package(conn,tenant)
            if session:
                command=dict(action='REVOKE_GUEST_DEVICE',stay=stay,session=session)
                replay=self._receipt(conn,tenant,key,actor,command)
                if replay is not None:return replay
                if not conn.execute('SELECT id FROM prsystem.stay WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,stay)).fetchone():raise DomainError('WORK_SOURCE_NOT_FOUND')
                if not conn.execute('UPDATE prsystem.guest_session SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE tenant_id=%s AND stay_id=%s AND id=%s RETURNING id',(tenant,stay,session)).fetchone():raise DomainError('WORK_SOURCE_NOT_FOUND')
                result=dict(session_id=session,status='REVOKED')
                self.event(conn,tenant,actor,'GUEST_DEVICE_REVOKED',stay,result)
                self._save_receipt(conn,tenant,key,actor,command,result);return result
            rows=conn.execute('SELECT id,created_at FROM prsystem.guest_session WHERE tenant_id=%s AND stay_id=%s AND revoked_at IS NULL ORDER BY created_at,id LIMIT 5',(tenant,stay)).fetchall()
            return [dict(session_id=r[0],created_at=r[1]) for r in rows]

    def qr_card(self,bearer,tenant,room,origin):
        from urllib.parse import urlsplit
        parsed=urlsplit(origin)
        if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {'','/'} or parsed.query or parsed.fragment:
            raise DomainError('PUBLIC_ORIGIN_REQUIRED')
        if parsed.scheme!='https' and parsed.hostname not in {'localhost','127.0.0.1','::1'}:raise DomainError('PUBLIC_ORIGIN_REQUIRED')
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant);self.package(conn,tenant)
            if not self.vault:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
            row=conn.execute('SELECT r.number,q.revision,q.envelope FROM prsystem.room r JOIN prsystem.room_guest_qr q ON(q.tenant_id,q.room_id)=(r.tenant_id,r.id) WHERE r.tenant_id=%s AND r.id=%s',(tenant,room)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            token=self.vault.open(row[2],tenant,room,'room-qr')
            import qrcode
            qr=qrcode.QRCode(border=4,error_correction=qrcode.constants.ERROR_CORRECT_M)
            qr.add_data(origin.rstrip('/')+'/guest/entry#qr='+token);qr.make(fit=True)
            self.event(conn,tenant,actor,'ROOM_QR_CARD_READ',room,dict(revision=row[1]))
            return dict(room_number=row[0],revision=row[1],matrix=qr.get_matrix())
