"""Strict Platform Operation routes. No cross-hotel guest search."""
import json
from typing import Annotated,Literal
from fastapi import Depends,Query
from pydantic import BaseModel,ConfigDict,Field
from prsystem.common import DomainError


class Command(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    idempotency_key:str=Field(min_length=1,max_length=128)


class Filters(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    package_mnt:Literal[20000,25000,30000]|None=None
    statuses:list[Literal['ACTIVE','EXPIRING','GRACE','EXPIRED','SUSPENDED']]=Field(default_factory=list,max_length=5)
    tenant_ids:list[str]|None=Field(default=None,max_length=500)
    expires_within_days:int|None=Field(default=None,ge=0,le=365)
    query:str=Field(default='',max_length=100)


class Preview(Command):
    filters:Filters
    message:str=Field(min_length=1,max_length=300)


class Confirm(Command):
    reviewed:Literal[True]


class DeliveryCommand(Command):
    expected_revision:int=Field(ge=0,le=2**63-1)


class BillingCommand(Command):
    source_kind:Literal['ONBOARDING','RENEWAL']
    source_id:str=Field(min_length=1,max_length=128)
    reason:str=Field(min_length=1,max_length=1000)


def install(app,service,token):
    @app.get('/platform/operation')
    def overview(secret:Annotated[str,Depends(token)],query:str=Query(default='',max_length=100),package_mnt:int|None=None,
                 status:Literal['ACTIVE','EXPIRING','GRACE','EXPIRED','SUSPENDED']|None=None,
                 expires_within_days:int|None=Query(default=None,ge=0,le=365),after:str=Query(default='',max_length=2000),limit:int=Query(default=25,ge=1,le=100)):
        cursor=None
        if after:
            try:
                cursor=json.loads(after)
                if not isinstance(cursor,list) or len(cursor)!=3 or any(not isinstance(i,str) or not i for i in cursor):raise ValueError()
                from datetime import datetime
                if datetime.fromisoformat(cursor[0]).tzinfo is None:raise ValueError()
            except (ValueError,TypeError):raise DomainError('INVALID_REQUEST') from None
        if package_mnt not in (None,20000,25000,30000):raise DomainError('INVALID_REQUEST')
        return service.overview(secret,dict(query=query,package_mnt=package_mnt,statuses=[status] if status else [],expires_within_days=expires_within_days),cursor,limit)

    @app.post('/platform/operation/sms/preview')
    def preview(body:Preview,secret:Annotated[str,Depends(token)]):
        return service.preview(secret,body.model_dump(exclude={'idempotency_key'}),body.idempotency_key)

    @app.post('/platform/operation/sms/{draft_id}/send',status_code=202)
    def send(draft_id:str,body:Confirm,secret:Annotated[str,Depends(token)]):
        return service.send(secret,draft_id,body.idempotency_key)

    @app.get('/platform/operation/sms')
    def history(secret:Annotated[str,Depends(token)],after:str=Query(default='',max_length=128),limit:int=Query(default=25,ge=1,le=100)):
        return service.sms_history(secret,after,limit)

    @app.post('/platform/operation/sms/recipients/{recipient_id}/{action}')
    def delivery(recipient_id:str,action:Literal['retry','cancel'],body:DeliveryCommand,secret:Annotated[str,Depends(token)]):
        return service.delivery_command(secret,recipient_id,action.upper(),body.expected_revision,body.idempotency_key)

    @app.post('/platform/operation/hotels/{tenant_id}/password-reset',status_code=202)
    def reset(tenant_id:str,body:Confirm,secret:Annotated[str,Depends(token)]):
        return service.reset(secret,tenant_id,body.idempotency_key)

    @app.get('/platform/operation/billing')
    def billing(secret:Annotated[str,Depends(token)],after:str=Query(default='',max_length=128),limit:int=Query(default=25,ge=1,le=100)):
        return service.billing_history(secret,after,limit)

    @app.post('/platform/operation/billing/{action}',status_code=202)
    def billing_command(action:Literal['reconcile','ebarimt'],body:BillingCommand,secret:Annotated[str,Depends(token)]):
        return service.billing_command(secret,action,body.model_dump(exclude={'idempotency_key'}),body.idempotency_key)
