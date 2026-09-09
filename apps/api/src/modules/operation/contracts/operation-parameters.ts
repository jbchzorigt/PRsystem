/**
 * The Operation realm's timings, in one place.
 *
 * Three of them are stated by an approved document and are not configurable in
 * any meaningful sense — they are here so a test can read the same number the
 * service applies, not so a deployment can move them. The rest are recorded
 * assumptions, and each says which.
 */
export interface OperationParameters {
  /** architecture 05 §2: an Operation session idles out after 30 minutes. */
  readonly sessionIdleSeconds: number;
  /** architecture 05 §2: and ends absolutely after 8 hours. */
  readonly sessionAbsoluteSeconds: number;
  /**
   * `A-P19-2`: how long a new Operation account's enrolment link lives.
   *
   * doc 14 §2 does not state one. Phase 05's Hotel Admin activation link lives
   * seven days and is the nearest approved precedent, so this matches it rather
   * than inventing a second convention.
   */
  readonly enrolmentTtlSeconds: number;
  /** doc 14 §2.3: a contact code lives five minutes. */
  readonly contactCodeTtlSeconds: number;
  /** doc 14 §2.3: and may be re-sent once a minute. */
  readonly contactCodeResendSeconds: number;
  /**
   * `A-P19-7`: how long an SMS preview stays confirmable.
   *
   * doc 14 §5.4 requires a fresh preview whenever the text or the recipients
   * move, and says nothing about elapsed time. Fifteen minutes bounds the
   * window in which a filter could have drifted without anybody noticing; the
   * hash comparison, not this, is what actually enforces the rule.
   */
  readonly previewTtlSeconds: number;
  /** The page size the subscription list and the queues default to. */
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
}

export const OPERATION_PARAMETERS: OperationParameters = {
  sessionIdleSeconds: 30 * 60,
  sessionAbsoluteSeconds: 8 * 60 * 60,
  enrolmentTtlSeconds: 7 * 24 * 60 * 60,
  contactCodeTtlSeconds: 300,
  contactCodeResendSeconds: 60,
  previewTtlSeconds: 15 * 60,
  defaultPageSize: 25,
  maxPageSize: 100,
};
