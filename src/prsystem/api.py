"""Staff API factory. Run with an application DSN, never migration credentials."""

import os
import base64
from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from prsystem.auth import AuthSettings, StaffAuth
from prsystem.common import DomainError
from prsystem.staff_lifecycle import StaffLifecycle


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


class ResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(min_length=3, max_length=254)


def create_app(dsn: str | None = None, settings: AuthSettings | None = None, *, token_key: bytes | None = None) -> FastAPI:
    service = StaffAuth(dsn or os.environ["PRSYSTEM_APP_DSN"], settings or AuthSettings())
    if token_key is None and os.environ.get("PRSYSTEM_LINK_KEY"):
        token_key = base64.b64decode(os.environ["PRSYSTEM_LINK_KEY"], altchars=b"-_", validate=True)
    lifecycle = StaffLifecycle(service, token_key) if token_key is not None else None
    app = FastAPI(title="PRsystem staff API", version="0.3.0")
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
                  "MEMBERSHIP_NOT_FOUND": 404, "MEMBERSHIP_EXISTS": 409, "MEMBERSHIP_NOT_PENDING": 409,
                  "REVISION_CONFLICT": 409, "IDEMPOTENCY_CONFLICT": 409, "LINK_SERVICE_UNAVAILABLE": 503,
                  "TOKEN_KEY_MISMATCH": 503, "CASH_BOOK_NOT_FOUND": 404, "UNSAFE_DATABASE_ROLE": 503}.get(code, 403)
        headers = {"WWW-Authenticate": "Bearer"} if status == 401 else {}
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

    @app.post("/auth/invitations/accept")
    def accept_invite(body: LinkPassword, request: Request):
        return links().accept(body.token.get_secret_value(), body.password.get_secret_value(), peer(request))

    @app.post("/auth/password/reset/request", status_code=202)
    def request_reset(body: ResetRequest, request: Request):
        links().request_reset(body.email, peer(request))
        return {"status": "ACCEPTED"}

    @app.post("/auth/password/reset/complete", status_code=204)
    def complete_reset(body: LinkPassword, request: Request):
        links().complete_reset(body.token.get_secret_value(), body.password.get_secret_value(), peer(request))
        return Response(status_code=204)

    return app
