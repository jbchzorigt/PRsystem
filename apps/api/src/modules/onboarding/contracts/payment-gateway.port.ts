/**
 * The subscription payment gateway (doc 16 `SUB-DEC-004`, doc 15 §4).
 *
 * The canonical contract lives in `@prsystem/ports` — EXT-03 / EXT-04 are shared
 * with Phases 10, 14 and 15 — and is re-exported here as this module's contracts
 * surface, so nothing inside the module reaches into another package's shape.
 */
export {
  PAYMENT_GATE_BY_PROVIDER,
  PAYMENT_PROVIDERS,
  PaymentGatewayRegistry,
  SimulatedPaymentGateway,
  UnavailablePaymentGateway,
  isPaymentProvider,
  selectPaymentGateways,
} from '@prsystem/ports';
export type {
  CreateInvoiceCommand,
  CreatedInvoice,
  InvoiceStatus,
  PaymentGatewayPort,
  PaymentGateways,
  PaymentProvider,
  RawCallback,
  VerifiedCallback,
} from '@prsystem/ports';
