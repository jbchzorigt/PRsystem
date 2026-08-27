import { randomUUID, randomBytes } from 'node:crypto';
import type { StableId } from './api';

/**
 * Stable identifiers.
 *
 * UUIDv7: time-ordered, so primary-key inserts stay local in the index and rows
 * sort by creation without a separate sequence, while still carrying no guessable
 * structure and no tenancy. A sequential integer would leak volume and allow
 * enumeration across tenants.
 */
export function newStableId(at: Date = new Date()): StableId {
  const millis = BigInt(at.getTime());
  const bytes = randomBytes(16);

  // 48-bit big-endian timestamp.
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((millis >> BigInt(8 * (5 - index))) & 0xffn);
  }
  // Version 7, RFC 9562 variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Correlation identifies one logical unit of work end to end; causation names the
 * message that caused this one. Together they reconstruct a chain across API,
 * outbox, worker and audit without any of them carrying business data.
 */
export function newCorrelationId(): string {
  return randomUUID();
}

export function isStableId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
