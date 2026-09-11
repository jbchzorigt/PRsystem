"""Reception contracts for stage-five services, with explicitly isolated durable mocks."""
import secrets
from psycopg.types.json import Jsonb
from prsystem.common import DomainError,money
from prsystem.guest_finance import GuestFinance
from prsystem.shifts import ShiftService
from prsystem.stays import StayService
from prsystem.subscription import Action
from prsystem.postgres.connection import transaction
from prsystem.mock_providers import require_development_database


class ReceptionDependencies(GuestFinance):
    def __init__(self,auth,vault=None,runtime_mode='production'):
        super().__init__(auth,vault,runtime_mode);self.runtime_mode=runtime_mode

    def mock(self):
        if self.runtime_mode=='production':raise DomainError('GUEST_PROVIDER_UNAVAILABLE')
        require_development_database(self.auth.dsn,self.runtime_mode)

    def configure(self,bearer,tenant,room,items,revision,key):
        self.mock()
        if len(items)>50 or len({x['product_id'] for x in items})!=len(items):raise DomainError('INVALID_REQUEST')
        for item in items:
            self._text(item['product_id'],100);self._text(item['name'],200);money(item['unit_price'],positive=True);money(item['opening_quantity'],positive=True)
        command=dict(action='MOCK_MINIBAR_CONFIGURATION',room=room,items=items,revision=revision)
        with transaction(self.auth.dsn) as conn:
            actor=self._queue_actor(conn,bearer,tenant)
            if conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]<25000:raise DomainError('FORBIDDEN')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            row=conn.execute('SELECT revision,status FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,room)).fetchone()
            if not row or row[0]!=revision:raise DomainError('REVISION_CONFLICT')
            from prsystem.minibar_configuration import MinibarConfiguration
            if MinibarConfiguration.pending(conn,tenant,room):raise DomainError('CONFIGURATION_PENDING')
            if row[1]!='ACTIVE' and items:raise DomainError('ROOM_NOT_READY')
            if conn.execute("SELECT 1 FROM prsystem.stay WHERE tenant_id=%s AND room_id=%s AND state='ACTIVE'",(tenant,room)).fetchone() or conn.execute("SELECT 1 FROM prsystem.room_cleaning_request WHERE tenant_id=%s AND room_id=%s AND state='OPEN'",(tenant,room)).fetchone():raise DomainError('LIFECYCLE_BLOCKED')
            conn.execute('INSERT INTO prsystem.mock_minibar_configuration(tenant_id,room_id,revision,items) VALUES(%s,%s,%s,%s)',(tenant,room,revision+1,Jsonb(items)))
            conn.execute('UPDATE prsystem.room SET minibar_mode=%s,revision=revision+1 WHERE tenant_id=%s AND id=%s',('MOCK_ON' if items else 'OFF',tenant,room))
            conn.execute("INSERT INTO prsystem.reception_dependency_blocker VALUES(%s,%s,'MOCK_MINIBAR',%s,%s) ON CONFLICT(tenant_id,source_kind,source_id) DO UPDATE SET state=EXCLUDED.state",(tenant,room,room,'OPEN' if items else 'DONE'))
            for item in items:
                product='mock:'+room+':'+item['product_id']
                for location,quantity in [('room:'+room,item['opening_quantity']),('warehouse',item['opening_quantity']*10)]:
                    conn.execute('INSERT INTO prsystem.cleaning_stock VALUES(%s,%s,%s,%s) ON CONFLICT(tenant_id,product_id,location_id) DO UPDATE SET quantity=EXCLUDED.quantity',(tenant,product,location,quantity))
            if not items:
                stocks=conn.execute('SELECT product_id,quantity FROM prsystem.cleaning_stock WHERE tenant_id=%s AND location_id=%s AND product_id LIKE %s FOR UPDATE',(tenant,'room:'+room,'mock:'+room+':%')).fetchall()
                for product,quantity in stocks:
                    conn.execute("UPDATE prsystem.cleaning_stock SET quantity=quantity+%s WHERE tenant_id=%s AND product_id=%s AND location_id='warehouse'",(quantity,tenant,product))
                    conn.execute('UPDATE prsystem.cleaning_stock SET quantity=0 WHERE tenant_id=%s AND product_id=%s AND location_id=%s',(tenant,product,'room:'+room))
                from prsystem.room_lifecycle import RoomLifecycle
                RoomLifecycle.sweep(conn,tenant)
            result=dict(room_id=room,revision=revision+1,minibar_mode='MOCK_ON' if items else 'OFF',mode='MOCK_ONLY')
            self.event(conn,tenant,actor,'MOCK_MINIBAR_CONFIGURATION',room,dict(result,items=items))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    @staticmethod
    def opening(conn,tenant,room,mode,actual,runtime_mode,recorded=None):
        if mode=='OFF':return None
        if mode=='ON':
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            book=conn.execute('SELECT prsystem.minibar_guest_opening(%s,%s,%s)',(tenant,room,recorded or actual)).fetchone()[0]
            if not book:raise DomainError('ROOM_NOT_READY')
            return book
        if mode!='MOCK_ON' or runtime_mode=='production':raise DomainError('ROOM_NOT_READY')
        row=conn.execute('SELECT revision,items,recorded_at FROM prsystem.mock_minibar_configuration WHERE tenant_id=%s AND room_id=%s ORDER BY revision DESC LIMIT 1',(tenant,room)).fetchone()
        if not row or not row[1] or row[2]>actual:raise DomainError('HISTORICAL_READINESS_REQUIRED')
        for item in row[1]:
            stock=conn.execute('SELECT quantity FROM prsystem.cleaning_stock WHERE tenant_id=%s AND product_id=%s AND location_id=%s',(tenant,'mock:'+room+':'+item['product_id'],'room:'+room)).fetchone()
            if not stock or stock[0]!=item['opening_quantity']:raise DomainError('ROOM_NOT_READY')
        if conn.execute("SELECT 1 FROM prsystem.reception_dependency_blocker WHERE tenant_id=%s AND room_id=%s AND state='OPEN' AND source_kind<>'MOCK_MINIBAR'",(tenant,room)).fetchone():raise DomainError('ROOM_NOT_READY')
        return dict(mode='MOCK_ONLY',configuration_revision=row[0],items=row[1])

    def begin(self,bearer,tenant,stay,key):
        command=dict(action='INITIATE_CHECKOUT',stay=stay)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,action=Action.CHECKOUT)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
            ShiftService._book(conn,tenant);self._catalog_lock(conn,tenant)
            conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=(SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s) FOR UPDATE',(tenant,tenant,stay)).fetchone()
            self.lock(conn,tenant,stay,active=True);StayService._shift(conn,tenant,actor)
            if conn.execute("""SELECT 1 FROM prsystem.minibar_refill_request q WHERE q.tenant_id=%s AND q.stay_id=%s
                AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_refill_result x WHERE(x.tenant_id,x.request_id)=(q.tenant_id,q.id))""",(tenant,stay)).fetchone():raise DomainError('MINIBAR_REFILL_PENDING')
            if conn.execute("SELECT 1 FROM prsystem.stay_time_amendment WHERE tenant_id=%s AND stay_id=%s AND state='PENDING'",(tenant,stay)).fetchone():raise DomainError('AMENDMENT_PENDING')
            snapshot=conn.execute('SELECT snapshot FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()[0]
            conn.execute('INSERT INTO prsystem.reception_checkout_intent(tenant_id,stay_id,actor_id) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING',(tenant,stay,actor))
            if snapshot['minibar_mode']!='OFF':
                if snapshot['minibar_mode']=='MOCK_ON':self.mock()
                conn.execute('INSERT INTO prsystem.reception_minibar_inspection(tenant_id,stay_id) VALUES(%s,%s) ON CONFLICT DO NOTHING',(tenant,stay))
                if snapshot['minibar_mode']=='ON':
                    from prsystem.minibar_guest import MinibarGuest
                    conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
                    inspection=conn.execute('SELECT state,revision FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone()
                    if inspection[0]=='REQUESTED':MinibarGuest.ensure_source(conn,tenant,stay,inspection[1])
            result=dict(stay_id=stay,minibar_report_required=snapshot['minibar_mode']!='OFF')
            self.event(conn,tenant,actor,'CHECKOUT_INITIATED',stay,result)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    @staticmethod
    def report_unpaid(conn,tenant,stay):
        if conn.execute("SELECT 1 FROM prsystem.guest_charge c WHERE c.tenant_id=%s AND c.stay_id=%s AND c.kind='MINIBAR' AND (c.paid_mnt>0 OR EXISTS(SELECT 1 FROM prsystem.guest_payment_intent p WHERE p.tenant_id=c.tenant_id AND p.charge_id=c.id AND p.state='PENDING'))",(tenant,stay)).fetchone():raise DomainError('MINIBAR_REPORT_LOCKED')

    @staticmethod
    def credit_previous(conn,tenant,stay,actor,reason):
        conn.execute('''INSERT INTO prsystem.guest_charge_adjustment(tenant_id,charge_id,id,amount_mnt,reason,actor_id)
            SELECT tenant_id,id,%s||id,-amount_mnt,%s,%s FROM prsystem.guest_charge c WHERE tenant_id=%s AND stay_id=%s AND kind='MINIBAR'
            AND NOT EXISTS(SELECT 1 FROM prsystem.guest_charge_adjustment a WHERE (a.tenant_id,a.charge_id)=(c.tenant_id,c.id))''',(secrets.token_hex(16),reason,actor,tenant,stay))

    def report(self,bearer,tenant,stay,used,no_consumption,revision,key,exception_reason=None):
        self.mock()
        if exception_reason:self._text(exception_reason,1000)
        command=dict(action='MOCK_MINIBAR_REPORT',stay=stay,used=used,no_consumption=no_consumption,revision=revision,exception_reason=exception_reason)
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);principal,_=self.auth._authenticate(conn,bearer,tenant);actor=principal['account_id']
            if exception_reason:self.actor(conn,bearer,tenant,stay,manager=True,action=Action.CHECKOUT_REPORT)
            else:self._cleaner(conn,tenant,actor,action=Action.CHECKOUT_REPORT,obligation=self.root(conn,tenant,stay))
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);before=self.lock(conn,tenant,stay,active=True)
            inspection=conn.execute('SELECT state,revision FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s FOR UPDATE',(tenant,stay)).fetchone()
            if not inspection or inspection[0]!='REQUESTED':raise DomainError('WORK_NOT_OPEN')
            if inspection[1]!=revision:raise DomainError('REVISION_CONFLICT')
            self.report_unpaid(conn,tenant,stay)
            snapshot=conn.execute('SELECT snapshot FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()[0]['minibar_snapshot']
            if snapshot.get('mode')!='MOCK_ONLY':raise DomainError('CANONICAL_TASK_REQUIRED')
            room=conn.execute('SELECT room_id FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()[0]
            items={item['product_id']:item for item in snapshot['items']}
            if set(used)-set(items) or (not any(used.values()) and not no_consumption) or (any(used.values()) and no_consumption):raise DomainError('INVALID_REQUEST')
            total=0;lines=[]
            for product,item in items.items():
                quantity=used.get(product,0)
                if type(quantity) is not int or not 0<=quantity<=item['opening_quantity']:raise DomainError('INVALID_REQUEST')
                total+=quantity*item['unit_price'];money(total)
                lines.append(dict(item,used_quantity=quantity,line_amount=quantity*item['unit_price']))
                conn.execute('UPDATE prsystem.cleaning_stock SET quantity=%s WHERE tenant_id=%s AND product_id=%s AND location_id=%s',(item['opening_quantity']-quantity,tenant,'mock:'+room+':'+product,'room:'+room))
            self.credit_previous(conn,tenant,stay,actor,'Corrected mock minibar report')
            charge=secrets.token_hex(16) if total else None;now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            if charge:conn.execute("INSERT INTO prsystem.guest_charge(tenant_id,stay_id,id,kind,source_id,amount_mnt,recorded_at) VALUES(%s,%s,%s,'MINIBAR',%s,%s,%s)",(tenant,stay,charge,stay+':'+str(revision+1),total,now))
            conn.execute('INSERT INTO prsystem.reception_minibar_report(tenant_id,stay_id,revision,actor_id,items,amount_mnt,charge_id,reason) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(tenant,stay,revision+1,actor,Jsonb(lines),total,charge,exception_reason))
            conn.execute("UPDATE prsystem.reception_minibar_inspection SET state='REPORTED',revision=revision+1 WHERE tenant_id=%s AND stay_id=%s",(tenant,stay))
            balance=self.save(conn,tenant,stay,before,before,actor,'MOCK_MINIBAR_REPORTED',stay,dict(report_revision=revision+1,amount_mnt=total,charge_id=charge,exception=bool(exception_reason)),now)
            result=dict(stay_id=stay,report_revision=revision+1,charge_id=charge,amount_mnt=total,balance=balance,mode='MOCK_ONLY')
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def review(self,bearer,tenant,stay,action,reason,key):
        reason=self._text(reason,1000)
        command=dict(action='MINIBAR_REVIEW',stay=stay,decision=action,reason=reason)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=action in {'UPHOLD','WAIVE'},action=Action.CHECKOUT_REPORT)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            ShiftService._book(conn,tenant);before=self.lock(conn,tenant,stay,active=True)
            row=conn.execute('SELECT state FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s FOR UPDATE',(tenant,stay)).fetchone()
            if not row or (row[0]!='REPORTED' if action in {'RETURN','DISPUTE'} else row[0]!='DISPUTED'):raise DomainError('WORK_NOT_OPEN')
            self.report_unpaid(conn,tenant,stay)
            state={'RETURN':'REQUESTED','DISPUTE':'DISPUTED','UPHOLD':'REPORTED','WAIVE':'REPORTED'}[action]
            if action=='WAIVE':self.credit_previous(conn,tenant,stay,actor,reason)
            conn.execute('UPDATE prsystem.reception_minibar_inspection SET state=%s WHERE tenant_id=%s AND stay_id=%s',(state,tenant,stay))
            if action=='RETURN' and conn.execute("SELECT 1 FROM prsystem.stay WHERE tenant_id=%s AND id=%s AND snapshot->>'minibar_mode'='ON'",(tenant,stay)).fetchone():
                from prsystem.minibar_guest import MinibarGuest
                conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
                revision=conn.execute('SELECT revision FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone()[0]
                MinibarGuest.ensure_source(conn,tenant,stay,revision)
            now=conn.execute('SELECT clock_timestamp()').fetchone()[0]
            balance=self.save(conn,tenant,stay,before,before,actor,'MINIBAR_'+action,stay,dict(reason=reason),now)
            result=dict(stay_id=stay,state=state,balance=balance)
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    @staticmethod
    def payment_guard(conn,tenant,stay,charge):
        row=conn.execute("SELECT kind FROM prsystem.guest_charge WHERE tenant_id=%s AND id=%s",(tenant,charge)).fetchone()
        if row and row[0]=='MINIBAR' and not conn.execute("SELECT 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s AND state='REPORTED'",(tenant,stay)).fetchone():raise DomainError('MINIBAR_REPORT_REQUIRED')

    @staticmethod
    def final(conn,tenant,stay,actor,choices,guest_informed,runtime_mode):
        snapshot=conn.execute('SELECT snapshot FROM prsystem.stay WHERE tenant_id=%s AND id=%s',(tenant,stay)).fetchone()[0]
        if snapshot['minibar_mode']!='OFF':
            if (runtime_mode=='production' and snapshot['minibar_mode']!='ON') or not conn.execute("SELECT 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s AND state='REPORTED'",(tenant,stay)).fetchone():raise DomainError('MINIBAR_REPORT_REQUIRED')
            if snapshot['minibar_mode']=='ON':
                conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
                if not conn.execute('''SELECT 1 FROM prsystem.minibar_guest_report r JOIN prsystem.reception_minibar_inspection i
                    ON(i.tenant_id,i.stay_id,i.revision)=(r.tenant_id,r.stay_id,r.revision) WHERE r.tenant_id=%s AND r.stay_id=%s''',(tenant,stay)).fetchone():raise DomainError('MINIBAR_REPORT_REQUIRED')
        # Both order insertion and final checkout hold the same stay lock.
        # No extra UPDATE privilege on read-only service projections is needed.
        orders=conn.execute("SELECT id FROM prsystem.reception_restaurant_order WHERE tenant_id=%s AND stay_id=%s AND state NOT IN ('DONE','REFUNDED')",(tenant,stay)).fetchall()
        if len(choices)!=len({x['order_id'] for x in choices}) or {x['order_id'] for x in choices}!={r[0] for r in orders} or (orders and not guest_informed):raise DomainError('RESTAURANT_ACK_REQUIRED')
        for choice in choices:conn.execute('INSERT INTO prsystem.restaurant_checkout_outbox(tenant_id,order_id,stay_id,choice,actor_id,guest_informed) VALUES(%s,%s,%s,%s,%s,true)',(tenant,choice['order_id'],stay,choice['choice'],actor))

    def order(self,bearer,tenant,stay,name,phone,state,key):
        self.mock();name=self._text(name,200);phone=self._text(phone,30)
        command=dict(action='MOCK_RESTAURANT_ORDER',stay=stay,name=name,phone=phone,state=state)
        with transaction(self.auth.dsn) as conn:
            actor=self.actor(conn,bearer,tenant,stay,manager=True)
            if conn.execute('SELECT package_mnt FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()[0]!=30000:raise DomainError('FORBIDDEN')
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            if not conn.execute("SELECT id FROM prsystem.stay WHERE tenant_id=%s AND id=%s AND state='ACTIVE' FOR UPDATE",(tenant,stay)).fetchone():raise DomainError('WORK_NOT_OPEN')
            identity=secrets.token_hex(16)
            conn.execute("INSERT INTO prsystem.reception_restaurant_order(tenant_id,stay_id,id,restaurant_name,contact_phone,state,mode) VALUES(%s,%s,%s,%s,%s,%s,'MOCK_ONLY')",(tenant,stay,identity,name,phone,state))
            result=dict(order_id=identity,mode='MOCK_ONLY')
            self.event(conn,tenant,actor,'MOCK_RESTAURANT_ORDER',stay,result);self._save_receipt(conn,tenant,key,actor,command,result);return result

    def preview(self,bearer,tenant,stay):
        with transaction(self.auth.dsn) as conn:
            self.read_actor(conn,bearer,tenant,stay)
            inspection=conn.execute('SELECT state,revision FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone()
            reports=conn.execute('SELECT revision,items,amount_mnt,reason FROM prsystem.reception_minibar_report WHERE tenant_id=%s AND stay_id=%s ORDER BY revision DESC LIMIT 1',(tenant,stay)).fetchone()
            book=conn.execute("SELECT snapshot->'minibar_snapshot' FROM prsystem.stay WHERE tenant_id=%s AND id=%s",(tenant,stay)).fetchone()[0]
            orders=conn.execute("SELECT id,restaurant_name,contact_phone,state FROM prsystem.reception_restaurant_order WHERE tenant_id=%s AND stay_id=%s AND state NOT IN ('DONE','REFUNDED') ORDER BY id LIMIT 100",(tenant,stay)).fetchall()
            availability=None
            if book and book.get('mode')=='CANONICAL':
                conn.execute("SELECT set_config('prsystem.tenant_id',%s,true)",(tenant,))
                availability={i['product_id']:conn.execute('SELECT prsystem.minibar_stay_availability(%s,%s,%s)',(tenant,stay,i['product_id'])).fetchone()[0] for i in book['items']}
            return dict(availability=availability,price_book=book if book and book.get('mode')=='CANONICAL' else None,inspection=dict(state=inspection[0],revision=inspection[1]) if inspection else None,report=dict(revision=reports[0],items=reports[1],amount_mnt=reports[2],exception_reason=reports[3]) if reports else None,restaurant_orders=[dict(zip(('order_id','restaurant_name','contact_phone','state'),r)) for r in orders])
