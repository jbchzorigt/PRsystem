'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, text, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../../lib/portal';

/** doc 14 §4.1 / OPS-DEC-016: suspend or reactivate with a reason code and a mandatory note. */
export async function suspension(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const name = text(form, 'name');
  const back = `/subscriptions/${hotelId}${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`;
  const { token } = await requireSession(back);
  const answer = await api().call(`/operation/subscriptions/${hotelId}/suspension`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      suspend: text(form, 'suspend') === 'yes',
      reasonCode: requiredText(form, 'reasonCode'),
      note: requiredText(form, 'note'),
    },
  });
  if (!answer.ok && answer.status === 412) redirect(`/step-up?next=${encodeURIComponent(back)}`);
  if (!answer.ok)
    redirect(withOutcome(back, { error: answer.code, message: answer.message, field: 'note' }));
  redirect(withOutcome(back, { ok: 'suspension' }));
}
