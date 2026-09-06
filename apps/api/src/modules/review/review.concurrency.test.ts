import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewHarness } from './test-support/review-harness';
import { createReviewHarness, newReviewRequest } from './test-support/review-harness';

/**
 * The races Phase 16 exists to lose safely.
 *
 * The aggregate is the one that matters: doc 10 §6 makes it the number every
 * visitor sees, and a lost update there is a wrong average that nothing later
 * recomputes. What orders these is the aggregate's own row lock and the
 * revision compare-and-set on top of it — a test that stubbed either would be
 * asserting about a hope.
 */

let h: ReviewHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `review-con-${String(keys)}`;
};
const COMMENT = 'Маш тухтай, цэвэрхэн өрөө байлаа. Баярлалаа.';

beforeAll(async () => {
  h = await createReviewHarness('review_con');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('two reviews published at the same instant', () => {
  it('counts both, and the average is the one the sum implies', async () => {
    const hotel = await h.booking.bookableHotel('parallel-write', 6);
    const guests = await Promise.all([1, 2, 3, 4, 5].map(() => h.booking.guest()));
    const stays = [];
    for (const guest of guests) stays.push(await h.completedStay(hotel, guest));

    const outcomes = await Promise.allSettled(
      stays.map((stay, index) =>
        h.reviews.write(
          {
            bookingId: stay.bookingId,
            rating: index + 1,
            comment: COMMENT,
            idempotencyKey: key(),
          },
          newReviewRequest(stay.accountId),
        ),
      ),
    );
    // Every one of them is a legitimate review of its own booking, so every one
    // has to land: the aggregate serialises them, it does not reject them.
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(5);

    const row = await h.admin.query<{
      published_count: number;
      rating_sum: string;
      average: number;
    }>(
      `SELECT published_count, rating_sum, average_rating_centi AS average
         FROM platform.hotel_review_aggregate WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    // 1+2+3+4+5 = 15 over 5, exactly 3.00 — no update lost.
    expect(row.rows[0]).toMatchObject({ published_count: 5, rating_sum: '15', average: 300 });
    const counted = await h.admin.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(rating), 0)::text AS total
         FROM platform.hotel_review WHERE hotel_id = $1 AND status = 'PUBLISHED'`,
      [hotel.hotelId],
    );
    // And the stored aggregate equals what the rows actually say.
    expect(counted.rows[0]).toMatchObject({ n: '5', total: '15' });
  }, 300_000);
});

describe('a hide and an owner delete committing together', () => {
  it('removes the rating from the aggregate exactly once', async () => {
    const hotel = await h.booking.bookableHotel('hide-vs-delete', 3);
    const moderator = await h.moderator();
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 4, comment: COMMENT, idempotencyKey: key() },
      newReviewRequest(guest),
    );

    const outcomes = await Promise.allSettled([
      h.moderation.hide(
        {
          reviewId: written.reviewId,
          reason: 'SPAM_FRAUD',
          note: 'Зэрэг ирсэн шийдвэр, шалгасан.',
          idempotencyKey: key(),
        },
        moderator,
        newReviewRequest(moderator.principal.accountId),
      ),
      h.reviews.softDelete(
        { reviewId: written.reviewId, idempotencyKey: key() },
        newReviewRequest(guest),
      ),
    ]);
    // Both are valid commands on a published review, so which one wins is the
    // lock's decision — but the aggregate loses the rating once either way.
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);

    const row = await h.admin.query<{ published_count: number; rating_sum: string }>(
      `SELECT published_count, rating_sum FROM platform.hotel_review_aggregate WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(row.rows[0]).toMatchObject({ published_count: 0, rating_sum: '0' });
    // And the row is in exactly one of the two terminal states, never both.
    const status = await h.admin.query<{ status: string }>(
      `SELECT status FROM platform.hotel_review WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(['HIDDEN', 'DELETED']).toContain(status.rows[0]?.status);
  }, 300_000);
});

describe('one booking, two reviews at once', () => {
  it('the UNIQUE index lets exactly one through', async () => {
    const hotel = await h.booking.bookableHotel('one-review', 3);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);

    const outcomes = await Promise.allSettled([
      h.reviews.write(
        { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
        newReviewRequest(guest),
      ),
      h.reviews.write(
        { bookingId: stay.bookingId, rating: 1, comment: COMMENT, idempotencyKey: key() },
        newReviewRequest(guest),
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const count = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.hotel_review WHERE booking_id = $1`,
      [stay.bookingId],
    );
    expect(count.rows[0]?.n).toBe('1');
  }, 300_000);
});

describe('one review, two replies at once', () => {
  it('the UNIQUE index on review_id lets exactly one through', async () => {
    const hotel = await h.booking.bookableHotel('one-reply', 3);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      newReviewRequest(guest),
    );
    const manager = hotel.manager;
    const context = newReviewRequest(manager.principal.accountId);
    const outcomes = await Promise.allSettled([
      h.replies.reply(
        {
          hotelId: hotel.hotelId,
          reviewId: written.reviewId,
          body: 'Эхний албан ёсны хариу байна.',
          idempotencyKey: key(),
        },
        manager,
        context,
      ),
      h.replies.reply(
        {
          hotelId: hotel.hotelId,
          reviewId: written.reviewId,
          body: 'Хоёр дахь албан ёсны хариу байна.',
          idempotencyKey: key(),
        },
        manager,
        context,
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const count = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.hotel_review_reply WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(count.rows[0]?.n).toBe('1');
  }, 300_000);
});

describe('one review, two reports from the same account at once', () => {
  it('leaves exactly one open report', async () => {
    const hotel = await h.booking.bookableHotel('one-report', 3);
    const author = await h.booking.guest();
    const reporter = await h.booking.guest();
    const stay = await h.completedStay(hotel, author);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 1, comment: COMMENT, idempotencyKey: key() },
      newReviewRequest(author),
    );
    const outcomes = await Promise.allSettled([
      h.reports.report(
        { reviewId: written.reviewId, reason: 'SPAM_FRAUD', idempotencyKey: key() },
        newReviewRequest(reporter),
      ),
      h.reports.report(
        { reviewId: written.reviewId, reason: 'ABUSE_ILLEGAL', idempotencyKey: key() },
        newReviewRequest(reporter),
      ),
    ]);
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    const count = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.review_report
        WHERE review_id = $1 AND account_id = $2 AND state = 'OPEN'`,
      [written.reviewId, reporter],
    );
    expect(count.rows[0]?.n).toBe('1');
  }, 300_000);
});
