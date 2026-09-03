/**
 * Phone one-time-password delivery (doc 15 §2.1, `INT-OTP-01`).
 *
 * The canonical contract lives in `@prsystem/ports`, where Phase 12 will take
 * it for Guest registration; this is the module's contracts surface for it.
 */
export {
  SimulatedPhoneVerification,
  UnavailablePhoneVerification,
  selectPhoneVerification,
} from '@prsystem/ports';
export type { OtpDelivery, OtpMessage, PhoneVerificationPort } from '@prsystem/ports';
