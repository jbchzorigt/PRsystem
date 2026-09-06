import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import type { ReviewHarness } from './test-support/review-harness';
import { createReviewHarness, newReviewRequest } from './test-support/review-harness';
import { rejectServerOwnedFields } from './http/review-validation';

/**
 * GATE — no role name grants report or moderation rights (build-plan §"Phase
 * 16"; doc 10 §7.3, `RV-DEC-005`, `RBAC-DEC-015`).
 *
 * Three separate claims, and each is proved against the real matrix and the
 * real pipeline rather than against a description of them:
 *
 * * no hotel role — Hotel Admin included — can hide, restore or report;
 * * `OPERATION_ADMIN` and `PLATFORM_SUPER_ADMIN` as *names* grant nothing: what
 *   grants moderation is the explicit `REVIEW_MODERATE` row, and revoking it
 *   closes the door again;
 * * the Guest boundary of Phases 12–15 still holds over this phase's data.
 */

let h: ReviewHarness;
let keys = 0;
const key = (): string => {
  keys += 1;
  return `review-sec-${String(keys)}`;
};
const COMMENT = 'Маш тухтай, цэвэрхэн өрөө байлаа. Баярлалаа.';
const NOTE = 'Шалгаж үзээд шийдвэр гаргав.';

beforeAll(async () => {
  h = await createReviewHarness('review_sec');
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h?.resetClock();
});

async function publishedReview(name: string): Promise<{
  hotel: Awaited<ReturnType<ReviewHarness['booking']['bookableHotel']>>;
  reviewId: string;
  accountId: string;
}> {
  const hotel = await h.booking.bookableHotel(name, 2);
  const guest = await h.booking.guest();
  const stay = await h.completedStay(hotel, guest);
  const written = await h.reviews.write(
    { bookingId: stay.bookingId, rating: 3, comment: COMMENT, idempotencyKey: key() },
    newReviewRequest(guest),
  );
  return { hotel, reviewId: written.reviewId, accountId: guest };
}

describe('the matrix itself says no role name grants these', () => {
  it('refuses report and moderation to every hotel column', async () => {
    const { HOTEL_ACTIONS } = await import('@prsystem/authz');
    for (const id of ['hotel.review.report_by_hotel_role', 'hotel.review.moderation_queue']) {
      const row = HOTEL_ACTIONS.find((action) => action.id === id);
      expect(row).toBeDefined();
      const cells = Object.values(row?.cells ?? {});
      expect(cells.length).toBeGreaterThan(0);
      // Every column is a refusal, so no role and no package reaches it.
      expect(cells.every((cell) => cell.kind === 'deny')).toBe(true);
    }
  }, 120_000);

  it('grants the official reply to Hotel Admin and Manager on every package, Manager Plus on 30,000₮ alone', async () => {
    const { HOTEL_ACTIONS } = await import('@prsystem/authz');
    const row = HOTEL_ACTIONS.find((a) => a.id === 'hotel.review.official_reply_manage');
    expect(row).toBeDefined();
    const cells = row?.cells as Record<string, { kind: string; packages?: readonly string[] }>;
    expect(cells['HOTEL_ADMIN']?.kind).toBe('allow');
    expect(cells['MANAGER']?.kind).toBe('allow');
    expect(cells['MANAGER_PLUS']?.packages).toEqual(['P30']);
    for (const column of ['RECEPTION', 'CLEANER', 'RESTAURANT_MANAGER']) {
      expect(cells[column]?.kind).toBe('deny');
    }
  }, 120_000);

  it('names REVIEW_MODERATE as a Platform permission, grantable to neither hotel nor police', async () => {
    const { OPERATION_ACTIONS, OPERATION_PERMISSIONS } = await import('@prsystem/authz');
    expect(OPERATION_PERMISSIONS).toContain('REVIEW_MODERATE');
    const action = OPERATION_ACTIONS.find((a) => a.id === 'operation.review_moderate');
    expect(action?.permission).toBe('REVIEW_MODERATE');
    // doc 10 §7.3: a high-risk action, so it carries a step-up requirement.
    expect(action?.stepUp).toBe(true);
  }, 120_000);
});

