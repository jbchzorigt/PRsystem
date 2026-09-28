"""Canonical first drawer opening from configured float and physical count."""

import secrets
from psycopg.types.json import Jsonb

from prsystem.common import DomainError, money
from prsystem.postgres.connection import transaction
from prsystem.shifts import ShiftService


class OpeningService(ShiftService):
    @staticmethod
    def _unused(conn, tenant, drawer):
        row = conn.execute('SELECT posted,reserved FROM prsystem.cash_drawer WHERE tenant_id=%s AND id=%s FOR UPDATE', (tenant, drawer)).fetchone()
        if not row:
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        if row != (0, 0) or conn.execute('SELECT 1 FROM prsystem.reception_shift WHERE tenant_id=%s AND drawer_id=%s', (tenant, drawer)).fetchone() or conn.execute('SELECT 1 FROM prsystem.cash_event WHERE tenant_id=%s AND drawer_id=%s', (tenant, drawer)).fetchone() or conn.execute('SELECT 1 FROM prsystem.cash_transfer WHERE tenant_id=%s AND (source_id=%s OR destination_id=%s)', (tenant, drawer, drawer)).fetchone():
            raise DomainError('DRAWER_ALREADY_USED')

    def configure(self, bearer, tenant, drawer, data, key, revision=0):
        money(data['expected_float'])
        if type(revision) is not int or revision < 0 or data['status'] not in {'ACTIVE','INACTIVE'}:
            raise DomainError('INVALID_REQUEST')
        if not all(isinstance(data[k],str) and 0<len(data[k].strip())<=200 for k in ('name','code','physical_location')):
            raise DomainError('INVALID_REQUEST')
        data = {**data, 'code': data['code'].strip().casefold(), 'name': data['name'].strip(), 'physical_location': data['physical_location'].strip()}
        command = dict(action='CONFIGURE_INITIAL_FLOAT', drawer=drawer, data=data, revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor,_ = self._admin(conn,bearer,tenant)
            replay = self._receipt(conn,tenant,key,actor,command)
            if replay is not None: return replay
            self._book(conn,tenant)
            target = drawer or secrets.token_hex(16)
            if drawer is None:
                if revision: raise DomainError('REVISION_CONFLICT')
                conn.execute('INSERT INTO prsystem.cash_drawer VALUES (%s,%s,%s,0,0)', (tenant,target,'unopened:'+target))
            self._unused(conn,tenant,target)
            old=conn.execute('SELECT revision FROM prsystem.cash_location_config WHERE tenant_id=%s AND drawer_id=%s FOR UPDATE',(tenant,target)).fetchone()
            if revision != (old[0] if old else 0): raise DomainError('REVISION_CONFLICT')
            if conn.execute('SELECT 1 FROM prsystem.cash_location_config WHERE tenant_id=%s AND code=%s AND drawer_id<>%s',(tenant,data['code'],target)).fetchone(): raise DomainError('LOCATION_CODE_EXISTS')
            conn.execute('''INSERT INTO prsystem.cash_location_config VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (tenant_id,drawer_id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,
                physical_location=EXCLUDED.physical_location,expected_float=EXCLUDED.expected_float,
                status=EXCLUDED.status,revision=EXCLUDED.revision,configured_by=EXCLUDED.configured_by''',
                (tenant,target,data['code'],data['name'],data['physical_location'],data['expected_float'],data['status'],revision+1,actor))
            result=dict(drawer_id=target,revision=revision+1,**data)
            self.event(conn,tenant,actor,'INITIAL_FLOAT_CONFIGURED',target,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def open(self,bearer,tenant,drawer,actual,key):
        money(actual)
        command=dict(action='INITIAL_SHIFT_OPEN',drawer=drawer,actual=actual)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant)
            principal,_=self.auth._authenticate(conn,bearer,tenant);actor=principal['account_id']
            self._reception(conn,tenant,actor)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            revision=self._book(conn,tenant);self._unused(conn,tenant,drawer)
            config=conn.execute('SELECT expected_float,status,revision FROM prsystem.cash_location_config WHERE tenant_id=%s AND drawer_id=%s FOR SHARE',(tenant,drawer)).fetchone()
            if not config or config[1]!='ACTIVE':raise DomainError('DRAWER_NOT_CONFIGURED')
            if conn.execute("SELECT 1 FROM prsystem.reception_shift WHERE tenant_id=%s AND owner_id=%s AND state IN ('OPEN','SUBMITTED')",(tenant,actor)).fetchone():raise DomainError('REPLACEMENT_HAS_OPEN_SHIFT')
            shift=secrets.token_hex(16)
            conn.execute('UPDATE prsystem.cash_drawer SET shift_id=%s,posted=%s WHERE tenant_id=%s AND id=%s',(shift,actual,tenant,drawer))
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if actual:
                conn.execute("INSERT INTO prsystem.cash_event VALUES (%s,%s,0,'INITIAL_FLOAT',%s,%s,%s,%s,0,%s,%s)",(tenant,revision+1,'initial:'+drawer,drawer,shift,actual,actor,now))
            # The location funding is posted before adopting the opening snapshot.
            self.register_shift(conn,tenant,actor,drawer)
            variance=actual-config[0];review='ADMIN_REQUIRED' if variance else 'NOT_REQUIRED'
            conn.execute('''INSERT INTO prsystem.cash_initial_opening
                (tenant_id,drawer_id,shift_id,actor_id,config_revision,expected,actual,variance,review_state)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,drawer,shift,actor,config[2],config[0],actual,variance,review))
            result=dict(drawer_id=drawer,shift_id=shift,opening_actual=actual,expected_float=config[0],variance=variance,review_state=review)
            conn.execute('UPDATE prsystem.cash_book SET revision=revision+1 WHERE tenant_id=%s',(tenant,))
            conn.execute("INSERT INTO prsystem.cash_outbox VALUES (%s,%s,'cash.changed',%s,%s)",(tenant,revision+1,Jsonb(dict(kind='INITIAL_SHIFT_OPENED',**result)),now))
            self.event(conn,tenant,actor,'INITIAL_SHIFT_OPENED',shift,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def review_opening(self,bearer,tenant,drawer,decision,key,reason):
        if decision not in {'APPROVE','DISPUTE'} or not isinstance(reason,str) or not reason.strip() or len(reason)>1000:raise DomainError('INVALID_REQUEST')
        command=dict(action='REVIEW_INITIAL_FLOAT',drawer=drawer,decision=decision,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor,_=self._admin(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._book(conn,tenant)
            row=conn.execute('SELECT actor_id,review_state FROM prsystem.cash_initial_opening WHERE tenant_id=%s AND drawer_id=%s FOR UPDATE',(tenant,drawer)).fetchone()
            if not row or row[1] not in {'ADMIN_REQUIRED','DISPUTED'}:raise DomainError('WORK_NOT_OPEN')
            result=dict(drawer_id=drawer,review_state='APPROVED' if decision=='APPROVE' else 'DISPUTED',self_reviewed=actor==row[0])
            conn.execute('UPDATE prsystem.cash_initial_opening SET review_state=%s WHERE tenant_id=%s AND drawer_id=%s',(result['review_state'],tenant,drawer))
            self.event(conn,tenant,actor,'INITIAL_FLOAT_REVIEWED',drawer,dict(result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result);return result
