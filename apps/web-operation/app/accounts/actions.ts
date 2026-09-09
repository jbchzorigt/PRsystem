'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, text, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../lib/portal';

/** doc 14 §2.4: a named account with explicit permissions; the API validates each name against the role. */
export async function createAccount(form: FormData): Promise<void> {
  const { token } = await requireSession('/accounts');
  const permissions = (text(form, 'permissions') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const answer = await api().call<{ accountId: string }>('/operation/accounts', {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: { email: requiredText(form, 'email'), role: requiredText(form, 'role'), permissions },
  });
  if (!answer.ok && answer.status === 412)
    redirect(`/step-up?next=${encodeURIComponent('/accounts')}`);
  if (!answer.ok)
    redirect(
      withOutcome('/accounts', {
        error: answer.code,
        message: answer.message,
        field: 'permissions',
      }),
    );
  redirect(withOutcome('/accounts', { ok: 'created' }));
}
