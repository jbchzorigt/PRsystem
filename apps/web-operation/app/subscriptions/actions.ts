'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, text, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../lib/portal';

/** doc 14 §2.1 / OPS-DEC-008: the API mails the link; the portal sees only queued-or-not. */
export async function passwordReset(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const back = text(form, 'back') ?? `/subscriptions/${hotelId}`;
  const { token } = await requireSession(back);
  const answer = await api().call<{ queued: boolean; emailMasked: string }>(
    `/operation/subscriptions/${hotelId}/password-reset`,
    {
      method: 'POST',
      token,
      idempotencyKey: idempotencyKeyOf(form),
      body: {},
    },
  );
  if (!answer.ok && answer.status === 412) redirect(`/step-up?next=${encodeURIComponent(back)}`);
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: answer.body.queued ? 'reset' : 'reset-failed' }));
}
