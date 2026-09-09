import { describe, expect, it } from 'vitest';
import {
  ADAPTER_SLOTS,
  AdapterSelectionError,
  GATE_IDS,
  GATE_REGISTER,
  PRODUCTION_ADAPTERS,
  Secret,
  defaultAdapterModes,
  gateForSlot,
  isGateCleared,
  selectAdapters,
} from '../index';
import type { AdapterSlot, PortContext, PortResult, SelectedAdapters } from '../index';

/**
 * SEC-ADAPTERS — the external adapters fail closed (Phase 20; CLAUDE.md §9).
 *
 * Three facts, each measured rather than asserted:
 *
 *  1. In production, every slot left at its default answers `DISABLED` with
 *     the gate that governs it, on every operation, and reaches no network —
 *     `fetch` is replaced with a tripwire for the duration and never fires.
 *  2. A production deployment cannot name a simulator, and cannot name a
 *     production adapter while its gate is uncleared; both refuse startup with
 *     the slot and the gate, and construct nothing.
 *  3. A credential handed to the selector is a `Secret`: no refusal, no
 *     description and no serialisation carries its value.
 */

const ctx: PortContext = { correlationId: 'sec-adapters' };
const CANARY = 'sec-adapters-canary-credential';

function err<T>(result: PortResult<T>): { kind: string; gate?: string } {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result.error;
}

async function withNetworkTripwire<T>(run: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('a disabled adapter reached the network');
  }) as typeof fetch;
  try {
    return { value: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Every operation of every port, so a new method cannot escape the rule. */
async function everyOperation(
  adapters: SelectedAdapters,
): Promise<
  readonly { slot: AdapterSlot; operation: string; error: { kind: string; gate?: string } }[]
> {
  const out: { slot: AdapterSlot; operation: string; error: { kind: string; gate?: string } }[] =
    [];
  const push = (slot: AdapterSlot, operation: string, result: PortResult<unknown>): void => {
    out.push({ slot, operation, error: err(result) });
  };
  for (const provider of ['QPAY', 'KHAAN'] as const) {
    const slot: AdapterSlot = provider === 'QPAY' ? 'payment.qpay' : 'payment.khaan';
    const gateway = adapters.payments.gateway(provider);
    const invoice = {
      intentId: 'i',
      amountMnt: 1n,
      currency: 'MNT' as const,
      merchantRef: 'm',
      expiresAt: new Date(),
      idempotencyKey: 'k',
    };
    push(slot, 'createInvoice', await gateway.createInvoice(invoice, ctx));
    push(slot, 'queryStatus', await gateway.queryStatus({ providerInvoiceId: 'x' }, ctx));
    push(
      slot,
      'refund',
      await gateway.refund(
        { providerPaymentId: 'p', amountMnt: 1n, reason: 'r', idempotencyKey: 'k' },
        ctx,
      ),
    );
    push(
      slot,
      'verifyCallback',
      await gateway.verifyCallback({ provider, providerInvoiceId: 'x' }, ctx),
    );
    push(slot, 'execute', await gateway.execute({ kind: 'createInvoice', input: invoice }, ctx));
  }
  const issue = {
    paymentId: 'p',
    totalMnt: 1n,
    vatBreakdown: { vatMnt: 0n, vatRateBp: 0 },
    buyer: { ownerRef: 'o', ownerType: 'CITIZEN' as const },
    idempotencyKey: 'k',
  };
  push('ebarimt', 'issue', await adapters.ebarimt.issue(issue, ctx));
  push('ebarimt', 'queryStatus', await adapters.ebarimt.queryStatus({ receiptId: 'r' }, ctx));
  push('ebarimt', 'cancel', await adapters.ebarimt.cancel({ receiptId: 'r', reason: 'x' }, ctx));
  push(
    'xyp',
    'lookupByRegistrationNumber',
    await adapters.xyp.lookupByRegistrationNumber(
      { registrationNumber: 'АА00000001', requestRef: 'r' },
      ctx,
    ),
  );
  push(
    'emongolia',
    'begin',
    await adapters.emongolia.begin({ redirectUri: 'https://app.invalid/', state: 's' }, ctx),
  );
  push(
    'emongolia',
    'complete',
    await adapters.emongolia.complete(
      { code: 'c', state: 's', redirectUri: 'https://app.invalid/' },
      ctx,
    ),
  );
  push('sms', 'send', await adapters.sms.send({ jobId: 'j', recipients: [], body: 'x' }, ctx));
  push('sms', 'queryStatus', await adapters.sms.queryStatus('m', ctx));
  push('sms', 'verifyCallback', await adapters.sms.verifyCallback({}, ctx));
  push('geo', 'geocode', await adapters.geo.geocode('x', ctx));
  push(
    'geo',
    'reverseGeocode',
    await adapters.geo.reverseGeocode({ latitudeMicro: 0, longitudeMicro: 0 }, ctx),
  );
  push(
    'payout',
    'transfer',
    await adapters.payouts.transfer(
      { batchRef: 'b', hotelId: 'h', amountMnt: 1n, currency: 'MNT', idempotencyKey: 'k' },
      ctx,
    ),
  );
  push(
    'email',
    'send',
    await adapters.notifications.send(
      {
        kind: 'staff_invitation',
        hotelId: 'h',
        invitationId: 'i',
        emailNormalized: 'x@example.test',
        expiresAt: new Date(),
        token: 't',
      },
      ctx,
    ),
  );
  push(
    'otp',
    'send',
    await adapters.otp.send(
      {
        subjectRef: 's',
        phone: '+97699000000',
        expiresAt: new Date(),
        deliveryId: 'd',
        code: '000000',
      },
      ctx,
    ),
  );
  push(
    'storage',
    'put',
    await adapters.storage.put({ key: 'k', body: new Uint8Array(1), contentType: 'x' }, ctx),
  );
  push(
    'storage',
    'signedUrl',
    await adapters.storage.signedUrl({ key: 'k', expiresInSeconds: 300 }, ctx),
  );
  push('storage', 'remove', await adapters.storage.remove('k', ctx));
  return out;
}

describe('SEC-ADAPTERS: the production defaults', () => {
  it('answer DISABLED with the governing gate on every operation, and reach no network', async () => {
    const { value: outcomes, calls } = await withNetworkTripwire(async () =>
      everyOperation(
        selectAdapters({ appEnv: 'production', slots: defaultAdapterModes('production') }),
      ),
    );
    expect(calls).toBe(0);
    expect(outcomes.length).toBeGreaterThanOrEqual(24);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        slot: outcome.slot,
        operation: outcome.operation,
        error: { kind: 'DISABLED', gate: gateForSlot(outcome.slot) },
      });
    }
    // Every slot was exercised; a slot with no operation here is a slot the gate does not cover.
    expect(new Set(outcomes.map((one) => one.slot))).toEqual(new Set(ADAPTER_SLOTS));
  });

  it('are governed by gates that are all still BLOCKED at this phase', () => {
    for (const gate of GATE_IDS) {
      expect({ gate, cleared: isGateCleared(gate) }).toEqual({ gate, cleared: false });
      expect(GATE_REGISTER[gate].status.cleared).toBe(false);
    }
  });
});

