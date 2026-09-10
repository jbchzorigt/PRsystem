"""Reasoned inventory changes; physical stock is separate from guest billing."""
import secrets
from fractions import Fraction
from psycopg.types.json import Jsonb
from prsystem.common import DomainError, money
from prsystem.minibar import MinibarWarehouse
from prsystem.postgres.connection import transaction


class MinibarAdjustments(MinibarWarehouse):
    def context(self, conn, tenant, product, room=None):
        if not conn.execute('SELECT id FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,product)).fetchone():
            raise DomainError('WORK_SOURCE_NOT_FOUND')
        stay=None
        if room:
            if not conn.execute('SELECT id FROM prsystem.room WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,room)).fetchone():
                raise DomainError('WORK_SOURCE_NOT_FOUND')
            st=conn.execute("SELECT id FROM prsystem.stay WHERE tenant_id=%s AND room_id=%s AND state='ACTIVE' FOR UPDATE",(tenant,room)).fetchone()
            stay=st[0] if st else None
        revision,total,value=self.stock(conn,tenant,product)
        all_rooms=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s)',(tenant,product)).fetchone()[0]
        physical=conn.execute('SELECT prsystem.minibar_room_quantity(%s,%s,%s)',(tenant,product,room)).fetchone()[0] if room else total-all_rooms
        locked=bool(stay and conn.execute('SELECT 1 FROM prsystem.reception_minibar_report WHERE tenant_id=%s AND stay_id=%s',(tenant,stay)).fetchone())
        room_number=conn.execute('SELECT number FROM prsystem.room WHERE tenant_id=%s AND id=%s',(tenant,room)).fetchone()[0] if room else None
        return dict(product_id=product,room_id=room,room_number=room_number,stay_id=stay,stock_revision=revision,physical_quantity=physical,
                    report_locked=locked,**{k:v for k,v in self.balance(revision,total,value,all_rooms).items() if k!='stock_revision'})

    def preview(self,bearer,tenant,product,room=None):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant);self._catalog_lock(conn,tenant)
            return self.context(conn,tenant,product,room)

    def change(self,bearer,tenant,product,data,key):
        data=dict(data,reason=self._text(data['reason'],1000))
        command=dict(action='MINIBAR_ADJUSTMENT',product_id=product,data=data)
        with transaction(self.auth.dsn) as conn:
            actor,roles,package=self.actor(conn,bearer,tenant)
            replay=self._receipt(conn,tenant,key,actor,command)
            if replay is not None:return replay
            self._catalog_lock(conn,tenant)
            before=self.context(conn,tenant,product,data.get('room_id'))
            if before['stock_revision']!=data['expected_revision'] or before['stay_id']!=data.get('expected_stay_id'):
                raise DomainError('REVISION_CONFLICT')
            if before['report_locked']:raise DomainError('STOCK_ADJUSTMENT_LOCKED')
            original=None;kind=data['kind'];quantity=data['quantity'];room=before['room_id'];stay=before['stay_id']
            if kind=='REVERSAL':
                original=conn.execute('''SELECT a.id,a.kind,a.quantity,a.hotel_delta,a.room_delta,a.billable_delta,r.cost_numerator,r.cost_denominator
                    FROM prsystem.minibar_adjustment a JOIN prsystem.minibar_receipt r ON(r.tenant_id,r.id)=(a.tenant_id,a.receipt_id)
                    WHERE a.tenant_id=%s AND a.id=%s AND a.product_id=%s AND a.room_id IS NOT DISTINCT FROM %s AND a.stay_id IS NOT DISTINCT FROM %s''',
                    (tenant,data.get('original_id'),product,room,stay)).fetchone()
                if not original:raise DomainError('WORK_SOURCE_NOT_FOUND')
                if original[1]=='REVERSAL' or conn.execute('SELECT 1 FROM prsystem.minibar_adjustment WHERE tenant_id=%s AND original_id=%s',(tenant,original[0])).fetchone():
                    raise DomainError('WORK_NOT_OPEN')
                if quantity!=original[2]:raise DomainError('INVALID_REQUEST')
                hotel_delta,room_delta,billable_delta=(-original[3],-original[4],-original[5])
            else:
                if data.get('original_id') is not None:raise DomainError('INVALID_REQUEST')
                if kind=='RETURN' and room is None:raise DomainError('INVALID_REQUEST')
                sign=1 if kind=='COUNT_PLUS' else -1
                hotel_delta=0 if kind=='RETURN' else sign*quantity
                room_delta=sign*quantity if room else 0
                billable_delta=-quantity if stay and kind!='COUNT_PLUS' else 0
            revision,total,value=self.stock(conn,tenant,product)
            cost=Fraction(int(original[6]),int(original[7])) if original else (value/total if total else None)
            supplied=data.get('unit_cost_mnt')
            if cost is None:
                if kind!='COUNT_PLUS' or supplied is None:raise DomainError('INVALID_REQUEST')
                cost=Fraction(supplied)
            elif supplied is not None:raise DomainError('INVALID_REQUEST')
            new_total=total+hotel_delta;new_value=value+hotel_delta*cost
            new_rooms=before['room_quantity']+room_delta
            if new_total<0 or new_value<0 or new_total-new_rooms<0 or (room and not 0<=before['physical_quantity']+room_delta<=1000000):
                raise DomainError('INSUFFICIENT_STOCK')
            if new_total==0 and new_value!=0:raise DomainError('ADJUSTMENT_COST_CONFLICT')
            money(new_total)
            identity=secrets.token_hex(16);receipt=secrets.token_hex(16)
            conn.execute('''INSERT INTO prsystem.minibar_adjustment(tenant_id,id,product_id,room_id,stay_id,kind,quantity,hotel_delta,room_delta,billable_delta,
                original_id,receipt_id,actor_id,actor_roles,package_mnt,reason) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,identity,product,room,stay,kind,quantity,hotel_delta,room_delta,billable_delta,original[0] if original else None,receipt,actor,roles,package,data['reason']))
            snapshot=conn.execute("SELECT jsonb_build_object('name',name,'category',category,'unit',unit,'selling_price_mnt',selling_price_mnt,'revision',revision) FROM prsystem.minibar_product WHERE tenant_id=%s AND id=%s",(tenant,product)).fetchone()[0]
            label=conn.execute("SELECT coalesce(nullif(display_name,''),email) FROM prsystem.staff_account WHERE id=%s",(actor,)).fetchone()[0]
            conn.execute('''INSERT INTO prsystem.minibar_receipt(tenant_id,id,product_id,stock_revision,kind,quantity,unit_cost_mnt,warehouse_after,
                inventory_value_after,inventory_value_denominator,cost_numerator,cost_denominator,room_id,adjustment_id,
                actor_id,actor_label,actor_roles,package_mnt,product_snapshot,reference)
                VALUES(%s,%s,%s,%s,'ADJUSTMENT',%s,0,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (tenant,receipt,product,revision+1,hotel_delta,new_total-new_rooms,new_value.numerator,new_value.denominator,
                 cost.numerator,cost.denominator,room,identity,actor,label,roles,package,Jsonb(snapshot),kind))
            result=dict(adjustment_id=identity,receipt_id=receipt,kind=kind,quantity=quantity,room_id=room,stay_id=stay,
                        **self.balance(revision+1,new_total,new_value,new_rooms))
            self.event(conn,tenant,actor,'MINIBAR_ADJUSTMENT',product,dict(result,before=before,reason=data['reason'],actor_roles=roles,package_mnt=package,original_id=data.get('original_id')))
            self._save_receipt(conn,tenant,key,actor,command,result);return result

    def history(self,bearer,tenant,product,after='',limit=50):
        with transaction(self.auth.dsn) as conn:
            self.actor(conn,bearer,tenant)
            rows=conn.execute('''SELECT a.id,a.kind,a.quantity,a.room_id,a.stay_id,a.original_id,a.reason,a.actor_id,a.recorded_at,
                r.cost_numerator,r.cost_denominator,EXISTS(SELECT 1 FROM prsystem.minibar_adjustment x WHERE x.tenant_id=a.tenant_id AND x.original_id=a.id),(SELECT number FROM prsystem.room WHERE tenant_id=a.tenant_id AND id=a.room_id),r.actor_label
                FROM prsystem.minibar_adjustment a JOIN prsystem.minibar_receipt r ON(r.tenant_id,r.id)=(a.tenant_id,a.receipt_id)
                WHERE a.tenant_id=%s AND a.product_id=%s AND a.id>%s ORDER BY a.id LIMIT %s''',(tenant,product,after,limit+1)).fetchall()
            items=[dict(adjustment_id=r[0],kind=r[1],quantity=r[2],room_id=r[3],stay_id=r[4],original_id=r[5],reason=r[6],actor_id=r[7],recorded_at=r[8],cost=dict(numerator=str(r[9]),denominator=str(r[10])),reversed=r[11],room_number=r[12],actor_label=r[13]) for r in rows[:limit]]
            return dict(items=items,next_after=items[-1]['adjustment_id'] if len(rows)>limit else None)
