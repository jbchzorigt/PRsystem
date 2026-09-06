"""Staff API factory. Run with an application DSN, never migration credentials."""

import os
from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from prsystem.auth import AuthSettings, StaffAuth
from prsystem.common import DomainError


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(min_length=3, max_length=254)
    password: SecretStr = Field(min_length=1, max_length=128)
    tenant_id: str = Field(min_length=1, max_length=128)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    current_password: SecretStr = Field(min_length=1, max_length=128)
    new_password: SecretStr = Field(min_length=12, max_length=128)


def create_app(dsn: str | None = None, settings: AuthSettings | None = None) -> FastAPI:
    service = StaffAuth(dsn or os.environ["PRSYSTEM_APP_DSN"], settings or AuthSettings())
    app = FastAPI(title="PRsystem staff API", version="0.2.0")
    bearer = HTTPBearer(auto_error=False)

    def token(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        if credentials is None or not 20 <= len(credentials.credentials) <= 256:
            raise DomainError("UNAUTHENTICATED")
        return credentials.credentials

    def peer(request):
        # Ignore user-supplied X-Forwarded-For. Configure trusted proxies at deployment.
        return request.client.host if request.client else "unknown"

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # Framework validation details may echo passwords/tokens from request input.
        return JSONResponse({"code": "INVALID_REQUEST"}, status_code=422)

    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        code = str(exc)
        status = {"INVALID_CREDENTIALS": 401, "UNAUTHENTICATED": 401, "RATE_LIMITED": 429,
                  "INVALID_PASSWORD": 422, "CASH_BOOK_NOT_FOUND": 404, "UNSAFE_DATABASE_ROLE": 503}.get(code, 403)
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

    return app
