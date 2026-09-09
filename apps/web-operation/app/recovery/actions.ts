'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../lib/portal';

/** doc 14 §2.2 / OPS-DEC-009: an Operation user records the request and hands it up. */
export async function escalate(form: FormData): Promise<void> {
  const { token } = await requireSession('/recovery');
  const answer = await api().call('/operation/recovery-requests', {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      hotelId: requiredText(form, 'hotelId'),
      caseReference: requiredText(form, 'caseReference'),
      note: requiredText(form, 'note'),
    },
  });
  if (!answer.ok && answer.status === 412)
    redirect(`/step-up?next=${encodeURIComponent('/recovery')}`);
  if (!answer.ok)
    redirect(
      withOutcome('/recovery', { error: answer.code, message: answer.message, field: 'note' }),
    );
  redirect(withOutcome('/recovery', { ok: 'escalated' }));
}

/** The Platform Super Admin decides, with a reason; the same account never decides its own request. */
export async function decide(form: FormData): Promise<void> {
  const requestId = requiredText(form, 'requestId');
  const { token } = await requireSession('/recovery');
  const answer = await api().call(`/operation/recovery-requests/${requestId}/decision`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: { decision: requiredText(form, 'decision'), reason: requiredText(form, 'reason') },
  });
  if (!answer.ok && answer.status === 412)
    redirect(`/step-up?next=${encodeURIComponent('/recovery')}`);
  if (!answer.ok)
    redirect(withOutcome('/recovery', { error: answer.code, message: answer.message }));
  redirect(withOutcome('/recovery', { ok: 'decided' }));
}
