'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, withOutcome } from '@prsystem/web-kit/server';
import { hotelContext } from '../../../../lib/hotel-context';

/** RC-DEC-026/027: the one-time guest access code, read to the guest and gone. */
export async function issueGuestCode(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const stayId = requiredText(form, 'stayId');
  const back = `/hotels/${hotelId}/restaurant`;
  const ctx = await hotelContext(hotelId, back);
  const answer = await ctx.client.call<{ codeId: string; code: string; expiresAt?: string }>(
    `/hotels/${hotelId}/stays/${stayId}/guest-access-codes`,
    { method: 'POST', token: ctx.token, idempotencyKey: idempotencyKeyOf(form) },
  );
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'code', message: answer.body.code }));
}

export async function revokeGuestSessions(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const stayId = requiredText(form, 'stayId');
  const back = `/hotels/${hotelId}/restaurant`;
  const ctx = await hotelContext(hotelId, back);
  const answer = await ctx.client.call(
    `/hotels/${hotelId}/stays/${stayId}/guest-access-revocations`,
    {
      method: 'POST',
      token: ctx.token,
      idempotencyKey: idempotencyKeyOf(form),
      body: {},
    },
  );
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'revoked' }));
}
