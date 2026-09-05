export { HMAC_SCOPES, KEY_SCOPES, KeyManagementError } from './key-management.port';
export type {
  HmacScope,
  KeyManagementPort,
  KeyScope,
  KeyedMac,
  WrappedKey,
} from './key-management.port';
export { LocalKeyManagement, UnavailableKeyManagement } from './local-key-management';
export type { LocalKeyManagementOptions } from './local-key-management';
export { decryptValue, encryptValue, rewrapValue } from './envelope';
export type { EnvelopeAad, EnvelopeCiphertext } from './envelope';
export { deriveLookupToken } from './lookup-token';
export type { IdentityNamespace, LookupToken } from './lookup-token';
export { selectKeyManagement } from './select-key-management';
export type { KeyManagementSelection, KmsAdapter } from './select-key-management';

// The port contract of docs/architecture/16-external-port-catalog.md §1.
export { fail, isNonProductionEnv, isRetryable, ok } from './port';
export type { Port, PortContext, PortError, PortMode, PortResult } from './port';

// EXT-03 / EXT-04.
export {
  PAYMENT_GATE_BY_PROVIDER,
  PAYMENT_PROVIDERS,
  PaymentGatewayRegistry,
  SimulatedPaymentGateway,
  UnavailablePaymentGateway,
  isPaymentProvider,
  selectPaymentGateways,
} from './payment-gateway.port';
export type {
  CreateInvoiceCommand,
  CreatedInvoice,
  InvoiceState,
  InvoiceStatus,
  PaymentCommand,
  PaymentGatewayPort,
  PaymentGateways,
  PaymentProvider,
  PaymentResponse,
  RawCallback,
  RefundCommand,
  RefundResult,
  SimulatedInvoice,
  VerifiedCallback,
} from './payment-gateway.port';

// EXT-11.
export { SimulatedEBarimt, UnavailableEBarimt, selectEBarimt } from './ebarimt.port';
export type {
  EBarimtCommand,
  EBarimtIssueCommand,
  EBarimtPort,
  EBarimtResponse,
  IssuedReceipt,
  ReceiptStatus,
} from './ebarimt.port';

// EXT-01.
export {
  SimulatedXypIdentity,
  UnavailableXypIdentity,
  selectXypIdentity,
} from './identity-verification.port';
export type {
  XypAnswer,
  XypCitizen,
  XypIdentityPort,
  XypLookup,
} from './identity-verification.port';

// EXT-02.
export {
  SimulatedEMongoliaAuth,
  UnavailableEMongoliaAuth,
  selectEMongoliaAuth,
} from './emongolia-auth.port';
export type {
  EMongoliaAuthPort,
  EMongoliaAuthorization,
  EMongoliaBeginCommand,
  EMongoliaCommand,
  EMongoliaCompleteCommand,
  EMongoliaIdentity,
  EMongoliaMinimalClaims,
  EMongoliaResult,
} from './emongolia-auth.port';

// EXT-06.
export { SimulatedGeo, UnavailableGeo, greatCircleMetres, isGeoPoint, selectGeo } from './geo.port';
export type {
  GeoAddress,
  GeoAnswer,
  GeoCommand,
  GeoDistance,
  GeoPoint,
  GeoPort,
  GeocodeAnswer,
} from './geo.port';

// INT-OTP-01.
export {
  SimulatedPhoneVerification,
  UnavailablePhoneVerification,
  selectPhoneVerification,
} from './phone-verification.port';
export type { OtpDelivery, OtpMessage, PhoneVerificationPort } from './phone-verification.port';

// INT-MAIL-01.
export {
  SimulatedNotification,
  SimulatedStaffNotification,
  StaffNotificationUnavailableError,
  UnavailableNotification,
  UnavailableStaffNotification,
  selectNotification,
  selectStaffNotification,
} from './notification.port';
export type {
  EBarimtReceiptMessage,
  NotificationDelivery,
  NotificationMessage,
  NotificationPort,
  OwnerChallengeMessage,
  PasswordResetMessage,
  StaffInvitationMessage,
  StaffNotification,
  StaffNotificationPort,
} from './notification.port';
