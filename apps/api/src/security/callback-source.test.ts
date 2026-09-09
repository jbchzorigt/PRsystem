import { describe, expect, it } from 'vitest';
import { parseCidrList } from '@prsystem/ports';
import { ApiError } from '@prsystem/contracts';
import {
  CallbackSourceGuard,
  callbackSourcePolicy,
  refuseAllCallbackSources,
} from './callback-source';

/**
 * The callback source policy and the guard that applies it (Phase 20).
 */

const QPAY = parseCidrList('203.0.113.0/24')!;

function context(provider: string, ip: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params: { provider }, ip }) }),
  } as unknown as Parameters<CallbackSourceGuard['canActivate']>[0];
}

describe('callbackSourcePolicy', () => {
  it('refuses every source above test when no list is configured', () => {
    for (const appEnv of ['staging', 'production']) {
      const policy = callbackSourcePolicy(appEnv, {});
      expect(policy.permits('QPAY', '203.0.113.5')).toBe(false);
      expect(policy.permits('KHAAN', '127.0.0.1')).toBe(false);
    }
  });

  it('allows every source below staging when no list is configured, and enforces one when it is', () => {
    for (const appEnv of ['local', 'ci', 'test']) {
      expect(callbackSourcePolicy(appEnv, {}).permits('QPAY', '127.0.0.1')).toBe(true);
      const configured = callbackSourcePolicy(appEnv, { QPAY });
      expect(configured.permits('QPAY', '203.0.113.5')).toBe(true);
      expect(configured.permits('QPAY', '127.0.0.1')).toBe(false);
      // The other provider has no list and stays permissive below staging.
      expect(configured.permits('KHAAN', '127.0.0.1')).toBe(true);
    }
  });

  it('enforces a configured list in production, per provider', () => {
    const policy = callbackSourcePolicy('production', { QPAY });
    expect(policy.permits('QPAY', '203.0.113.200')).toBe(true);
    expect(policy.permits('QPAY', '::ffff:203.0.113.200')).toBe(true);
    expect(policy.permits('QPAY', '198.51.100.1')).toBe(false);
    expect(policy.permits('KHAAN', '203.0.113.200')).toBe(false);
    expect(policy.describe()).toEqual([
      { provider: 'QPAY', configured: true, ranges: 1 },
      { provider: 'KHAAN', configured: false, ranges: 0 },
    ]);
  });
});

describe('CallbackSourceGuard', () => {
  it('answers an opaque NOT_FOUND for a source the policy does not permit', () => {
    const guard = new CallbackSourceGuard(callbackSourcePolicy('production', { QPAY }));
    expect(guard.canActivate(context('qpay', '203.0.113.7'))).toBe(true);
    let caught: unknown;
    try {
      guard.canActivate(context('qpay', '198.51.100.7'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('NOT_FOUND');
  });

  it('leaves an unknown provider to the controller, and refuses everything under the default policy', () => {
    const refusing = new CallbackSourceGuard(refuseAllCallbackSources());
    expect(refusing.canActivate(context('paypal', '127.0.0.1'))).toBe(true);
    expect(() => refusing.canActivate(context('khaan', '127.0.0.1'))).toThrow(ApiError);
  });
});
