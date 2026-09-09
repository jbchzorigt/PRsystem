import { redirect } from 'next/navigation';
import { hotelContext } from '../../../lib/hotel-context';

/** A hotel's front door is its first tab. */
export default async function HotelHome({ params }: { params: Promise<{ hotelId: string }> }) {
  const { hotelId } = await params;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}`);
  if (ctx.has('hotel.housekeeping.task_claim') && !ctx.has('hotel.stay.check_in')) {
    redirect(`${ctx.base}/cleaner`);
  }
  redirect(`${ctx.base}/rooms`);
}
