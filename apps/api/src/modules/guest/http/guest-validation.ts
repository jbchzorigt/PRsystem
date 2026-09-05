import { ApiError } from '@prsystem/contracts';
import type { FastifyRequest } from 'fastify';
import type { VerificationPurpose } from '../domain/guest';
import { isVerificationPurpose } from '../domain/guest';

/**
 * What the Guest endpoints accept.
 *
 * The rules that matter here are the ones about what is *not* accepted: a
 * caller never names the number a link code is sent to, never supplies a
 * distance, and never supplies an account id — those come from the account or
 * from the server. Anything a body could use to steer a decision it should not
 * steer is rejected rather than ignored, so a client that sends one is told.
 */

export function requirePurpose(value: unknown): VerificationPurpose {
  if (typeof value !== 'string' || !isVerificationPurpose(value)) {
    throw new ApiError('VALIDATION_FAILED', 'purpose must be a known verification purpose');
  }
  // A caller may ask for the three purposes that begin a flow. `ACCOUNT_LINK`
  // is not among them: its code goes to the number an account already holds,
  // and is requested through the link request rather than by naming a number
  // (doc 09 §6.3).
  if (value === 'ACCOUNT_LINK') {
    throw new ApiError('VALIDATION_FAILED', 'a link code is requested through the link request');
  }
  return value;
}

/** The digits as typed. Normalized in the domain, never trusted from here. */
export function requirePhone(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 24) {
    throw new ApiError('VALIDATION_FAILED', 'phone must be a phone number');
  }
  return value.trim();
}

export function requireCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4,10}$/.test(value)) {
    throw new ApiError('VALIDATION_FAILED', 'code must be the digits that were sent');
  }
  return value;
}

/**
 * The password, unbounded in content and bounded in length.
 *
 * The policy itself lives in the IAM module, so a guest's password meets the
 * same rule a staff password does and there is one place to change it.
 */
export function requirePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new ApiError('VALIDATION_FAILED', 'password must be a password');
  }
  return value;
}

/**
 * The provider's return address.
 *
 * Absolute, `https`, and no fragment or credentials — a redirect target is the
 * one field of this flow an attacker would most like to choose, and the code
 * the provider returns travels to it.
 */
export function requireRedirectUri(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) {
    throw new ApiError('VALIDATION_FAILED', 'redirectUri must be a URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'redirectUri must be a URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.hash !== '') {
    throw new ApiError('VALIDATION_FAILED', 'redirectUri must be an https URL without credentials');
  }
  return parsed.toString();
}

export function requireOpaque(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ApiError('VALIDATION_FAILED', `${field} must be a short opaque string`);
  }
  return value;
}

export function optionalPhone(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : requirePhone(value);
}

/**
 * The caller's address, for rate limiting only.
 *
 * Read from the connection rather than from a header a caller controls, and
 * reduced to a digest before it is stored.
 */
export function callerIp(request: FastifyRequest): string | undefined {
  return request.ip === '' ? undefined : request.ip;
}
