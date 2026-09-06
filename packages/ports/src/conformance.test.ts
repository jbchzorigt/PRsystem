import { describe, expect, it } from 'vitest';
import {
  SimulatedEBarimt,
  SimulatedEMongoliaAuth,
  SimulatedGeo,
  SimulatedNotification,
  SimulatedPaymentGateway,
  SimulatedPhoneVerification,
  SimulatedXypIdentity,
  UnavailableEBarimt,
  UnavailableEMongoliaAuth,
  UnavailableGeo,
  UnavailableNotification,
  UnavailablePaymentGateway,
  UnavailablePhoneVerification,
  UnavailableXypIdentity,
  selectEBarimt,
  selectEMongoliaAuth,
  selectGeo,
  selectNotification,
  selectPaymentGateways,
  selectPhoneVerification,
  selectXypIdentity,
  SimulatedHotelPayout,
  UnavailableHotelPayout,
  selectHotelPayout,
} from './index';
import { greatCircleMetres } from './index';
import type { PortContext, PortResult } from './index';

/**
 * The simulator conformance suite of docs/architecture/16-external-port-catalog.md §3.
 *
 * Every port ships a simulator that passes these eight scenarios, and every
 * adapter whose gate is uncleared answers `DISABLED` without a network call.
 * The suite is what "port and simulator shipped" means for EXT-03, EXT-04 and
 * EXT-11 — a port without it is a type, not a contract.
 */

const ctx: PortContext = { correlationId: 'conformance' };

