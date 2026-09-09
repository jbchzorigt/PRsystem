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

/** doc 14 §2: password plus a TOTP code; sign-in counts as the first step-up. */
export async function signIn(form: FormData): Promise<void> {
  const next = text(form, 'next');
  const target = next !== undefined && next.startsWith('/') ? next : '/';
  let email: string;
  let password: string;
  let code: string;
  try {
    email = requiredText(form, 'email');
    password = requiredText(form, 'password');
    code = requiredText(form, 'code');
  } catch {
    redirect(withOutcome('/sign-in', { error: 'VALIDATION_FAILED', field: 'email' }));
  }
  const answer = await api().call<{ token: string }>('/operation/auth/sign-in', {
    method: 'POST',
    body: { email, password, code },
  });
  if (!answer.ok)
    redirect(withOutcome('/sign-in', { error: answer.code, message: answer.message }));
  // The API's absolute session lifetime is eight hours; the cookie says the same.
  await writeToken(runtime(), answer.body.token, 8 * 60 * 60);
  redirect(target);
}

/** doc 14 §2.4: re-prove the second factor on the live session. */
export async function stepUp(form: FormData): Promise<void> {
  const next = text(form, 'next');
  const target = next !== undefined && next.startsWith('/') ? next : '/';
  const token = await readToken(runtime());
  if (token === undefined) redirect(`/sign-in?next=${encodeURIComponent(target)}`);
  const answer = await api().call('/operation/auth/step-up', {
    method: 'POST',
    token,
    body: { code: requiredText(form, 'code') },
  });
  if (!answer.ok)
    redirect(
      withOutcome(`/step-up?next=${encodeURIComponent(target)}`, {
        error: answer.code,
        message: answer.message,
      }),
    );
  redirect(target);
}

export async function signOut(): Promise<void> {
  const token = await readToken(runtime());
  if (token !== undefined) await api().call('/auth/sign-out', { method: 'POST', token });
  await clearToken(runtime());
  redirect('/sign-in');
}
