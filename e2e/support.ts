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
  readonly citizens: { readonly wanted: readonly Citizen[]; readonly ordinary: readonly Citizen[] };
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
  method: 'GET' | 'POST',
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
