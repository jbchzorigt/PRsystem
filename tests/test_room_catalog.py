import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
from postgres_support import ADMIN_DSN
from reception_support import ReceptionCase
if ADMIN_DSN:
    import psycopg


@unittest.skipUnless(ADMIN_DSN,'PRSYSTEM_TEST_ADMIN_DSN is not set')
class RoomCatalogTests(ReceptionCase):
    def category(self,token=None,**extra):
        data=dict(name='Standard',description='Стандарт',hourly_price=None,nightly_price=90000,deposit=10000,cleaning_buffer_minutes=30,status='ACTIVE',idempotency_key='category')
        data.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/room-categories',headers=self.headers(token or self.manager_token),json=data)

    def room(self,category,token=None,**extra):
        data=dict(number='101',floor='1',category_id=category,hourly_price=12000,nightly_price=None,status='ACTIVE',idempotency_key='room')
        data.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/rooms',headers=self.headers(token or self.manager_token),json=data)

    def settings(self,token=None,**extra):
        data=dict(hourly_price=10000,nightly_price=80000,checkout_time='12:00',expected_revision=0,idempotency_key='settings')
        data.update(extra)
        return self.client.put(f'/hotels/{self.tenant}/rooms/settings',headers=self.headers(token or self.manager_token),json=data)

    def listing(self,token=None,tenant=None,**params):
        return self.client.get(f'/hotels/{tenant or self.tenant}/rooms',headers=self.headers(token or self.worker_token),params=params)

    def test_manager_sets_up_catalog_and_reception_sees_versioned_tariff_sources(self):
        self.assertEqual(self.settings().status_code,200)
        category=self.category();self.assertEqual(category.status_code,201,category.text)
        room=self.room(category.json()['category_id']);self.assertEqual(room.status_code,201,room.text)
        rows=self.listing();self.assertEqual(rows.status_code,200,rows.text)
        item=rows.json()[0]
        self.assertEqual(item['tariffs']['hourly']['source'],'ROOM')
        self.assertEqual(item['tariffs']['hourly']['unit_price'],12000)
        self.assertEqual(item['tariffs']['nightly']['source'],'CATEGORY')
        self.assertEqual(item['tariffs']['nightly']['unit_price'],90000)
        self.assertEqual((item['cleaning_state'],item['minibar_mode']),('DIRTY','OFF'))
        self.assertNotIn('available',item)

    def test_optional_overrides_unset_to_hotel_with_cas_and_history(self):
        self.settings();category=self.category(nightly_price=None).json()['category_id']
        room=self.room(category).json()['room_id']
        body=dict(hourly_price=None,nightly_price=None,expected_revision=1,idempotency_key='unset')
        path=f'/hotels/{self.tenant}/rooms/{room}/tariffs'
        updated=self.client.put(path,headers=self.headers(self.manager_token),json=body)
        self.assertEqual(updated.status_code,200,updated.text)
        self.assertEqual(self.listing().json()[0]['tariffs']['hourly']['source'],'HOTEL')
        self.assertEqual(self.client.put(path,headers=self.headers(self.manager_token),json=dict(body,idempotency_key='stale')).json()['code'],'REVISION_CONFLICT')
        with psycopg.connect(self.owner_dsn) as conn:
            event=conn.execute("SELECT details FROM prsystem.operational_event WHERE tenant_id=%s AND kind='STAY_TARIFF_CHANGED'",(self.tenant,)).fetchone()[0]
            self.assertEqual(event['before']['hourly_price'],12000);self.assertIsNone(event['after']['hourly_price'])

    def test_reception_and_admin_do_not_inherit_manager_configuration(self):
        for token in (self.worker_token,self.admin):
            self.assertEqual(self.category(token).status_code,403)
            self.assertEqual(self.settings(token).status_code,403)
        self.assertEqual(self.category().status_code,201)

    def test_manager_plus_entitlement_and_expiry_security_gates(self):
        _,plus=self.add_staff(['MANAGER_PLUS'])
        self.assertEqual(self.category(token=plus).status_code,201)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET package_mnt=25000 WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.category(token=plus).status_code,403)
        with psycopg.connect(self.owner_dsn) as conn:conn.execute("UPDATE prsystem.hotel_access SET expires_at=now()-interval '3 days' WHERE tenant_id=%s",(self.tenant,))
        self.assertEqual(self.listing().json()['code'],'SUBSCRIPTION_EXPIRED')
        with psycopg.connect(self.owner_dsn) as conn:conn.execute('UPDATE prsystem.hotel_access SET security_suspended=true WHERE tenant_id=%s',(self.tenant,))
        self.assertEqual(self.listing().json()['code'],'SECURITY_SUSPENDED')

    def test_same_tenant_active_category_required(self):
        inactive=self.category(status='INACTIVE').json()['category_id']
        self.assertEqual(self.room(inactive).json()['code'],'CATEGORY_NOT_ACTIVE')
        self.assertEqual(self.room(uuid4().hex).json()['code'],'CATEGORY_NOT_ACTIVE')
        active=self.category(name='Active',idempotency_key='active').json()['category_id']
        with psycopg.connect(self.owner_dsn) as conn:
            with self.assertRaises(psycopg.errors.ForeignKeyViolation):
                conn.execute("INSERT INTO prsystem.room(tenant_id,id,number,floor,category_id,status) VALUES (%s,'foreign','1','1',%s,'ACTIVE')",(self.other,active))
        self.assertEqual(self.listing(tenant=self.other).status_code,403)

    def test_duplicate_names_numbers_and_idempotency_do_not_duplicate_entities(self):
        category=self.category();self.assertEqual(self.category().json(),category.json())
        self.assertEqual(self.category(name='STANDARD',idempotency_key='duplicate').json()['code'],'CATEGORY_NAME_EXISTS')
        original=self.room(category.json()['category_id'],number='101A')
        self.assertEqual(self.room(category.json()['category_id'],number='101A').json(),original.json())
        self.assertEqual(self.room(category.json()['category_id'],number='101a',idempotency_key='duplicate-room').json()['code'],'ROOM_NUMBER_EXISTS')
        self.assertEqual(len(self.listing().json()),1)

    def test_concurrent_room_number_creation_is_unique(self):
        category=self.category().json()['category_id'];barrier=Barrier(2)
        _,second=self.add_staff(['MANAGER'])
        def go(token):barrier.wait();return self.room(category,token=token,idempotency_key=uuid4().hex).status_code
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(go,[self.manager_token,second]))
        self.assertEqual(sorted(results),[201,409]);self.assertEqual(len(self.listing().json()),1)

    def test_missing_tariff_is_not_fabricated_and_pagination_is_bounded(self):
        category=self.category(nightly_price=None).json()['category_id']
        self.room(category,hourly_price=None)
        item=self.listing(limit=1).json()[0];self.assertIsNone(item['tariffs']['hourly']);self.assertIsNone(item['tariffs']['nightly'])
        self.assertEqual(self.listing(after=item['room_id']).json(),[])
        self.assertEqual(self.listing(limit=101).status_code,422)

    def test_readiness_price_and_lifecycle_facts_cannot_be_forged(self):
        category=self.category().json()['category_id']
        for extra in [dict(status='RETIRING'),dict(cleaning_state='CLEAN'),dict(minibar_mode='ON'),dict(hourly_price=True),dict(hourly_price=0)]:
            self.assertEqual(self.room(category,**extra).status_code,422)
        self.assertEqual(self.settings(checkout_time='25:00').status_code,422)
        self.assertEqual(self.category(cleaning_buffer_minutes=-1).status_code,422)
