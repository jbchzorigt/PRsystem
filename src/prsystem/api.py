"""Staff API factory. Run with an application DSN, never migration credentials."""

import os
import base64
from pathlib import Path
from typing import Annotated, Literal

import psycopg
from fastapi import Depends, FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
from starlette.concurrency import run_in_threadpool

from prsystem.auth import AuthSettings, StaffAuth
from prsystem.common import DomainError
from prsystem.staff_lifecycle import StaffLifecycle
from prsystem.membership import MembershipService
from prsystem.security_audit import record_denial
from prsystem.restaurant_identity import RestaurantIdentity
from prsystem.cleaning import CleaningService
from prsystem.shifts import ShiftService
from prsystem.platform import PlatformService
from prsystem.onboarding import OnboardingService
from prsystem.renewal import RenewalService
from prsystem.opening import OpeningService
from prsystem.rooms import RoomService
from prsystem.readiness import ReadinessService
from prsystem.stays import StayService
from prsystem.guest_finance import GuestFinance
from prsystem.guest_corrections import GuestCorrections
from prsystem.guest_payments import GuestPayments
from prsystem.checkout import CheckoutService
from prsystem.guest_access import GuestAccess
from prsystem.stay_amendments import StayAmendments
from prsystem.room_lifecycle import RoomLifecycle
from prsystem.handover import HandoverService
from prsystem.reception_booking import ReceptionBooking
from prsystem.checkin_funding import CheckinFunding
from prsystem.routed_refunds import RoutedRefunds
from prsystem.reception_dependencies import ReceptionDependencies
from prsystem.guest_identity import vault_from_environment


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


class WorkReplacement(MembershipChange):
    replacement_id: str = Field(min_length=1, max_length=128)


