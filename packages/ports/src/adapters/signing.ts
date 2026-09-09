import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature primitives shared by every production adapter.
 *
 * These are the building blocks a provider's scheme is assembled from — never
 * a scheme themselves. Which fields a provider signs, in what order and under
 * which key is part of its contract, and no contract is approved (CLAUDE.md
 * §9); the S3 adapter is the one exception, because AWS Signature Version 4 is
 * a published standard rather than a vendor's private rule.
 */

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Uint8Array | string, data: Uint8Array | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Equal in constant time, or not equal. Two strings of different length are
 * unequal without comparing their bytes, which reveals nothing a length header
 * would not.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
