import type { APIRequestContext, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { API_URL, CONSOLE_URL } from './portals';

/** What the e2e API server seeded, as its console reports it. */
export interface Seed {
  readonly api: string;
  readonly projects: readonly string[];
  readonly hotel: {
    readonly hotelId: string;
    readonly name: string;
    readonly categoryId: string;
    readonly rooms: readonly string[];
    readonly reception: Credential;
    readonly manager: Credential;
    readonly cleaner: Credential;
  };
  readonly restaurantHotel: {
    readonly hotelId: string;
    readonly name: string;
    readonly rooms: readonly string[];
    readonly reception: Credential;
    readonly manager: Credential;
    readonly managerPlus: Credential;
    readonly restaurants: readonly { restaurantId: string; manager: Credential }[];
  };
  readonly operation: {
    readonly admins: readonly Credential[];
    readonly auditAdmins: readonly Credential[];
    readonly superAdmins: readonly Credential[];
    readonly hotels: readonly {
      hotelId: string;
      name: string;
      district: string;
      contactPhone: string;
    }[];
  };
  readonly police: { readonly admin: Credential; readonly officer: Credential };
  readonly subscriptionHotels: readonly Record<
    'expiring' | 'grace' | 'expired',
    { hotelId: string; name: string; admin: Credential }
  >[];
  readonly worker: { readonly queuePrefix: string; readonly sweepMs: number };
  readonly citizens: {
    readonly wanted: readonly Citizen[];
    readonly wantedSweep: readonly Citizen[];
    readonly ordinary: readonly Citizen[];
  };
}
export interface Credential {
  readonly email: string;
  readonly password: string;
}
export interface Citizen {
  readonly registrationNumber: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly dateOfBirth: string;
}

let cached: Seed | undefined;
export async function seed(request: APIRequestContext): Promise<Seed> {
  if (cached === undefined) {
    const response = await request.get(`${CONSOLE_URL}/seed`);
    expect(response.ok()).toBe(true);
    cached = (await response.json()) as Seed;
  }
  return cached;
}

/** The index this project owns in every per-project fixture list. */
export function lane(testInfo: TestInfo): number {
  const index = ['mobile', 'tablet', 'desktop'].indexOf(testInfo.project.name);
  return index < 0 ? 0 : index;
}

/** The code the OTP simulator "sent" to a phone, as its recipient would read it. */
export async function otpCode(request: APIRequestContext, phone: string): Promise<string> {
  const response = await request.get(`${CONSOLE_URL}/otp?phone=${encodeURIComponent(phone)}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { code: string }).code;
}

const lastTotp = new Map<string, string>();
/**
 * The authenticator code a seeded operator would read right now — and never
 * the one this process already used: the API accepts a code once per step,
 * so a second sign-in inside the same thirty seconds waits for the next.
 */
export async function totpCode(request: APIRequestContext, email: string): Promise<string> {
  for (;;) {
    const response = await request.get(`${CONSOLE_URL}/totp?email=${encodeURIComponent(email)}`);
    expect(response.ok()).toBe(true);
    const { code } = (await response.json()) as { code: string };
    if (lastTotp.get(email) !== code) {
      lastTotp.set(email, code);
      return code;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
}

/** doc 03: a walk-in needs an open Reception shift; one already open is fine. */
export async function openShift(
  request: APIRequestContext,
  token: string,
  hotelId: string,
): Promise<void> {
  const answer = await api(request, 'POST', `/hotels/${hotelId}/shifts`, {
    token,
    body: { openingCountedMnt: '0' },
  });
  expect([201, 200, 409], JSON.stringify(answer.body)).toContain(answer.status);
}

let keys = 0;
/** A direct API call, for the setup a flow needs before the portal takes over. */
export async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  keys += 1;
  const response = await request.fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `e2e-${String(process.pid)}-${String(Date.now())}-${String(keys)}`,
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { data: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status(), body: (text === '' ? {} : JSON.parse(text)) as T };
}

export async function hotelToken(
  request: APIRequestContext,
  credential: Credential,
): Promise<string> {
  const answer = await api<{ token: string }>(request, 'POST', '/auth/sign-in', {
    body: credential,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.token;
}

/** A walk-in check-in through the API, the way the Reception's screen does it. */
export async function checkIn(
  request: APIRequestContext,
  token: string,
  hotelId: string,
  roomId: string,
  citizen: Citizen,
): Promise<string> {
  const answer = await api<{ stayId: string }>(request, 'POST', `/hotels/${hotelId}/stays`, {
    token,
    body: {
      roomId,
      source: 'WALK_IN',
      stayType: 'NIGHTLY',
      nightCount: 1,
      guest: {
        identityType: 'MN_REG_NO',
        familyName: citizen.familyName,
        givenName: citizen.givenName,
        dateOfBirth: citizen.dateOfBirth,
        nationality: 'MN',
        registrationNumber: citizen.registrationNumber,
      },
    },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.stayId;
}

/** A guest account registered over the API with the simulator's code. */
export async function registerGuest(
  request: APIRequestContext,
  phone: string,
  password: string,
): Promise<void> {
  const sent = await api(request, 'POST', '/guest/phone-verifications', {
    body: { phone, purpose: 'REGISTER' },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  const code = await otpCode(request, phone);
  const created = await api(request, 'POST', '/guest/accounts', {
    body: { phone, code, password },
  });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
}

export const GUEST_PASSWORD = ['synthetic', 'guest', 'passphrase'].join('-');

// ------------------------------------------------------------------ Phase 22

/** A console call: the e2e server's loopback console, never the API. */
export async function consoleCall<T = Record<string, unknown>>(
  request: APIRequestContext,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response =
    body === undefined
      ? await request.get(`${CONSOLE_URL}${path}`)
      : await request.post(`${CONSOLE_URL}${path}`, { data: body });
  return { status: response.status(), body: (await response.json()) as T };
}

/** Values this run must never find in a log or a durable record. */
export async function registerCanaries(
  request: APIRequestContext,
  values: readonly string[],
): Promise<void> {
  await consoleCall(request, '/leakage/canaries', {
    values: values.filter((v) => typeof v === 'string' && v.length >= 6),
  });
}

/** Polls until `probe` answers, or the deadline passes. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 500,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs)
      throw new Error(`nothing arrived within ${String(timeoutMs)}ms`);
    await new Promise((done) => setTimeout(done, everyMs));
  }
}

export type PaymentScope = 'booking' | 'onboarding' | 'subscription' | 'restaurant';

/**
 * The provider pays — in the simulator — and calls back. The callback is the
 * API's real route with the simulator's stand-in signature; the API verifies,
 * re-queries the provider and applies the transition, as it would in production.
 */
export async function payThroughProvider(
  request: APIRequestContext,
  scope: PaymentScope,
  subject: Record<string, string>,
): Promise<{ providerInvoiceId: string; status: number; body: Record<string, unknown> }> {
  const simulated = await consoleCall<{
    provider: string;
    providerInvoiceId: string;
    signature: string;
    callbackPath: string;
  }>(request, '/simulate/payment', { scope, ...subject });
  expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);
  const callback = await api(request, 'POST', simulated.body.callbackPath, {
    body: {
      providerInvoiceId: simulated.body.providerInvoiceId,
      signature: simulated.body.signature,
    },
  });
  return {
    providerInvoiceId: simulated.body.providerInvoiceId,
    status: callback.status,
    body: callback.body,
  };
}

/** The newest staff notification of a kind, once it exists. */
export async function notification(
  request: APIRequestContext,
  query: { kind?: string; email?: string; hotelId?: string },
  timeoutMs = 30_000,
): Promise<{ token: string; hotelId: string; invitationId: string; email: string }> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query))
    if (value !== undefined) params.set(name, value);
  return waitFor(async () => {
    const answer = await consoleCall<{
      token: string;
      hotelId: string;
      invitationId: string;
      email: string;
    }>(request, `/notification?${params.toString()}`);
    return answer.status === 200 ? answer.body : undefined;
  }, timeoutMs);
}

/** A staff member invited by the hotel and accepted with a password of their own. */
export async function inviteAndAccept(
  request: APIRequestContext,
  inviterToken: string,
  hotelId: string,
  email: string,
  roles: readonly string[],
  password: string,
): Promise<string> {
  const invited = await api(request, 'POST', `/hotels/${hotelId}/staff/invitations`, {
    token: inviterToken,
    body: { email, roles },
  });
  expect(invited.status, JSON.stringify(invited.body)).toBeLessThan(300);
  const message = await notification(request, { kind: 'staff_invitation', email });
  const accepted = await api(request, 'POST', `/hotels/${hotelId}/staff/invitations/accept`, {
    body: { token: message.token, password },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
  await registerCanaries(request, [password, message.token]);
  return hotelToken(request, { email, password });
}

/** The Cleaner takes the stay's minibar inspection and states no usage. */
export async function inspectNoUsage(
  request: APIRequestContext,
  cleanerToken: string,
  hotelId: string,
  roomId: string,
): Promise<string> {
  const list = await api<{
    reports: readonly { reportId: string; roomId: string; state: string; revision: number }[];
  }>(request, 'GET', `/hotels/${hotelId}/minibar-reports`, { token: cleanerToken });
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const report = list.body.reports.find((r) => r.roomId === roomId);
  expect(report, 'a minibar report for the room').toBeDefined();
  const claimed = await api<{ revision: number }>(
    request,
    'POST',
    `/hotels/${hotelId}/minibar-reports/${report!.reportId}/claim`,
    {
      token: cleanerToken,
      body: { expectedRevision: report!.revision },
    },
  );
  expect(claimed.status, JSON.stringify(claimed.body)).toBeLessThan(300);
  const submitted = await api(
    request,
    'POST',
    `/hotels/${hotelId}/minibar-reports/${report!.reportId}/versions`,
    {
      token: cleanerToken,
      body: { expectedRevision: claimed.body.revision, counted: [], noUsage: true },
    },
  );
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
  return report!.reportId;
}
