"""Public mock listing projection and account-bound category reservations."""
import base64
import math
from psycopg.types.json import Jsonb
from prsystem.common import DomainError,identifier
from prsystem.postgres.connection import transaction
from prsystem.booking_inventory import scope,claims,room_intervals
from prsystem.booking_policy import InventoryInterval,unassigned_capacity,quote_nights
from prsystem.booking_holds import snapshot


class BookingPublic:
    def __init__(self,booking,bookers):self.booking,self.bookers,self.auth=booking,bookers,booking.auth
    @staticmethod
    def photos(values):
        if not isinstance(values,list) or not 1<=len(values)<=4:raise DomainError('INVALID_REQUEST')
        for value in values:
            if not isinstance(value,str) or len(value)>400000:raise DomainError('INVALID_REQUEST')
            try:
                header,encoded=value.split(',',1);data=base64.b64decode(encoded,validate=True)
                if not ((header=='data:image/png;base64' and data.startswith(b'\x89PNG\r\n\x1a\n')) or (header=='data:image/jpeg;base64' and data.startswith(b'\xff\xd8\xff'))):raise ValueError()
            except ValueError as exc:raise DomainError('INVALID_REQUEST') from exc
        return values
    def profile(self,token,tenant,data,key):
        self.booking.mock();data=dict(data);data['photos']=self.photos(data['photos'])
        with transaction(self.auth.dsn) as conn:
            actor=self.booking._queue_actor(conn,token,tenant);scope(conn,tenant)
            command=dict(action='BOOKING_PROFILE',data=data);replay=self.booking._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self.booking._catalog_lock(conn,tenant)
            version=conn.execute('SELECT revision FROM prsystem.booking_listing WHERE tenant_id=%s',(tenant,)).fetchone()
            if (version[0] if version else 0)!=data['expected_revision']:raise DomainError('REVISION_CONFLICT')
            conn.execute('''INSERT INTO prsystem.booking_listing VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(tenant_id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,phone=EXCLUDED.phone,description=EXCLUDED.description,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,photos=EXCLUDED.photos,published=EXCLUDED.published,accepting=EXCLUDED.accepting,revision=EXCLUDED.revision,actor_id=EXCLUDED.actor_id''',(tenant,data['name'],data['address'],self.bookers.phone_number(data['phone']),data['description'],data['latitude'],data['longitude'],Jsonb(data['photos']),data['published'],data['accepting'],data['expected_revision']+1,actor))
            result=dict(revision=data['expected_revision']+1);self.booking.event(conn,tenant,actor,'BOOKING_PROFILE',tenant,dict(revision=result['revision']));self.booking._save_receipt(conn,tenant,key,actor,command,result);return result
    def category(self,token,tenant,category,photos,published,revision,key):
        self.booking.mock();photos=self.photos(photos)
        with transaction(self.auth.dsn) as conn:
            actor=self.booking._queue_actor(conn,token,tenant);scope(conn,tenant)
            command=dict(action='BOOKING_CATEGORY_PUBLIC',category=category,photos=photos,published=published,revision=revision)
            replay=self.booking._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self.booking._catalog_lock(conn,tenant)
            old=conn.execute('SELECT revision FROM prsystem.booking_category_listing WHERE tenant_id=%s AND category_id=%s',(tenant,category)).fetchone()
            if (old[0] if old else 0)!=revision:raise DomainError('REVISION_CONFLICT')
            conn.execute('INSERT INTO prsystem.booking_category_listing VALUES(%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,category_id) DO UPDATE SET photos=EXCLUDED.photos,published=EXCLUDED.published,revision=EXCLUDED.revision',(tenant,category,Jsonb(photos),published,revision+1))
            result=dict(revision=revision+1);self.booking.event(conn,tenant,actor,'BOOKING_CATEGORY_PUBLIC',category,result);self.booking._save_receipt(conn,tenant,key,actor,command,result);return result
    def platform_contract(self,token,tenant,data,key):
        from prsystem.booking_policy import Contract
        self.booking.mock()
        if self.booking.platform is None:raise DomainError('PLATFORM_UNAVAILABLE')
        start,end=self.booking.instant(data['valid_from']),self.booking.instant(data['valid_until'])
        contract=Contract(tenant,data['contract_id'],data['expected_revision']+1,data['rate_bps'],start,end)
        with transaction(self.auth.dsn) as conn:
            actor,_=self.booking.platform.authenticate(conn,token,'BOOKING_FINANCE');scope(conn,tenant)
            command=dict(action='BOOKING_CONTRACT',tenant=tenant,data=snapshot(contract));replay=self.booking.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            self.booking._catalog_lock(conn,tenant)
            version=conn.execute('SELECT coalesce(max(version),0) FROM prsystem.booking_contract WHERE tenant_id=%s',(tenant,)).fetchone()[0]
            if version!=data['expected_revision']:raise DomainError('REVISION_CONFLICT')
            conn.execute("INSERT INTO prsystem.booking_contract(tenant_id,version,contract_id,rate_bps,valid_from,valid_until,platform_actor_id,mode) VALUES(%s,%s,%s,%s,%s,%s,%s,'MOCK_ONLY')",(tenant,contract.version,contract.contract_id,contract.rate_bps,start,end,actor))
            result=dict(version=contract.version,mode='MOCK_ONLY');self.booking.platform._event(conn,actor,'BOOKING_CONTRACT',tenant,command);self.booking.platform.save(conn,key,actor,command,result);return result

    def settings(self,token,tenant):
        self.booking.mock()
        with transaction(self.auth.dsn) as conn:
            self.booking._queue_actor(conn,token,tenant);scope(conn,tenant)
            row=conn.execute('SELECT name,address,phone,description,latitude,longitude,photos,published,accepting,revision FROM prsystem.booking_listing WHERE tenant_id=%s',(tenant,)).fetchone()
            categories=conn.execute('SELECT c.id,r.rank,r.revision,l.published,l.revision FROM prsystem.room_category c LEFT JOIN prsystem.booking_category_rank r ON(r.tenant_id,r.category_id)=(c.tenant_id,c.id) LEFT JOIN prsystem.booking_category_listing l ON(l.tenant_id,l.category_id)=(c.tenant_id,c.id) WHERE c.tenant_id=%s ORDER BY c.id LIMIT 100',(tenant,)).fetchall()
            return dict(profile=dict(zip(('name','address','phone','description','latitude','longitude','photos','published','accepting','revision'),row)) if row else None,categories=[dict(category_id=r[0],rank=r[1],rank_revision=r[2] or 0,published=r[3],publication_revision=r[4] or 0) for r in categories])

    def publication(self,token,tenant,allowed,revision,key):
        self.booking.mock()
        if self.booking.platform is None:raise DomainError('PLATFORM_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            actor,_=self.booking.platform.authenticate(conn,token,'BOOKING_PUBLISH');scope(conn,tenant)
            command=dict(action='BOOKING_PUBLICATION',tenant=tenant,allowed=allowed,revision=revision);replay=self.booking.platform.receipt(conn,key,actor,command)
            if replay is not None:return replay
            self.booking._catalog_lock(conn,tenant)
            old=conn.execute('SELECT revision FROM prsystem.booking_publication WHERE tenant_id=%s',(tenant,)).fetchone()
            if (old[0] if old else 0)!=revision:raise DomainError('REVISION_CONFLICT')
            conn.execute('INSERT INTO prsystem.booking_publication VALUES(%s,%s,%s,%s) ON CONFLICT(tenant_id) DO UPDATE SET allowed=EXCLUDED.allowed,revision=EXCLUDED.revision,actor_id=EXCLUDED.actor_id',(tenant,allowed,revision+1,actor))
            result=dict(allowed=allowed,revision=revision+1);self.booking.platform._event(conn,actor,'BOOKING_PUBLICATION',tenant,result);self.booking.platform.save(conn,key,actor,command,result);return result
    def listing(self,conn,tenant):
        scope(conn,tenant)
        row=conn.execute('''SELECT l.name,l.address,l.phone,l.description,l.latitude,l.longitude,l.photos,l.accepting FROM prsystem.booking_listing l
            JOIN prsystem.booking_publication p ON p.tenant_id=l.tenant_id JOIN prsystem.hotel_access h ON h.tenant_id=l.tenant_id
            WHERE l.tenant_id=%s AND l.published AND p.allowed AND NOT h.security_suspended AND h.expires_at>clock_timestamp() FOR SHARE OF l,p,h''',(tenant,)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        return dict(tenant_id=tenant,**dict(zip(('name','address','phone','description','latitude','longitude','photos','accepting'),row)),rating=None,review_count=0,mode='MOCK_ONLY')
    def detail(self,conn,tenant,arrival,nights):
        scope(conn,tenant);self.booking._catalog_lock(conn,tenant);hotel=self.listing(conn,tenant)
        now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
        try:contract=self.booking.current_contract(conn,tenant,now)
        except DomainError as exc:
            if str(exc) not in {'BOOKING_CONTRACT_REQUIRED','CONTRACT_NOT_CURRENT'}:raise
            hotel['accepting']=False;hotel['categories']=[];return hotel
        rows=conn.execute('''SELECT c.id,c.name,c.nightly_price,c.revision,h.nightly_price,h.revision,h.checkout_time,c.cleaning_buffer_minutes,l.photos
            FROM prsystem.room_category c JOIN prsystem.room_hotel_settings h ON h.tenant_id=c.tenant_id JOIN prsystem.booking_category_listing l ON(l.tenant_id,l.category_id)=(c.tenant_id,c.id)
            WHERE c.tenant_id=%s AND c.status='ACTIVE' AND l.published ORDER BY c.id LIMIT 100''',(tenant,)).fetchall()
        result=[]
        for cat,name,price,rev,default,hrev,checkout,buffer,photos in rows:
            quote=quote_nights(tenant_id=tenant,category_id=cat,now=now,arrival=arrival,nights=nights,category_price=price,category_version=rev,hotel_price=default,hotel_version=hrev,checkout_time=checkout,cleaning_buffer_minutes=buffer,contract=contract)
            capacity=unassigned_capacity(InventoryInterval(arrival,quote.planned_checkout_at,buffer),eligible_room_intervals=room_intervals(conn,tenant,cat),category_reservations=[InventoryInterval(*r[1:]) for r in claims(conn,tenant,cat)])
            result.append(dict(category_id=cat,name=name,photos=photos,quote=snapshot(quote),available=capacity if hotel['accepting'] else 0))
        return dict(hotel,categories=result)
    def search(self,arrival,nights,query,after,limit,latitude=None,longitude=None):
        self.booking.mock();arrival=self.booking.instant(arrival)
        with transaction(self.auth.dsn) as conn:
            ids=conn.execute('''SELECT l.tenant_id FROM prsystem.booking_listing l JOIN prsystem.booking_publication p ON p.tenant_id=l.tenant_id JOIN prsystem.hotel_access h ON h.tenant_id=l.tenant_id WHERE l.published AND p.allowed AND NOT h.security_suspended AND h.expires_at>clock_timestamp() AND l.tenant_id>%s AND (strpos(lower(l.name||' '||l.address),lower(%s))>0) ORDER BY l.tenant_id LIMIT %s''',(after,query,limit)).fetchall()
            result=[]
            for (tenant,) in ids:
                try:hotel=self.detail(conn,tenant,arrival,nights)
                except DomainError as exc:
                    if str(exc)=='WORK_SOURCE_NOT_FOUND':continue
                    raise
                if latitude is not None and longitude is not None:
                    a,b=map(math.radians,(latitude,hotel['latitude']));delta=math.radians(longitude-hotel['longitude']);v=math.sin((b-a)/2)**2+math.cos(a)*math.cos(b)*math.sin(delta/2)**2;hotel['distance_km']=round(6371*2*math.asin(min(1,math.sqrt(v))),1)
                result.append(hotel)
            return dict(items=result,next_after=ids[-1][0] if len(ids)==limit else None)
    def create(self,token,tenant,category,arrival,nights,provider,key):
        self.booking.mock();arrival=self.booking.instant(arrival);identifier(key)
        with transaction(self.auth.dsn) as conn:
            actor=self.bookers.authenticate(conn,token);scope(conn,tenant)
            command=dict(tenant=tenant,category=category,arrival=arrival.isoformat(),nights=nights,provider=provider)
            replay=conn.execute('SELECT command,hold_id FROM prsystem.booker_receipt WHERE account_id=%s AND key=%s',(actor,key)).fetchone()
            if replay:
                if replay[0]!=command:raise DomainError('IDEMPOTENCY_CONFLICT')
                return self.owned(conn,actor,tenant,replay[1])
            scope(conn,tenant);self.booking._catalog_lock(conn,tenant);hotel=self.listing(conn,tenant)
            if not hotel['accepting']:raise DomainError('BOOKING_CAPACITY_UNAVAILABLE')
            if not conn.execute('SELECT 1 FROM prsystem.booking_category_listing WHERE tenant_id=%s AND category_id=%s AND published',(tenant,category)).fetchone():raise DomainError('BOOKING_CAPACITY_UNAVAILABLE')
            result=self.booking.create_locked(conn,tenant,category,arrival,nights,provider,booker=actor)
            conn.execute('INSERT INTO prsystem.booker_receipt VALUES(%s,%s,%s,%s,%s)',(actor,key,tenant,Jsonb(command),result['booking_id']));return result
    def owned(self,conn,actor,tenant,hold):
        scope(conn,tenant)
        row=conn.execute('SELECT token_envelope FROM prsystem.booking_hold WHERE tenant_id=%s AND id=%s AND booker_id=%s',(tenant,hold,actor)).fetchone()
        if not row:raise DomainError('WORK_SOURCE_NOT_FOUND')
        secret=self.booking.vault.open(row[0],tenant,hold,'mock-booker');self.booking.guest(conn,tenant,hold,secret)
        return dict(self.booking.statement(conn,tenant,hold),tenant_id=tenant,access_token=secret)
    def mine(self,token,after='',limit=25):
        with transaction(self.auth.dsn) as conn:
            actor=self.bookers.authenticate(conn,token)
            rows=conn.execute('SELECT tenant_id,hold_id FROM prsystem.booker_receipt WHERE account_id=%s AND hold_id>%s ORDER BY hold_id LIMIT %s',(actor,after,limit)).fetchall()
            result=[]
            for tenant,hold in rows:
                try:result.append(self.owned(conn,actor,tenant,hold))
                except DomainError as exc:
                    if str(exc) not in {'FORBIDDEN','SUBSCRIPTION_EXPIRED'}:raise
                    result.append(dict(tenant_id=tenant,booking_id=hold,unavailable=True))
            return result
