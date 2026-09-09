'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, text, withOutcome } from '@prsystem/web-kit/server';
import { api, requireSession } from '../../lib/portal';

/**
 * doc 14 §5.4 steps 2–5: the recipients and the text go to the API, which
 * answers with the preview — counts, segments, cost. Nothing is sent.
 */
export async function preview(form: FormData): Promise<void> {
  const { token } = await requireSession('/sms');
  const hotelIds = (text(form, 'hotelIds') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const filters: Record<string, unknown> = {};
  if (hotelIds.length > 0) filters['hotelIds'] = hotelIds;
  for (const name of ['package', 'status', 'expiresFrom', 'expiresTo']) {
    const value = text(form, name);
    if (value !== undefined) filters[name] = value;
  }
  const answer = await api().call<Record<string, unknown> & { previewId: string }>(
    '/operation/sms/previews',
    {
      method: 'POST',
      token,
      body: { body: requiredText(form, 'body'), filters },
    },
  );
  if (!answer.ok && answer.status === 412) redirect(`/step-up?next=${encodeURIComponent('/sms')}`);
  if (!answer.ok)
    redirect(withOutcome('/sms', { error: answer.code, message: answer.message, field: 'body' }));
  const params = new URLSearchParams();
  for (const name of [
    'previewId',
    'characters',
    'alphabet',
    'segmentsPerRecipient',
    'recipientCount',
    'duplicateCount',
    'excludedCount',
    'totalSegments',
    'estimatedCostMnt',
    'expiresAt',
  ]) {
    const value = answer.body[name];
    if (value !== undefined && value !== null) params.set(name, String(value));
  }
  if (hotelIds.length > 0) params.set('hotelIds', hotelIds.join(','));
  redirect(`/sms?${params.toString()}`);
}

/** Step 6: "Илгээхийг баталгаажуулах" — only now does a send job exist. */
export async function confirm(form: FormData): Promise<void> {
  const { token } = await requireSession('/sms');
  const answer = await api().call<{ jobId: string }>('/operation/sms/jobs', {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: { previewId: requiredText(form, 'previewId') },
  });
  if (!answer.ok && answer.status === 412) redirect(`/step-up?next=${encodeURIComponent('/sms')}`);
  if (!answer.ok) redirect(withOutcome('/sms', { error: answer.code, message: answer.message }));
  redirect(withOutcome('/sms', { ok: 'confirmed' }));
}

/** doc 14 §6: pull the provider's delivery states into the history. */
export async function refresh(): Promise<void> {
  const { token } = await requireSession('/sms');
  const answer = await api().call('/operation/sms/deliveries/refresh', {
    method: 'POST',
    token,
    body: {},
  });
  if (!answer.ok && answer.status === 412) redirect(`/step-up?next=${encodeURIComponent('/sms')}`);
  if (!answer.ok) redirect(withOutcome('/sms', { error: answer.code, message: answer.message }));
  redirect(withOutcome('/sms', { ok: 'refreshed' }));
}
