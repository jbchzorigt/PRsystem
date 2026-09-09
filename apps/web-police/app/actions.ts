'use server';

import { redirect } from 'next/navigation';
import {
  clearToken,
  readToken,
  requiredText,
  text,
  withOutcome,
  writeToken,
} from '@prsystem/web-kit/server';
import { api, runtime } from '../lib/portal';

/**
 * doc 13 §5 / POL-DEC-004: the Police portal's own password login. The
 * password travels in this request body only — never logged, stored or echoed.
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
  const answer = await api().call<{ token: string; expiresInSeconds: number }>(
    '/police/auth/sign-in',
    {
      method: 'POST',
      body: { email, password },
    },
  );
  if (!answer.ok)
    redirect(withOutcome('/sign-in', { error: answer.code, message: answer.message }));
  await writeToken(runtime(), answer.body.token, answer.body.expiresInSeconds);
  redirect(target);
}

export async function signOut(): Promise<void> {
  const token = await readToken(runtime());
  if (token !== undefined) await api().call('/auth/sign-out', { method: 'POST', token });
  await clearToken(runtime());
  redirect('/sign-in');
}
