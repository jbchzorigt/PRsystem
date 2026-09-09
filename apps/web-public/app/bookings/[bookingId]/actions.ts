'use server';

import { redirect } from 'next/navigation';
import {
  idempotencyKeyOf,
  integer,
  requiredText,
  text,
  withOutcome,
} from '@prsystem/web-kit/server';
import { api, requireGuest } from '../../../lib/portal';

const back = (bookingId: string) => `/bookings/${bookingId}`;

/**
 * doc 09 §7 step 6 / §8: the guest picks a provider and opens its invoice.
 * The API keeps exactly one live attempt — asking for the same provider
 * returns it, another provider supersedes it — and only then issues the
 * invoice; the portal never chooses an amount or a status.
 */
export async function pay(form: FormData): Promise<void> {
  const bookingId = requiredText(form, 'bookingId');
  const token = await requireGuest(back(bookingId));
  const client = api();
  const attempt = await client.call<{ attemptId: string }>(
    `/guest/bookings/${bookingId}/payment-attempts`,
    {
      method: 'POST',
      token,
      idempotencyKey: idempotencyKeyOf(form),
      body: { provider: requiredText(form, 'provider') },
    },
  );
  if (!attempt.ok)
    redirect(withOutcome(back(bookingId), { error: attempt.code, message: attempt.message }));
  const invoice = await client.call<{ payUrl?: string }>(
    `/guest/bookings/${bookingId}/payment-attempts/${attempt.body.attemptId}/invoice`,
    { method: 'POST', token, idempotencyKey: `${idempotencyKeyOf(form)}-invoice` },
  );
  if (!invoice.ok)
    redirect(withOutcome(back(bookingId), { error: invoice.code, message: invoice.message }));
  if (invoice.body.payUrl === undefined) redirect(withOutcome(back(bookingId), { ok: 'invoice' }));
  redirect(invoice.body.payUrl);
}

/** doc 09 §3.6: cancel own booking; the refund terms are decided by the API from the policy snapshot. */
export async function cancel(form: FormData): Promise<void> {
  const bookingId = requiredText(form, 'bookingId');
  const token = await requireGuest(back(bookingId));
  const reason = text(form, 'reason');
  const answer = await api().call(`/guest/bookings/${bookingId}/cancellation`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: reason === undefined ? {} : { reason },
  });
  if (!answer.ok)
    redirect(withOutcome(back(bookingId), { error: answer.code, message: answer.message }));
  redirect(withOutcome(back(bookingId), { ok: 'cancelled' }));
}

/** doc 09 §3.5: one verified review per completed booking (RV-DEC-001). */
export async function review(form: FormData): Promise<void> {
  const bookingId = requiredText(form, 'bookingId');
  const token = await requireGuest(back(bookingId));
  const answer = await api().call(`/guest/reviews`, {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: { bookingId, rating: integer(form, 'rating'), comment: requiredText(form, 'comment') },
  });
  if (!answer.ok)
    redirect(
      withOutcome(back(bookingId), {
        error: answer.code,
        message: answer.message,
        field: 'comment',
      }),
    );
  redirect(withOutcome(back(bookingId), { ok: 'reviewed' }));
}