class DrawerConfiguration(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    code: str = Field(min_length=1,max_length=200)
    name: str = Field(min_length=1,max_length=200)
    physical_location: str = Field(min_length=1,max_length=200)
    expected_float: int = Field(ge=0,le=2**63-1)
    status: Literal['ACTIVE','INACTIVE'] = 'ACTIVE'
    expected_revision: int = Field(default=0,ge=0)
    idempotency_key: str = Field(min_length=1,max_length=128)


class PhysicalOpening(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    actual: int = Field(ge=0,le=2**63-1)
    idempotency_key: str = Field(min_length=1,max_length=128)


class GuestRedeem(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    qr_token: SecretStr=Field(min_length=20,max_length=128)
    code: SecretStr=Field(min_length=4,max_length=6)


class TimeAmendment(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    actual_checkin_at: str=Field(min_length=20,max_length=50)
    reason: str=Field(min_length=1,max_length=1000)
    idempotency_key: str=Field(min_length=1,max_length=128)


class AmendmentDecision(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    approve: bool
    reason: str=Field(min_length=1,max_length=1000)
    idempotency_key: str=Field(min_length=1,max_length=128)


class RoomTransition(MembershipChange):
    action: Literal['DEACTIVATE','REACTIVATE','CANCEL_RETIRING','REASSIGN_CATEGORY']
    category_id: str|None=Field(default=None,min_length=1,max_length=128)


class ShiftPolicy(InvitationChange):
    single_worker: bool


class HandoverSubmit(PhysicalOpening):
    receiver_id: str=Field(min_length=1,max_length=128)
    reason: str=Field(min_length=1,max_length=1000)
    self_close: bool=False
    custody_id: str|None=Field(default=None,min_length=1,max_length=128)


class HandoverDecision(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    accept: bool
    count_id: str|None=Field(default=None,min_length=1,max_length=128)
    reason: str=Field(min_length=1,max_length=1000)
    idempotency_key: str=Field(min_length=1,max_length=128)


class HotelStaySettings(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    hourly_price: int = Field(gt=0,le=2**63-1)
    nightly_price: int = Field(gt=0,le=2**63-1)
    checkout_time: str = Field(pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    expected_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=1,max_length=128)


class CategoryCreate(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    name: str = Field(min_length=1,max_length=200)
    description: str = Field(default='',max_length=2000)
    hourly_price: int | None = Field(default=None,gt=0,le=2**63-1)
    nightly_price: int | None = Field(default=None,gt=0,le=2**63-1)
    deposit: int = Field(default=0,ge=0,le=2**63-1)
    cleaning_buffer_minutes: int = Field(ge=0,le=2147483647)
    status: Literal['ACTIVE','INACTIVE'] = 'ACTIVE'
    idempotency_key: str = Field(min_length=1,max_length=128)


class RoomCreate(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    number: str = Field(min_length=1,max_length=50)
    floor: str = Field(min_length=1,max_length=50)
    category_id: str = Field(min_length=1,max_length=128)
    hourly_price: int | None = Field(default=None,gt=0,le=2**63-1)
    nightly_price: int | None = Field(default=None,gt=0,le=2**63-1)
    status: Literal['ACTIVE','INACTIVE'] = 'ACTIVE'
    idempotency_key: str = Field(min_length=1,max_length=128)


class TariffChange(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    hourly_price: int | None = Field(gt=0,le=2**63-1)
    nightly_price: int | None = Field(gt=0,le=2**63-1)
    expected_revision: int = Field(ge=1)
    idempotency_key: str = Field(min_length=1,max_length=128)


class GuardianInput(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    name: str = Field(min_length=1,max_length=200)
    phone: str = Field(min_length=1,max_length=200)
    relationship: str = Field(min_length=1,max_length=200)


class PrimaryGuestInput(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    identity_type: Literal['MN_REG_NO','FOREIGN_PASSPORT','OTHER_GOV_ID','NO_DOCUMENT']
    family_name: str = Field(min_length=1,max_length=200)
    given_name: str = Field(min_length=1,max_length=200)
    date_of_birth: str = Field(min_length=10,max_length=10)
    nationality: str = Field(min_length=1,max_length=200)
    document_number: str | None = Field(default=None,min_length=1,max_length=200)
    issuing_country: str | None = Field(default=None,min_length=2,max_length=2)
    expiry_date: str | None = Field(default=None,min_length=10,max_length=10)
    document_type: str | None = Field(default=None,min_length=1,max_length=200)
    issuing_authority: str | None = Field(default=None,min_length=1,max_length=200)
    no_document_reason: str | None = Field(default=None,min_length=1,max_length=1000)
    note: str | None = Field(default=None,min_length=1,max_length=2000)
    guardian: GuardianInput | None = None


class CashConfirmation(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    channel: Literal['CASH']
    amount_mnt: int = Field(gt=0,le=2**63-1)
    received: bool

    @model_validator(mode='after')
    def cash_received(self):
        if self.received is not True:raise ValueError('Physical cash confirmation required')
        return self


class DepositSetting(InvitationChange):
    amount_mnt: int | None = Field(ge=50000,le=100000)


class GuestCashReceipt(CashConfirmation):
    purpose: Literal['PAYMENT']
    charge_id: str | None = Field(default=None,min_length=1,max_length=128)
    expected_revision: int = Field(ge=1)
    idempotency_key: str = Field(min_length=1,max_length=128)


class EmptyInput(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)


class ManualPosPayment(InvitationChange):
    charge_id: str = Field(min_length=1,max_length=128)
    amount_mnt: int = Field(gt=0,le=2**63-1)
    reference: str = Field(min_length=1,max_length=200)
    terminal_id: str = Field(min_length=1,max_length=100)
    transacted_at: str = Field(min_length=20,max_length=40)


class GuestPaymentIntent(InvitationChange):
    charge_id: str = Field(min_length=1,max_length=128)
    amount_mnt: int = Field(gt=0,le=2**63-1)
    provider: Literal['QPAY','KHAAN']


class CashCorrectionRequest(InvitationChange):
    receipt_id: str = Field(min_length=1,max_length=128)
    replacement_amount_mnt: int = Field(ge=0,le=2**63-1)
    reason: str = Field(min_length=1,max_length=1000)


class CashCorrectionDecision(InvitationChange):
    approve: bool
    reason: str = Field(min_length=1,max_length=1000)


class DepositAllocation(InvitationChange):
    receipt_id: str = Field(min_length=1,max_length=128)
    charge_id: str = Field(min_length=1,max_length=128)
    amount_mnt: int = Field(gt=0,le=2**63-1)


class CashRefundRequest(InvitationChange):
    receipt_id: str = Field(min_length=1,max_length=128)
    amount_mnt: int = Field(gt=0,le=2**63-1)


class CashRefundComplete(InvitationChange):
    recipient_confirmation: str = Field(min_length=1,max_length=1000)


class CashRefundRelease(InvitationChange):
    reason: str = Field(min_length=1,max_length=1000)
    cash_not_handed: bool

    @model_validator(mode='after')
    def not_handed(self):
        if self.cash_not_handed is not True:raise ValueError('Cash must not have been handed over')
        return self


class WalkInCheckIn(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    room_id: str = Field(min_length=1,max_length=128)
    kind: Literal['HOURLY','NIGHTLY']
    duration_units: int = Field(ge=1,le=2**63-1)
    actual_checkin_at: str | None = Field(default=None,min_length=20,max_length=40)
    backdate_reason: str | None = Field(default=None,min_length=1,max_length=1000)
    guest: PrimaryGuestInput
    deposit: CashConfirmation | None = None
    funding_id: str|None=Field(default=None,min_length=1,max_length=128)
    idempotency_key: str = Field(min_length=1,max_length=128)


class OnlineCheckIn(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    guest: PrimaryGuestInput
    actual_checkin_at: str|None=Field(default=None,min_length=20,max_length=40)
    backdate_reason: str|None=Field(default=None,min_length=1,max_length=1000)
    idempotency_key: str=Field(min_length=1,max_length=128)


class MockBookingInput(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    room_id: str=Field(min_length=1,max_length=128)
    kind: Literal['HOURLY','NIGHTLY']
    duration_units: int=Field(ge=1,le=365)
    planned_checkin_at: str=Field(min_length=20,max_length=40)
    idempotency_key: str=Field(min_length=1,max_length=128)


class CheckinFundingInput(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    room_id: str=Field(min_length=1,max_length=128)
    channel: Literal['MANUAL_POS','QPAY','KHAAN']
    reference: str|None=Field(default=None,min_length=1,max_length=200)
    terminal_id: str|None=Field(default=None,min_length=1,max_length=100)
    transacted_at: str|None=Field(default=None,min_length=20,max_length=40)
    idempotency_key: str=Field(min_length=1,max_length=128)


class RoutedRefundInput(InvitationChange):
    receipt_id: str=Field(min_length=1,max_length=128)
    amount_mnt: int=Field(gt=0,le=2**63-1)
    channel: Literal['CASH','MANUAL_POS','QPAY','KHAAN']
    recipient: str=Field(min_length=1,max_length=1000)
    reason: str=Field(min_length=1,max_length=1000)


class ManualRoutedRefund(InvitationChange):
    recipient_confirmation: str=Field(min_length=1,max_length=1000)
    reference: str|None=Field(default=None,min_length=1,max_length=200)


class ReasonCommand(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    reason: str=Field(min_length=1,max_length=1000)
    idempotency_key: str=Field(min_length=1,max_length=128)


class FundingReturnProof(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    reference: str|None=Field(default=None,min_length=1,max_length=200)
    confirmation: str|None=Field(default=None,min_length=1,max_length=1000)
    idempotency_key: str=Field(min_length=1,max_length=128)


class CorrectionProof(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    reference: str=Field(min_length=1,max_length=200)
    terminal_id: str=Field(min_length=1,max_length=100)
    transacted_at: str=Field(min_length=20,max_length=40)


class FinancialCorrectionInput(InvitationChange):
    receipt_id: str=Field(min_length=1,max_length=128)
    replacement_amount_mnt: int=Field(ge=0,le=2**63-1)
    replacement_channel: Literal['CASH','MANUAL_POS','QPAY','KHAAN']
    proof: CorrectionProof|None=None
    reason: str=Field(min_length=1,max_length=1000)


class MinibarFixtureItem(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    product_id: str=Field(min_length=1,max_length=100)
    name: str=Field(min_length=1,max_length=200)
    unit_price: int=Field(gt=0,le=2**63-1)
    opening_quantity: int=Field(gt=0,le=1000)


class MinibarFixture(InvitationChange):
    items: list[MinibarFixtureItem]=Field(max_length=50)


class MinibarReportInput(InvitationChange):
    used: dict[str,int]=Field(max_length=50)
    no_consumption: bool=False
    exception_reason: str|None=Field(default=None,min_length=1,max_length=1000)


class MinibarReview(ReasonCommand):
    action: Literal['RETURN','DISPUTE','UPHOLD','WAIVE']


class RestaurantOrderFixture(ReasonCommand):
    restaurant_name: str=Field(min_length=1,max_length=200)
    contact_phone: str=Field(min_length=1,max_length=30)
    state: Literal['PAID_PENDING','ACCEPTED','PREPARING','READY','DONE','REFUNDED']


class RestaurantCheckoutChoice(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    order_id: str=Field(min_length=1,max_length=128)
    choice: Literal['RECEPTION_PICKUP','GUEST_PICKUP','REFUND_REQUEST']


class CheckoutInput(InvitationChange):
    restaurant_choices: list[RestaurantCheckoutChoice]=Field(default_factory=list,max_length=100)
    guest_informed: bool=False


class RoomCleaningRequest(InvitationChange):
    assignee_id: str = Field(min_length=1,max_length=128)


class OnboardingApplication(BaseModel):
    model_config = ConfigDict(extra="forbid",strict=True)
    owner_kind: Literal["INDIVIDUAL","COMPANY"]
    owner_identifier: str = Field(min_length=5,max_length=20)
    first_name: str = Field(min_length=1,max_length=200)
    last_name: str = Field(min_length=1,max_length=200)
    company_name: str | None = Field(default=None,min_length=1,max_length=200)
    position: str | None = Field(default=None,min_length=1,max_length=200)
    phone: str = Field(min_length=8,max_length=16)
    email: str = Field(min_length=3,max_length=254)
    contact_phone: str = Field(min_length=8,max_length=16)
    hotel_name: str = Field(min_length=1,max_length=200)
    hotel_phone: str = Field(min_length=8,max_length=16)
    district: str = Field(min_length=1,max_length=200)
    ward: str = Field(min_length=1,max_length=200)
    address: str = Field(min_length=1,max_length=500)
    latitude: float = Field(ge=-90,le=90,allow_inf_nan=False)
    longitude: float = Field(ge=-180,le=180,allow_inf_nan=False)
    package_mnt: int
    months: int


class OnboardingOTP(BaseModel):
    model_config = ConfigDict(extra="forbid",strict=True)
    code: SecretStr = Field(min_length=4,max_length=8)


class RenewalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid",strict=True)
    package_mnt: int
    months: int
    provider: Literal["QPAY","KHAAN"]
    idempotency_key: str = Field(min_length=1,max_length=128)


class AccountProof(BaseModel):
    model_config = ConfigDict(extra="forbid",strict=True)
    staff_token: SecretStr = Field(min_length=20,max_length=256)


class PlatformLogin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(min_length=3,max_length=254)
    password: SecretStr = Field(min_length=1,max_length=128)
    code: SecretStr = Field(min_length=6,max_length=6)


class PlatformMFA(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    code: SecretStr = Field(min_length=6,max_length=6)


class SecurityRecovery(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    reason: str = Field(min_length=1,max_length=1000)
    reference: str = Field(min_length=1,max_length=200)
    idempotency_key: str = Field(min_length=1,max_length=128)


class CashCount(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    actual: int = Field(ge=0,le=9223372036854775807)
    idempotency_key: str = Field(min_length=1,max_length=128)


class TakeoverClose(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    count_id: str = Field(min_length=1,max_length=128)
    idempotency_key: str = Field(min_length=1,max_length=128)


class CleaningPost(InvitationChange):
    action_id: str = Field(min_length=1,max_length=128)
    quantity: int = Field(gt=0,le=9223372036854775807)
    actual_count: int | None = Field(default=None,ge=0,le=9223372036854775807)


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


def create_app(dsn: str | None = None, settings: AuthSettings | None = None, *, token_key: bytes | None = None, platform_secret_resolver=None, phone_gateway=None, payment_gateways=None, runtime_mode='production', identity_vault=None, mock_stay_finance=False) -> FastAPI:
    if runtime_mode not in {'production','development','test'}:
        raise ValueError('Unknown runtime mode')
    service = StaffAuth(dsn or os.environ["PRSYSTEM_APP_DSN"], settings or AuthSettings())
    if type(mock_stay_finance) is not bool:
        raise ValueError('mock_stay_finance must be boolean')
    mocked = runtime_mode != 'production' or mock_stay_finance or any(getattr(port, 'is_mock', False) for port in [phone_gateway, *(payment_gateways or {}).values()])
    if mocked:
        from prsystem.mock_providers import require_development_database
        require_development_database(service.dsn, runtime_mode)
    if token_key is None and os.environ.get("PRSYSTEM_LINK_KEY"):
        token_key = base64.b64decode(os.environ["PRSYSTEM_LINK_KEY"], altchars=b"-_", validate=True)
    lifecycle = StaffLifecycle(service, token_key) if token_key is not None else None
    memberships = MembershipService(service)
    cleaning = CleaningService(service,runtime_mode)
    onboarding = OnboardingService(service,lifecycle,phone_gateway=phone_gateway,payment_gateways=payment_gateways)
    renewals = RenewalService(service,payment_gateways)
    shifts = ShiftService(service)
    handovers = HandoverService(service)
    openings = OpeningService(service)
    rooms = RoomService(service)
    room_lifecycle = RoomLifecycle(service)
    readiness = ReadinessService(service,runtime_mode)
    stays = ReceptionBooking(service, identity_vault if identity_vault is not None else vault_from_environment(), mock_finance=mock_stay_finance, runtime_mode=runtime_mode)
    guest_finance = GuestFinance(service, stays.vault, runtime_mode)
    checkout = CheckoutService(service, stays.vault, runtime_mode)
    guest_access = GuestAccess(service, stays.vault, runtime_mode)
    amendments = StayAmendments(service, stays.vault, runtime_mode)
    guest_corrections = GuestCorrections(service, stays.vault, runtime_mode,payment_gateways)
    guest_payments = GuestPayments(service, stays.vault, runtime_mode, payment_gateways)
    checkin_funding = CheckinFunding(service, stays.vault, runtime_mode, payment_gateways)
    routed_refunds = RoutedRefunds(service, stays.vault, runtime_mode, payment_gateways)
    from prsystem.operations import Operations
    operations=Operations(service,stays.vault,runtime_mode)
    reception_dependencies=ReceptionDependencies(service,stays.vault,runtime_mode)
    platform = PlatformService(service,platform_secret_resolver) if platform_secret_resolver else None
    restaurants = RestaurantIdentity(service, lifecycle)
    app = FastAPI(title="PRsystem MOCK ONLY API" if mocked else "PRsystem staff API", version="0.12.0")
    bearer = HTTPBearer(auto_error=False)

    def token(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        if credentials is None or not 20 <= len(credentials.credentials) <= 256:
            raise DomainError("UNAUTHENTICATED")
        return credentials.credentials

    def peer(request):
        # Ignore user-supplied X-Forwarded-For. Configure trusted proxies at deployment.
        return request.client.host if request.client else "unknown"

    def platform_service():
        if platform is None:
            raise DomainError("PLATFORM_UNAVAILABLE")
        return platform

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
        if mocked:
            response.headers['X-PRsystem-Mode'] = 'MOCK_ONLY'
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # Framework validation details may echo passwords/tokens from request input.
        return JSONResponse({"code": "INVALID_REQUEST"}, status_code=422)

    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        code = str(exc)
        stay_errors = {code:409 for code in ('ROOM_NOT_READY','ROOM_OCCUPIED','RESERVATION_CONFLICT','HISTORICAL_READINESS_REQUIRED','OPEN_SHIFT_REQUIRED','STAY_SETTINGS_REQUIRED','STAY_DEPOSIT_SETTINGS_REQUIRED','CLEANING_NOT_STARTED','WORK_SOURCE_CONFLICT')}
        stay_errors.update({code:422 for code in ('INVALID_GUEST_IDENTITY','GUARDIAN_REQUIRED','ACTUAL_TIME_OUT_OF_RANGE','INVALID_STAY_DURATION','STAY_ALREADY_ENDED','TIMEZONE_REQUIRED')})
        stay_errors['IDENTITY_VAULT_UNAVAILABLE'] = 503
        stay_errors['STAY_FINANCE_UNAVAILABLE'] = 503
        stay_errors.update({code:409 for code in ('DEPOSIT_REQUIREMENT_NOT_MET','FINANCIAL_SOURCE_NOT_READY','FINANCIAL_AGGREGATE_FROZEN','DEPOSIT_BALANCE_CONFLICT','INSUFFICIENT_DEPOSIT','CHARGE_OVERPAYMENT','INVALID_FINANCIAL_SOURCE','ORIGINAL_CASH_DRAWER_REQUIRED','REFUND_TERMINAL','CASH_SOURCE_CONFLICT','INSUFFICIENT_CASH')})
        stay_errors.update({code:409 for code in ('CORRECTION_SOURCE_IN_USE','CORRECTION_HAS_NO_CHANGE','CORRECTION_PENDING','CORRECTION_TERMINAL','CORRECTION_SOURCE_CHANGED')})
        stay_errors.update({'INVALID_TRANSACTION_TIME':422,'PAYMENT_REFERENCE_USED':409,'GUEST_PROVIDER_UNAVAILABLE':503})
        stay_errors.update({'CHECKOUT_SOURCE_NOT_READY':409,'CHECKOUT_FINANCE_PENDING':409})
        stay_errors.update({'INVALID_GUEST_ACCESS':401,'GUEST_ACCESS_LIMIT':409,'AMENDMENT_PENDING':409})
        stay_errors.update({'INVALID_LIFECYCLE_TRANSITION':409,'LIFECYCLE_BLOCKED':409})
        stay_errors.update({'HANDOVER_PENDING':409,'RECOUNT_REQUIRED':409})
        stay_errors.update({'REFUND_APPROVAL_REQUIRED':409,'REFUND_RELEASE_NOT_PROVEN':409})
        stay_errors.update({'MINIBAR_REPORT_LOCKED':409,'MINIBAR_REPORT_REQUIRED':409,'RESTAURANT_ACK_REQUIRED':409})
        stay_errors.update({'PAYMENT_ALREADY_PAID':409,'PAYMENT_VOID_REQUIRES_CANCELLATION':409,'PHYSICAL_COUNT_REQUIRED':409})
        stay_errors['PUBLIC_ORIGIN_REQUIRED']=503
        stay_errors['INVALID_DEPOSIT_AMOUNT'] = 422
        catalog_errors = {'LOCATION_CODE_EXISTS':409,'DRAWER_ALREADY_USED':409,'DRAWER_NOT_CONFIGURED':409,
                          'CATEGORY_NAME_EXISTS':409,'ROOM_NUMBER_EXISTS':409,'CATEGORY_NOT_ACTIVE':409,'INVALID_MNT':422}
        status = {"PAYMENT_ALREADY_PENDING":409,"PROVISION_RETRY_BLOCKED":409,"ONBOARDING_UNAVAILABLE":503,"PROVIDER_EVIDENCE_INVALID":503,"PAYMENT_REQUIRED":409,"PHONE_PROOF_REQUIRED":409,"APPLICATION_ALREADY_PAID":409,
                  "PLATFORM_UNAVAILABLE":503,"MFA_REQUIRED":403,"INVALID_CREDENTIALS": 401, "UNAUTHENTICATED": 401, "RATE_LIMITED": 429,
                  "INVALID_PASSWORD": 422, "INVALID_EMAIL": 422, "INVALID_LINK": 400,
                  "INVALID_REASON": 422, "INVALID_REQUEST": 422, "EXCEPTION_NOT_FOUND": 404,
                  "INVALID_MEMBERSHIP_TRANSITION": 409, "EXCEPTION_ALREADY_CLAIMED": 409,
                  "TAKEOVER_ALREADY_PREPARED":409,"REPLACEMENT_HAS_OPEN_SHIFT":409,"STALE_CASH_COUNT":409,"PENDING_SHIFT_OBLIGATIONS":409,
                  "WORK_SOURCE_NOT_FOUND":404,"WORK_NOT_OPEN":409,"REMAINING_ACTION_EXCEEDED":409,"INSUFFICIENT_STOCK":409,
                  "EXCEPTION_NOT_CLAIMED": 409, "CLAIMANT_STILL_ELIGIBLE": 409,
                  "VERIFIED_ACCOUNT_REQUIRES_REACTIVATION": 409,
                  "RESTAURANT_LINK_EXISTS": 409,
                  "MEMBERSHIP_NOT_FOUND": 404, "MEMBERSHIP_EXISTS": 409, "MEMBERSHIP_NOT_PENDING": 409,
                  "REVISION_CONFLICT": 409, "IDEMPOTENCY_CONFLICT": 409, "LINK_SERVICE_UNAVAILABLE": 503,
                  "TOKEN_KEY_MISMATCH": 503, "CASH_BOOK_NOT_FOUND": 404, "UNSAFE_DATABASE_ROLE": 503}.get(code, 403)
        status = stay_errors.get(code,catalog_errors.get(code,status))
        headers = {"WWW-Authenticate": "Bearer"} if status == 401 else {}
        if status in {401, 403}:
            authorization = request.headers.get("Authorization", "").split(" ", 1)
            secret = authorization[1] if len(authorization) == 2 and authorization[0].lower() == "bearer" and 20 <= len(authorization[1]) <= 256 else None
            route = request.scope.get("route")
            try:
                if request.url.path.startswith("/platform/") and platform is not None:
                    await run_in_threadpool(platform.denial,secret,getattr(route,"path","UNKNOWN"),code)
                else:
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

    static_root = Path(__file__).with_name("static")

    @app.get('/hotels/{tenant_id}/operations')
    def operations_overview(tenant_id: str,secret: Annotated[str,Depends(token)],after: str=Query(default='',max_length=128),limit: int=Query(default=50,ge=1,le=100)):
        return operations.overview(secret,tenant_id,after,limit)

    @app.get('/hotels/{tenant_id}/stays/{stay_id}/guest')
    def reception_guest(tenant_id: str,stay_id: str,secret: Annotated[str,Depends(token)]):
        return operations.stay_detail(secret,tenant_id,stay_id)

    @app.get('/hotels/{tenant_id}/shifts/{shift_id}/report')
    def reception_shift_report(tenant_id: str,shift_id: str,secret: Annotated[str,Depends(token)]):
        return operations.shift_report(secret,tenant_id,shift_id)

    @app.post('/hotels/{tenant_id}/cash/drawers',status_code=201)
    def create_drawer(tenant_id: str,body: DrawerConfiguration,secret: Annotated[str,Depends(token)]):
        return openings.configure(secret,tenant_id,None,body.model_dump(exclude={'idempotency_key','expected_revision'}),body.idempotency_key,body.expected_revision)

    @app.post('/hotels/{tenant_id}/cash/drawers/{drawer_id}/configure')
    def configure_drawer(tenant_id: str,drawer_id: str,body: DrawerConfiguration,secret: Annotated[str,Depends(token)]):
        return openings.configure(secret,tenant_id,drawer_id,body.model_dump(exclude={'idempotency_key','expected_revision'}),body.idempotency_key,body.expected_revision)

    @app.post('/hotels/{tenant_id}/cash/drawers/{drawer_id}/open',status_code=201)
    def open_drawer(tenant_id: str,drawer_id: str,body: PhysicalOpening,secret: Annotated[str,Depends(token)]):
        return openings.open(secret,tenant_id,drawer_id,body.actual,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/cash/drawers/{drawer_id}/opening-review/{decision}')
    def review_opening(tenant_id: str,drawer_id: str,decision: Literal['approve','dispute'],body: MembershipChange,secret: Annotated[str,Depends(token)]):
        return openings.review_opening(secret,tenant_id,drawer_id,decision.upper(),body.idempotency_key,body.reason)

    @app.post('/hotels/{tenant_id}/rooms/{room_id}/cleaning-requests',status_code=201)
    def request_room_cleaning(tenant_id: str,room_id: str,body: RoomCleaningRequest,secret: Annotated[str,Depends(token)]):
        return readiness.request(secret,tenant_id,room_id,body.assignee_id,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/rooms/{room_id}/manager-clean')
    def manager_room_clean(tenant_id: str,room_id: str,body: InvitationChange,secret: Annotated[str,Depends(token)]):
        return readiness.manager_clean(secret,tenant_id,room_id,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/cleaning/tasks/{task_id}/start')
    def start_room_cleaning(tenant_id: str,task_id: str,body: InvitationChange,secret: Annotated[str,Depends(token)]):
        return readiness.start(secret,tenant_id,task_id,body.expected_revision,body.idempotency_key)

    @app.put('/hotels/{tenant_id}/deposit-settings')
    def hotel_deposit_settings(tenant_id: str,body: DepositSetting,secret: Annotated[str,Depends(token)]):
        return guest_finance.configure(secret,tenant_id,None,body.amount_mnt,body.expected_revision,body.idempotency_key)

    @app.put('/hotels/{tenant_id}/room-categories/{category_id}/deposit-settings')
    def category_deposit_settings(tenant_id: str,category_id: str,body: DepositSetting,secret: Annotated[str,Depends(token)]):
        return guest_finance.configure(secret,tenant_id,category_id,body.amount_mnt,body.expected_revision,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/room-categories/{category_id}/deposit-settings')
    def effective_deposit_settings(tenant_id: str,category_id: str,secret: Annotated[str,Depends(token)]):
        return guest_finance.read_setting(secret,tenant_id,category_id)

    @app.put('/hotels/{tenant_id}/mock/rooms/{room_id}/minibar')
    def configure_mock_minibar(tenant_id: str,room_id: str,body: MinibarFixture,secret: Annotated[str,Depends(token)]):
        return reception_dependencies.configure(secret,tenant_id,room_id,[x.model_dump() for x in body.items],body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/checkout/initiate')
    def initiate_checkout(tenant_id: str,stay_id: str,body: RestaurantLink,secret: Annotated[str,Depends(token)]):
        return reception_dependencies.begin(secret,tenant_id,stay_id,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/stays/{stay_id}/checkout/preview')
    def preview_checkout(tenant_id: str,stay_id: str,secret: Annotated[str,Depends(token)]):
        return reception_dependencies.preview(secret,tenant_id,stay_id)

    @app.post('/hotels/{tenant_id}/mock/stays/{stay_id}/minibar-report',status_code=201)
    def mock_minibar_report(tenant_id: str,stay_id: str,body: MinibarReportInput,secret: Annotated[str,Depends(token)]):
        return reception_dependencies.report(secret,tenant_id,stay_id,body.used,body.no_consumption,body.expected_revision,body.idempotency_key,body.exception_reason)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/minibar-review')
    def review_minibar(tenant_id: str,stay_id: str,body: MinibarReview,secret: Annotated[str,Depends(token)]):
        return reception_dependencies.review(secret,tenant_id,stay_id,body.action,body.reason,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/mock/stays/{stay_id}/restaurant-orders',status_code=201)
    def mock_restaurant_order(tenant_id: str,stay_id: str,body: RestaurantOrderFixture,secret: Annotated[str,Depends(token)]):
        return reception_dependencies.order(secret,tenant_id,stay_id,body.restaurant_name,body.contact_phone,body.state,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/financial-corrections',status_code=201)
    def request_financial_correction(tenant_id: str,stay_id: str,body: FinancialCorrectionInput,secret: Annotated[str,Depends(token)]):
        return guest_corrections.request(secret,tenant_id,stay_id,body.receipt_id,body.replacement_amount_mnt,body.reason,body.expected_revision,body.idempotency_key,body.replacement_channel,body.proof.model_dump() if body.proof else None)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/financial-corrections/{correction_id}/invoice')
    def financial_correction_invoice(tenant_id: str,stay_id: str,correction_id: str,body: EmptyInput,secret: Annotated[str,Depends(token)]):
        return guest_corrections.invoice(secret,tenant_id,stay_id,correction_id)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/financial-corrections/{correction_id}/decision')
    def decide_financial_correction(tenant_id: str,stay_id: str,correction_id: str,body: CashCorrectionDecision,secret: Annotated[str,Depends(token)]):
        return guest_corrections.decide(secret,tenant_id,stay_id,correction_id,body.approve,body.reason,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/refunds',status_code=201)
    def reserve_routed_refund(tenant_id: str,stay_id: str,body: RoutedRefundInput,secret: Annotated[str,Depends(token)]):
        return routed_refunds.reserve(secret,tenant_id,stay_id,body.receipt_id,body.amount_mnt,body.channel,body.recipient,body.reason,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/refunds/{refund_id}/approval')
    def approve_routed_refund(tenant_id: str,stay_id: str,refund_id: str,body: AmendmentDecision,secret: Annotated[str,Depends(token)]):
        return routed_refunds.approve(secret,tenant_id,stay_id,refund_id,body.approve,body.reason,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/refunds/{refund_id}/complete')
    def complete_routed_refund(tenant_id: str,stay_id: str,refund_id: str,body: ManualRoutedRefund,secret: Annotated[str,Depends(token)]):
        return routed_refunds.manual(secret,tenant_id,stay_id,refund_id,body.recipient_confirmation,body.reference,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/refunds/{refund_id}/release')
    def release_routed_refund(tenant_id: str,stay_id: str,refund_id: str,body: CashRefundRelease,secret: Annotated[str,Depends(token)]):
        return routed_refunds.release(secret,tenant_id,stay_id,refund_id,body.reason,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/refunds/{refund_id}/reconcile')
    def reconcile_routed_refund(tenant_id: str,stay_id: str,refund_id: str,body: EmptyInput,secret: Annotated[str,Depends(token)]):
        return routed_refunds.reconcile(secret,tenant_id,stay_id,refund_id)

    @app.post('/platform/hotels/{tenant_id}/refunds/{refund_id}/claim')
    def claim_late_refund(tenant_id: str,refund_id: str,body: RestaurantLink,secret: Annotated[str,Depends(token)]):
        return routed_refunds.claim_case(platform_service(),secret,tenant_id,refund_id,body.idempotency_key)

    @app.post('/platform/hotels/{tenant_id}/refunds/{refund_id}/resolve')
    def resolve_late_refund(tenant_id: str,refund_id: str,body: ReasonCommand,secret: Annotated[str,Depends(token)]):
        return routed_refunds.resolve_case(platform_service(),secret,tenant_id,refund_id,body.reason,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/payment-intents/{intent_id}/cancel')
    def cancel_guest_intent(tenant_id: str,stay_id: str,intent_id: str,body: MembershipChange,secret: Annotated[str,Depends(token)]):
        return guest_payments.cancel(secret,tenant_id,stay_id,intent_id,body.expected_revision,body.idempotency_key,body.reason)

    @app.post('/hotels/{tenant_id}/check-in-funding/{funding_id}/return')
    def return_funding(tenant_id: str,funding_id: str,body: ReasonCommand,secret: Annotated[str,Depends(token)]):
        return checkin_funding.request_return(secret,tenant_id,funding_id,body.idempotency_key,body.reason)

    @app.post('/hotels/{tenant_id}/check-in-funding/{funding_id}/return/complete')
    def finish_funding_return(tenant_id: str,funding_id: str,body: FundingReturnProof,secret: Annotated[str,Depends(token)]):
        return checkin_funding.finish_return(secret,tenant_id,funding_id,body.idempotency_key,body.reference,body.confirmation)

    @app.post('/hotels/{tenant_id}/check-in-funding/{funding_id}/cancel')
    def cancel_funding(tenant_id: str,funding_id: str,body: ReasonCommand,secret: Annotated[str,Depends(token)]):
        return checkin_funding.cancel(secret,tenant_id,funding_id,body.idempotency_key,body.reason)

    @app.post('/hotels/{tenant_id}/check-in-funding',status_code=201)
    def prepare_checkin_funding(tenant_id: str,body: CheckinFundingInput,secret: Annotated[str,Depends(token)]):
        return checkin_funding.create(secret,tenant_id,body.room_id,body.channel,body.idempotency_key,body.reference,body.terminal_id,body.transacted_at)

    @app.post('/hotels/{tenant_id}/check-in-funding/{funding_id}/reconcile')
    def reconcile_checkin_funding(tenant_id: str,funding_id: str,body: EmptyInput,secret: Annotated[str,Depends(token)]):
        return checkin_funding.reconcile(secret,tenant_id,funding_id)

    @app.post('/hotels/{tenant_id}/mock/bookings',status_code=201)
    def simulate_confirmed_booking(tenant_id: str,body: MockBookingInput,secret: Annotated[str,Depends(token)]):
        return stays.mock_booking(secret,tenant_id,body.room_id,body.kind,body.duration_units,body.planned_checkin_at,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/bookings')
    def list_bookings(tenant_id: str,secret: Annotated[str,Depends(token)],limit: int=Query(default=50,ge=1,le=100),after: str=Query(default='',max_length=128)):
        return stays.bookings(secret,tenant_id,limit,after)

    @app.post('/hotels/{tenant_id}/bookings/{booking_id}/check-in',status_code=201)
    def booking_check_in(tenant_id: str,booking_id: str,body: OnlineCheckIn,secret: Annotated[str,Depends(token)]):
        return stays.check_in_booking(secret,tenant_id,booking_id,body.model_dump(exclude={'idempotency_key'}),body.idempotency_key)

    @app.put('/hotels/{tenant_id}/shifts/policy')
    def configure_shift_policy(tenant_id: str,body: ShiftPolicy,secret: Annotated[str,Depends(token)]):
        return handovers.policy(secret,tenant_id,body.single_worker,body.expected_revision,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/handovers')
    def handover_inbox(tenant_id: str,secret: Annotated[str,Depends(token)]):
        return handovers.inbox(secret,tenant_id)

    @app.post('/hotels/{tenant_id}/handovers',status_code=201)
    def submit_handover(tenant_id: str,body: HandoverSubmit,secret: Annotated[str,Depends(token)]):
        return handovers.submit(secret,tenant_id,body.receiver_id,body.actual,body.idempotency_key,body.reason,self_close=body.self_close,custody=body.custody_id)

    @app.post('/hotels/{tenant_id}/handovers/{handover_id}/counts',status_code=201)
    def count_handover(tenant_id: str,handover_id: str,body: PhysicalOpening,secret: Annotated[str,Depends(token)]):
        return handovers.count_handover(secret,tenant_id,handover_id,body.actual,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/handovers/{handover_id}/decision')
    def decide_handover(tenant_id: str,handover_id: str,body: HandoverDecision,secret: Annotated[str,Depends(token)]):
        return handovers.decide(secret,tenant_id,handover_id,body.accept,body.count_id,body.reason,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/rooms/{room_id}/guest-qr/card')
    def room_qr_card(tenant_id: str,room_id: str,secret: Annotated[str,Depends(token)]):
        origin=os.environ.get('PRSYSTEM_PUBLIC_ORIGIN','http://127.0.0.1:8000' if runtime_mode!='production' else '')
        return guest_access.qr_card(secret,tenant_id,room_id,origin)

    @app.post('/guest/access')
    def redeem_guest_access(body: GuestRedeem):
        return guest_access.redeem(body.qr_token.get_secret_value(),body.code.get_secret_value())

    @app.post('/hotels/{tenant_id}/rooms/{room_id}/lifecycle')
    def change_room_lifecycle(tenant_id: str,room_id: str,body: RoomTransition,secret: Annotated[str,Depends(token)]):
        return room_lifecycle.change(secret,tenant_id,'room',room_id,body.action,body.expected_revision,body.reason,body.idempotency_key,body.category_id)

    @app.post('/hotels/{tenant_id}/room-categories/{category_id}/lifecycle')
    def change_category_lifecycle(tenant_id: str,category_id: str,body: RoomTransition,secret: Annotated[str,Depends(token)]):
        return room_lifecycle.change(secret,tenant_id,'category',category_id,body.action,body.expected_revision,body.reason,body.idempotency_key,body.category_id)

    @app.get('/guest/session')
    def guest_session(secret: Annotated[str,Depends(token)]):
        return guest_access.session(secret)

    @app.post('/hotels/{tenant_id}/rooms/{room_id}/guest-qr')
    def rotate_guest_qr(tenant_id: str,room_id: str,body: MembershipChange,secret: Annotated[str,Depends(token)]):
        return guest_access.qr(secret,tenant_id,room_id,body.expected_revision,body.idempotency_key,body.reason)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/guest-codes',status_code=201)
    def issue_guest_code(tenant_id: str,stay_id: str,body: RestaurantLink,secret: Annotated[str,Depends(token)]):
        return guest_access.codes(secret,tenant_id,stay_id,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/guest-access/revoke')
    def revoke_guest_access(tenant_id: str,stay_id: str,body: RestaurantLink,secret: Annotated[str,Depends(token)]):
        return guest_access.codes(secret,tenant_id,stay_id,body.idempotency_key,revoke=True)

    @app.get('/hotels/{tenant_id}/stays/{stay_id}/guest-sessions')
    def list_guest_devices(tenant_id: str,stay_id: str,secret: Annotated[str,Depends(token)]):
        return guest_access.devices(secret,tenant_id,stay_id)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/guest-sessions/{session_id}/revoke')
    def revoke_guest_device(tenant_id: str,stay_id: str,session_id: str,body: RestaurantLink,secret: Annotated[str,Depends(token)]):
        return guest_access.devices(secret,tenant_id,stay_id,session_id,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/stays/{stay_id}/time-amendments')
    def list_time_amendments(tenant_id: str,stay_id: str,secret: Annotated[str,Depends(token)]):
        return amendments.history(secret,tenant_id,stay_id)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/time-amendments',status_code=201)
    def request_time_amendment(tenant_id: str,stay_id: str,body: TimeAmendment,secret: Annotated[str,Depends(token)]):
        return amendments.request(secret,tenant_id,stay_id,body.actual_checkin_at,body.reason,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/time-amendments/{amendment_id}/decision')
    def decide_time_amendment(tenant_id: str,stay_id: str,amendment_id: str,body: AmendmentDecision,secret: Annotated[str,Depends(token)]):
        return amendments.decide(secret,tenant_id,stay_id,amendment_id,body.approve,body.reason,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/cleaning/checkouts')
    def checkout_cleaning_queue(tenant_id: str,secret: Annotated[str,Depends(token)],limit: int=Query(default=50,ge=1,le=100),after: str=Query(default='',max_length=128)):
        return checkout.cleaning_queue(secret,tenant_id,limit,after)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/checkout')
    def checkout_stay(tenant_id: str,stay_id: str,body: CheckoutInput,secret: Annotated[str,Depends(token)]):
        return checkout.close(secret,tenant_id,stay_id,body.expected_revision,body.idempotency_key,[x.model_dump() for x in body.restaurant_choices],body.guest_informed)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/checkout-cleaning/manager-complete')
    def manager_checkout_clean(tenant_id: str,stay_id: str,body: InvitationChange,secret: Annotated[str,Depends(token)]):
        return checkout.manager_clean(secret,tenant_id,stay_id,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/checkout-cleaning/claim',status_code=201)
    def claim_checkout_cleaning(tenant_id: str,stay_id: str,body: RestaurantLink,secret: Annotated[str,Depends(token)]):
        return checkout.claim_cleaning(secret,tenant_id,stay_id,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/stays/{stay_id}/finance')
    def guest_finance_statement(tenant_id: str,stay_id: str,secret: Annotated[str,Depends(token)]):
        return guest_finance.statement(secret,tenant_id,stay_id)

    @app.get('/hotels/{tenant_id}/stays/{stay_id}/finance/events')
    def guest_finance_events(tenant_id: str,stay_id: str,secret: Annotated[str,Depends(token)],after_revision: int=Query(default=0,ge=0),through_revision: int|None=Query(default=None,ge=0),limit: int=Query(default=50,ge=1,le=100)):
        return guest_finance.timeline(secret,tenant_id,stay_id,after_revision,through_revision,limit)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/cash-receipts',status_code=201)
    def guest_cash_receipt(tenant_id: str,stay_id: str,body: GuestCashReceipt,secret: Annotated[str,Depends(token)]):
        return guest_finance.receive(secret,tenant_id,stay_id,body.purpose,body.amount_mnt,body.charge_id,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/pos-payments',status_code=201)
    def guest_pos_payment(tenant_id: str,stay_id: str,body: ManualPosPayment,secret: Annotated[str,Depends(token)]):
        return guest_payments.pos(secret,tenant_id,stay_id,body.charge_id,body.amount_mnt,body.reference,body.terminal_id,body.transacted_at,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/payment-intents',status_code=201)
    def guest_payment_intent(tenant_id: str,stay_id: str,body: GuestPaymentIntent,secret: Annotated[str,Depends(token)]):
        return guest_payments.intent(secret,tenant_id,stay_id,body.charge_id,body.amount_mnt,body.provider,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/payment-intents/{intent_id}/reconcile')
    def guest_payment_reconcile(tenant_id: str,stay_id: str,intent_id: str,body: EmptyInput,secret: Annotated[str,Depends(token)]):
        return guest_payments.reconcile(secret,tenant_id,stay_id,intent_id)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/cash-corrections',status_code=201)
    def request_cash_correction(tenant_id: str,stay_id: str,body: CashCorrectionRequest,secret: Annotated[str,Depends(token)]):
        return guest_corrections.request(secret,tenant_id,stay_id,body.receipt_id,body.replacement_amount_mnt,body.reason,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/cash-corrections/{correction_id}/decision')
    def decide_cash_correction(tenant_id: str,stay_id: str,correction_id: str,body: CashCorrectionDecision,secret: Annotated[str,Depends(token)]):
        return guest_corrections.decide(secret,tenant_id,stay_id,correction_id,body.approve,body.reason,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/deposit-allocations',status_code=201)
    def guest_deposit_allocation(tenant_id: str,stay_id: str,body: DepositAllocation,secret: Annotated[str,Depends(token)]):
        return guest_finance.allocate(secret,tenant_id,stay_id,body.receipt_id,body.charge_id,body.amount_mnt,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/cash-refunds',status_code=201)
    def guest_cash_refund(tenant_id: str,stay_id: str,body: CashRefundRequest,secret: Annotated[str,Depends(token)]):
        return guest_finance.reserve_refund(secret,tenant_id,stay_id,body.receipt_id,body.amount_mnt,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/cash-refunds/{refund_id}/complete')
    def complete_guest_cash_refund(tenant_id: str,stay_id: str,refund_id: str,body: CashRefundComplete,secret: Annotated[str,Depends(token)]):
        return guest_finance.finish_refund(secret,tenant_id,stay_id,refund_id,body.expected_revision,body.idempotency_key,body.recipient_confirmation)

    @app.post('/hotels/{tenant_id}/stays/{stay_id}/cash-refunds/{refund_id}/release')
    def release_guest_cash_refund(tenant_id: str,stay_id: str,refund_id: str,body: CashRefundRelease,secret: Annotated[str,Depends(token)]):
        return guest_finance.finish_refund(secret,tenant_id,stay_id,refund_id,body.expected_revision,body.idempotency_key,body.reason,release=True)

    @app.post('/hotels/{tenant_id}/stays/check-in',status_code=201)
    def walk_in_check_in(tenant_id: str,body: WalkInCheckIn,secret: Annotated[str,Depends(token)]):
        return stays.check_in(secret,tenant_id,body.model_dump(exclude={'idempotency_key'}),body.idempotency_key)

    @app.get('/hotels/{tenant_id}/stays/active')
    def active_stays(tenant_id: str,secret: Annotated[str,Depends(token)],limit: Annotated[int,Query(ge=1,le=100)]=100,after: Annotated[str,Query(max_length=128)]=''):
        return stays.list_active(secret,tenant_id,limit,after)

    @app.put('/hotels/{tenant_id}/rooms/settings')
    def room_settings(tenant_id: str,body: HotelStaySettings,secret: Annotated[str,Depends(token)]):
        return rooms.hotel_settings(secret,tenant_id,body.hourly_price,body.nightly_price,body.checkout_time,body.expected_revision,body.idempotency_key)

    @app.post('/hotels/{tenant_id}/room-categories',status_code=201)
    def create_category(tenant_id: str,body: CategoryCreate,secret: Annotated[str,Depends(token)]):
        return rooms.create_category(secret,tenant_id,body.model_dump(exclude={'idempotency_key'}),body.idempotency_key)

    @app.post('/hotels/{tenant_id}/rooms',status_code=201)
    def create_room(tenant_id: str,body: RoomCreate,secret: Annotated[str,Depends(token)]):
        return rooms.create_room(secret,tenant_id,body.model_dump(exclude={'idempotency_key'}),body.idempotency_key)

    @app.put('/hotels/{tenant_id}/rooms/{room_id}/tariffs')
    def room_tariffs(tenant_id: str,room_id: str,body: TariffChange,secret: Annotated[str,Depends(token)]):
        return rooms.tariffs(secret,tenant_id,'room',room_id,body.hourly_price,body.nightly_price,body.expected_revision,body.idempotency_key)

    @app.put('/hotels/{tenant_id}/room-categories/{category_id}/tariffs')
    def category_tariffs(tenant_id: str,category_id: str,body: TariffChange,secret: Annotated[str,Depends(token)]):
        return rooms.tariffs(secret,tenant_id,'category',category_id,body.hourly_price,body.nightly_price,body.expected_revision,body.idempotency_key)

    @app.get('/hotels/{tenant_id}/rooms')
    def list_rooms(tenant_id: str,secret: Annotated[str,Depends(token)],limit: Annotated[int,Query(ge=1,le=100)]=100,after: Annotated[str,Query(max_length=128)]=''):
        return rooms.list_rooms(secret,tenant_id,limit,after)

    @app.get('/hotels/{tenant_id}/room-categories')
    def list_categories(tenant_id: str,secret: Annotated[str,Depends(token)],limit: Annotated[int,Query(ge=1,le=100)]=100,after: Annotated[str,Query(max_length=128)]=''):
        return rooms.list_categories(secret,tenant_id,limit,after)

    @app.get("/staff/activate", include_in_schema=False)
    @app.get("/staff/accept", include_in_schema=False)
    @app.get("/staff/reset", include_in_schema=False)
    @app.get("/staff/restaurant-accept", include_in_schema=False)
    def staff_page():
        return FileResponse(static_root / "staff.html", headers={
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "X-Frame-Options": "DENY",
        })

    @app.get("/guest/entry", include_in_schema=False)
    def guest_entry_page():
        return FileResponse(static_root / "guest.html", headers={
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "X-Frame-Options": "DENY",
        })

    @app.get("/reception", include_in_schema=False)
    def reception_page():
        return FileResponse(static_root / "reception.html", headers={
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "X-Frame-Options": "DENY",
        })

    @app.get("/staff/assets/{asset}", include_in_schema=False)
    def staff_asset(asset: Literal["staff.css", "staff.js", "reception.css", "reception.js"]):
        return FileResponse(static_root / asset)

    @app.post("/hotels/{tenant_id}/staff-work/exceptions/{exception_id}/cleaning/reassign")
    def cleaning_reassign(tenant_id: str, exception_id: str, body: WorkReplacement, secret: Annotated[str, Depends(token)]):
        return cleaning.reassign(secret,tenant_id,exception_id,body.expected_revision,body.replacement_id,body.idempotency_key,body.reason)

    @app.post("/hotels/{tenant_id}/cleaning/tasks/{task_id}/post")
    def cleaning_post(tenant_id: str, task_id: str, body: CleaningPost, secret: Annotated[str, Depends(token)]):
        return cleaning.post(secret,tenant_id,task_id,body.expected_revision,body.action_id,body.quantity,body.idempotency_key,body.actual_count)

    @app.post("/hotels/{tenant_id}/staff-work/exceptions/{exception_id}/takeover")
    def takeover_prepare(tenant_id: str,exception_id: str,body: WorkReplacement,secret: Annotated[str,Depends(token)]):
        return shifts.prepare(secret,tenant_id,exception_id,body.expected_revision,body.replacement_id,body.idempotency_key,body.reason)

    @app.post("/hotels/{tenant_id}/takeovers/{takeover_id}/count")
    def takeover_count(tenant_id: str,takeover_id: str,body: CashCount,secret: Annotated[str,Depends(token)]):
        return shifts.count(secret,tenant_id,takeover_id,body.actual,body.idempotency_key)

    @app.post("/hotels/{tenant_id}/takeovers/{takeover_id}/close")
    def takeover_close(tenant_id: str,takeover_id: str,body: TakeoverClose,secret: Annotated[str,Depends(token)]):
        return shifts.close(secret,tenant_id,takeover_id,body.count_id,body.idempotency_key)

    @app.post("/hotels/{tenant_id}/takeovers/{takeover_id}/payments/{obligation_id}/reconcile",status_code=202)
    def takeover_reconcile(tenant_id: str,takeover_id: str,obligation_id: str,body: RestaurantLink,secret: Annotated[str,Depends(token)]):
        return shifts.reconcile(secret,tenant_id,takeover_id,obligation_id,body.idempotency_key)

    @app.post("/hotels/{tenant_id}/takeovers/{takeover_id}/transfers/{transfer_id}/{action}")
    def takeover_transfer(tenant_id: str,takeover_id: str,transfer_id: str,action: Literal["receive","return"],body: CashCount,secret: Annotated[str,Depends(token)]):
        return shifts.transfer(secret,tenant_id,takeover_id,transfer_id,action.upper(),body.actual,body.idempotency_key)

    @app.post("/hotels/{tenant_id}/cash/transfers/{transfer_id}/cancel-request")
    def transfer_cancel_request(tenant_id: str,transfer_id: str,body: MembershipChange,secret: Annotated[str,Depends(token)]):
        return shifts.cancel_request(secret,tenant_id,transfer_id,body.idempotency_key,body.reason)

    @app.post("/hotels/{tenant_id}/shifts/{shift_id}/review/{decision}")
    def shift_review(tenant_id: str,shift_id: str,decision: Literal["approve","dispute"],body: MembershipChange,secret: Annotated[str,Depends(token)]):
        return shifts.review(secret,tenant_id,shift_id,decision.upper(),body.idempotency_key,body.reason)

    @app.post("/platform/auth/login")
    def platform_login(body: PlatformLogin,request: Request):
        return platform_service().login(body.email,body.password.get_secret_value(),body.code.get_secret_value(),peer(request))

    @app.post("/platform/auth/step-up")
    def platform_mfa(body: PlatformMFA,request: Request,secret: Annotated[str,Depends(token)]):
        return platform_service().step_up(secret,body.code.get_secret_value(),peer(request))

    @app.post("/platform/hotels/{tenant_id}/security/{action}")
    def platform_security(tenant_id: str,action: Literal["suspend","resume"],body: SecurityRecovery,secret: Annotated[str,Depends(token)]):
        return platform_service().hotel_security(secret,tenant_id,action=="suspend",body.idempotency_key,body.reason,body.reference)

    @app.post("/onboarding/applications",status_code=201)
    def onboarding_create(body: OnboardingApplication,request: Request):
        return onboarding.create(body.model_dump(exclude_none=True),peer(request))

    @app.post("/onboarding/{application_id}/phone/request",status_code=202)
    def onboarding_phone_request(application_id: str,request: Request,secret: Annotated[str,Depends(token)]):
        return onboarding.request_phone(application_id,secret,peer(request))

    @app.post("/onboarding/{application_id}/phone/verify")
    def onboarding_phone_verify(application_id: str,body: OnboardingOTP,request: Request,secret: Annotated[str,Depends(token)]):
        return onboarding.verify_phone(application_id,secret,body.code.get_secret_value(),peer(request))

    @app.post("/onboarding/{application_id}/account-proof")
    def onboarding_proof(application_id: str,body: AccountProof,secret: Annotated[str,Depends(token)]):
        return onboarding.prove_account(application_id,secret,body.staff_token.get_secret_value())

    @app.post("/onboarding/{application_id}/invoice/{provider}")
    def onboarding_invoice(application_id: str,provider: Literal["QPAY","KHAAN"],secret: Annotated[str,Depends(token)]):
        return onboarding.invoice(application_id,secret,provider)

    @app.post("/auth/admin/activate")
    def admin_activation(body: LinkPassword,request: Request):
        return onboarding.accept(body.token.get_secret_value(),body.password.get_secret_value(),peer(request))

    @app.post("/platform/onboarding/{application_id}/retry",status_code=202)
    def onboarding_retry(application_id: str,body: SecurityRecovery,secret: Annotated[str,Depends(token)]):
        return onboarding.manual_retry(platform_service(),secret,application_id,body.idempotency_key,body.reason,body.reference)

    @app.post("/onboarding/{application_id}/owner/request",status_code=202)
    def onboarding_owner_request(application_id: str,request: Request,secret: Annotated[str,Depends(token)]):
        return onboarding.request_owner(application_id,secret,peer(request))

    @app.post("/onboarding/{application_id}/owner/verify")
    def onboarding_owner_verify(application_id: str,body: OnboardingOTP,request: Request,secret: Annotated[str,Depends(token)]):
        return onboarding.verify_owner(application_id,secret,body.code.get_secret_value(),peer(request))

    @app.post("/hotels/{tenant_id}/subscription/renewals",status_code=202)
    def renewal_invoice(tenant_id: str,body: RenewalRequest,secret: Annotated[str,Depends(token)]):
        return renewals.invoice(secret,tenant_id,body.package_mnt,body.months,body.provider,body.idempotency_key)

    @app.get("/hotels/{tenant_id}/subscription/renewals/{renewal_id}")
    def renewal_status(tenant_id: str,renewal_id: str,secret: Annotated[str,Depends(token)]):
        return renewals.status(secret,tenant_id,renewal_id)

    @app.get("/onboarding/{application_id}")
    def onboarding_status(application_id: str,secret: Annotated[str,Depends(token)]):
        return onboarding.status(application_id,secret)

    @app.post("/hotels/{tenant_id}/takeovers/{takeover_id}/recover-replacement")
    def takeover_replacement_recover(tenant_id: str,takeover_id: str,body: WorkReplacement,secret: Annotated[str,Depends(token)]):
        return shifts.recover_replacement(secret,tenant_id,takeover_id,body.replacement_id,body.expected_revision,body.idempotency_key,body.reason)

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
