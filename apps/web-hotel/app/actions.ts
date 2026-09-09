'use server';

import { redirect } from 'next/navigation';
import { clearToken, writeToken, requiredText, text, withOutcome } from '@prsystem/web-kit/server';
import { api, runtime } from '../lib/portal';

/**
 * Sign in: the portal exchanges the credentials for a token over the server
 * side only and keeps it in an httpOnly cookie. The password is in this
 * request body and nowhere else — not logged, not stored, not echoed.
 */
export async function signIn(form: FormData): Promise<void> {
  const next = text(form, 'next');
  const target = next !== undefined && next.startsWith('/') ? next : '/';
  let email: string;
  let password: string;
  try {
    email = requiredText(form, 'email');
    password = requiredText(form, 'password');
  } catch {
    redirect(withOutcome('/sign-in', { error: 'VALIDATION_FAILED', field: 'email' }));
  }
  const answer = await api().call<{ token: string; expiresInSeconds: number }>('/auth/sign-in', {
    method: 'POST',
    body: { email, password },
  });
  if (!answer.ok) {
    redirect(withOutcome('/sign-in', { error: answer.code, message: answer.message }));
  }
  await writeToken(runtime(), answer.body.token, answer.body.expiresInSeconds);
  redirect(target);
}

export async function signOut(): Promise<void> {
  const { readToken } = await import('@prsystem/web-kit/server');
  const token = await readToken(runtime());
  if (token !== undefined) {
    await api().call('/auth/sign-out', { method: 'POST', token });
  }
  await clearToken(runtime());
  redirect('/sign-in');
}
