'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { clearToken, requiredText, text, withOutcome, writeToken } from '@prsystem/web-kit/server';
import { REGISTER_PHONE_COOKIE, api, runtime, sessionToken } from '../lib/portal';

/** doc 09 §6.2: a phone-and-password sign-in; the same answer for every failure. */
export async function signIn(form: FormData): Promise<void> {
  const next = text(form, 'next');
  const target = next !== undefined && next.startsWith('/') ? next : '/bookings';
  const back = `/sign-in${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`;
  const answer = await api().call<{ token: string }>('/guest/sessions', {
    method: 'POST',
    body: { phone: requiredText(form, 'phone'), password: requiredText(form, 'password') },
  });
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  // doc 09: the guest session's own life is the API's; the cookie lasts a day at most.
  await writeToken(runtime(), answer.body.token, 24 * 3600);
  redirect(target);
}

const registerPath = (next: string | undefined) =>
  next === undefined ? '/register' : `/register?next=${encodeURIComponent(next)}`;

/** doc 09 §6.2 steps 1–2: ask for the six-digit code. */
export async function requestCode(form: FormData): Promise<void> {
  const phone = requiredText(form, 'phone');
  const next = text(form, 'next');
  const answer = await api().call('/guest/phone-verifications', {
    method: 'POST',
    body: { phone, purpose: 'REGISTER' },
  });
  const back = registerPath(next);
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  const jar = await cookies();
  jar.set(REGISTER_PHONE_COOKIE, phone, {
    httpOnly: true,
    sameSite: 'lax',
    secure: runtime().origin.startsWith('https://'),
    path: '/register',
    maxAge: 10 * 60,
  });
  redirect(withOutcome(back, { ok: 'sent' }));
}

/** doc 09 §6.2 steps 3–5: the code proves the number; the password is the guest's own. */
export async function register(form: FormData): Promise<void> {
  const next = text(form, 'next');
  const back = registerPath(next);
  const jar = await cookies();
  const phone = jar.get(REGISTER_PHONE_COOKIE)?.value;
  if (phone === undefined || phone === '')
    redirect(withOutcome(back, { error: 'VALIDATION_FAILED', field: 'phone' }));
  const answer = await api().call<{ token: string }>('/guest/accounts', {
    method: 'POST',
    body: { phone, code: requiredText(form, 'code'), password: requiredText(form, 'password') },
  });
  if (!answer.ok)
    redirect(withOutcome(back, { error: answer.code, message: answer.message, ok: 'sent' }));
  jar.delete(REGISTER_PHONE_COOKIE);
  await writeToken(runtime(), answer.body.token, 24 * 3600);
  redirect(next !== undefined && next.startsWith('/') ? next : '/bookings');
}

export async function signOut(): Promise<void> {
  const token = await sessionToken();
  if (token !== undefined) await api().call('/auth/sign-out', { method: 'POST', token });
  await clearToken(runtime());
  redirect('/');
}
