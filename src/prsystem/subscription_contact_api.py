from typing import Annotated,Literal
from fastapi import Depends,Request
from pydantic import BaseModel,ConfigDict,Field,SecretStr
from prsystem.operation_api import Command,Confirm


class Start(Command):
    new_phone:str=Field(min_length=8,max_length=16)
    password:SecretStr=Field(min_length=1,max_length=128)


class Verify(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    code:SecretStr=Field(min_length=6,max_length=6)


class ExceptionCommand(Command):
    reason:str=Field(min_length=1,max_length=1000)
    reference:str=Field(min_length=1,max_length=200)


def install(app,service,token,peer):
    @app.get('/hotels/{tenant_id}/subscription/contact')
    def read(tenant_id:str,secret:Annotated[str,Depends(token)]):return service.read(secret,tenant_id)

    @app.post('/hotels/{tenant_id}/subscription/contact/changes',status_code=201)
    def start(tenant_id:str,body:Start,request:Request,secret:Annotated[str,Depends(token)]):
        return service.start(secret,tenant_id,body.new_phone,body.password.get_secret_value(),body.idempotency_key,peer(request))

    @app.post('/hotels/{tenant_id}/subscription/contact/changes/{request_id}/{side}/challenge',status_code=202)
    def challenge(tenant_id:str,request_id:str,side:Literal['OLD','NEW'],body:Command,request:Request,secret:Annotated[str,Depends(token)]):
        return service.challenge(secret,tenant_id,request_id,side,body.idempotency_key,peer(request))

    @app.post('/hotels/{tenant_id}/subscription/contact/changes/{request_id}/{side}/verify')
    def verify(tenant_id:str,request_id:str,side:Literal['OLD','NEW'],body:Verify,request:Request,secret:Annotated[str,Depends(token)]):
        return service.verify(secret,tenant_id,request_id,side,body.code.get_secret_value(),peer(request))

    @app.post('/hotels/{tenant_id}/subscription/contact/changes/{request_id}/complete')
    def complete(tenant_id:str,request_id:str,body:Confirm,secret:Annotated[str,Depends(token)]):
        return service.complete(secret,tenant_id,request_id,body.idempotency_key)

    @app.get('/platform/operation/hotels/{tenant_id}/contact-support')
    def support(tenant_id:str,secret:Annotated[str,Depends(token)]):return service.support(secret,tenant_id)

    @app.post('/platform/operation/hotels/{tenant_id}/contact-changes/{request_id}/exception')
    def exception(tenant_id:str,request_id:str,body:ExceptionCommand,secret:Annotated[str,Depends(token)]):
        return service.exception(secret,tenant_id,request_id,body.reason,body.reference,body.idempotency_key)
