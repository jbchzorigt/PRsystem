'use server';

import { redirect } from 'next/navigation';
import {
  idempotencyKeyOf,
  integer,
  requiredText,
  text,
  withOutcome,
} from '@prsystem/web-kit/server';
import { hotelContext } from '../../../../../lib/hotel-context';

/**
 * The Reception's stay commands (doc 02 §3.2–§3.3, doc 04 §5.2): start and
 * cancel the checkout, record a payment, settle the bill, finish the checkout.
 * Every one is the API's own transaction; the portal carries the expected
 * revision it was shown and the key it minted when it rendered the button.
 */
async function post(
  hotelId: string,
  stayId: string,
  path: string,
  form: FormData,
  body: Record<string, unknown>,
  ok: string,
): Promise<never> {
  const back = `/hotels/${hotelId}/stays/${stayId}`;
  const ctx = await hotelContext(hotelId, back);
  const answer = await ctx.client.call(path, {
    method: 'POST',
    token: ctx.token,
    body,
    idempotencyKey: idempotencyKeyOf(form),
  });
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok }));
}

export async function startCheckout(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const stayId = requiredText(form, 'stayId');
  await post(
    hotelId,
    stayId,
    `/hotels/${hotelId}/stays/${stayId}/checkout/start`,
    form,
    { expectedRevision: integer(form, 'expectedRevision') },
    'checkout-started',
  );
}

export async function cancelCheckout(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const stayId = requiredText(form, 'stayId');
  await post(
    hotelId,
    stayId,
    `/hotels/${hotelId}/stays/${stayId}/checkout/cancel`,
    form,
    { expectedRevision: integer(form, 'expectedRevision'), reason: requiredText(form, 'reason') },
    'checkout-cancelled',
  );
}

export async function recordPayment(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const stayId = requiredText(form, 'stayId');
  const approvalCode = text(form, 'approvalCode');
  const terminalId = text(form, 'terminalId');
  const providerReference = text(form, 'providerReference');
  await post(
    hotelId,
    stayId,
    `/hotels/${hotelId}/stays/${stayId}/folio/payments`,
    form,
    {
      channel: requiredText(form, 'channel'),
      amountMnt: String(integer(form, 'amountMnt') ?? 0),
      ...(approvalCode === undefined ? {} : { approvalCode }),
      ...(terminalId === undefined ? {} : { terminalId }),
      ...(providerReference === undefined ? {} : { providerReference }),
    },
    'paid',
  );
}

export async function settleFolio(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const stayId = requiredText(form, 'stayId');
  await post(
    hotelId,
    stayId,
    `/hotels/${hotelId}/stays/${stayId}/folio/settle`,
    form,
    { expectedRevision: integer(form, 'expectedRevision') },
    'settled',
  );
}

export async function finishCheckout(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const stayId = requiredText(form, 'stayId');
  await post(
    hotelId,
    stayId,
    `/hotels/${hotelId}/stays/${stayId}/checkout`,
    form,
    { expectedRevision: integer(form, 'expectedRevision') },
    'checked-out',
  );
}
