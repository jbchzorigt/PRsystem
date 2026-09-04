import type { LocalDate } from '@prsystem/time';

/**
 * The primary guest's identity (doc 02 §3.1, doc 12 §6, doc 13 §8.2;
 * `RC-DEC-044`).
 *
 * Four identity types, one set of common fields, a server-derived age, and
 * the one rule Police matching depends on: only a structurally valid,
 * normalized Mongolian registration number is eligible for exact matching.
 */

export const IDENTITY_TYPES = [
  'MN_REG_NO',
  'FOREIGN_PASSPORT',
  'OTHER_GOV_ID',
  'NO_DOCUMENT',
] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export type Provenance = 'XYP_VERIFIED' | 'MANUAL';
export type Assurance = 'DOCUMENT' | 'LOW_ASSURANCE';
export type PoliceEligibility = 'ELIGIBLE_EXACT_RD' | 'NOT_ELIGIBLE_EXACT_RD';

export const ADULT_AGE = 18;

/**
 * A Mongolian registration number: two Cyrillic letters and eight digits,
 * `LL YYMMDD NN`, where a month of 21–32 marks a birth in the 2000s. Spaces
 * and case are not identity; the normalized form is what is tokenized.
 */
const REGISTRATION_NUMBER = /^[А-ЯЁӨҮ]{2}\d{8}$/u;

export function normalizeRegistrationNumber(raw: string): string {
  return raw.replace(/\s+/gu, '').toUpperCase();
}

/** The date of birth a structurally valid number encodes, or `undefined` when it is not valid. */
export function registrationBirthDate(normalized: string): LocalDate | undefined {
  if (!REGISTRATION_NUMBER.test(normalized)) return undefined;
  const yy = Number(normalized.slice(2, 4));
  const mm = Number(normalized.slice(4, 6));
  const dd = Number(normalized.slice(6, 8));
  const century = mm > 20 ? 2000 : 1900;
  const month = mm > 20 ? mm - 20 : mm;
  if (month < 1 || month > 12) return undefined;
  const year = century + yy;
  const probe = new Date(Date.UTC(year, month - 1, dd));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== dd
  ) {
    return undefined;
  }
  return probe.toISOString().slice(0, 10) as LocalDate;
}

export function isStructurallyValidRegistrationNumber(normalized: string): boolean {
  return registrationBirthDate(normalized) !== undefined;
}

/** doc 12 §6: whole years completed on the hotel-local date of the effective check-in. */
export function ageAt(dateOfBirth: LocalDate, onDate: LocalDate): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [oy, om, od] = onDate.split('-').map(Number) as [number, number, number];
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

export function policeEligibility(
  identityType: IdentityType,
  structurallyValid: boolean,
): PoliceEligibility {
  return identityType === 'MN_REG_NO' && structurallyValid
    ? 'ELIGIBLE_EXACT_RD'
    : 'NOT_ELIGIBLE_EXACT_RD';
}

export interface GuardianInput {
  readonly name: string;
  readonly phone: string;
  readonly relationship: string;
}

interface CommonIdentityInput {
  readonly familyName: string;
  readonly givenName: string;
  /** Required for every type; for `MN_REG_NO` it must agree with the number. */
  readonly dateOfBirth: LocalDate;
  /** ISO 3166-1 alpha-2. */
  readonly nationality: string;
  readonly guardian?: GuardianInput;
}

export type GuestIdentityInput = CommonIdentityInput &
  (
    | { readonly identityType: 'MN_REG_NO'; readonly registrationNumber: string }
    | {
        readonly identityType: 'FOREIGN_PASSPORT';
        readonly passportNumber: string;
        readonly issuingCountry: string;
        readonly expiresOn: LocalDate;
      }
    | {
        readonly identityType: 'OTHER_GOV_ID';
        readonly documentNumber: string;
        readonly documentType: string;
        readonly issuingCountry: string;
        readonly issuingAuthority: string;
      }
    | { readonly identityType: 'NO_DOCUMENT'; readonly reason: string; readonly note?: string }
  );

export type IdentityRefusalCode =
  | 'REGISTRATION_NUMBER_INVALID'
  | 'DATE_OF_BIRTH_MISMATCH'
  | 'DOCUMENT_EXPIRED'
  | 'GUARDIAN_REQUIRED'
  | 'NATIONALITY_INVALID'
  | 'COUNTRY_INVALID';

export interface IdentityRefusal {
  readonly code: IdentityRefusalCode;
  readonly field: string;
}

const COUNTRY = /^[A-Z]{2}$/u;

/**
 * Every rule doc 02 §3.1 states about the identity form, evaluated together so
 * the Reception sees all of them at once. The age is computed here from the
 * date of birth the caller has established (XYP's or the form's).
 */
export function identityRefusals(
  input: GuestIdentityInput,
  checkInDate: LocalDate,
): readonly IdentityRefusal[] {
  const refusals: IdentityRefusal[] = [];
  if (!COUNTRY.test(input.nationality))
    refusals.push({ code: 'NATIONALITY_INVALID', field: 'nationality' });
  if (input.identityType === 'MN_REG_NO') {
    const normalized = normalizeRegistrationNumber(input.registrationNumber);
    const encoded = registrationBirthDate(normalized);
    if (encoded === undefined) {
      refusals.push({ code: 'REGISTRATION_NUMBER_INVALID', field: 'registrationNumber' });
    } else if (encoded !== input.dateOfBirth) {
      refusals.push({ code: 'DATE_OF_BIRTH_MISMATCH', field: 'dateOfBirth' });
    }
  }
  if (input.identityType === 'FOREIGN_PASSPORT') {
    if (!COUNTRY.test(input.issuingCountry))
      refusals.push({ code: 'COUNTRY_INVALID', field: 'issuingCountry' });
    if (input.expiresOn < checkInDate)
      refusals.push({ code: 'DOCUMENT_EXPIRED', field: 'expiresOn' });
  }
  if (input.identityType === 'OTHER_GOV_ID' && !COUNTRY.test(input.issuingCountry)) {
    refusals.push({ code: 'COUNTRY_INVALID', field: 'issuingCountry' });
  }
  if (ageAt(input.dateOfBirth, checkInDate) < ADULT_AGE && input.guardian === undefined) {
    refusals.push({ code: 'GUARDIAN_REQUIRED', field: 'guardian' });
  }
  return refusals;
}

/** The identifier the record encrypts and tokenizes, and its lookup namespace. */
export function identifierOf(input: GuestIdentityInput):
  | {
      readonly value: string;
      readonly identityType: 'registration_number' | 'passport' | 'foreign_id';
      readonly countryCode: string;
    }
  | undefined {
  switch (input.identityType) {
    case 'MN_REG_NO':
      return {
        value: normalizeRegistrationNumber(input.registrationNumber),
        identityType: 'registration_number',
        countryCode: 'MN',
      };
    case 'FOREIGN_PASSPORT':
      return {
        value: input.passportNumber.replace(/\s+/gu, '').toUpperCase(),
        identityType: 'passport',
        countryCode: input.issuingCountry,
      };
    case 'OTHER_GOV_ID':
      return {
        value: input.documentNumber.replace(/\s+/gu, '').toUpperCase(),
        identityType: 'foreign_id',
        countryCode: input.issuingCountry,
      };
    case 'NO_DOCUMENT':
      return undefined;
  }
}
