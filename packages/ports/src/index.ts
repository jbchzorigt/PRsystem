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

// EXT-07.
export {
  SimulatedHotelPayout,
  UnavailableHotelPayout,
  selectHotelPayout,
} from './hotel-payout.port';
export type {
  HotelPayoutPort,
  PayoutCommand,
  PayoutInstruction,
  PayoutResult,
} from './hotel-payout.port';

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
export { SimulatedSms, UnavailableSms, selectSms } from './sms.port';
export type { SmsDelivery, SmsMessage, SmsPort, SmsRecipient, SmsStatus } from './sms.port';
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
  OperationEnrolmentMessage,
  SubscriptionContactChangedMessage,
  PasswordResetMessage,
  StaffInvitationMessage,
  StaffNotification,
  StaffNotificationPort,
} from './notification.port';

export {
  SimulatedObjectStorage,
  UnavailableObjectStorage,
  selectObjectStorage,
} from './object-storage.port';
export type {
  ObjectStorageCommand,
  ObjectStoragePort,
  ObjectStorageResult,
  PutObjectInput,
  SignedUrl,
  SignedUrlInput,
  StoredObject,
} from './object-storage.port';

// Phase 20 — the gate register as code, and the adapter selection it governs.
export {
  ADAPTER_SLOTS,
  EXTERNAL_GATE_IDS,
  GATE_IDS,
  GATE_REGISTER,
  INTERNAL_GATE_IDS,
  describeGates,
  gateForSlot,
  isAdapterSlot,
  isGateCleared,
  isGateId,
} from './gates';
export type {
  AdapterSlot,
  ExternalGateId,
  GateEntry,
  GateId,
  GateStatus,
  InternalGateId,
} from './gates';
export {
  AdapterSelectionError,
  PRODUCTION_ADAPTERS,
  S3_OUTBOUND_TIMEOUT_MS,
  defaultAdapterModes,
  selectAdapters,
} from './adapters/select-adapters';
export type {
  AdapterDescription,
  AdapterMode,
  AdapterSelection,
  AdapterSelectionReason,
  S3StorageConfig,
  SelectedAdapters,
} from './adapters/select-adapters';
export { REDACTED_SECRET, Secret } from './adapters/secret';
export { constantTimeEqual, hmacSha256, sha256Hex } from './adapters/signing';
export { ipInCidr, isAllowedSource, parseCidr, parseCidrList } from './adapters/ip-allowlist';
export type { Cidr } from './adapters/ip-allowlist';
export {
  FetchOutboundHttp,
  TokenBucket,
  classifyStatus,
  expectStatus,
} from './adapters/outbound-http';
export type {
  FetchOutboundHttpOptions,
  OutboundHttp,
  OutboundRequest,
  OutboundResponse,
  RateLimit,
} from './adapters/outbound-http';
export { S3ObjectStorage } from './adapters/s3/s3-object-storage';
export type { S3ObjectStorageConfig } from './adapters/s3/s3-object-storage';
export {
  EMPTY_PAYLOAD_HASH,
  UNSIGNED_PAYLOAD,
  canonicalRequest,
  presignUrl,
  signHeaders,
  uriEncode,
} from './adapters/s3/sigv4';
export type { SigV4Credentials, SigV4Request } from './adapters/s3/sigv4';