function ok<T>(result: PortResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function err<T>(result: PortResult<T>): { kind: string } & Record<string, unknown> {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.error;
}

describe.each([['QPAY'], ['KHAAN']] as const)('PaymentGatewayPort — %s simulator', (provider) => {
  const invoiceCommand = (idempotencyKey: string) => ({
    intentId: `intent-${idempotencyKey}`,
    amountMnt: 240_000n,
    currency: 'MNT' as const,
    merchantRef: `merchant-${idempotencyKey}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    idempotencyKey,
  });

  it('exposes its identity and mode', () => {
    const port = new SimulatedPaymentGateway(provider);
    expect(port.id).toBe(provider.toLowerCase());
    expect(port.provider).toBe(provider);
    expect(port.mode).toBe('simulator');
  });

  it('1 — a duplicate callback carries the same provider event id', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const invoice = ok(await port.createInvoice(invoiceCommand('dup'), ctx));
    port.pay(invoice.providerInvoiceId, new Date(), 'pay-1');
    const callback = {
      provider,
      providerInvoiceId: invoice.providerInvoiceId,
      providerPaymentId: 'pay-1',
      signature: port.signatureFor(invoice.providerInvoiceId),
    };
    const first = ok(await port.verifyCallback(callback, ctx));
    const second = ok(await port.verifyCallback(callback, ctx));
    expect(second.providerEventId).toBe(first.providerEventId);
  });

  it('2 — out-of-order callbacks: the provider status is what is authoritative', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const invoice = ok(await port.createInvoice(invoiceCommand('order'), ctx));
    port.pay(invoice.providerInvoiceId, new Date('2026-08-21T07:00:00Z'), 'pay-2');
    // A stale "pending" notification arrives after the payment.
    const stale = ok(
      await port.verifyCallback(
        {
          provider,
          providerInvoiceId: invoice.providerInvoiceId,
          status: 'PENDING',
          signature: port.signatureFor(invoice.providerInvoiceId),
        },
        ctx,
      ),
    );
    expect(stale.payload.providerInvoiceId).toBe(invoice.providerInvoiceId);
    const status = ok(
      await port.queryStatus({ providerInvoiceId: invoice.providerInvoiceId }, ctx),
    );
    expect(status.state).toBe('PAID');
    expect(status.providerPaymentId).toBe('pay-2');
  });

  it('3 — a late success after expiry is reported, never hidden', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const invoice = ok(await port.createInvoice(invoiceCommand('late'), ctx));
    port.settle(invoice.providerInvoiceId, { state: 'EXPIRED' });
    expect(
      ok(await port.queryStatus({ providerInvoiceId: invoice.providerInvoiceId }, ctx)).state,
    ).toBe('EXPIRED');
    port.pay(invoice.providerInvoiceId, new Date(), 'pay-late');
    const status = ok(
      await port.queryStatus({ providerInvoiceId: invoice.providerInvoiceId }, ctx),
    );
    expect(status.state).toBe('PAID');
    expect(status.paidAt).toBeInstanceOf(Date);
  });

  it('4 — an unknown reference is rejected on both surfaces', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const verify = err(
      await port.verifyCallback(
        { provider, providerInvoiceId: 'nope', signature: port.signatureFor('nope') },
        ctx,
      ),
    );
    expect(verify).toEqual({ kind: 'REJECTED', providerCode: 'UNKNOWN_REFERENCE' });
    expect(err(await port.queryStatus({ providerInvoiceId: 'nope' }, ctx)).kind).toBe('REJECTED');
  });

  it('5, 6 — an amount or currency the callback claims that the invoice does not carry is a MISMATCH', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const invoice = ok(await port.createInvoice(invoiceCommand('mismatch'), ctx));
    const base = {
      provider,
      providerInvoiceId: invoice.providerInvoiceId,
      signature: port.signatureFor(invoice.providerInvoiceId),
    };
    expect(err(await port.verifyCallback({ ...base, amountMnt: '1' }, ctx))).toEqual({
      kind: 'MISMATCH',
      field: 'amount',
    });
    expect(err(await port.verifyCallback({ ...base, currency: 'USD' }, ctx))).toEqual({
      kind: 'MISMATCH',
      field: 'currency',
    });
    expect(err(await port.verifyCallback({ ...base, merchantRef: 'other' }, ctx))).toEqual({
      kind: 'MISMATCH',
      field: 'merchant',
    });
  });

  it('7 — an invalid signature is refused before anything is looked up', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const invoice = ok(await port.createInvoice(invoiceCommand('sig'), ctx));
    const lookupsBefore = port.lookups;
    expect(
      err(
        await port.verifyCallback(
          { provider, providerInvoiceId: invoice.providerInvoiceId, signature: 'forged' },
          ctx,
        ),
      ),
    ).toEqual({ kind: 'INVALID_SIGNATURE' });
    expect(port.lookups).toBe(lookupsBefore);
  });

  it('8 — a timeout then a retry with the same idempotency key yields one invoice', async () => {
    const port = new SimulatedPaymentGateway(provider);
    port.loseNextAcknowledgement();
    const lost = err(await port.createInvoice(invoiceCommand('timeout'), ctx));
    expect(lost).toEqual({ kind: 'TIMEOUT', retryable: true });
    expect(port.invoiceCount).toBe(1);
    const recovered = ok(await port.createInvoice(invoiceCommand('timeout'), ctx));
    expect(port.invoiceCount).toBe(1);
    expect(port.invoice(recovered.providerInvoiceId)?.idempotencyKey).toBe('timeout');
    // A different payload under the same key is refused, not silently served.
    const reused = err(
      await port.createInvoice({ ...invoiceCommand('timeout'), amountMnt: 1n }, ctx),
    );
    expect(reused).toEqual({ kind: 'REJECTED', providerCode: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('reports the provider fee it settled with, and a refund surface that is never called by the subscription domain', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const invoice = ok(await port.createInvoice(invoiceCommand('fee'), ctx));
    port.pay(invoice.providerInvoiceId, new Date(), 'pay-fee', 1_200n);
    const status = ok(
      await port.queryStatus({ providerInvoiceId: invoice.providerInvoiceId }, ctx),
    );
    expect(status.providerFeeMnt).toBe(1_200n);
    const refund = ok(
      await port.refund(
        { providerPaymentId: 'pay-fee', amountMnt: 100n, reason: 'test', idempotencyKey: 'rf-1' },
        ctx,
      ),
    );
    expect(refund.state).toBe('REFUNDED');
  });

  it('7b — a malformed callback amount is a typed refusal, never a throw', async () => {
    const port = new SimulatedPaymentGateway(provider);
    const invoice = ok(await port.createInvoice(invoiceCommand('malformed'), ctx));
    port.pay(invoice.providerInvoiceId, new Date(), 'pay-malformed');
    for (const amountMnt of ['abc', '12.5', '', '1e3', ' 240000']) {
      const outcome = await port.verifyCallback(
        {
          provider,
          providerInvoiceId: invoice.providerInvoiceId,
          providerPaymentId: 'pay-malformed',
          amountMnt,
          signature: port.signatureFor(invoice.providerInvoiceId),
        },
        ctx,
      );
      expect(err(outcome)).toEqual({ kind: 'MISMATCH', field: 'amount' });
    }
  });

  it('the uncleared adapter answers DISABLED without a network call', async () => {
    const port = new UnavailablePaymentGateway(provider);
    expect(port.mode).toBe('adapter');
    const gate = provider === 'QPAY' ? 'EXT-03' : 'EXT-04';
    expect(err(await port.createInvoice(invoiceCommand('x'), ctx))).toEqual({
      kind: 'DISABLED',
      gate,
    });
    expect(err(await port.queryStatus({ providerInvoiceId: 'x' }, ctx))).toEqual({
      kind: 'DISABLED',
      gate,
    });
    expect(err(await port.verifyCallback({ provider, providerInvoiceId: 'x' }, ctx))).toEqual({
      kind: 'DISABLED',
      gate,
    });
    expect(
      err(
        await port.refund(
          { providerPaymentId: 'x', amountMnt: 1n, reason: 'r', idempotencyKey: 'k' },
          ctx,
        ),
      ),
    ).toEqual({ kind: 'DISABLED', gate });
  });

  it('is selected for local, ci and test, and refused elsewhere', () => {
    expect(selectPaymentGateways('ci').gateway(provider)).toBeInstanceOf(SimulatedPaymentGateway);
    expect(selectPaymentGateways('production').gateway(provider)).toBeInstanceOf(
      UnavailablePaymentGateway,
    );
    expect(selectPaymentGateways('staging').gateway(provider)).toBeInstanceOf(
      UnavailablePaymentGateway,
    );
  });
});

describe('EBarimtPort simulator', () => {
  const issue = (idempotencyKey: string) => ({
    paymentId: `payment-${idempotencyKey}`,
    totalMnt: 20_000n,
    vatBreakdown: { vatMnt: 1_818n, vatRateBp: 1000 },
    buyer: { ownerRef: 'owner-1', ownerType: 'CITIZEN' as const },
    idempotencyKey,
  });

  it('issues one receipt per idempotency key, with every field from the port', async () => {
    const port = new SimulatedEBarimt();
    expect(port.id).toBe('ebarimt');
    expect(port.mode).toBe('simulator');
    const first = ok(await port.issue(issue('a'), ctx));
    const again = ok(await port.issue(issue('a'), ctx));
    expect(again).toEqual(first);
    expect(first.receiptNumber).toMatch(/^SIM-/);
    expect(first.qr).toMatch(/^sim-qr-/);
    expect(first.totalMnt).toBe(20_000n);
    expect(port.receiptCount).toBe(1);
    expect(ok(await port.queryStatus({ receiptId: first.receiptId }, ctx)).state).toBe('ISSUED');
  });

  it('refuses the same key with a materially different buyer or VAT input', async () => {
    const port = new SimulatedEBarimt();
    const first = ok(await port.issue(issue('same-key'), ctx));
    const variants = [
      { ...issue('same-key'), buyer: { ownerRef: 'owner-2', ownerType: 'CITIZEN' as const } },
      { ...issue('same-key'), buyer: { ownerRef: 'owner-1', ownerType: 'ORGANIZATION' as const } },
      { ...issue('same-key'), vatBreakdown: { vatMnt: 1_818n, vatRateBp: 500 } },
      { ...issue('same-key'), vatBreakdown: { vatMnt: 1_000n, vatRateBp: 1000 } },
      { ...issue('same-key'), totalMnt: 25_000n },
    ];
    for (const variant of variants) {
      expect(err(await port.issue(variant, ctx))).toEqual({
        kind: 'REJECTED',
        providerCode: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    expect(ok(await port.issue(issue('same-key'), ctx))).toEqual(first);
    expect(port.receiptCount).toBe(1);
  });

  it('reports retryable and permanent failures as typed errors', async () => {
    const port = new SimulatedEBarimt();
    port.failNext('retryable', 'permanent');
    expect(err(await port.issue(issue('b'), ctx))).toEqual({
      kind: 'UNAVAILABLE',
      retryable: true,
    });
    expect(err(await port.issue(issue('b'), ctx)).kind).toBe('REJECTED');
    expect(port.receiptCount).toBe(0);
  });

  it('the uncleared adapter answers DISABLED', async () => {
    const port = new UnavailableEBarimt();
    expect(err(await port.issue(issue('c'), ctx))).toEqual({ kind: 'DISABLED', gate: 'EXT-11' });
    expect(err(await port.queryStatus({ receiptId: 'x' }, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-11',
    });
    expect(err(await port.cancel({ receiptId: 'x', reason: 'r' }, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-11',
    });
    expect(selectEBarimt('production')).toBeInstanceOf(UnavailableEBarimt);
    expect(selectEBarimt('test')).toBeInstanceOf(SimulatedEBarimt);
  });
});

describe('PhoneVerificationPort simulator', () => {
  it('delivers once per delivery id and answers DISABLED when uncleared', async () => {
    const port = new SimulatedPhoneVerification();
    expect(port.id).toBe('phone-otp');
    const message = {
      subjectRef: 'app-1',
      phone: '+97699000001',
      expiresAt: new Date(Date.now() + 60_000),
      deliveryId: 'd-1',
      code: '123456',
    };
    ok(await port.send(message, ctx));
    ok(await port.send(message, ctx));
    expect(port.deliveries).toHaveLength(1);
    port.failNext();
    expect(err(await port.send({ ...message, deliveryId: 'd-2' }, ctx))).toEqual({
      kind: 'UNAVAILABLE',
      retryable: true,
    });
    const disabled = new UnavailablePhoneVerification();
    expect(err(await disabled.send(message, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'INT-OTP-01',
    });
    expect(selectPhoneVerification('production')).toBeInstanceOf(UnavailablePhoneVerification);
  });
});

describe('XypIdentityPort simulator', () => {
  it('answers found, not found, unavailable and timeout deterministically, and DISABLED when uncleared', async () => {
    const port = new SimulatedXypIdentity();
    expect(port.id).toBe('xyp-identity');
    port.register('АА00000001', {
      familyName: 'Синтетик',
      givenName: 'Зочин',
      dateOfBirth: '2000-01-01',
    });
    const known = { registrationNumber: 'АА00000001', requestRef: 'r-1' };
    expect(ok(await port.lookupByRegistrationNumber(known, ctx))).toEqual({
      found: true,
      citizen: { familyName: 'Синтетик', givenName: 'Зочин', dateOfBirth: '2000-01-01' },
    });
    expect(
      ok(
        await port.lookupByRegistrationNumber({ ...known, registrationNumber: 'АА00000002' }, ctx),
      ),
    ).toEqual({ found: false });
    port.failNext();
    expect(err(await port.lookupByRegistrationNumber(known, ctx))).toEqual({
      kind: 'UNAVAILABLE',
      retryable: true,
    });
    port.timeoutNext();
    expect(err(await port.lookupByRegistrationNumber(known, ctx))).toEqual({
      kind: 'TIMEOUT',
      retryable: true,
    });
    expect(port.lookupCount).toBe(4);
    const disabled = new UnavailableXypIdentity();
    expect(err(await disabled.lookupByRegistrationNumber(known, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-01',
    });
    expect(selectXypIdentity('production')).toBeInstanceOf(UnavailableXypIdentity);
    expect(selectXypIdentity('test')).toBeInstanceOf(SimulatedXypIdentity);
  });
});

describe('NotificationPort simulator', () => {
  it('delivers once per delivery id, carries the receipt template, and answers DISABLED when uncleared', async () => {
    const port = new SimulatedNotification();
    expect(port.id).toBe('email');
    const receipt = {
      kind: 'ebarimt_receipt' as const,
      deliveryId: 'ebarimt-1',
      hotelId: '11111111-1111-4111-8111-111111111111',
      paymentId: '22222222-2222-4222-8222-222222222222',
      emailNormalized: 'owner@example.test',
      receiptNumber: 'SIM-0000000001',
      receiptQr: 'sim-qr-1',
      totalMnt: '20000',
      issuedAt: new Date('2026-01-01T00:00:00Z'),
    };
    ok(await port.send(receipt, ctx));
    ok(await port.send(receipt, ctx));
    expect(port.all().filter((m) => m.kind === 'ebarimt_receipt')).toHaveLength(1);
    const disabled = new UnavailableNotification();
    expect(err(await disabled.send(receipt, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'INT-MAIL-01',
    });
    expect(selectNotification('production')).toBeInstanceOf(UnavailableNotification);
  });
});

describe('EMongoliaAuthPort simulator', () => {
  it('issues an authorization that carries no token, refuses an unknown and a replayed code, and answers DISABLED when uncleared', async () => {
    const port = new SimulatedEMongoliaAuth();
    expect(port.id).toBe('emongolia-auth');
    const begin = { redirectUri: 'https://app.invalid/guest/emongolia', state: 's-1' };
    const authorization = ok(await port.begin(begin, ctx));
    expect(authorization.state).toBe('s-1');
    // The provider's URL carries the state and nothing of ours: no session, no
    // subject, no code (doc 09 §6.1).
    expect(authorization.authorizationUrl).toContain('state=s-1');
    expect(authorization.authorizationUrl).not.toContain('token');

    port.register('code-1', {
      providerSubject: 'sub-synthetic-1',
      claims: { displayName: 'Синтетик Зочин', verified: true },
    });
    const complete = { code: 'code-1', state: 's-1', redirectUri: begin.redirectUri };
    expect(ok(await port.complete(complete, ctx))).toEqual({
      providerSubject: 'sub-synthetic-1',
      claims: { displayName: 'Синтетик Зочин', verified: true },
    });
    // Single use is the provider's rule, so the simulator holds callers to it.
    expect(err(await port.complete(complete, ctx))).toEqual({
      kind: 'REJECTED',
      providerCode: 'code_already_used',
    });
    expect(err(await port.complete({ ...complete, code: 'code-unknown' }, ctx))).toEqual({
      kind: 'REJECTED',
      providerCode: 'invalid_code',
    });

    port.failNext();
    expect(err(await port.begin(begin, ctx))).toEqual({ kind: 'UNAVAILABLE', retryable: true });
    port.timeoutNext();
    expect(err(await port.complete(complete, ctx))).toEqual({ kind: 'TIMEOUT', retryable: true });

    const disabled = new UnavailableEMongoliaAuth();
    expect(err(await disabled.begin(begin, ctx))).toEqual({ kind: 'DISABLED', gate: 'EXT-02' });
    expect(err(await disabled.complete(complete, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-02',
    });
    expect(selectEMongoliaAuth('production')).toBeInstanceOf(UnavailableEMongoliaAuth);
    expect(selectEMongoliaAuth('test')).toBeInstanceOf(SimulatedEMongoliaAuth);
  });
});

describe('GeoPort simulator', () => {
  // Ulaanbaatar's centre and a point a known distance from it, both synthetic.
  const centre = { latitudeMicro: 47_918_600, longitudeMicro: 106_917_700 };
  const north = { latitudeMicro: 47_928_600, longitudeMicro: 106_917_700 };

  it('geocodes only what it was taught, and fails over deterministically', async () => {
    const port = new SimulatedGeo();
    expect(port.id).toBe('geo');
    port.register('Сүхбаатар талбай', { formattedAddress: 'Сүхбаатар талбай', point: centre });
    expect(ok(await port.geocode('  сүхбаатар талбай ', ctx))).toEqual({
      found: true,
      address: { formattedAddress: 'Сүхбаатар талбай', point: centre },
    });
    expect(ok(await port.geocode('nowhere', ctx))).toEqual({ found: false });
    expect(ok(await port.reverseGeocode(centre, ctx))).toEqual({
      found: true,
      address: { formattedAddress: 'Сүхбаатар талбай', point: centre },
    });
    expect(ok(await port.reverseGeocode(north, ctx))).toEqual({ found: false });
    port.failNext();
    expect(err(await port.geocode('nowhere', ctx))).toEqual({
      kind: 'UNAVAILABLE',
      retryable: true,
    });
    port.timeoutNext();
    expect(err(await port.geocode('nowhere', ctx))).toEqual({ kind: 'TIMEOUT', retryable: true });
    expect(selectGeo('production')).toBeInstanceOf(UnavailableGeo);
    expect(selectGeo('test')).toBeInstanceOf(SimulatedGeo);
  });

  it('gates geocoding but not distance, and both paths compute the same metres', async () => {
    const disabled = new UnavailableGeo();
    expect(err(await disabled.geocode('Сүхбаатар талбай', ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-06',
    });
    expect(err(await disabled.reverseGeocode(centre, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-06',
    });
    // Distance reaches no provider: it is the server-side calculation doc 09 §4
    // requires, so answering DISABLED would leave only the client to do it.
    const simulated = new SimulatedGeo();
    expect(disabled.distance(centre, north)).toEqual(simulated.distance(centre, north));
    // Ten thousandths of a degree of latitude is about 1,112 m; whole metres,
    // so two callers agree exactly and an ordering never turns on a float bit.
    expect(disabled.distance(centre, north).metres).toBe(1112);
    expect(greatCircleMetres(centre, centre)).toBe(0);
    expect(greatCircleMetres(centre, north)).toBe(greatCircleMetres(north, centre));
  });
});

describe('HotelPayoutPort simulator', () => {
  const instruction = {
    batchRef: 'batch-000001',
    hotelId: '00000000-0000-4000-8000-0000000000aa',
    amountMnt: 108_000n,
    currency: 'MNT',
    idempotencyKey: 'payout:batch-000001',
  } as const;

  it('answers the same transfer for the same key, and never moves money twice', async () => {
    const port = new SimulatedHotelPayout();
    expect(port.id).toBe('hotel-payout');
    expect(port.mode).toBe('simulator');
    const first = ok(await port.transfer(instruction, ctx));
    expect(first.state).toBe('PAID');
    expect(first.bankReference).toMatch(/^sim-payout-\d{6}$/);
    // A redriven attempt: the same key, the same answer, one transfer.
    const again = ok(await port.transfer(instruction, ctx));
    expect(again).toEqual(first);
    expect(port.transfers).toHaveLength(1);
  });

  it('distinguishes a bank that declined from one that could not be reached', async () => {
    const port = new SimulatedHotelPayout();
    port.declineNext('BANK_CLOSED');
    const declined = ok(await port.transfer(instruction, ctx));
    expect(declined).toEqual({ state: 'FAILED', failureCode: 'BANK_CLOSED' });
    // Reaching the bank and being refused is a decision; a timeout is not.
    port.failNext({ kind: 'TIMEOUT', retryable: true });
    const unreachable = new SimulatedHotelPayout();
    unreachable.failNext({ kind: 'TIMEOUT', retryable: true });
    expect(err(await unreachable.transfer(instruction, ctx))).toEqual({
      kind: 'TIMEOUT',
      retryable: true,
    });
    expect(unreachable.transfers).toHaveLength(0);
  });

  it('is disabled in production and makes no transfer at all (EXT-07)', async () => {
    const disabled = new UnavailableHotelPayout();
    expect(disabled.mode).toBe('adapter');
    expect(err(await disabled.transfer(instruction, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-07',
    });
    expect(err(await disabled.execute({ kind: 'transfer', input: instruction }, ctx))).toEqual({
      kind: 'DISABLED',
      gate: 'EXT-07',
    });
    expect(selectHotelPayout('production')).toBeInstanceOf(UnavailableHotelPayout);
    expect(selectHotelPayout('test')).toBeInstanceOf(SimulatedHotelPayout);
  });
});
