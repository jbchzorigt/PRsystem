/**
 * eBarimt receipting (doc 16 §4.1, `SUB-DEC-005`, `SUB-DEC-008`).
 *
 * The canonical EXT-11 contract lives in `@prsystem/ports`; this is the
 * module's contracts surface for it.
 */
export { SimulatedEBarimt, UnavailableEBarimt, selectEBarimt } from '@prsystem/ports';
export type {
  EBarimtIssueCommand,
  EBarimtPort,
  IssuedReceipt,
  ReceiptStatus,
} from '@prsystem/ports';
