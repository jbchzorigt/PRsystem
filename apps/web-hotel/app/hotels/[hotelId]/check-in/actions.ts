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

/**
 * Check-in (doc 02 §3.1, doc 05 §3, doc 06 §4.2).
 *
 * Two steps, both server-side: a quote that writes nothing and shows the
 * planned end, the charge and every blocker the API found; then the check-in
 * itself, which the API confirms in one transaction. The portal sends what
 * the Reception typed and the server's own quote back; it prices nothing.
 */

function guestFrom(form: FormData): Record<string, unknown> {
  const identityType = requiredText(form, 'identityType');
  const guest: Record<string, unknown> = {
    identityType,
    familyName: requiredText(form, 'familyName'),
    givenName: requiredText(form, 'givenName'),
    dateOfBirth: requiredText(form, 'dateOfBirth'),
    nationality: requiredText(form, 'nationality'),
  };
  if (identityType === 'MN_REG_NO')
    guest['registrationNumber'] = requiredText(form, 'registrationNumber');
  if (identityType === 'FOREIGN_PASSPORT') {
    guest['issuingCountry'] = requiredText(form, 'issuingCountry');
    guest['passportNumber'] = requiredText(form, 'passportNumber');
    const expiry = text(form, 'passportExpiry');
    if (expiry !== undefined) guest['passportExpiry'] = expiry;
  }
  if (identityType === 'OTHER_GOV_ID') {
    guest['documentType'] = requiredText(form, 'documentType');
    guest['issuingCountry'] = requiredText(form, 'issuingCountry');
    guest['documentNumber'] = requiredText(form, 'documentNumber');
  }
  if (identityType === 'NO_DOCUMENT') {
    guest['reason'] = requiredText(form, 'noDocumentReason');
    guest['note'] = requiredText(form, 'note');
  }
  return guest;
}

function stayFrom(form: FormData): Record<string, unknown> {
  const stayType = requiredText(form, 'stayType');
  const body: Record<string, unknown> = { roomId: requiredText(form, 'roomId'), stayType };
  if (stayType === 'HOURLY') body['halfHourUnits'] = integer(form, 'halfHourUnits');
  if (stayType === 'NIGHTLY') body['nightCount'] = integer(form, 'nightCount');
  return body;
}

export async function quote(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const back = `/hotels/${hotelId}/check-in`;
  const ctx = await hotelContext(hotelId, back);
  let stay: Record<string, unknown>;
  try {
    stay = stayFrom(form);
  } catch (error) {
    redirect(withOutcome(back, { error: 'VALIDATION_FAILED', message: (error as Error).message }));
  }
  const answer = await ctx.client.call<Record<string, unknown>>(`/hotels/${hotelId}/stays/quote`, {
    method: 'POST',
    token: ctx.token,
    body: stay,
  });
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(stay))
    if (value !== undefined) params.set(name, String(value));
  for (const name of [
    'identityType',
    'familyName',
    'givenName',
    'dateOfBirth',
    'nationality',
    'registrationNumber',
    'source',
  ]) {
    const value = text(form, name);
    if (value !== undefined) params.set(name, value);
  }
  if (!answer.ok) {
    params.set('error', answer.code);
    params.set('message', answer.message);
    redirect(`${back}?${params.toString()}`);
  }
  params.set('quoted', '1');
  redirect(`${back}?${params.toString()}`);
}

export async function checkIn(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const back = `/hotels/${hotelId}/check-in`;
  const ctx = await hotelContext(hotelId, back);
  let body: Record<string, unknown>;
  try {
    const bookingRef = text(form, 'bookingRef');
    body = {
      ...stayFrom(form),
      source: requiredText(form, 'source'),
      ...(bookingRef === undefined ? {} : { bookingRef: bookingRef.toUpperCase() }),
      guest: guestFrom(form),
    };
  } catch (error) {
    redirect(withOutcome(back, { error: 'VALIDATION_FAILED', message: (error as Error).message }));
  }
  const answer = await ctx.client.call<{ stayId: string }>(`/hotels/${hotelId}/stays`, {
    method: 'POST',
    token: ctx.token,
    body,
    idempotencyKey: idempotencyKeyOf(form),
  });
  if (!answer.ok) {
    redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  }
  redirect(withOutcome(`/hotels/${hotelId}/stays/${answer.body.stayId}`, { ok: 'checked-in' }));
}
