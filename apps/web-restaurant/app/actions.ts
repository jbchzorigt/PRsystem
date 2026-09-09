'use server';

import { redirect } from 'next/navigation';
import {
  clearToken,
  idempotencyKeyOf,
  integer,
  requiredText,
  text,
  withOutcome,
  writeToken,
} from '@prsystem/web-kit/server';
import { api, headersFor, requireGuestSession, runtime } from '../lib/portal';

/** RC-DEC-026: QR plus code; one message for a wrong QR, a wrong code and a stale one. */
export async function openSession(form: FormData): Promise<void> {
  const answer = await api().call<{ token: string; expiresAt: string }>(
    '/restaurant/guest/sessions',
    {
      method: 'POST',
      body: { roomToken: requiredText(form, 'roomToken'), code: requiredText(form, 'code') },
    },
  );
  if (!answer.ok) redirect(withOutcome('/', { error: answer.code, message: answer.message }));
  const seconds = Math.max(
    60,
    Math.round((new Date(answer.body.expiresAt).getTime() - Date.now()) / 1000),
  );
  await writeToken(runtime(), answer.body.token, seconds);
  redirect('/menu');
}

/** doc 08 §6: the basket is item ids and quantities; the server prices it. */
export async function placeOrder(form: FormData): Promise<void> {
  const token = await requireGuestSession();
  const restaurantId = requiredText(form, 'restaurantId');
  const lines: { itemId: string; quantity: number }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith('qty:') || typeof value !== 'string') continue;
    const quantity = Number(value);
    if (Number.isInteger(quantity) && quantity > 0) lines.push({ itemId: name.slice(4), quantity });
  }
  if (lines.length === 0)
    redirect(
      withOutcome('/menu', { error: 'VALIDATION_FAILED', message: 'Захиалах зүйлээ сонгоно уу.' }),
    );
  const note = text(form, 'note');
  const answer = await api().call<{ orderId: string }>('/restaurant/guest/orders', {
    method: 'POST',
    headers: headersFor(token),
    idempotencyKey: idempotencyKeyOf(form),
    body: { restaurantId, lines, ...(note === undefined ? {} : { note }) },
  });
  if (!answer.ok) redirect(withOutcome('/menu', { error: answer.code, message: answer.message }));
  redirect(withOutcome(`/orders/${answer.body.orderId}`, { ok: 'placed' }));
}

export async function openInvoice(form: FormData): Promise<void> {
  const token = await requireGuestSession();
  const orderId = requiredText(form, 'orderId');
  const back = `/orders/${orderId}`;
  const answer = await api().call<{ payUrl?: string }>(
    `/restaurant/guest/orders/${orderId}/invoice`,
    {
      method: 'POST',
      headers: headersFor(token),
      idempotencyKey: idempotencyKeyOf(form),
      body: {},
    },
  );
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'invoice', message: answer.body.payUrl ?? '' }));
}

export async function requestRefund(form: FormData): Promise<void> {
  const token = await requireGuestSession();
  const orderId = requiredText(form, 'orderId');
  const back = `/orders/${orderId}`;
  const answer = await api().call(`/restaurant/guest/orders/${orderId}/refund-request`, {
    method: 'POST',
    headers: headersFor(token),
    idempotencyKey: idempotencyKeyOf(form),
    body: {},
  });
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'refund-requested' }));
}

export async function signOut(): Promise<void> {
  await clearToken(runtime());
  redirect('/');
}

export { integer };