describe('GATE — moderation needs the explicit grant, not a role name', () => {
  it('refuses an OPERATION_ADMIN who holds no REVIEW_MODERATE', async () => {
    const published = await publishedReview('no-grant');
    const bare = await h.moderator({ granted: false });
    await expect(
      h.moderation.hide(
        { reviewId: published.reviewId, reason: 'SPAM_FRAUD', note: NOTE, idempotencyKey: key() },
        bare,
        newReviewRequest(bare.principal.accountId),
      ),
    ).rejects.toThrow();
    const status = await h.admin.query<{ status: string }>(
      `SELECT status FROM platform.hotel_review WHERE review_id = $1`,
      [published.reviewId],
    );
    expect(status.rows[0]?.status).toBe('PUBLISHED');
  }, 180_000);

  it('refuses a PLATFORM_SUPER_ADMIN who holds no REVIEW_MODERATE either', async () => {
    const published = await publishedReview('super-admin');
    const bare = await h.moderator({ granted: false, role: 'PLATFORM_SUPER_ADMIN' });
    await expect(
      h.moderation.queue(bare, 10, newReviewRequest(bare.principal.accountId)),
    ).rejects.toThrow();
    await expect(
      h.moderation.hide(
        { reviewId: published.reviewId, reason: 'SPAM_FRAUD', note: NOTE, idempotencyKey: key() },
        bare,
        newReviewRequest(bare.principal.accountId),
      ),
    ).rejects.toThrow();
  }, 180_000);

  it('allows the same account once the grant exists, and refuses again once revoked', async () => {
    const published = await publishedReview('grant-lifecycle');
    const moderator = await h.moderator();
    const context = newReviewRequest(moderator.principal.accountId);
    const hidden = await h.moderation.hide(
      { reviewId: published.reviewId, reason: 'PERSONAL_DATA', note: NOTE, idempotencyKey: key() },
      moderator,
      context,
    );
    expect(hidden.status).toBe('HIDDEN');

    // The pipeline re-reads the grant inside the command's own transaction, so
    // a revocation that commits first wins over a request authorised a moment
    // earlier.
    await h.admin.query(
      `UPDATE platform.account_permission_grant
          SET revoked_at = now(), revoked_by_account_id = account_id,
              revoked_reason = 'security test'
        WHERE account_id = $1 AND permission = 'REVIEW_MODERATE'`,
      [moderator.principal.accountId],
    );
    await expect(
      h.moderation.restore(
        { reviewId: published.reviewId, note: NOTE, idempotencyKey: key() },
        moderator,
        context,
      ),
    ).rejects.toThrow();
    const still = await h.admin.query<{ status: string }>(
      `SELECT status FROM platform.hotel_review WHERE review_id = $1`,
      [published.reviewId],
    );
    expect(still.rows[0]?.status).toBe('HIDDEN');
  }, 180_000);

  it('refuses a moderator whose step-up has gone stale (doc 05 §5)', async () => {
    const published = await publishedReview('stale-step-up');
    const moderator = await h.moderator();
    const stale = {
      ...moderator,
      principal: {
        ...moderator.principal,
        stepUpAt: new Date(Date.now() - 60 * 60_000),
      },
    } as typeof moderator;
    await expect(
      h.moderation.hide(
        { reviewId: published.reviewId, reason: 'SPAM_FRAUD', note: NOTE, idempotencyKey: key() },
        stale,
        newReviewRequest(stale.principal.accountId),
      ),
    ).rejects.toThrow();
  }, 180_000);

  it('grants no Platform account the power to hard-delete or rewrite a review', async () => {
    const published = await publishedReview('no-hard-delete');
    // The database refuses it whoever asks, which is the guarantee doc 10 §7.3
    // asks for — not a missing route.
    await expect(
      h.admin.query(`DELETE FROM platform.hotel_review WHERE review_id = $1`, [published.reviewId]),
    ).rejects.toThrow();
    const row = await h.admin.query<{ comment: string }>(
      `SELECT comment FROM platform.hotel_review WHERE review_id = $1`,
      [published.reviewId],
    );
    expect(row.rows[0]?.comment).toBe(COMMENT);
  }, 180_000);
});

