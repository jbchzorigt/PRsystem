'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, integer, requiredText, withOutcome } from '@prsystem/web-kit/server';
import { hotelContext } from '../../../../lib/hotel-context';

/** doc 04 §11: on the 20,000₮ package the Manager moves a room to `Цэвэр`. */
export async function setCleaning(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const roomId = requiredText(form, 'roomId');
  const back = `/hotels/${hotelId}/housekeeping`;
  const ctx = await hotelContext(hotelId, back);
  const answer = await ctx.client.call(`/hotels/${hotelId}/rooms/${roomId}/cleaning`, {
    method: 'POST',
    token: ctx.token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      toState: requiredText(form, 'toState'),
      expectedRevision: integer(form, 'expectedRevision') ?? 0,
    },
  });
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'done' }));
}
