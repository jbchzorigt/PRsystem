import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@prsystem/contracts';
import type { ReviewHarness } from './test-support/review-harness';
import {
  createReviewHarness,
  newPublicRequest,
  newReviewRequest,
} from './test-support/review-harness';

/**
 * Verified reviews, end to end, against real PostgreSQL (doc 10;
 * `RV-DEC-001`–`007`, `BK-DEC-004`–`007`).
 *
 * Two of the phase's three gates live here — the database uniqueness on the
 * review's booking and the reply's review, and the aggregate's correctness
 * after every visibility transition. The third, the authorization one, is in
 * the security suite.
 */

let h: ReviewHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `review-int-${String(keys)}`;
};
const request = (accountId: string) => newReviewRequest(accountId);
const COMMENT = 'Маш тухтай, цэвэрхэн өрөө байлаа. Баярлалаа.';

beforeAll(async () => {
  h = await createReviewHarness('review_int');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

describe('eligibility (RV-DEC-002, BK-DEC-005)', () => {
  it('a completed booking earns exactly one review', async () => {
    const hotel = await h.booking.bookableHotel('eligible', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);

    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    expect(written.rating).toBe(5);
    expect(written.hotelId).toBe(hotel.hotelId);
    // The masked name, and never the account's own (doc 10 §8).
    expect(written.displayName).toMatch(/\*\*\*$|^Зочин$/);

    // GATE — the second review for the same booking is refused by the database.
    await expect(
      h.reviews.write(
        { bookingId: stay.bookingId, rating: 3, comment: COMMENT, idempotencyKey: key() },
        request(guest),
      ),
    ).rejects.toThrow(/REVIEW_EXISTS/);
  }, 180_000);

  it('refuses a booking that never completed, in every non-completed state', async () => {
    const hotel = await h.booking.bookableHotel('not-completed', 3);
    const guest = await h.booking.guest();
    for (const state of ['HOLDING', 'CONFIRMED', 'CANCELLED_GUEST', 'NO_SHOW', 'EXPIRED']) {
      const bookingId = await h.unfinishedBooking(hotel, guest, state);
      await expect(
        h.reviews.write(
          { bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
          request(guest),
        ),
      ).rejects.toThrow(/NOT_A_COMPLETED_STAY/);
    }
  }, 180_000);

  it('refuses another guest’s booking with the same answer as one that does not exist', async () => {
    const hotel = await h.booking.bookableHotel('not-mine', 2);
    const mine = await h.booking.guest();
    const theirs = await h.booking.guest();
    const stay = await h.completedStay(hotel, mine);

    const stranger = await h.reviews
      .write(
        { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
        request(theirs),
      )
      .catch((error: ApiError) => error);
    const missing = await h.reviews
      .write(
        {
          bookingId: '00000000-0000-4000-8000-000000000000',
          rating: 5,
          comment: COMMENT,
          idempotencyKey: key(),
        },
        request(theirs),
      )
      .catch((error: ApiError) => error);
    expect((stranger as ApiError).code).toBe((missing as ApiError).code);
    expect((stranger as ApiError).message).toBe((missing as ApiError).message);
  }, 180_000);

  it('refuses a review once the 30 days from checkout have passed (RV-DEC-003)', async () => {
    const hotel = await h.booking.bookableHotel('window', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest, 31);
    await expect(
      h.reviews.write(
        { bookingId: stay.bookingId, rating: 4, comment: COMMENT, idempotencyKey: key() },
        request(guest),
      ),
    ).rejects.toThrow(/REVIEW_WINDOW_CLOSED/);
  }, 180_000);

  it('re-checks the deadline at submission, not when the form was opened', async () => {
    const hotel = await h.booking.bookableHotel('late-submit', 2);
    const guest = await h.booking.guest();
    // Twenty-nine days ago: the window is open now and closes in a day.
    const stay = await h.completedStay(hotel, guest, 29);
    h.advance(2 * 86_400);
    await expect(
      h.reviews.write(
        { bookingId: stay.bookingId, rating: 4, comment: COMMENT, idempotencyKey: key() },
        request(guest),
      ),
    ).rejects.toThrow(/REVIEW_WINDOW_CLOSED/);
  }, 180_000);
});

describe('input rules (RV-DEC-003)', () => {
  it('refuses a rating outside 1–5 and a comment outside 10–1000 once trimmed', async () => {
    const hotel = await h.booking.bookableHotel('input', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    for (const rating of [0, 6, 4.5]) {
      await expect(
        h.reviews.write(
          { bookingId: stay.bookingId, rating, comment: COMMENT, idempotencyKey: key() },
          request(guest),
        ),
      ).rejects.toThrow(/rating/);
    }
    for (const comment of ['   ', 'богино', 'a'.repeat(1001)]) {
      await expect(
        h.reviews.write(
          { bookingId: stay.bookingId, rating: 5, comment, idempotencyKey: key() },
          request(guest),
        ),
      ).rejects.toThrow(/comment/);
    }
  }, 180_000);

  it('stores the trimmed comment, so padding is not length', async () => {
    const hotel = await h.booking.bookableHotel('trim', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      {
        bookingId: stay.bookingId,
        rating: 5,
        comment: `   ${COMMENT}   `,
        idempotencyKey: key(),
      },
      request(guest),
    );
    expect(written.comment).toBe(COMMENT);
  }, 180_000);
});

describe('the owner’s edit and delete (RV-DEC-004, BK-DEC-007)', () => {
  it('edits inside the window, keeps the previous words, and marks the row edited', async () => {
    const hotel = await h.booking.bookableHotel('edit', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    const edited = await h.reviews.edit(
      {
        reviewId: written.reviewId,
        rating: 3,
        comment: 'Дахин бодоход дунд зэрэг байсан юм байна.',
        idempotencyKey: key(),
      },
      request(guest),
    );
    expect(edited.rating).toBe(3);
    expect(edited.edited).toBe(true);
    const history = await h.admin.query<{ from_rating: number; from_comment: string }>(
      `SELECT from_rating, from_comment FROM platform.hotel_review_edit WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(history.rows[0]?.from_rating).toBe(5);
    expect(history.rows[0]?.from_comment).toBe(COMMENT);
  }, 180_000);

  it('refuses an edit after the window, and still allows the delete', async () => {
    const hotel = await h.booking.bookableHotel('late-edit', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest, 1);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    h.advance(31 * 86_400);
    await expect(
      h.reviews.edit(
        { reviewId: written.reviewId, rating: 1, comment: COMMENT, idempotencyKey: key() },
        request(guest),
      ),
    ).rejects.toThrow(/REVIEW_WINDOW_CLOSED/);
    // doc 10 §7.1: the delete has no deadline.
    const deleted = await h.reviews.softDelete(
      { reviewId: written.reviewId, idempotencyKey: key() },
      request(guest),
    );
    expect(deleted.status).toBe('DELETED');
  }, 180_000);

  it('keeps the booking occupied after a delete, so no second review is possible', async () => {
    const hotel = await h.booking.bookableHotel('deleted-booking', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    await h.reviews.softDelete(
      { reviewId: written.reviewId, idempotencyKey: key() },
      request(guest),
    );
    await expect(
      h.reviews.write(
        { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
        request(guest),
      ),
    ).rejects.toThrow(/REVIEW_EXISTS/);
    // The row is soft-deleted, not gone.
    const rows = await h.admin.query<{ status: string; comment: string }>(
      `SELECT status, comment FROM platform.hotel_review WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(rows.rows[0]?.status).toBe('DELETED');
    expect(rows.rows[0]?.comment).toBe(COMMENT);
  }, 180_000);

  it('refuses to edit or delete somebody else’s review', async () => {
    const hotel = await h.booking.bookableHotel('other-owner', 2);
    const mine = await h.booking.guest();
    const theirs = await h.booking.guest();
    const stay = await h.completedStay(hotel, mine);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(mine),
    );
    await expect(
      h.reviews.edit(
        { reviewId: written.reviewId, rating: 1, comment: COMMENT, idempotencyKey: key() },
        request(theirs),
      ),
    ).rejects.toThrow(/no such review/);
    await expect(
      h.reviews.softDelete({ reviewId: written.reviewId, idempotencyKey: key() }, request(theirs)),
    ).rejects.toThrow(/no such review/);
  }, 180_000);
});

describe('GATE — the aggregate after every visibility transition (doc 10 §6)', () => {
  it('counts a publish, an edit, a hide, a restore and a delete, exactly', async () => {
    const hotel = await h.booking.bookableHotel('aggregate', 4);
    const moderator = await h.moderator();
    const first = await h.booking.guest();
    const second = await h.booking.guest();
    const stayOne = await h.completedStay(hotel, first);
    const stayTwo = await h.completedStay(hotel, second);

    const readAggregate = async () =>
      (
        await h.admin.query<{ published_count: number; rating_sum: string; average: number }>(
          `SELECT published_count, rating_sum, average_rating_centi AS average
             FROM platform.hotel_review_aggregate WHERE hotel_id = $1`,
          [hotel.hotelId],
        )
      ).rows[0];

    const one = await h.reviews.write(
      { bookingId: stayOne.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(first),
    );
    expect(await readAggregate()).toMatchObject({
      published_count: 1,
      rating_sum: '5',
      average: 500,
    });

    const two = await h.reviews.write(
      { bookingId: stayTwo.bookingId, rating: 4, comment: COMMENT, idempotencyKey: key() },
      request(second),
    );
    expect(await readAggregate()).toMatchObject({
      published_count: 2,
      rating_sum: '9',
      average: 450,
    });

    // An edit moves the sum and not the count.
    await h.reviews.edit(
      { reviewId: two.reviewId, rating: 2, comment: COMMENT, idempotencyKey: key() },
      request(second),
    );
    expect(await readAggregate()).toMatchObject({
      published_count: 2,
      rating_sum: '7',
      average: 350,
    });

    // A hide removes it from both.
    await h.moderation.hide(
      {
        reviewId: two.reviewId,
        reason: 'SPAM_FRAUD',
        note: 'Давтагдсан агуулга, шалгасан.',
        idempotencyKey: key(),
      },
      moderator,
      newReviewRequest(moderator.principal.accountId),
    );
    expect(await readAggregate()).toMatchObject({
      published_count: 1,
      rating_sum: '5',
      average: 500,
    });

    // A restore puts it back, at the rating it had.
    await h.moderation.restore(
      { reviewId: two.reviewId, note: 'Дахин шалгаад сэргээв.', idempotencyKey: key() },
      moderator,
      newReviewRequest(moderator.principal.accountId),
    );
    expect(await readAggregate()).toMatchObject({
      published_count: 2,
      rating_sum: '7',
      average: 350,
    });

    // And the owner's delete removes it again.
    await h.reviews.softDelete({ reviewId: one.reviewId, idempotencyKey: key() }, request(first));
    expect(await readAggregate()).toMatchObject({
      published_count: 1,
      rating_sum: '2',
      average: 200,
    });
  }, 300_000);

  it('does not double-remove when a hidden review is then deleted by its owner', async () => {
    const hotel = await h.booking.bookableHotel('hidden-then-deleted', 2);
    const moderator = await h.moderator();
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    await h.moderation.hide(
      {
        reviewId: written.reviewId,
        reason: 'ABUSE_ILLEGAL',
        note: 'Зохисгүй үг хэллэг агуулсан.',
        idempotencyKey: key(),
      },
      moderator,
      newReviewRequest(moderator.principal.accountId),
    );
    await h.reviews.softDelete(
      { reviewId: written.reviewId, idempotencyKey: key() },
      request(guest),
    );
    const row = await h.admin.query<{ published_count: number; rating_sum: string }>(
      `SELECT published_count, rating_sum FROM platform.hotel_review_aggregate WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(row.rows[0]).toMatchObject({ published_count: 0, rating_sum: '0' });
  }, 180_000);
});

describe('moderation (RV-DEC-005, RV-DEC-006)', () => {
  it('never restores a review its owner deleted', async () => {
    const hotel = await h.booking.bookableHotel('no-undelete', 2);
    const moderator = await h.moderator();
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    await h.reviews.softDelete(
      { reviewId: written.reviewId, idempotencyKey: key() },
      request(guest),
    );
    await expect(
      h.moderation.restore(
        { reviewId: written.reviewId, note: 'Сэргээх оролдлого.', idempotencyKey: key() },
        moderator,
        newReviewRequest(moderator.principal.accountId),
      ),
    ).rejects.toThrow();
  }, 180_000);

  it('requires an approved reason and a note, and refuses a bare dislike', async () => {
    const hotel = await h.booking.bookableHotel('reason', 2);
    const moderator = await h.moderator();
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 1, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    const context = newReviewRequest(moderator.principal.accountId);
    await expect(
      h.moderation.hide(
        {
          reviewId: written.reviewId,
          reason: 'BAD_RATING',
          note: 'Муу үнэлгээ.',
          idempotencyKey: key(),
        },
        moderator,
        context,
      ),
    ).rejects.toThrow(/PERSONAL_DATA/);
    await expect(
      h.moderation.hide(
        { reviewId: written.reviewId, reason: 'SPAM_FRAUD', note: 'богино', idempotencyKey: key() },
        moderator,
        context,
      ),
    ).rejects.toThrow(/note is mandatory/);
  }, 180_000);

  it('records the hide with the actor, the permission and both states', async () => {
    const hotel = await h.booking.bookableHotel('audit', 2);
    const moderator = await h.moderator();
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 2, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    await h.moderation.hide(
      {
        reviewId: written.reviewId,
        reason: 'PERSONAL_DATA',
        note: 'Хувийн мэдээлэл агуулсан тул нуув.',
        idempotencyKey: key(),
      },
      moderator,
      newReviewRequest(moderator.principal.accountId),
    );
    const events = await h.admin.query<{
      action: string;
      permission: string;
      actor_account_id: string;
      from_status: string;
      to_status: string;
    }>(
      `SELECT action, permission, actor_account_id, from_status, to_status
         FROM platform.review_moderation_event WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(events.rows[0]).toMatchObject({
      action: 'HIDE',
      permission: 'REVIEW_MODERATE',
      actor_account_id: moderator.principal.accountId,
      from_status: 'PUBLISHED',
      to_status: 'HIDDEN',
    });
  }, 180_000);
});

describe('the report (RV-DEC-005)', () => {
  it('lets any other guest report, and keeps one open report per account', async () => {
    const hotel = await h.booking.bookableHotel('report', 2);
    const author = await h.booking.guest();
    const reporter = await h.booking.guest();
    const stay = await h.completedStay(hotel, author);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 1, comment: COMMENT, idempotencyKey: key() },
      request(author),
    );
    const first = await h.reports.report(
      { reviewId: written.reviewId, reason: 'SPAM_FRAUD', idempotencyKey: key() },
      request(reporter),
    );
    expect(first.state).toBe('OPEN');
    // A repeat submission answers with the same report rather than creating a
    // second (doc 10 §7.2).
    const again = await h.reports.report(
      { reviewId: written.reviewId, reason: 'SPAM_FRAUD', idempotencyKey: key() },
      request(reporter),
    );
    expect(again.reportId).toBe(first.reportId);
    const count = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.review_report WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(count.rows[0]?.n).toBe('1');

    // And the review is untouched: a report hides nothing.
    const status = await h.admin.query<{ status: string }>(
      `SELECT status FROM platform.hotel_review WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(status.rows[0]?.status).toBe('PUBLISHED');
  }, 180_000);

  it('requires an explanation for OTHER and refuses one for the other three', async () => {
    const hotel = await h.booking.bookableHotel('report-note', 2);
    const author = await h.booking.guest();
    const reporter = await h.booking.guest();
    const stay = await h.completedStay(hotel, author);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 1, comment: COMMENT, idempotencyKey: key() },
      request(author),
    );
    await expect(
      h.reports.report(
        { reviewId: written.reviewId, reason: 'OTHER', idempotencyKey: key() },
        request(reporter),
      ),
    ).rejects.toThrow(/OTHER explains itself/);
    await expect(
      h.reports.report(
        {
          reviewId: written.reviewId,
          reason: 'SPAM_FRAUD',
          note: 'Энэ бол нэмэлт тайлбар юм.',
          idempotencyKey: key(),
        },
        request(reporter),
      ),
    ).rejects.toThrow(/only a report of OTHER/);
  }, 180_000);

  it('refuses the author reporting their own review', async () => {
    const hotel = await h.booking.bookableHotel('self-report', 2);
    const author = await h.booking.guest();
    const stay = await h.completedStay(hotel, author);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 1, comment: COMMENT, idempotencyKey: key() },
      request(author),
    );
    await expect(
      h.reports.report(
        { reviewId: written.reviewId, reason: 'SPAM_FRAUD', idempotencyKey: key() },
        request(author),
      ),
    ).rejects.toThrow(/own review/);
  }, 180_000);

  it('decides a report once, and never twice', async () => {
    const hotel = await h.booking.bookableHotel('resolve', 2);
    const moderator = await h.moderator();
    const author = await h.booking.guest();
    const reporter = await h.booking.guest();
    const stay = await h.completedStay(hotel, author);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 1, comment: COMMENT, idempotencyKey: key() },
      request(author),
    );
    const reported = await h.reports.report(
      { reviewId: written.reviewId, reason: 'ABUSE_ILLEGAL', idempotencyKey: key() },
      request(reporter),
    );
    const context = newReviewRequest(moderator.principal.accountId);
    const queue = await h.moderation.queue(moderator, 50, context);
    expect(queue.map((entry) => entry.reportId)).toContain(reported.reportId);

    const decided = await h.moderation.resolveReport(
      {
        reportId: reported.reportId,
        resolution: 'DISMISSED',
        note: 'Шалгасан, зөрчил илрээгүй.',
        idempotencyKey: key(),
      },
      moderator,
      context,
    );
    expect(decided.resolution).toBe('DISMISSED');
    await expect(
      h.moderation.resolveReport(
        {
          reportId: reported.reportId,
          resolution: 'UPHELD',
          note: 'Дахин шийдвэрлэх оролдлого.',
          idempotencyKey: key(),
        },
        moderator,
        context,
      ),
    ).rejects.toThrow(/no such open report/);
  }, 180_000);
});

describe('GATE — one official reply per review (RV-DEC-007)', () => {
  it('writes one, refuses a second, edits it and restores the same record', async () => {
    const hotel = await h.booking.bookableHotel('reply', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 4, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    const manager = hotel.manager;
    const context = newReviewRequest(manager.principal.accountId);
    const body = 'Сэтгэгдэл үлдээсэнд баярлалаа. Дахин хүлээж байна.';
    const reply = await h.replies.reply(
      { hotelId: hotel.hotelId, reviewId: written.reviewId, body, idempotencyKey: key() },
      manager,
      context,
    );
    expect(reply.state).toBe('ACTIVE');

    await expect(
      h.replies.reply(
        { hotelId: hotel.hotelId, reviewId: written.reviewId, body, idempotencyKey: key() },
        manager,
        context,
      ),
    ).rejects.toThrow(/REPLY_EXISTS/);

    const edited = await h.replies.editReply(
      {
        hotelId: hotel.hotelId,
        reviewId: written.reviewId,
        body: 'Засварласан албан ёсны хариу байна.',
        idempotencyKey: key(),
      },
      manager,
      context,
    );
    expect(edited.edited).toBe(true);
    expect(edited.replyId).toBe(reply.replyId);

    await h.replies.setReplyState(
      {
        hotelId: hotel.hotelId,
        reviewId: written.reviewId,
        state: 'DELETED',
        idempotencyKey: key(),
      },
      manager,
      context,
    );
    // A soft-deleted reply is restored, never replaced.
    await expect(
      h.replies.reply(
        { hotelId: hotel.hotelId, reviewId: written.reviewId, body, idempotencyKey: key() },
        manager,
        context,
      ),
    ).rejects.toThrow(/REPLY_DELETED/);
    const restored = await h.replies.setReplyState(
      {
        hotelId: hotel.hotelId,
        reviewId: written.reviewId,
        state: 'ACTIVE',
        idempotencyKey: key(),
      },
      manager,
      context,
    );
    expect(restored.replyId).toBe(reply.replyId);

    const count = await h.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.hotel_review_reply WHERE review_id = $1`,
      [written.reviewId],
    );
    expect(count.rows[0]?.n).toBe('1');
  }, 180_000);
});

describe('the public surface (BK-DEC-004, doc 10 §6)', () => {
  it('shows the rating on the listing and the reviews on the page, and hides what is hidden', async () => {
    const hotel = await h.booking.bookableHotel('public', 3);
    const moderator = await h.moderator();
    const first = await h.booking.guest();
    const second = await h.booking.guest();
    const stayOne = await h.completedStay(hotel, first);
    const stayTwo = await h.completedStay(hotel, second);
    await h.reviews.write(
      { bookingId: stayOne.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(first),
    );
    const two = await h.reviews.write(
      { bookingId: stayTwo.bookingId, rating: 3, comment: COMMENT, idempotencyKey: key() },
      request(second),
    );

    const listed = await h.publicSearch.detail({ hotelId: hotel.hotelId }, newPublicRequest());
    expect(listed.reviewCount).toBe(2);
    expect(listed.averageRatingCenti).toBe(400);

    const page = await h.publicSearch.reviews({ hotelId: hotel.hotelId }, newPublicRequest());
    expect(page.reviews).toHaveLength(2);
    // doc 10 §8: no account, no booking, no contact detail on the public page.
    const serialised = JSON.stringify(page.reviews);
    expect(serialised).not.toContain(first);
    expect(serialised).not.toContain(stayOne.bookingId);

    await h.moderation.hide(
      {
        reviewId: two.reviewId,
        reason: 'SPAM_FRAUD',
        note: 'Хуурамч сэтгэгдэл гэж дүгнэв.',
        idempotencyKey: key(),
      },
      moderator,
      newReviewRequest(moderator.principal.accountId),
    );
    const after = await h.publicSearch.reviews({ hotelId: hotel.hotelId }, newPublicRequest());
    expect(after.reviews.map((r) => r.reviewId)).not.toContain(two.reviewId);
    const relisted = await h.publicSearch.detail({ hotelId: hotel.hotelId }, newPublicRequest());
    expect(relisted.reviewCount).toBe(1);
    expect(relisted.averageRatingCenti).toBe(500);
  }, 300_000);

  it('shows a live reply and stops showing it once the reply is withdrawn', async () => {
    const hotel = await h.booking.bookableHotel('public-reply', 2);
    const guest = await h.booking.guest();
    const stay = await h.completedStay(hotel, guest);
    const written = await h.reviews.write(
      { bookingId: stay.bookingId, rating: 5, comment: COMMENT, idempotencyKey: key() },
      request(guest),
    );
    const manager = hotel.manager;
    const context = newReviewRequest(manager.principal.accountId);
    await h.replies.reply(
      {
        hotelId: hotel.hotelId,
        reviewId: written.reviewId,
        body: 'Танд баярлалаа, дахин ирээрэй.',
        idempotencyKey: key(),
      },
      manager,
      context,
    );
    const withReply = await h.publicSearch.reviews({ hotelId: hotel.hotelId }, newPublicRequest());
    expect(withReply.reviews[0]?.reply?.body).toContain('баярлалаа');

    await h.replies.setReplyState(
      {
        hotelId: hotel.hotelId,
        reviewId: written.reviewId,
        state: 'DELETED',
        idempotencyKey: key(),
      },
      manager,
      context,
    );
    const without = await h.publicSearch.reviews({ hotelId: hotel.hotelId }, newPublicRequest());
    expect(without.reviews[0]?.reply).toBeNull();
  }, 180_000);
});