describe('GATE — no hotel role touches a review', () => {
  it('refuses a hotel actor the moderation commands outright', async () => {
    const published = await publishedReview('hotel-moderation');
    // A Hotel Admin is a Hotel-realm principal, so the Operation endpoint
    // refuses at stage 1: realms never merge (CLAUDE.md §4).
    const admin = published.hotel.manager;
    await expect(
      h.moderation.hide(
        { reviewId: published.reviewId, reason: 'SPAM_FRAUD', note: NOTE, idempotencyKey: key() },
        admin,
        newReviewRequest(admin.principal.accountId),
      ),
    ).rejects.toThrow();
  }, 180_000);

  it('lets a hotel reply and nothing more: the review’s own rows are untouched', async () => {
    const published = await publishedReview('reply-only');
    const manager = published.hotel.manager;
    const context = newReviewRequest(manager.principal.accountId);
    await h.replies.reply(
      {
        hotelId: published.hotel.hotelId,
        reviewId: published.reviewId,
        body: 'Сэтгэгдэлд баярлалаа, засах зүйлээ анхаарлаа.',
        idempotencyKey: key(),
      },
      manager,
      context,
    );
    const row = await h.admin.query<{ rating: number; comment: string; status: string }>(
      `SELECT rating, comment, status FROM platform.hotel_review WHERE review_id = $1`,
      [published.reviewId],
    );
    expect(row.rows[0]).toMatchObject({ rating: 3, comment: COMMENT, status: 'PUBLISHED' });
  }, 180_000);

  it('refuses a reply to another hotel’s review', async () => {
    const mine = await publishedReview('tenant-a');
    const other = await h.booking.bookableHotel('tenant-b', 2);
    const manager = other.manager;
    await expect(
      h.replies.reply(
        {
          hotelId: other.hotelId,
          reviewId: mine.reviewId,
          body: 'Өөр буудлын сэтгэгдэлд хариулах оролдлого.',
          idempotencyKey: key(),
        },
        manager,
        newReviewRequest(manager.principal.accountId),
      ),
    ).rejects.toThrow(/no such review/);
  }, 180_000);
});

