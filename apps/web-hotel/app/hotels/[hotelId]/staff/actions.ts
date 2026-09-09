'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, withOutcome } from '@prsystem/web-kit/server';
import { hotelContext } from '../../../../lib/hotel-context';

/** Staff invitation (doc 19 §3): the link goes to the address; the portal never sees it. */
export async function invite(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const back = `/hotels/${hotelId}/staff`;
  const ctx = await hotelContext(hotelId, back);
  const roles = form
    .getAll('roles')
    .filter((role): role is string => typeof role === 'string' && role !== '');
  const answer = await ctx.client.call(`/hotels/${hotelId}/staff/invitations`, {
    method: 'POST',
    token: ctx.token,
    idempotencyKey: idempotencyKeyOf(form),
    body: { email: requiredText(form, 'email'), roles },
  });
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'invited' }));
}
