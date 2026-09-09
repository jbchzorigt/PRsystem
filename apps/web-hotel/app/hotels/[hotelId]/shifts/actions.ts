'use server';

import { redirect } from 'next/navigation';
import {
  idempotencyKeyOf,
  integer,
  requiredText,
  text,
  withOutcome,
} from '@prsystem/web-kit/server';
import { hotelContext } from '../../../../lib/hotel-context';

/** Ээлж (doc 03, doc 24): open, count, self-close — the Reception's own shift. */
async function post(
  hotelId: string,
  path: string,
  form: FormData,
  body: Record<string, unknown>,
): Promise<never> {
  const back = `/hotels/${hotelId}/shifts`;
  const ctx = await hotelContext(hotelId, back);
  const answer = await ctx.client.call(path, {
    method: 'POST',
    token: ctx.token,
    body,
    idempotencyKey: idempotencyKeyOf(form),
  });
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(back, { ok: 'done' }));
}

export async function openShift(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const location = text(form, 'locationId');
  await post(hotelId, `/hotels/${hotelId}/shifts`, form, {
    openingCountedMnt: String(integer(form, 'openingCountedMnt') ?? 0),
    ...(location === undefined ? {} : { locationId: location }),
  });
}

export async function countShift(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const shiftId = requiredText(form, 'shiftId');
  await post(hotelId, `/hotels/${hotelId}/shifts/${shiftId}/count`, form, {
    expectedRevision: integer(form, 'expectedRevision'),
    countedCashMnt: String(integer(form, 'countedCashMnt') ?? 0),
  });
}

export async function selfCloseShift(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const shiftId = requiredText(form, 'shiftId');
  const reason = text(form, 'reason');
  await post(hotelId, `/hotels/${hotelId}/shifts/${shiftId}/self-close`, form, {
    expectedRevision: integer(form, 'expectedRevision'),
    countedCashMnt: String(integer(form, 'countedCashMnt') ?? 0),
    ...(reason === undefined ? {} : { reason }),
  });
}