describe('the Guest boundary over this phase’s data', () => {
  it('shows a guest their own reviews and no hotel tenant table', async () => {
    const mine = await publishedReview('guest-scope');
    const theirs = await publishedReview('guest-scope-other');

    await withTenantTransaction(
      h.api,
      {
        hotelId: PLATFORM_SCOPE,
        realm: 'guest',
        actorRef: mine.accountId,
        accountId: mine.accountId,
        correlationId: 'review-sec-scope',
      },
      async (uow) => {
        const reviews = await uow.query<{ review_id: string }>(
          `SELECT review_id FROM platform.hotel_review`,
        );
        expect(reviews.rows.map((r) => r.review_id)).toEqual([mine.reviewId]);
        expect(reviews.rows.map((r) => r.review_id)).not.toContain(theirs.reviewId);

        // Nothing else of the hotel's is visible in this scope, because no
        // hotel carries the platform sentinel as its id.
        for (const relation of [
          'platform.hotel_review_reply',
          'platform.hotel_review_aggregate',
          'platform.review_moderation_event',
          'platform.hotel_review_reply_event',
          'platform.stay',
          'platform.room',
        ]) {
          const rows = await uow.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${relation}`,
          );
          expect({ relation, n: rows.rows[0]?.n }).toEqual({ relation, n: '0' });
        }
      },
    );
  }, 300_000);

  it('shows a guest nothing at all when the scope names no account', async () => {
    await publishedReview('anonymous-scope');
    await withTenantTransaction(
      h.api,
      {
        hotelId: PLATFORM_SCOPE,
        realm: 'guest',
        actorRef: 'anonymous',
        correlationId: 'review-sec-anon',
      },
      async (uow) => {
        const rows = await uow.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM platform.hotel_review`,
        );
        // No account, no rows: the policy compares against a NULL and matches
        // nothing rather than falling back to everything.
        expect(rows.rows[0]?.n).toBe('0');
      },
    );
  }, 180_000);

  it('answers identically for another guest’s review and one that never existed', async () => {
    const mine = await publishedReview('opaque');
    const stranger = await h.booking.guest();
    const foreign = await h.reviews
      .edit(
        { reviewId: mine.reviewId, rating: 1, comment: COMMENT, idempotencyKey: key() },
        newReviewRequest(stranger),
      )
      .catch((error: ApiError) => error);
    const missing = await h.reviews
      .edit(
        {
          reviewId: '00000000-0000-4000-8000-000000000000',
          rating: 1,
          comment: COMMENT,
          idempotencyKey: key(),
        },
        newReviewRequest(stranger),
      )
      .catch((error: ApiError) => error);
    expect((foreign as ApiError).code).toBe((missing as ApiError).code);
    expect((foreign as ApiError).message).toBe((missing as ApiError).message);
  }, 180_000);
});

describe('the server owns the identity, the tenant and the status', () => {
  it('refuses a request that names a hotel, an account, a status or a deadline', () => {
    for (const field of [
      'hotelId',
      'accountId',
      'status',
      'bookingState',
      'reviewDeadlineAt',
      'actualCheckoutAt',
      'displayName',
      'edited',
    ]) {
      expect(() => rejectServerOwnedFields({ [field]: 'anything' })).toThrow(ApiError);
      expect(() => rejectServerOwnedFields({ [field.toUpperCase()]: 'x' })).toThrow(ApiError);
    }
  });

  it('publishes no reviewer identity: the masked name, and nothing behind it', async () => {
    const published = await publishedReview('privacy');
    const page = await h.admin.query<{
      display_name_snapshot: string;
      comment: string;
      account_id: string;
    }>(
      `SELECT display_name_snapshot, comment, account_id
         FROM platform.hotel_review WHERE review_id = $1`,
      [published.reviewId],
    );
    const stored = page.rows[0];
    expect(stored?.display_name_snapshot).not.toBe(stored?.account_id);
    // doc 10 §8: the public projection returns no account, booking or room.
    const projected = await h.admin.query<Record<string, unknown>>(
      `SELECT * FROM platform.public_hotel_reviews($1::uuid, 20, 0)`,
      [published.hotel.hotelId],
    );
    const columns = Object.keys(projected.rows[0] ?? {});
    for (const forbidden of ['account_id', 'booking_id', 'hotel_id', 'room_id', 'status']) {
      expect(columns).not.toContain(forbidden);
    }
  }, 180_000);
});

describe('the Police realm is refused', () => {
  it('holds no privilege on any review relation', async () => {
    const grants = await h.admin.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND grantee = 'prsystem_police'
          AND table_name = ANY($1)`,
      [
        [
          'hotel_review',
          'hotel_review_edit',
          'hotel_review_aggregate',
          'review_report',
          'review_moderation_event',
          'hotel_review_reply',
          'hotel_review_reply_event',
        ],
      ],
    );
    expect(grants.rows.map((row) => row.table_name)).toEqual([]);
  }, 120_000);

  it('grants the worker nothing either: this phase has no job at all', async () => {
    const grants = await h.admin.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND grantee = 'prsystem_worker'
          AND table_name LIKE '%review%'`,
    );
    expect(grants.rows.map((row) => row.table_name)).toEqual([]);
  }, 120_000);
});
