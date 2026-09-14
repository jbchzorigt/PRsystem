"""Restaurant endpoints use realm authentication and strict request bodies."""
from typing import Annotated, Literal
from fastapi import Depends, Query
from pydantic import BaseModel, ConfigDict, Field


class Command(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    expected_revision: int = Field(ge=0, le=2**63-1)
    idempotency_key: str = Field(min_length=1, max_length=128)


class MenuItem(Command):
    category: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=2000)
    price_mnt: int = Field(ge=1, le=2**63-1)
    active: bool = True
    available: bool = True


class LinkState(Command):
    active: bool


class Cart(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    quantities: dict[str, Annotated[int, Field(ge=1, le=100)]] = Field(min_length=1, max_length=100)
    idempotency_key: str = Field(min_length=1, max_length=128)


class Accept(Command):
    eta_minutes: Literal[15, 30, 45, 60]


class Fulfill(Command):
    fulfillment: Literal['PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED_TO_ROOM','HANDED_TO_RECEPTION','PICKED_UP_BY_GUEST']


class Decision(Command):
    approve: bool
    reason: Literal['PREPARATION_STARTED','FOOD_READY','OUT_FOR_DELIVERY','HANDED_OVER'] | None = None


def install(app, service, token):
    @app.put('/restaurants/{restaurant_id}/menu/{item_id}')
    def menu_item(restaurant_id: str, item_id: str, body: MenuItem, secret: Annotated[str, Depends(token)]):
        return service.menu_item(secret, restaurant_id, item_id,
            body.model_dump(exclude={'expected_revision','idempotency_key'}), body.expected_revision, body.idempotency_key)

    @app.put('/hotels/{tenant_id}/restaurants/{restaurant_id}/link-state')
    def link(tenant_id: str, restaurant_id: str, body: LinkState, secret: Annotated[str, Depends(token)]):
        return service.set_link(secret, tenant_id, restaurant_id, body.active, body.expected_revision, body.idempotency_key)

    @app.get('/guest/restaurants/{restaurant_id}/menu')
    def menu(restaurant_id: str, secret: Annotated[str, Depends(token)]):
        return service.menu(secret, restaurant_id)

    @app.post('/guest/restaurants/{restaurant_id}/orders', status_code=201)
    def create(restaurant_id: str, body: Cart, secret: Annotated[str, Depends(token)]):
        return service.create(secret, restaurant_id, body.quantities, body.idempotency_key)

    @app.post('/guest/restaurant-orders/{order_id}/invoice')
    def invoice(order_id: str, secret: Annotated[str, Depends(token)]):
        return service.invoice(secret, order_id)

    @app.get('/guest/restaurant-orders/{order_id}')
    def detail(order_id: str, secret: Annotated[str, Depends(token)]):
        return service.guest_detail(secret, order_id)

    @app.post('/guest/hotels/{tenant_id}/restaurant-orders/{order_id}/{action}')
    def guest_command(tenant_id: str, order_id: str, action: Literal['request-refund','reconcile-payment'], body: Command,
                      secret: Annotated[str, Depends(token)]):
        return service.command(secret, tenant_id, order_id, action.upper().replace('-','_'), body.expected_revision, body.idempotency_key)

    @app.get('/restaurants/{restaurant_id}/orders')
    def queue(restaurant_id: str, secret: Annotated[str, Depends(token)], after: str='', limit: int=Query(50, ge=1, le=100)):
        return service.restaurant_queue(secret, restaurant_id, after, limit)

    @app.post('/restaurants/{restaurant_id}/hotels/{tenant_id}/orders/{order_id}/accept')
    def accept(restaurant_id: str, tenant_id: str, order_id: str, body: Accept, secret: Annotated[str, Depends(token)]):
        return service.command(secret, tenant_id, order_id, 'ACCEPT', body.expected_revision, body.idempotency_key,
                               dict(eta_minutes=body.eta_minutes), restaurant=restaurant_id)

    @app.post('/restaurants/{restaurant_id}/hotels/{tenant_id}/orders/{order_id}/fulfill')
    def fulfill(restaurant_id: str, tenant_id: str, order_id: str, body: Fulfill, secret: Annotated[str, Depends(token)]):
        return service.command(secret, tenant_id, order_id, 'FULFILL', body.expected_revision, body.idempotency_key,
                               dict(fulfillment=body.fulfillment), restaurant=restaurant_id)

    @app.post('/restaurants/{restaurant_id}/hotels/{tenant_id}/orders/{order_id}/decide-refund')
    def decide(restaurant_id: str, tenant_id: str, order_id: str, body: Decision, secret: Annotated[str, Depends(token)]):
        return service.command(secret, tenant_id, order_id, 'DECIDE_REFUND', body.expected_revision, body.idempotency_key,
                               dict(approve=body.approve, reason=body.reason), restaurant=restaurant_id)

    @app.post('/restaurants/{restaurant_id}/hotels/{tenant_id}/orders/{order_id}/{action}')
    def restaurant_command(restaurant_id: str, tenant_id: str, order_id: str,
                           action: Literal['cannot-fulfill','begin-refund','reconcile-refund','reconcile-payment'],
                           body: Command, secret: Annotated[str, Depends(token)]):
        return service.command(secret, tenant_id, order_id, action.upper().replace('-','_'), body.expected_revision, body.idempotency_key, restaurant=restaurant_id)
