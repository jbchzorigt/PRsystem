"""Staff-authorized terminal outcomes and explicit category upgrades."""
import secrets
from prsystem.booking_refunds import BookingRefunds
from prsystem.booking_inventory import scope
from prsystem.postgres.connection import transaction
from prsystem.common import DomainError
from prsystem.stays import StayService


class BookingLifecycle(BookingRefunds):
    def staff_hold(self,conn,token,tenant,hold,manager=False):
        self.mock()
        principal,_=self.auth._authenticate(conn,token,tenant)
        hotel=conn.execute('SELECT package_mnt,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        allowed=self._manager(principal['roles'],hotel[0]) or (not manager and 'RECEPTION' in principal['roles'])
        if not allowed or hotel[1]:raise DomainError('FORBIDDEN')
        scope(conn,tenant)
        envelope=conn.execute('SELECT token_envelope FROM prsystem.booking_hold WHERE tenant_id=%s AND id=%s',(tenant,hold)).fetchone()
        if not envelope:raise DomainError('WORK_SOURCE_NOT_FOUND')
        row=self.guest(conn,tenant,hold,self.vault.open(envelope[0],tenant,hold,'mock-booker'))
        return principal['account_id'],row

    def candidates(self,conn,tenant,hold,row,*,higher=False):
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        actual=max(now,row[6])
        if actual>=row[7]:return []
        rooms=conn.execute('''SELECT r.id,r.category_id,s.rank,t.rank FROM prsystem.room r
            JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id)
            LEFT JOIN prsystem.booking_category_rank s ON s.tenant_id=r.tenant_id AND s.category_id=%s
            LEFT JOIN prsystem.booking_category_rank t ON(t.tenant_id,t.category_id)=(r.tenant_id,r.category_id)
            WHERE r.tenant_id=%s AND r.status='ACTIVE' AND c.status='ACTIVE' AND r.cleaning_state='CLEAN' AND r.minibar_mode='OFF'
            AND NOT EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker b WHERE b.tenant_id=r.tenant_id AND b.room_id=r.id AND b.state='OPEN')
            ORDER BY r.id''',(row[0],tenant)).fetchall()
        result=[]
        for room,category,source_rank,target_rank in rooms:
            if (higher and (source_rank is None or target_rank is None or target_rank<=source_rank)) or (not higher and category!=row[0]):continue
            try:
                StayService._readiness(conn,tenant,room,category,actual,now)
                StayService._available(conn,tenant,room,actual,row[7],row[8],excluding_hold=hold)
            except DomainError as exc:
                if str(exc) not in {'ROOM_NOT_READY','ROOM_OCCUPIED','HISTORICAL_READINESS_REQUIRED','RESERVATION_CONFLICT','BOOKING_CAPACITY_UNAVAILABLE'}:raise
                continue
            result.append(dict(room_id=room,category_id=category,source_rank=source_rank,target_rank=target_rank))
        return result

    def terminal(self,token,tenant,hold,outcome,reason,key):
        if outcome not in {'NO_SHOW','CANCELLED_HOTEL'}:raise DomainError('INVALID_REQUEST')
        reason=self._text(reason,1000)
        with transaction(self.auth.dsn) as conn:
            actor,row=self.staff_hold(conn,token,tenant,hold,manager=outcome=='CANCELLED_HOTEL')
            command=dict(action=outcome,hold=hold,reason=reason)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            if outcome=='CANCELLED_HOTEL':
                if conn.execute('SELECT clock_timestamp()').fetchone()[0]<row[6]:raise DomainError('ACTUAL_TIME_OUT_OF_RANGE')
                if self.candidates(conn,tenant,hold,row) or self.candidates(conn,tenant,hold,row,higher=True):raise DomainError('BOOKING_ROOM_AVAILABLE')
            result=self.cancel_in_transaction(conn,tenant,hold,row,outcome)
            self.event(conn,tenant,actor,'BOOKING_'+outcome,hold,dict(result,reason=reason))
            self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def ranks(self,token,tenant,category,rank,revision,key):
        self.mock()
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,token,tenant);scope(conn,tenant)
            command=dict(action='BOOKING_CATEGORY_RANK',category=category,rank=rank,revision=revision)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            old=conn.execute('SELECT revision FROM prsystem.booking_category_rank WHERE tenant_id=%s AND category_id=%s',(tenant,category)).fetchone()
            if (old[0] if old else 0)!=revision:raise DomainError('REVISION_CONFLICT')
            conn.execute('''INSERT INTO prsystem.booking_category_rank VALUES(%s,%s,%s,%s)
                ON CONFLICT(tenant_id,category_id) DO UPDATE SET rank=EXCLUDED.rank,revision=EXCLUDED.revision''',(tenant,category,rank,revision+1))
            result=dict(category_id=category,rank=rank,revision=revision+1)
            self.event(conn,tenant,actor,'BOOKING_CATEGORY_RANK',category,result);self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def upgrade(self,token,tenant,hold,room,reason,key):
        reason=self._text(reason,1000)
        with transaction(self.auth.dsn) as conn:
            actor,row=self.staff_hold(conn,token,tenant,hold,manager=True)
            command=dict(action='BOOKING_UPGRADE',hold=hold,room=room,reason=reason)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            if row[3]!='CONFIRMED' or self.statement(conn,tenant,hold)['cancellation'] or self.statement(conn,tenant,hold)['stay_id']:raise DomainError('BOOKING_NOT_CONFIRMED')
            if self.candidates(conn,tenant,hold,row):raise DomainError('BOOKING_ROOM_AVAILABLE')
            target=next((r for r in self.candidates(conn,tenant,hold,row,higher=True) if r['room_id']==room),None)
            if not target:raise DomainError('ROOM_NOT_READY')
            identity=secrets.token_hex(16)
            conn.execute('INSERT INTO prsystem.booking_upgrade(tenant_id,hold_id,id,room_id,actor_id,source_rank,target_rank,reason) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,hold,identity,room,actor,target['source_rank'],target['target_rank'],reason))
            result=dict(upgrade_id=identity,booking_id=hold,room_id=room,extra_charge_mnt=0)
            self.event(conn,tenant,actor,'BOOKING_UPGRADE_APPROVED',hold,dict(result,reason=reason));self._save_receipt(conn,tenant,key,actor,command,result)
            return result

    def inbox(self,token,tenant,after='',limit=50):
        self.mock()
        with transaction(self.auth.dsn) as conn:
            principal,_=self.auth._authenticate(conn,token,tenant)
            hotel=conn.execute('SELECT package_mnt,security_suspended,expires_at FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
            if not hotel or hotel[1] or not (self._manager(principal['roles'],hotel[0]) or 'RECEPTION' in principal['roles']):raise DomainError('FORBIDDEN')
            scope(conn,tenant)
            ids=conn.execute("SELECT id FROM prsystem.booking_hold WHERE tenant_id=%s AND id>%s AND created_at<%s+interval '48 hours' ORDER BY id LIMIT %s",(tenant,after,hotel[2],limit)).fetchall()
            return [self.statement(conn,tenant,r[0]) for r in ids]
