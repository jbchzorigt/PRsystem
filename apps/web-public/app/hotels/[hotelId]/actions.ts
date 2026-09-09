'use server';

import { redirect } from 'next/navigation';
import { idempotencyKeyOf, requiredText, withOutcome } from '@prsystem/web-kit/server';
import { api, requireGuest } from '../../../lib/portal';

/**
 * doc 09 §7 steps 3–6: `Захиалах` takes the ten-minute hold and opens the
 * payment attempt. Signed-in guests only; the API prices and rechecks
 * availability, and the portal carries the category, the dates and the name.
 */
export async function book(form: FormData): Promise<void> {
  const hotelId = requiredText(form, 'hotelId');
  const checkInDate = requiredText(form, 'checkInDate');
  const checkOutDate = requiredText(form, 'checkOutDate');
  const back = `/hotels/${hotelId}?checkIn=${checkInDate}&checkOut=${checkOutDate}`;
  const token = await requireGuest(back);
  const answer = await api().call<{ bookingId: string }>('/guest/bookings', {
    method: 'POST',
    token,
    idempotencyKey: idempotencyKeyOf(form),
    body: {
      categoryId: requiredText(form, 'categoryId'),
      checkInDate,
      checkOutDate,
      stayingGuestName: requiredText(form, 'stayingGuestName'),
      provider: requiredText(form, 'provider'),
    },
  });
  if (!answer.ok) redirect(withOutcome(back, { error: answer.code, message: answer.message }));
  redirect(withOutcome(`/bookings/${answer.body.bookingId}`, { ok: 'held' }));
}
