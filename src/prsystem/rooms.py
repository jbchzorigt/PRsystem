"""Manager room catalog and versioned tariff sources; no invented availability."""

import re
import secrets

from prsystem.cleaning import CleaningService
from prsystem.common import DomainError, money
from prsystem.postgres.connection import transaction
from prsystem.subscription import AccessFacts, Action, subscription_gate


class RoomService(CleaningService):
    @staticmethod
    def _catalog_lock(conn,tenant):
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ('room-catalog:'+tenant,))

    @staticmethod
    def _prices(hourly,nightly,required=False):
        for value in (hourly,nightly):
            if value is not None or required:money(value,positive=True)

    @staticmethod
    def _text(value,limit=200):
        if not isinstance(value,str) or not 0<len(value.strip())<=limit or any(ord(c)<32 for c in value):raise DomainError('INVALID_REQUEST')
        return value.strip()

    def hotel_settings(self,bearer,tenant,hourly,nightly,checkout_time,revision,key):
        self._prices(hourly,nightly,True)
        if not isinstance(checkout_time,str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',checkout_time):raise DomainError('INVALID_REQUEST')
        if type(revision) is not int or revision<0:raise DomainError('INVALID_REQUEST')
        command=dict(action='HOTEL_STAY_SETTINGS',hourly_price=hourly,nightly_price=nightly,checkout_time=checkout_time,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            old=conn.execute('SELECT hourly_price,nightly_price,checkout_time,revision FROM prsystem.room_hotel_settings WHERE tenant_id=%s FOR UPDATE',(tenant,)).fetchone()
            if revision!=(old[3] if old else 0):raise DomainError('REVISION_CONFLICT')
            conn.execute('''INSERT INTO prsystem.room_hotel_settings VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (tenant_id) DO UPDATE SET hourly_price=EXCLUDED.hourly_price,nightly_price=EXCLUDED.nightly_price,
                checkout_time=EXCLUDED.checkout_time,revision=EXCLUDED.revision''',(tenant,hourly,nightly,checkout_time,revision+1))
            result=dict(hourly_price=hourly,nightly_price=nightly,checkout_time=checkout_time,revision=revision+1)
            self.event(conn,tenant,actor,'HOTEL_STAY_SETTINGS_CHANGED',tenant,dict(before=dict(hourly_price=old[0],nightly_price=old[1],checkout_time=str(old[2]),revision=old[3]) if old else None,after=result))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def create_category(self,bearer,tenant,data,key):
        data={**data,'name':self._text(data['name'])}
        self._prices(data['hourly_price'],data['nightly_price']);money(data['deposit'])
        if not isinstance(data['description'],str) or len(data['description'])>2000 or type(data['cleaning_buffer_minutes']) is not int or not 0<=data['cleaning_buffer_minutes']<=2147483647 or data['status'] not in {'ACTIVE','INACTIVE'}:raise DomainError('INVALID_REQUEST')
        command=dict(action='CREATE_ROOM_CATEGORY',data=data)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            if conn.execute('SELECT 1 FROM prsystem.room_category WHERE tenant_id=%s AND lower(name)=lower(%s)',(tenant,data['name'])).fetchone():raise DomainError('CATEGORY_NAME_EXISTS')
            category=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.room_category VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,1)',(tenant,category,data['name'],data['description'],data['hourly_price'],data['nightly_price'],data['deposit'],data['cleaning_buffer_minutes'],data['status']))
            result=dict(category_id=category,revision=1,**data)
            self.event(conn,tenant,actor,'ROOM_CATEGORY_CREATED',category,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def create_room(self,bearer,tenant,data,key):
        data={**data,'number':self._text(data['number'],50),'floor':self._text(data['floor'],50)}
        self._prices(data['hourly_price'],data['nightly_price'])
        if data['status'] not in {'ACTIVE','INACTIVE'}:raise DomainError('INVALID_REQUEST')
        command=dict(action='CREATE_ROOM',data=data)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            category=conn.execute('SELECT status FROM prsystem.room_category WHERE tenant_id=%s AND id=%s FOR SHARE',(tenant,data['category_id'])).fetchone()
            if not category or category[0]!='ACTIVE':raise DomainError('CATEGORY_NOT_ACTIVE')
            if conn.execute('SELECT 1 FROM prsystem.room WHERE tenant_id=%s AND lower(number)=lower(%s)',(tenant,data['number'])).fetchone():raise DomainError('ROOM_NUMBER_EXISTS')
            room=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.room (tenant_id,id,number,floor,category_id,hourly_price,nightly_price,status)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)''',(tenant,room,data['number'],data['floor'],data['category_id'],data['hourly_price'],data['nightly_price'],data['status']))
            result=dict(room_id=room,revision=1,cleaning_state='DIRTY',minibar_mode='OFF',**data)
            self.event(conn,tenant,actor,'ROOM_CREATED',room,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def tariffs(self,bearer,tenant,kind,entity,hourly,nightly,revision,key):
        if kind not in {'room','category'} or type(revision) is not int or revision<1:raise DomainError('INVALID_REQUEST')
        self._prices(hourly,nightly)
        command=dict(action='CHANGE_STAY_TARIFF',kind=kind,entity=entity,hourly=hourly,nightly=nightly,revision=revision)
        table='room' if kind=='room' else 'room_category'
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            row=conn.execute('SELECT hourly_price,nightly_price,revision FROM prsystem.'+table+' WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,entity)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
            if revision!=row[2]:raise DomainError('REVISION_CONFLICT')
            conn.execute('UPDATE prsystem.'+table+' SET hourly_price=%s,nightly_price=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',(hourly,nightly,tenant,entity))
            result=dict(entity_id=entity,kind=kind,hourly_price=hourly,nightly_price=nightly,revision=revision+1)
            self.event(conn,tenant,actor,'STAY_TARIFF_CHANGED',entity,dict(before=dict(hourly_price=row[0],nightly_price=row[1],revision=row[2]),after=result))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def _reader(self,conn,bearer,tenant):
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        hotel=conn.execute('SELECT package_mnt,expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        allowed='RECEPTION' in principal['roles'] or self._manager(principal['roles'],hotel[0])
        gate=subscription_gate(Action.CONFIGURE,AccessFacts(tenant,True,True,True,allowed,True,True,True,hotel[2]),hotel[1],conn.execute('SELECT clock_timestamp()').fetchone()[0])
        if not gate.allowed:raise DomainError(gate.code)

    @staticmethod
    def effective_prices(row):
        """Only current configuration. A future stay must persist its own snapshot."""
        result={}
        for name,offset in [('hourly',8),('nightly',9)]:
            choices=[('ROOM',row[0],row[offset],row[7]),('CATEGORY',row[3],row[offset+2],row[12]),('HOTEL',row[16],row[offset+5],row[15])]
            result[name]=next((dict(unit_price=value,source=source,source_id=identity,revision=revision) for source,identity,value,revision in choices if value is not None),None)
        return result

    def list_rooms(self,bearer,tenant,limit=100,after=''):
        with transaction(self.auth.dsn) as conn:
            self._reader(conn,bearer,tenant)
            rows=conn.execute('''SELECT r.id,r.number,r.floor,r.category_id,c.name,r.status,r.cleaning_state,r.revision,
                r.hourly_price,r.nightly_price,c.hourly_price,c.nightly_price,c.revision,
                h.hourly_price,h.nightly_price,h.revision,r.tenant_id,c.cleaning_buffer_minutes,c.status,r.minibar_mode
                FROM prsystem.room r JOIN prsystem.room_category c ON (c.tenant_id,c.id)=(r.tenant_id,r.category_id)
                LEFT JOIN prsystem.room_hotel_settings h ON h.tenant_id=r.tenant_id
                WHERE r.tenant_id=%s AND r.id>%s ORDER BY r.id LIMIT %s''',(tenant,after,limit)).fetchall()
            return [dict(room_id=r[0],number=r[1],floor=r[2],category_id=r[3],category_name=r[4],status=r[5],
                         cleaning_state=r[6],revision=r[7],minibar_mode=r[19],tariffs=self.effective_prices(r),
                         cleaning_buffer_minutes=r[17],category_status=r[18]) for r in rows]

    def list_categories(self,bearer,tenant,limit=100,after=''):
        with transaction(self.auth.dsn) as conn:
            self._reader(conn,bearer,tenant)
            rows=conn.execute('''SELECT id,name,description,hourly_price,nightly_price,deposit,cleaning_buffer_minutes,status,revision
                FROM prsystem.room_category WHERE tenant_id=%s AND id>%s ORDER BY id LIMIT %s''',(tenant,after,limit)).fetchall()
            fields=('category_id','name','description','hourly_price','nightly_price','deposit','cleaning_buffer_minutes','status','revision')
            return [dict(zip(fields,row)) for row in rows]
