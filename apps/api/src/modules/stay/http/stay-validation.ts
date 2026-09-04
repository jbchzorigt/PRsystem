import { ApiError } from '@prsystem/contracts';
import type { LocalDate } from '@prsystem/time';
import { requireString, requireUuid } from '../../iam/http/validation';
import type { GuestIdentityInput } from '../domain/identity';
import { IDENTITY_TYPES } from '../domain/identity';
import type { StayType } from '../domain/timing';

/**
 * Request validation for the stay routes. Shape only: every rule that needs
 * the server's time, the room's state or the history lives in the services.
 */

function fail(field: string, issue: string): never {
  throw new ApiError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
}

export function requireStayType(value: unknown): StayType {
  if (value === 'HOURLY' || value === 'NIGHTLY') return value;
  return fail('stayType', 'must be HOURLY or NIGHTLY');
}

export function requirePositiveInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    return fail(field, `must be an integer between 1 and ${String(max)}`);
  }
  return value;
}

export function optionalPositiveInteger(
  value: unknown,
  field: string,
  max: number,
): number | undefined {
  return value === undefined || value === null
    ? undefined
    : requirePositiveInteger(value, field, max);
}

export function requireInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string') return fail(field, 'must be an ISO-8601 timestamp');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fail(field, 'must be an ISO-8601 timestamp');
  return parsed;
}

export function optionalInstant(value: unknown, field: string): Date | undefined {
  return value === undefined || value === null ? undefined : requireInstant(value, field);
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function requireLocalDate(value: unknown, field: string): LocalDate {
  if (typeof value !== 'string' || !LOCAL_DATE.test(value))
    return fail(field, 'must be YYYY-MM-DD');
  const probe = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== value) {
    return fail(field, 'must be a real calendar date');
  }
  return value as LocalDate;
}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, max);
}

export function requireSource(value: unknown): 'WALK_IN' | 'ONLINE' {
  if (value === undefined) return 'WALK_IN';
  if (value === 'WALK_IN' || value === 'ONLINE') return value;
  return fail('source', 'must be WALK_IN or ONLINE');
}

export function requireCountry(value: unknown, field: string): string {
  const text = requireString(value, field, 2).toUpperCase();
  if (!/^[A-Z]{2}$/u.test(text)) return fail(field, 'must be an ISO 3166-1 alpha-2 code');
  return text;
}

/** doc 02 §3.1: the primary guest's identity form, by type. */
export function requireGuest(value: unknown): GuestIdentityInput {
  if (typeof value !== 'object' || value === null) return fail('guest', 'must be an object');
  const guest = value as Record<string, unknown>;
  const identityType = guest['identityType'];
  if (
    typeof identityType !== 'string' ||
    !(IDENTITY_TYPES as readonly string[]).includes(identityType)
  ) {
    return fail('guest.identityType', `must be one of ${IDENTITY_TYPES.join(', ')}`);
  }
  const guardianRaw = guest['guardian'];
  const guardian =
    guardianRaw === undefined || guardianRaw === null
      ? undefined
      : (() => {
          if (typeof guardianRaw !== 'object') return fail('guest.guardian', 'must be an object');
          const g = guardianRaw as Record<string, unknown>;
          return {
            name: requireString(g['name'], 'guest.guardian.name', 120),
            phone: requireString(g['phone'], 'guest.guardian.phone', 30),
            relationship: requireString(g['relationship'], 'guest.guardian.relationship', 60),
          };
        })();
  const common = {
    familyName: requireString(guest['familyName'], 'guest.familyName', 120),
    givenName: requireString(guest['givenName'], 'guest.givenName', 120),
    dateOfBirth: requireLocalDate(guest['dateOfBirth'], 'guest.dateOfBirth'),
    nationality: requireCountry(guest['nationality'], 'guest.nationality'),
    ...(guardian === undefined ? {} : { guardian }),
  };
  switch (identityType) {
    case 'MN_REG_NO':
      return {
        ...common,
        identityType,
        registrationNumber: requireString(
          guest['registrationNumber'],
          'guest.registrationNumber',
          20,
        ),
      };
    case 'FOREIGN_PASSPORT':
      return {
        ...common,
        identityType,
        passportNumber: requireString(guest['passportNumber'], 'guest.passportNumber', 40),
        issuingCountry: requireCountry(guest['issuingCountry'], 'guest.issuingCountry'),
        expiresOn: requireLocalDate(guest['expiresOn'], 'guest.expiresOn'),
      };
    case 'OTHER_GOV_ID':
      return {
        ...common,
        identityType,
        documentNumber: requireString(guest['documentNumber'], 'guest.documentNumber', 40),
        documentType: requireString(guest['documentType'], 'guest.documentType', 60),
        issuingCountry: requireCountry(guest['issuingCountry'], 'guest.issuingCountry'),
        issuingAuthority: requireString(guest['issuingAuthority'], 'guest.issuingAuthority', 120),
      };
    default: {
      const note = optionalString(guest['note'], 'guest.note', 500);
      return {
        ...common,
        identityType: 'NO_DOCUMENT',
        reason: requireString(guest['reason'], 'guest.reason', 300),
        ...(note === undefined ? {} : { note }),
      };
    }
  }
}

export function requireCleaningTarget(value: unknown): 'CLEAN' | 'CLEANING' {
  if (value === 'CLEAN' || value === 'CLEANING') return value;
  return fail('toState', 'must be CLEAN or CLEANING');
}

export { requireUuid };

/** doc 04 §5.2: what the Cleaner counted, per product of the price book. */
export function requireCountedLines(
  value: unknown,
  field: string,
): readonly { readonly productId: string; readonly quantity: number }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail(field, 'must be an array');
  if (value.length > 200) return fail(field, 'must not exceed 200 lines');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      return fail(`${field}[${String(index)}]`, 'must be an object');
    }
    const line = entry as Record<string, unknown>;
    const quantity = line['quantity'];
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
      return fail(`${field}[${String(index)}].quantity`, 'must be a whole number of units');
    }
    return {
      productId: requireUuid(line['productId'], `${field}[${String(index)}].productId`),
      quantity,
    };
  });
}

/** doc 21 §7: the decision on a disputed line. */
export function requireDisputeDecision(value: unknown): 'UPHELD' | 'WAIVED' {
  if (value === 'UPHELD' || value === 'WAIVED') return value;
  return fail('decision', 'must be UPHELD or WAIVED');
}

/** `CHK-DEC-005`: the kinds of correction a settled charge admits. */
export function requireAdjustmentKind(
  value: unknown,
): 'OVERCHARGE_REVERSAL' | 'UNDERCHARGE_RECEIVABLE' | 'DISPUTE_WAIVER' {
  if (
    value === 'OVERCHARGE_REVERSAL' ||
    value === 'UNDERCHARGE_RECEIVABLE' ||
    value === 'DISPUTE_WAIVER'
  ) {
    return value;
  }
  return fail('kind', 'must be OVERCHARGE_REVERSAL, UNDERCHARGE_RECEIVABLE or DISPUTE_WAIVER');
}

/** An amount in whole MNT, never a float (CLAUDE.md §5). */
export function optionalAmountMnt(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1)
      return fail(field, 'must be a whole positive amount');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,17}$/u.test(value)) {
    return fail(field, 'must be a whole positive amount in MNT');
  }
  return BigInt(value);
}
