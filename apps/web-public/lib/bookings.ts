import { GUEST } from './copy';

/** The Guest booking view as the API returns it (booking, hold, payment and refund states kept apart). */
export interface BookingRow {
  readonly bookingId: string;
  readonly bookingRef: string;
  readonly hotelId: string;
  readonly categoryId: string;
  readonly stayingGuestName: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly nightCount: number;
  readonly state: string;
  readonly holdState: string;
  readonly paymentState: string;
  readonly refundState: string;
  readonly holdExpiresAt: string;
  readonly totalAmountMnt: string | null;
}

export const stateLabel = (state: string): string => GUEST.states[state] ?? state;