describe('SEC-ADAPTERS: a production deployment cannot be talked into an adapter', () => {
  it('refuses every slot set to the simulator, naming the slot and its gate', () => {
    for (const slot of ADAPTER_SLOTS) {
      let caught: unknown;
      try {
        selectAdapters({
          appEnv: 'production',
          slots: { ...defaultAdapterModes('production'), [slot]: 'simulator' },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdapterSelectionError);
      expect(caught).toMatchObject({
        slot,
        reason: 'simulator_not_permitted',
        gate: gateForSlot(slot),
      });
    }
  });

  it('refuses every existing production adapter while its gate is uncleared, and constructs nothing', async () => {
    const { calls } = await withNetworkTripwire(async () => {
      for (const slot of ADAPTER_SLOTS) {
        for (const adapter of PRODUCTION_ADAPTERS[slot]) {
          let caught: unknown;
          try {
            selectAdapters({
              appEnv: 'production',
              slots: { ...defaultAdapterModes('production'), [slot]: adapter },
              storage: {
                endpoint: 'http://127.0.0.1:1',
                region: 'us-east-1',
                bucket: 'prsystem-local',
                accessKeyId: 'k',
                secretAccessKey: new Secret(CANARY),
              },
            });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(AdapterSelectionError);
          expect(caught).toMatchObject({
            slot,
            reason: 'gate_not_cleared',
            gate: gateForSlot(slot),
          });
          expect(String(caught)).not.toContain(CANARY);
          expect(JSON.stringify(caught)).not.toContain(CANARY);
        }
      }
    });
    expect(calls).toBe(0);
    // Non-vacuous: at least one production adapter exists to be refused.
    expect(Object.values(PRODUCTION_ADAPTERS).flat().length).toBeGreaterThan(0);
  });

  it('refuses a named adapter nobody has written, for every contract-bound slot', () => {
    for (const slot of ADAPTER_SLOTS) {
      if (PRODUCTION_ADAPTERS[slot].length > 0) continue;
      let caught: unknown;
      try {
        selectAdapters({
          appEnv: 'production',
          slots: { ...defaultAdapterModes('production'), [slot]: 'production' },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ slot, reason: 'unknown_adapter', gate: gateForSlot(slot) });
    }
  });
});

describe('SEC-ADAPTERS: the credential', () => {
  it('appears in no description and no serialisation of a selection that carries it', () => {
    const selected = selectAdapters({
      appEnv: 'ci',
      slots: { ...defaultAdapterModes('ci'), storage: 's3' },
      storage: {
        endpoint: 'http://127.0.0.1:1',
        region: 'us-east-1',
        bucket: 'prsystem-local',
        accessKeyId: 'k',
        secretAccessKey: new Secret(CANARY),
      },
    });
    const surfaces = [
      JSON.stringify(selected.describe()),
      JSON.stringify(selected.storage),
      String(selected.storage),
      JSON.stringify(new Secret(CANARY)),
      String(new Secret(CANARY)),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(CANARY);
  });
});
