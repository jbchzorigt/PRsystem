"""Reception's confirmed-booking adapter; isolated mock replaces the stage-four service."""
import secrets
from datetime import datetime
from psycopg.types.json import Jsonb
from prsystem.common import DomainError,timestamp
from prsystem.stays import StayService
from prsystem.stay_policy import stay_terms
from prsystem.postgres.connection import transaction
from prsystem.mock_providers import require_development_database


class ReceptionBooking(StayService):
    def mock_booking(self,bearer,tenant,room,kind,units,arrival,key):
        if self.runtime_mode=='production':raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
        require_development_database(self.auth.dsn,self.runtime_mode)
        try:arrival=datetime.fromisoformat(arrival);timestamp(arrival)
        except (ValueError,TypeError) as exc:raise DomainError('INVALID_REQUEST') from exc
        command=dict(action='MOCK_CONFIRMED_BOOKING',room=room,kind=kind,units=units,arrival=arrival.isoformat())
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            row=conn.execute('''SELECT r.category_id,r.status,c.status,r.hourly_price,r.nightly_price,c.hourly_price,c.nightly_price,
                h.hourly_price,h.nightly_price,h.checkout_time,c.cleaning_buffer_minutes,r.revision,c.revision,h.revision
                FROM prsystem.room r JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id)
                JOIN prsystem.room_hotel_settings h ON h.tenant_id=r.tenant_id WHERE r.tenant_id=%s AND r.id=%s FOR UPDATE OF r''',(tenant,room)).fetchone()
            if not row or row[1:3]!=('ACTIVE','ACTIVE'):raise DomainError('ROOM_NOT_READY')
            offset=3 if kind=='HOURLY' else 4
            price=next((row[n] for n in (offset+2,offset+4) if row[n] is not None),None)
            if price is None:raise DomainError('STAY_SETTINGS_REQUIRED')
            end,amount=stay_terms(kind,units,arrival,arrival,price,row[9])
            self._available(conn,tenant,room,arrival,end,row[10])
            identity=secrets.token_hex(16)
            snapshot=dict(category_id=row[0],room_revision=row[11],category_revision=row[12],hotel_settings_revision=row[13],unit_price=price,cleaning_buffer_minutes=row[10],planned_checkin_at=arrival.isoformat())
            conn.execute("INSERT INTO prsystem.room_reservation VALUES(%s,%s,%s,%s,%s,%s,%s,'CONFIRMED')",(tenant,identity,room,arrival,end,row[10],'mock-booking:'+identity))
            conn.execute('''INSERT INTO prsystem.reception_booking(tenant_id,id,room_id,kind,duration_units,planned_checkin_at,planned_checkout_at,amount_mnt,snapshot,mode,payment_reference)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'MOCK_ONLY',%s)''',(tenant,identity,room,kind,units,arrival,end,amount,Jsonb(snapshot),'mock-booking-payment:'+identity))
            result=dict(booking_id=identity,room_id=room,planned_checkin_at=arrival.isoformat(),planned_checkout_at=end.isoformat(),amount_mnt=amount,mode='MOCK_ONLY',state='CONFIRMED')
            self.event(conn,tenant,actor,'MOCK_BOOKING_CONFIRMED',identity,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def check_in_booking(self,bearer,tenant,booking,data,key):
        if self.runtime_mode=='production':raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
        require_development_database(self.auth.dsn,self.runtime_mode)
        with transaction(self.auth.dsn) as conn:
            self._actor(conn,bearer,tenant)
            row=conn.execute('SELECT room_id,kind,duration_units FROM prsystem.reception_booking WHERE tenant_id=%s AND id=%s',(tenant,booking)).fetchone()
            if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        return self.check_in(bearer,tenant,dict(data,room_id=row[0],kind=row[1],duration_units=row[2],booking_id=booking),key)

    def bookings(self,bearer,tenant,limit=100,after=''):
        with transaction(self.auth.dsn) as conn:
            self._reader(conn,bearer,tenant)
            rows=conn.execute('''SELECT b.id,b.room_id,b.kind,b.planned_checkin_at,b.planned_checkout_at,b.amount_mnt,r.state,b.mode
                FROM prsystem.reception_booking b JOIN prsystem.room_reservation r ON(r.tenant_id,r.id)=(b.tenant_id,b.id)
                WHERE b.tenant_id=%s AND b.id>%s ORDER BY b.id LIMIT %s''',(tenant,after,limit)).fetchall()
            return [dict(zip(('booking_id','room_id','kind','planned_checkin_at','planned_checkout_at','amount_mnt','state','mode'),r)) for r in rows]
