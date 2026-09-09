'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, integer, requiredText, withOutcome } from '@prsystem/web-kit/server';
import { hotelContext } from '../../../../lib/hotel-context';

/** Renewal (doc 17 §4): the API quotes and opens the invoice; the portal shows the link. */
export async function renew(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const back = `/hotels/${hotelId}/subscription`;
  const ctx = await hotelContext(hotelId, back);
  const answer = await ctx.client.call<{ payUrl?: string; invoiceId?: string }>(
    `/hotels/${hotelId}/subscription/renewals`,
    {
      method: 'POST',
      token: ctx.token,
      idempotencyKey: idempotencyKeyOf(form),
      body: {
        targetPackage: requiredText(form, 'targetPackage'),
        termMonths: integer(form, 'termMonths'),
        provider: requiredText(form, 'provider'),
      },
    },
  );
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'renewal', message: answer.body.payUrl ?? '' }));
}
