"""Tenant-scoped Reception read models. Amounts never precede physical counting.

These projections do not authorize mutations. Commands recheck current roles,
versions, source locks and subscription completion roots themselves.
"""
from prsystem.common import DomainError
from prsystem.guest_finance import GuestFinance
from prsystem.shifts import ShiftService
from prsystem.subscription import Action,AccessFacts,subscription_gate,Obligation,RootKind
from prsystem.postgres.connection import transaction


def rows(conn,query,args,fields):
    return [dict(zip(fields.split(),r)) for r in conn.execute(query,args).fetchall()]


class Operations(GuestFinance):
    def reader(self,conn,bearer,tenant,obligation=None):
        self._actors(conn,bearer,tenant)
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        hotel=conn.execute('SELECT package_mnt,expires_at,security_suspended FROM prsystem.hotel_access WHERE tenant_id=%s FOR SHARE',(tenant,)).fetchone()
        roles=principal['roles'];manager=self._manager(roles,hotel[0]);admin='HOTEL_ADMIN' in roles
        allowed=manager or admin or 'RECEPTION' in roles or ('CLEANER' in roles and hotel[0]>=25000)
        gate=subscription_gate(Action.DETAIL,AccessFacts(tenant,True,True,True,allowed,True,True,True,hotel[2]),hotel[1],conn.execute('SELECT clock_timestamp()').fetchone()[0],obligation)
        if not gate.allowed:raise DomainError(gate.code)
        if not allowed:raise DomainError('FORBIDDEN')
        return principal,hotel,manager,admin

    def overview(self,bearer,tenant,after='',limit=50):
        with transaction(self.auth.dsn) as conn:
            try:principal,hotel,manager,admin=self.reader(conn,bearer,tenant)
            except DomainError as exc:
                if str(exc)!='SUBSCRIPTION_EXPIRED':raise
                return self.completion_overview(conn,bearer,tenant,after,limit)
            actor=principal['account_id'];reception='RECEPTION' in principal['roles']
            ShiftService._book(conn,tenant)
            result=dict(account_id=actor,roles=principal['roles'],package_mnt=hotel[0],expires_at=hotel[1],mode=self.mode,limit=limit)
            if manager or admin or reception:
                result['staff']=rows(conn,"""SELECT a.id,a.email,m.roles FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
                    WHERE m.tenant_id=%s AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL ORDER BY a.id LIMIT 100""",(tenant,), 'account_id email roles')
                result['drawers']=rows(conn,"""SELECT c.drawer_id,c.code,c.name,c.physical_location,c.revision,
                    NOT EXISTS(SELECT 1 FROM prsystem.reception_shift s WHERE s.tenant_id=c.tenant_id AND s.drawer_id=c.drawer_id) AS unused
                    FROM prsystem.cash_location_config c WHERE c.tenant_id=%s AND c.status='ACTIVE' ORDER BY c.drawer_id LIMIT 100""",(tenant,), 'drawer_id code name physical_location revision unused')
                result['shifts']=rows(conn,"""SELECT id,owner_id,drawer_id,state,opened_at,closed_at,review_state FROM prsystem.reception_shift
                    WHERE tenant_id=%s AND (owner_id=%s OR %s) AND id>%s ORDER BY id LIMIT %s""",(tenant,actor,manager or admin,after,limit),'shift_id owner_id drawer_id state opened_at closed_at review_state')
                result['custodies']=rows(conn,"SELECT id,drawer_id FROM prsystem.cash_custody WHERE tenant_id=%s AND owner_id=%s AND state='HELD' ORDER BY id LIMIT 100",(tenant,actor),'custody_id drawer_id')
                result['funding']=rows(conn,"""SELECT id,room_id,channel,amount_mnt,state,invoice_id FROM prsystem.checkin_funding
                    WHERE tenant_id=%s AND actor_id=%s AND state IN ('PENDING','CONFIRMED','REFUNDING') ORDER BY id LIMIT 100""",(tenant,actor),'funding_id room_id channel amount_mnt state invoice_id')
            if manager:
                result['qrs']=rows(conn,'SELECT room_id,revision FROM prsystem.room_guest_qr WHERE tenant_id=%s ORDER BY room_id LIMIT 100',(tenant,),'room_id revision')
                result['settings']=conn.execute('SELECT hourly_price,nightly_price,checkout_time,revision FROM prsystem.room_hotel_settings WHERE tenant_id=%s',(tenant,)).fetchone()
                result['deposit_settings']=conn.execute('SELECT amount_mnt,revision FROM prsystem.deposit_hotel_settings WHERE tenant_id=%s',(tenant,)).fetchone()
            if admin:
                result['opening_reviews']=rows(conn,"SELECT drawer_id,shift_id,expected,actual,variance,review_state FROM prsystem.cash_initial_opening WHERE tenant_id=%s AND review_state IN ('ADMIN_REQUIRED','DISPUTED') ORDER BY drawer_id LIMIT 100",(tenant,),'drawer_id shift_id expected actual variance review_state')
                result['shift_policy']=conn.execute('SELECT single_worker,revision FROM prsystem.shift_policy WHERE tenant_id=%s',(tenant,)).fetchone()
            if manager or 'CLEANER' in principal['roles']:
                result['inspections']=rows(conn,"""SELECT i.stay_id,s.snapshot->>'room_number',i.state,i.revision,s.snapshot->'minibar_snapshot'->'items'
                    FROM prsystem.reception_minibar_inspection i JOIN prsystem.stay s ON (s.tenant_id,s.id)=(i.tenant_id,i.stay_id)
                    JOIN prsystem.hotel_access h ON h.tenant_id=s.tenant_id
                    WHERE i.tenant_id=%s AND s.state='ACTIVE' AND s.check_in_recorded_at<h.expires_at+interval '48 hours'
                    AND i.stay_id>%s ORDER BY i.stay_id LIMIT %s""",(tenant,after,limit),'stay_id room_number state revision items')
                result['cleaning']=rows(conn,"""SELECT t.id,t.source_id,s.room_id,t.assignment_version,t.started_at,a.id,a.kind,a.product_id,a.quantity-a.completed
                    FROM prsystem.cleaning_task t JOIN prsystem.cleaning_source s ON (s.tenant_id,s.id)=(t.tenant_id,t.source_id)
                    JOIN prsystem.cleaning_action a ON (a.tenant_id,a.source_id)=(t.tenant_id,t.source_id)
                    WHERE t.tenant_id=%s AND t.assignee_id=%s AND t.state='OPEN' AND a.quantity>a.completed AND t.id>%s
                    ORDER BY t.id,a.id LIMIT %s""",(tenant,actor,after,limit),'task_id source_id room_id assignment_version started_at action_id kind product_id remaining')
            return result

    def completion_overview(self,conn,bearer,tenant,after,limit):
        # Called only after the ordinary reader denied subscription expiry.
        # Each resource is independently authorized with its persisted root.
        principal,_=self.auth._authenticate(conn,bearer,tenant)
        actor=principal['account_id'];hotel=conn.execute('SELECT package_mnt,expires_at FROM prsystem.hotel_access WHERE tenant_id=%s',(tenant,)).fetchone()
        manager=self._manager(principal['roles'],hotel[0]);admin='HOTEL_ADMIN' in principal['roles']
        ShiftService._book(conn,tenant)
        result=dict(account_id=actor,roles=principal['roles'],package_mnt=hotel[0],expires_at=hotel[1],mode=self.mode,limit=limit,completion_only=True,
                    staff=[],drawers=[],shifts=[],custodies=[],funding=[],stays=[],rooms=[],inspections=[],cleaning=[])
        sources=rows(conn,"""SELECT s.id,s.room_id,s.kind,coalesce((SELECT a.actual_checkin_at FROM prsystem.stay_time_amendment a WHERE a.tenant_id=s.tenant_id AND a.stay_id=s.id AND a.state='APPROVED' ORDER BY a.decided_at DESC,a.id DESC LIMIT 1),s.actual_checkin_at),s.planned_checkout_at,s.amount_mnt,s.check_in_recorded_at,s.snapshot->>'room_number',s.state
            FROM prsystem.stay s JOIN prsystem.hotel_access h ON h.tenant_id=s.tenant_id WHERE s.tenant_id=%s AND s.id>%s
            AND s.check_in_recorded_at<h.expires_at+interval '48 hours'
            AND (s.state='ACTIVE' OR EXISTS(SELECT 1 FROM prsystem.stay_checkout c JOIN prsystem.room_cleaning_request b ON(b.tenant_id,b.source_id)=(c.tenant_id,c.cleaning_source_id) WHERE c.tenant_id=s.tenant_id AND c.stay_id=s.id AND b.state='OPEN'))
            ORDER BY s.id LIMIT %s""",(tenant,after,limit),'stay_id room_id kind actual_checkin_at planned_checkout_at amount_mnt recorded_at room_number state')
        for item in sources:
            self.reader(conn,bearer,tenant,Obligation(tenant,item['stay_id'],RootKind.STAY,item['recorded_at'],True))
            if (manager or 'RECEPTION' in principal['roles']) and item['state']=='ACTIVE':
                result['stays'].append({k:v for k,v in item.items() if k not in {'recorded_at','room_number','state'}})
                result['rooms']+=rows(conn,'SELECT r.id,r.number,c.name,r.status,r.cleaning_state,r.minibar_mode,r.revision FROM prsystem.room r JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id) WHERE r.tenant_id=%s AND r.id=%s',(tenant,item['room_id']),'room_id number category_name status cleaning_state minibar_mode revision')
            if manager or 'CLEANER' in principal['roles']:
                if item['state']=='ACTIVE':result['inspections']+=rows(conn,"SELECT stay_id,%s,state,revision,(SELECT snapshot->'minibar_snapshot'->'items' FROM prsystem.stay WHERE tenant_id=%s AND id=%s) FROM prsystem.reception_minibar_inspection WHERE tenant_id=%s AND stay_id=%s",(item['room_number'],tenant,item['stay_id'],tenant,item['stay_id']),'stay_id room_number state revision items')
                result['cleaning']+=rows(conn,"""SELECT t.id,t.source_id,c.room_id,t.assignment_version,t.started_at,a.id,a.kind,a.product_id,a.quantity-a.completed
                    FROM prsystem.stay_checkout c JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(c.tenant_id,c.cleaning_source_id)
                    JOIN prsystem.cleaning_action a ON(a.tenant_id,a.source_id)=(t.tenant_id,t.source_id)
                    WHERE c.tenant_id=%s AND c.stay_id=%s AND t.assignee_id=%s AND t.state='OPEN' AND a.quantity>a.completed""",(tenant,item['stay_id'],actor),'task_id source_id room_id assignment_version started_at action_id kind product_id remaining')
        if manager or admin or 'RECEPTION' in principal['roles']:
            shifts=rows(conn,"""SELECT s.id,s.owner_id,s.drawer_id,s.state,s.opened_at,s.closed_at,s.review_state FROM prsystem.reception_shift s
                JOIN prsystem.hotel_access h ON h.tenant_id=s.tenant_id WHERE s.tenant_id=%s AND s.id>%s AND (s.owner_id=%s OR %s)
                AND s.opened_at<h.expires_at+interval '48 hours' AND (s.state IN ('OPEN','SUBMITTED') OR s.review_state IN ('MANAGER_REQUIRED','ADMIN_REQUIRED','DISPUTED')) ORDER BY s.id LIMIT %s""",(tenant,after,actor,manager or admin,limit),'shift_id owner_id drawer_id state opened_at closed_at review_state')
            for shift in shifts:
                self.reader(conn,bearer,tenant,Obligation(tenant,shift['shift_id'],RootKind.SHIFT,shift['opened_at'],True));result['shifts'].append(shift)
            if shifts:
                result['staff']=rows(conn,"SELECT a.id,a.email,m.roles FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id WHERE m.tenant_id=%s AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL ORDER BY a.id LIMIT 100",(tenant,),'account_id email roles')
        return result

    def stay_detail(self,bearer,tenant,stay):
        with transaction(self.auth.dsn) as conn:
            actor=self.read_actor(conn,bearer,tenant,stay)
            row=conn.execute("SELECT s.state,s.snapshot->>'room_number',i.envelope FROM prsystem.stay s JOIN prsystem.stay_guest_identity i ON (i.tenant_id,i.stay_id)=(s.tenant_id,s.id) WHERE s.tenant_id=%s AND s.id=%s",(tenant,stay)).fetchone()
            if not row or row[0]!='ACTIVE':raise DomainError('WORK_NOT_OPEN')
            if not self.vault:raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
            data=self.vault.open(row[2],tenant,stay)
            self.event(conn,tenant,actor,'RECEPTION_GUEST_DETAIL_READ',stay,{})
            return dict(stay_id=stay,room_number=row[1],guest={k:data[k] for k in ('family_name','given_name','identity_type')})

    def shift_report(self,bearer,tenant,shift):
        with transaction(self.auth.dsn) as conn:
            self._actors(conn,bearer,tenant);self.auth._authenticate(conn,bearer,tenant)
            ShiftService._book(conn,tenant)
            source=conn.execute('SELECT owner_id,drawer_id,state,opening_actual,opened_at,closed_at,review_state FROM prsystem.reception_shift WHERE tenant_id=%s AND id=%s',(tenant,shift)).fetchone()
            if not source:raise DomainError('WORK_SOURCE_NOT_FOUND')
            eligible=source[2] in {'OPEN','SUBMITTED'} or source[6] in {'MANAGER_REQUIRED','ADMIN_REQUIRED','DISPUTED'}
            principal,hotel,manager,admin=self.reader(conn,bearer,tenant,Obligation(tenant,shift,RootKind.SHIFT,source[4],eligible))
            if not (admin or manager or source[0]==principal['account_id']):raise DomainError('FORBIDDEN')
            # An intended handover receiver must submit their independent count
            # before any route reveals this shift's expected cash.
            pending=conn.execute("SELECT id FROM prsystem.shift_handover WHERE tenant_id=%s AND shift_id=%s AND receiver_id=%s AND state='SUBMITTED'",(tenant,shift,principal['account_id'])).fetchone()
            if pending and not conn.execute('SELECT 1 FROM prsystem.handover_count WHERE tenant_id=%s AND handover_id=%s AND actor_id=%s',(tenant,pending[0],principal['account_id'])).fetchone():raise DomainError('PHYSICAL_COUNT_REQUIRED')
            cash=rows(conn,'SELECT kind,sum(posted_delta),sum(reserved_delta) FROM prsystem.cash_event WHERE tenant_id=%s AND shift_id=%s GROUP BY kind ORDER BY kind',(tenant,shift),'kind posted_delta reserved_delta')
            receipts=rows(conn,'SELECT purpose,channel,sum(amount_mnt) FROM prsystem.guest_receipt WHERE tenant_id=%s AND shift_id=%s GROUP BY purpose,channel ORDER BY purpose,channel',(tenant,shift),'purpose channel amount_mnt')
            refunds=rows(conn,"SELECT channel,sum(amount_mnt) FROM prsystem.guest_refund WHERE tenant_id=%s AND shift_id=%s AND state='COMPLETED' GROUP BY channel ORDER BY channel",(tenant,shift),'channel amount_mnt')
            obligations=rows(conn,"SELECT id,state FROM prsystem.shift_obligation WHERE tenant_id=%s AND shift_id=%s AND state='PENDING' ORDER BY id LIMIT 100",(tenant,shift),'id state')
            self.event(conn,tenant,principal['account_id'],'SHIFT_REPORT_READ',shift,{})
            return dict(shift_id=shift,owner_id=source[0],drawer_id=source[1],state=source[2],opening_actual=source[3],opened_at=source[4],closed_at=source[5],review_state=source[6],cash_movements=cash,gross_receipts=receipts,completed_refunds=refunds,pending_obligations=obligations,
                        note='SOURCE_SHIFT_TOTALS_NOT_REVENUE',as_of=conn.execute('SELECT clock_timestamp()').fetchone()[0])
