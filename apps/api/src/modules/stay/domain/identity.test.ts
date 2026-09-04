import { describe, expect, it } from 'vitest';
import type { LocalDate } from '@prsystem/time';
import {
  ageAt,
  identifierOf,
  identityRefusals,
  isStructurallyValidRegistrationNumber,
  normalizeRegistrationNumber,
  policeEligibility,
  registrationBirthDate,
} from './identity';

const d = (value: string): LocalDate => value as LocalDate;

describe('RC-DEC-044 — a Mongolian registration number is normalized and structurally checked', () => {
  it('normalizes case and spaces, and reads the encoded birth date', () => {
    expect(normalizeRegistrationNumber(' аа 90010112 ')).toBe('АА90010112');
    expect(registrationBirthDate('АА90010112')).toBe('1990-01-01');
    // A month of 21–32 is a birth in the 2000s.
    expect(registrationBirthDate('ЧБ01210512')).toBe('2001-01-05');
    expect(isStructurallyValidRegistrationNumber('АА90010112')).toBe(true);
  });

  it('refuses a wrong shape, an impossible month or day', () => {
    expect(isStructurallyValidRegistrationNumber('AA90010112')).toBe(false); // Latin letters
    expect(isStructurallyValidRegistrationNumber('АА9001011')).toBe(false);
    expect(isStructurallyValidRegistrationNumber('АА90130112')).toBe(false); // month 13
    expect(isStructurallyValidRegistrationNumber('АА90023012')).toBe(false); // 30 February
    expect(isStructurallyValidRegistrationNumber('АА90330112')).toBe(false); // month 33
  });

  it('only a valid registration number is eligible for exact matching (doc 13 §8.2)', () => {
    expect(policeEligibility('MN_REG_NO', true)).toBe('ELIGIBLE_EXACT_RD');
    expect(policeEligibility('MN_REG_NO', false)).toBe('NOT_ELIGIBLE_EXACT_RD');
    expect(policeEligibility('FOREIGN_PASSPORT', true)).toBe('NOT_ELIGIBLE_EXACT_RD');
    expect(policeEligibility('NO_DOCUMENT', true)).toBe('NOT_ELIGIBLE_EXACT_RD');
  });
});

describe('doc 12 §6 — the age is whole years on the check-in date', () => {
  it('turns on the birthday, not the day before', () => {
    expect(ageAt(d('2008-08-15'), d('2026-08-14'))).toBe(17);
    expect(ageAt(d('2008-08-14'), d('2026-08-14'))).toBe(18);
    expect(ageAt(d('1990-01-01'), d('2026-08-14'))).toBe(36);
  });
});

describe('doc 02 §3.1 — every failing rule of the form is named', () => {
  const adult = {
    familyName: 'Синтетик',
    givenName: 'Зочин',
    dateOfBirth: d('1990-01-01'),
    nationality: 'MN',
  };

  it('a minor needs a guardian; a passport must not be expired; countries are alpha-2', () => {
    expect(
      identityRefusals(
        { ...adult, identityType: 'MN_REG_NO', registrationNumber: 'АА90010112' },
        d('2026-08-14'),
      ),
    ).toEqual([]);
    expect(
      identityRefusals(
        {
          ...adult,
          dateOfBirth: d('2010-05-05'),
          identityType: 'MN_REG_NO',
          registrationNumber: 'АА10250512',
        },
        d('2026-08-14'),
      ).map((r) => r.code),
    ).toEqual(['GUARDIAN_REQUIRED']);
    expect(
      identityRefusals(
        {
          ...adult,
          identityType: 'FOREIGN_PASSPORT',
          passportNumber: 'P1234567',
          issuingCountry: 'DE',
          expiresOn: d('2026-01-01'),
        },
        d('2026-08-14'),
      ).map((r) => r.code),
    ).toEqual(['DOCUMENT_EXPIRED']);
    expect(
      identityRefusals(
        {
          ...adult,
          nationality: 'MNG',
          identityType: 'OTHER_GOV_ID',
          documentNumber: 'X',
          documentType: 'ID',
          issuingCountry: 'Germany',
          issuingAuthority: 'Bonn',
        },
        d('2026-08-14'),
      ).map((r) => r.code),
    ).toEqual(['NATIONALITY_INVALID', 'COUNTRY_INVALID']);
  });

  it('a registration number that disagrees with the stated date of birth is refused', () => {
    expect(
      identityRefusals(
        {
          ...adult,
          dateOfBirth: d('1991-01-01'),
          identityType: 'MN_REG_NO',
          registrationNumber: 'АА90010112',
        },
        d('2026-08-14'),
      ).map((r) => r.code),
    ).toEqual(['DATE_OF_BIRTH_MISMATCH']);
    expect(
      identityRefusals(
        { ...adult, identityType: 'MN_REG_NO', registrationNumber: 'АА90130112' },
        d('2026-08-14'),
      ).map((r) => r.code),
    ).toEqual(['REGISTRATION_NUMBER_INVALID']);
  });

  it('the identifier and its namespace follow the type; no document has none', () => {
    expect(
      identifierOf({ ...adult, identityType: 'MN_REG_NO', registrationNumber: 'аа 90010112' }),
    ).toEqual({
      value: 'АА90010112',
      identityType: 'registration_number',
      countryCode: 'MN',
    });
    expect(
      identifierOf({
        ...adult,
        identityType: 'FOREIGN_PASSPORT',
        passportNumber: 'p 123',
        issuingCountry: 'DE',
        expiresOn: d('2030-01-01'),
      }),
    ).toEqual({ value: 'P123', identityType: 'passport', countryCode: 'DE' });
    expect(identifierOf({ ...adult, identityType: 'NO_DOCUMENT', reason: 'lost' })).toBeUndefined();
  });
});
