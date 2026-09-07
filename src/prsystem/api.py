"""Staff API factory. Run with an application DSN, never migration credentials."""

import os
import base64
from typing import Annotated, Literal

import psycopg
from fastapi import Depends, FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
from starlette.concurrency import run_in_threadpool

from prsystem.auth import AuthSettings, StaffAuth
from prsystem.common import DomainError
from prsystem.staff_lifecycle import StaffLifecycle
from prsystem.membership import MembershipService
from prsystem.security_audit import record_denial
from prsystem.restaurant_identity import RestaurantIdentity


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(min_length=3, max_length=254)
    password: SecretStr = Field(min_length=1, max_length=128)
    tenant_id: str = Field(min_length=1, max_length=128)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    current_password: SecretStr = Field(min_length=1, max_length=128)
    new_password: SecretStr = Field(min_length=12, max_length=128)


class Invitation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=200)
    roles: list[str] = Field(min_length=1, max_length=4)
    idempotency_key: str = Field(min_length=1, max_length=128)


class InvitationChange(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=1, max_length=128)


class LinkPassword(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    token: SecretStr = Field(min_length=20, max_length=256)
    password: SecretStr = Field(min_length=1, max_length=128)


class MembershipChange(InvitationChange):
    reason: str = Field(min_length=1, max_length=1000)


class RoleChange(MembershipChange):
    roles: list[str] = Field(min_length=1, max_length=5)


class ResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(min_length=3, max_length=254)


class RestaurantLogin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(min_length=3, max_length=254)
    password: SecretStr = Field(min_length=1, max_length=128)
    restaurant_id: str = Field(min_length=1, max_length=128)


class RestaurantInvite(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=200)
    idempotency_key: str = Field(min_length=1, max_length=128)


class WeeklyHours(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    day: int = Field(ge=0, le=6)
    closed: bool
    opens: str | None = Field(default=None, pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")
    closes: str | None = Field(default=None, pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")

    @model_validator(mode="after")
    def hours(self):
        if (self.closed and (self.opens is not None or self.closes is not None)) or (
                not self.closed and (self.opens is None or self.closes is None or self.opens == self.closes)):
            raise ValueError("Invalid weekly hours")
        return self


class RestaurantRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    address: str = Field(min_length=1, max_length=500)
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    phone: str = Field(pattern=r"^\+?[0-9][0-9 -]{5,19}$")
    weekly_hours: list[WeeklyHours] = Field(min_length=7, max_length=7)
    email: str = Field(min_length=3, max_length=254)
    manager_name: str = Field(min_length=1, max_length=200)
    idempotency_key: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def unique_days(self):
        if len({entry.day for entry in self.weekly_hours}) != 7:
            raise ValueError("Exactly one entry for each weekday is required")
        return self


class RestaurantLink(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    idempotency_key: str = Field(min_length=1, max_length=128)


def create_app(dsn: str | None = None, settings: AuthSettings | None = None, *, token_key: bytes | None = None) -> FastAPI:
    service = StaffAuth(dsn or os.environ["PRSYSTEM_APP_DSN"], settings or AuthSettings())
    if token_key is None and os.environ.get("PRSYSTEM_LINK_KEY"):
        token_key = base64.b64decode(os.environ["PRSYSTEM_LINK_KEY"], altchars=b"-_", validate=True)
    lifecycle = StaffLifecycle(service, token_key) if token_key is not None else None
    memberships = MembershipService(service)
    restaurants = RestaurantIdentity(service, lifecycle)
    app = FastAPI(title="PRsystem staff API", version="0.6.0")
    bearer = HTTPBearer(auto_error=False)

    def token(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        if credentials is None or not 20 <= len(credentials.credentials) <= 256:
            raise DomainError("UNAUTHENTICATED")
        return credentials.credentials

    def peer(request):
        # Ignore user-supplied X-Forwarded-For. Configure trusted proxies at deployment.
        return request.client.host if request.client else "unknown"

    def links():
        if lifecycle is None:
            raise DomainError("LINK_SERVICE_UNAVAILABLE")
        return lifecycle

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # Framework validation details may echo passwords/tokens from request input.
        return JSONResponse({"code": "INVALID_REQUEST"}, status_code=422)

    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        code = str(exc)
        status = {"INVALID_CREDENTIALS": 401, "UNAUTHENTICATED": 401, "RATE_LIMITED": 429,
                  "INVALID_PASSWORD": 422, "INVALID_EMAIL": 422, "INVALID_LINK": 400,
                  "INVALID_REASON": 422, "INVALID_REQUEST": 422, "EXCEPTION_NOT_FOUND": 404,
                  "INVALID_MEMBERSHIP_TRANSITION": 409, "EXCEPTION_ALREADY_CLAIMED": 409,
                  "EXCEPTION_NOT_CLAIMED": 409, "CLAIMANT_STILL_ELIGIBLE": 409,
                  "VERIFIED_ACCOUNT_REQUIRES_REACTIVATION": 409,
                  "RESTAURANT_LINK_EXISTS": 409,
                  "MEMBERSHIP_NOT_FOUND": 404, "MEMBERSHIP_EXISTS": 409, "MEMBERSHIP_NOT_PENDING": 409,
                  "REVISION_CONFLICT": 409, "IDEMPOTENCY_CONFLICT": 409, "LINK_SERVICE_UNAVAILABLE": 503,
                  "TOKEN_KEY_MISMATCH": 503, "CASH_BOOK_NOT_FOUND": 404, "UNSAFE_DATABASE_ROLE": 503}.get(code, 403)
        headers = {"WWW-Authenticate": "Bearer"} if status == 401 else {}
        if status in {401, 403}:
            authorization = request.headers.get("Authorization", "").split(" ", 1)
            secret = authorization[1] if len(authorization) == 2 and authorization[0].lower() == "bearer" and 20 <= len(authorization[1]) <= 256 else None
            route = request.scope.get("route")
            try:
                await run_in_threadpool(record_denial, service, bearer=secret,
                    tenant=request.path_params.get("tenant_id"), target=request.path_params.get("account_id"),
                    restaurant=request.path_params.get("restaurant_id"),
                    action=getattr(route, "path", "UNKNOWN"), method=request.method, code=code)
            except (psycopg.Error, DomainError):
                return JSONResponse({"code": "SERVICE_UNAVAILABLE"}, status_code=503)
        if status == 429:
            headers["Retry-After"] = str(service.settings.login_window_seconds)
        return JSONResponse({"code": "SERVICE_UNAVAILABLE" if status == 503 else code}, status_code=status, headers=headers)

    @app.exception_handler(psycopg.Error)
    async def database_error(request, exc):
        return JSONResponse({"code": "SERVICE_UNAVAILABLE"}, status_code=503)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/auth/login")
    def login(body: Login, request: Request):
        return service.login(body.email, body.password.get_secret_value(), body.tenant_id, peer(request))

    @app.post("/auth/restaurants/login")
    def restaurant_login(body: RestaurantLogin, request: Request):
        return service.login(body.email, body.password.get_secret_value(), None, peer(request), restaurant=body.restaurant_id)

    @app.post("/auth/restaurants/invitations/accept")
    def restaurant_accept(body: LinkPassword, request: Request):
        return restaurants.accept(body.token.get_secret_value(), body.password.get_secret_value(), peer(request))

    @app.post("/hotels/{tenant_id}/restaurants", status_code=201)
    def restaurant_register(tenant_id: str, body: RestaurantRegistration, secret: Annotated[str, Depends(token)]):
        return restaurants.register(secret, tenant_id, body.model_dump(mode="json", exclude={"idempotency_key"}), body.idempotency_key)

    @app.post("/hotels/{tenant_id}/restaurants/{restaurant_id}/link", status_code=201)
    def restaurant_link(tenant_id: str, restaurant_id: str, body: RestaurantLink, secret: Annotated[str, Depends(token)]):
        return restaurants.link(secret, tenant_id, restaurant_id, body.idempotency_key)

    @app.get("/hotels/{tenant_id}/restaurants/{restaurant_id}/profile")
    def restaurant_profile(tenant_id: str, restaurant_id: str, secret: Annotated[str, Depends(token)]):
        return restaurants.profile(secret, tenant_id, restaurant_id)

    @app.post("/hotels/{tenant_id}/restaurants/{restaurant_id}/staff/invitations", status_code=201)
    def restaurant_invite(tenant_id: str, restaurant_id: str, body: RestaurantInvite, secret: Annotated[str, Depends(token)]):
        return restaurants.invite(secret, tenant_id, restaurant_id, body.email, body.name, body.idempotency_key)

    @app.post("/hotels/{tenant_id}/restaurants/{restaurant_id}/staff/{account_id}/invitations/{action}")
    def restaurant_invite_change(tenant_id: str, restaurant_id: str, account_id: str,
                                 action: Literal["resend", "revoke"], body: InvitationChange,
                                 secret: Annotated[str, Depends(token)]):
        return restaurants.change(secret, tenant_id, restaurant_id, account_id, action.upper(), body.expected_revision, body.idempotency_key)

    @app.post("/hotels/{tenant_id}/restaurants/{restaurant_id}/staff/{account_id}/{action}")
    def restaurant_member_change(tenant_id: str, restaurant_id: str, account_id: str,
                                 action: Literal["suspend", "terminate", "reactivate", "recover"], body: MembershipChange,
                                 secret: Annotated[str, Depends(token)]):
        return restaurants.change(secret, tenant_id, restaurant_id, account_id, action.upper(), body.expected_revision, body.idempotency_key, body.reason)

    @app.get("/auth/me")
    def me(secret: Annotated[str, Depends(token)]):
        return service.me(secret)

    @app.post("/auth/logout", status_code=204)
    def logout(secret: Annotated[str, Depends(token)]):
        service.logout(secret)
        return Response(status_code=204)

    @app.post("/auth/logout-all", status_code=204)
    def logout_all(secret: Annotated[str, Depends(token)]):
        service.logout_all(secret)
        return Response(status_code=204)

    @app.post("/auth/password/change", status_code=204)
    def change_password(body: PasswordChange, request: Request, secret: Annotated[str, Depends(token)]):
        service.change_password(secret, body.current_password.get_secret_value(), body.new_password.get_secret_value(), peer(request))
        return Response(status_code=204)

    @app.get("/hotels/{tenant_id}/cash/drawers")
    def cash_drawers(tenant_id: str, secret: Annotated[str, Depends(token)]):
        return service.cash_drawers(secret, tenant_id)

    @app.post("/hotels/{tenant_id}/staff/invitations", status_code=201)
    def invite(tenant_id: str, body: Invitation, secret: Annotated[str, Depends(token)]):
        return links().invite(secret, tenant_id, body.email, body.name, body.roles, body.idempotency_key)

    @app.post("/hotels/{tenant_id}/staff/{account_id}/invitations/resend")
    def resend(tenant_id: str, account_id: str, body: InvitationChange, secret: Annotated[str, Depends(token)]):
        return links().change_invite(secret, tenant_id, account_id, body.expected_revision, body.idempotency_key, resend=True)

    @app.post("/hotels/{tenant_id}/staff/{account_id}/invitations/revoke")
    def revoke(tenant_id: str, account_id: str, body: InvitationChange, secret: Annotated[str, Depends(token)]):
        return links().change_invite(secret, tenant_id, account_id, body.expected_revision, body.idempotency_key, resend=False)

    @app.post("/hotels/{tenant_id}/staff/{account_id}/invitations/recover")
    def recover_invite(tenant_id: str, account_id: str, body: MembershipChange, secret: Annotated[str, Depends(token)]):
        return links().recover_invite(secret, tenant_id, account_id, body.expected_revision, body.idempotency_key, body.reason)

    @app.post("/hotels/{tenant_id}/staff/{account_id}/password/reset", status_code=202)
    def admin_reset(tenant_id: str, account_id: str, body: InvitationChange, request: Request,
                    secret: Annotated[str, Depends(token)]):
        return links().admin_reset(secret, tenant_id, account_id, body.expected_revision, body.idempotency_key, peer(request))

    @app.post("/auth/invitations/accept")
    def accept_invite(body: LinkPassword, request: Request):
        return links().accept(body.token.get_secret_value(), body.password.get_secret_value(), peer(request))

    @app.post("/hotels/{tenant_id}/staff/{account_id}/roles")
    def roles(tenant_id: str, account_id: str, body: RoleChange, secret: Annotated[str, Depends(token)]):
        return memberships.change(secret, tenant_id, account_id, "ROLES", body.expected_revision,
                                  body.idempotency_key, body.reason, body.roles)

    @app.post("/hotels/{tenant_id}/staff/{account_id}/suspend")
    def suspend(tenant_id: str, account_id: str, body: MembershipChange, secret: Annotated[str, Depends(token)]):
        return memberships.change(secret, tenant_id, account_id, "SUSPEND", body.expected_revision, body.idempotency_key, body.reason)

    @app.post("/hotels/{tenant_id}/staff/{account_id}/terminate")
    def terminate(tenant_id: str, account_id: str, body: MembershipChange, secret: Annotated[str, Depends(token)]):
        return memberships.change(secret, tenant_id, account_id, "TERMINATE", body.expected_revision, body.idempotency_key, body.reason)

    @app.post("/hotels/{tenant_id}/staff/{account_id}/reactivate")
    def reactivate(tenant_id: str, account_id: str, body: MembershipChange, secret: Annotated[str, Depends(token)]):
        return memberships.change(secret, tenant_id, account_id, "REACTIVATE", body.expected_revision, body.idempotency_key, body.reason)

    @app.get("/hotels/{tenant_id}/staff-work/exceptions")
    def exceptions(tenant_id: str, secret: Annotated[str, Depends(token)],
                   limit: Annotated[int, Query(ge=1, le=100)] = 100,
                   after: Annotated[str, Query(max_length=128)] = ""):
        return memberships.exceptions(secret, tenant_id, limit, after)

    @app.post("/hotels/{tenant_id}/staff-work/exceptions/{exception_id}/claim")
    def claim(tenant_id: str, exception_id: str, body: InvitationChange, secret: Annotated[str, Depends(token)]):
        return memberships.claim(secret, tenant_id, exception_id, body.expected_revision, body.idempotency_key)

    @app.post("/hotels/{tenant_id}/staff-work/exceptions/{exception_id}/recover")
    def recover_claim(tenant_id: str, exception_id: str, body: MembershipChange, secret: Annotated[str, Depends(token)]):
        return memberships.recover_claim(secret, tenant_id, exception_id, body.expected_revision, body.idempotency_key, body.reason)

    @app.post("/auth/password/reset/request", status_code=202)
    def request_reset(body: ResetRequest, request: Request):
        links().request_reset(body.email, peer(request))
        return {"status": "ACCEPTED"}

    @app.post("/auth/password/reset/complete", status_code=204)
    def complete_reset(body: LinkPassword, request: Request):
        links().complete_reset(body.token.get_secret_value(), body.password.get_secret_value(), peer(request))
        return Response(status_code=204)

    return app
