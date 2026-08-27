/**
 * The canonical error envelope and its stable code vocabulary.
 *
 * Codes are part of the API contract: a client may branch on them, so they are
 * added but never renamed or repurposed. Messages are for humans and may change.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  // Cross-tenant denial is deliberately indistinguishable from not-found
  // (08-trust-boundaries): NOT_FOUND is returned rather than FORBIDDEN so a
  // probe cannot confirm that another tenant's resource exists.
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENT_REQUEST_IN_PROGRESS',
  'PRECONDITION_FAILED',
  'REVISION_MISMATCH',
  'RATE_LIMITED',
  'TENANT_SCOPE_MISSING',
  'EXTERNAL_GATE_CLOSED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every non-2xx response has exactly this shape. */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    /**
     * Field-level detail only. Never a stack trace, a query, a connection
     * string, a provider payload or any value from CLAUDE.md §8.
     */
    readonly details?: readonly { readonly field: string; readonly issue: string }[];
    readonly correlationId: string;
  };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENT_REQUEST_IN_PROGRESS: 409,
  PRECONDITION_FAILED: 412,
  REVISION_MISMATCH: 409,
  RATE_LIMITED: 429,
  TENANT_SCOPE_MISSING: 403,
  EXTERNAL_GATE_CLOSED: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export function httpStatusForErrorCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** The one error type the API layer translates into the envelope. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly { readonly field: string; readonly issue: string }[],
  ) {
    super(message);
  }

  get status(): number {
    return httpStatusForErrorCode(this.code);
  }
}

export function errorEnvelope(error: ApiError, correlationId: string): ApiErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      correlationId,
    },
  };
}
