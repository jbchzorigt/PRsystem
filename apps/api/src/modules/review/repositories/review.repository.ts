import type { UnitOfWork } from '@prsystem/db';
import type {
  Aggregate,
  ReplyState,
  ReportReason,
  ReportResolution,
  ReportState,
  ReviewStatus,
} from '../domain/review';

/**
 * The review module's own storage, and nothing else's.
 *
 * Every read that a command decides on takes the row `FOR UPDATE` first: a
 * review's status, a report's state and a reply's existence are all things two
 * requests can race for, and the row lock is what orders them (CLAUDE.md §6).
 */

type Row = Record<string, unknown>;

export interface ReviewRow {
  readonly reviewId: string;
  readonly hotelId: string;
  readonly bookingId: string;
  readonly accountId: string;
  readonly rating: number;
  readonly comment: string;
  readonly displayNameSnapshot: string;
  readonly status: ReviewStatus;
  readonly reviewDeadlineAt: Date;
  readonly edited: boolean;
  readonly hiddenAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revision: number;
}

export interface ReportRow {
  readonly reportId: string;
  readonly hotelId: string;
  readonly reviewId: string;
  readonly accountId: string;
  readonly reason: ReportReason;
  readonly note: string | null;
  readonly state: ReportState;
  readonly resolution: ReportResolution | null;
  readonly createdAt: Date;
  readonly revision: number;
}

export interface ReplyRow {
  readonly replyId: string;
  readonly hotelId: string;
  readonly reviewId: string;
  readonly body: string;
  readonly state: ReplyState;
  readonly edited: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revision: number;
}

export interface AggregateRow extends Aggregate {
  readonly hotelId: string;
  readonly revision: number;
}

const REVIEW_COLUMNS = `review_id, hotel_id, booking_id, account_id, rating, comment,
  display_name_snapshot, status, review_deadline_at, edited, hidden_at, deleted_at,
  created_at, updated_at, revision`;
const REPORT_COLUMNS = `report_id, hotel_id, review_id, account_id, reason, note, state,
  resolution, created_at, revision`;
const REPLY_COLUMNS = `reply_id, hotel_id, review_id, body, state, edited, created_at,
  updated_at, revision`;

function mapReview(row: Row | undefined): ReviewRow | undefined {
  if (row === undefined) return undefined;
  return {
    reviewId: String(row['review_id']),
    hotelId: String(row['hotel_id']),
    bookingId: String(row['booking_id']),
    accountId: String(row['account_id']),
    rating: Number(row['rating']),
    comment: String(row['comment']),
    displayNameSnapshot: String(row['display_name_snapshot']),
    status: row['status'] as ReviewStatus,
    reviewDeadlineAt: row['review_deadline_at'] as Date,
    edited: row['edited'] === true,
    hiddenAt: (row['hidden_at'] as Date | null) ?? null,
    deletedAt: (row['deleted_at'] as Date | null) ?? null,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
    revision: Number(row['revision']),
  };
}

function mapReport(row: Row | undefined): ReportRow | undefined {
  if (row === undefined) return undefined;
  return {
    reportId: String(row['report_id']),
    hotelId: String(row['hotel_id']),
    reviewId: String(row['review_id']),
    accountId: String(row['account_id']),
    reason: row['reason'] as ReportReason,
    note: (row['note'] as string | null) ?? null,
    state: row['state'] as ReportState,
    resolution: (row['resolution'] as ReportResolution | null) ?? null,
    createdAt: row['created_at'] as Date,
    revision: Number(row['revision']),
  };
}

function mapReply(row: Row | undefined): ReplyRow | undefined {
  if (row === undefined) return undefined;
  return {
    replyId: String(row['reply_id']),
    hotelId: String(row['hotel_id']),
    reviewId: String(row['review_id']),
    body: String(row['body']),
    state: row['state'] as ReplyState,
    edited: row['edited'] === true,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
    revision: Number(row['revision']),
  };
}

export class ReviewRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ------------------------------------------------------------- the review

  async createReview(input: {
    hotelId: string;
    bookingId: string;
    accountId: string;
    rating: number;
    comment: string;
    displayNameSnapshot: string;
    reviewDeadlineAt: Date;
  }): Promise<ReviewRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.hotel_review
         (hotel_id, booking_id, account_id, rating, comment, display_name_snapshot,
          review_deadline_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
       RETURNING ${REVIEW_COLUMNS}`,
      [
        input.hotelId,
        input.bookingId,
        input.accountId,
        input.rating,
        input.comment,
        input.displayNameSnapshot,
        input.reviewDeadlineAt,
      ],
    );
    const row = mapReview(result.rows[0]);
    if (row === undefined) throw new Error('the review insert returned no row');
    return row;
  }

  async lockReview(reviewId: string): Promise<ReviewRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REVIEW_COLUMNS} FROM platform.hotel_review WHERE review_id = $1 FOR UPDATE`,
      [reviewId],
    );
    return mapReview(result.rows[0]);
  }

  async reviewById(reviewId: string): Promise<ReviewRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REVIEW_COLUMNS} FROM platform.hotel_review WHERE review_id = $1`,
      [reviewId],
    );
    return mapReview(result.rows[0]);
  }

  /** doc 10 §7.1: the owner's own reviews, in every status they are in. */
  async reviewsForAccount(accountId: string): Promise<readonly ReviewRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${REVIEW_COLUMNS} FROM platform.hotel_review
        WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId],
    );
    return result.rows.map((row) => mapReview(row)).filter((r): r is ReviewRow => r !== undefined);
  }

  /** A compare-and-set on the revision: the loser of a race re-reads. */
  async updateReview(input: {
    reviewId: string;
    expectedRevision: number;
    rating?: number;
    comment?: string;
    status?: ReviewStatus;
    edited?: boolean;
    hiddenAt?: Date | null;
    hiddenByAccountId?: string | null;
    deletedAt?: Date | null;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.hotel_review
          SET rating = COALESCE($3, rating),
              comment = COALESCE($4, comment),
              status = COALESCE($5, status),
              edited = COALESCE($6, edited),
              hidden_at = CASE WHEN $9 THEN $7::timestamptz ELSE hidden_at END,
              hidden_by_account_id = CASE WHEN $9 THEN $10::uuid ELSE hidden_by_account_id END,
              deleted_at = CASE WHEN $11 THEN $8::timestamptz ELSE deleted_at END,
              updated_at = $12,
              revision = revision + 1
        WHERE review_id = $1 AND revision = $2`,
      [
        input.reviewId,
        input.expectedRevision,
        input.rating ?? null,
        input.comment ?? null,
        input.status ?? null,
        input.edited ?? null,
        input.hiddenAt ?? null,
        input.deletedAt ?? null,
        input.hiddenAt !== undefined,
        input.hiddenByAccountId ?? null,
        input.deletedAt !== undefined,
        input.at,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async recordEdit(input: {
    hotelId: string;
    reviewId: string;
    accountId: string;
    fromRating: number;
    fromComment: string;
    toRating: number;
    toComment: string;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.hotel_review_edit
         (hotel_id, review_id, account_id, from_rating, from_comment, to_rating, to_comment)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
      [
        input.hotelId,
        input.reviewId,
        input.accountId,
        input.fromRating,
        input.fromComment,
        input.toRating,
        input.toComment,
      ],
    );
  }

  // ---------------------------------------------------------- the aggregate

  /**
   * The hotel's aggregate, created empty on first use and locked.
   *
   * Locked because every visibility transition reads it, changes it and writes
   * it back: two reviews published at the same instant would otherwise both
   * read the same count and one of them would be lost.
   */
  async lockAggregate(hotelId: string): Promise<AggregateRow> {
    await this.uow.query(
      `INSERT INTO platform.hotel_review_aggregate (hotel_id)
       VALUES ($1::uuid) ON CONFLICT (hotel_id) DO NOTHING`,
      [hotelId],
    );
    const result = await this.uow.query<Row>(
      `SELECT hotel_id, published_count, rating_sum, average_rating_centi, revision
         FROM platform.hotel_review_aggregate WHERE hotel_id = $1 FOR UPDATE`,
      [hotelId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the review aggregate vanished under its own lock');
    return {
      hotelId: String(row['hotel_id']),
      publishedCount: Number(row['published_count']),
      ratingSum: BigInt(String(row['rating_sum'])),
      averageRatingCenti: Number(row['average_rating_centi']),
      revision: Number(row['revision']),
    };
  }

  async setAggregate(input: {
    hotelId: string;
    expectedRevision: number;
    aggregate: Aggregate;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.hotel_review_aggregate
          SET published_count = $3, rating_sum = $4::bigint, average_rating_centi = $5,
              updated_at = $6, revision = revision + 1
        WHERE hotel_id = $1 AND revision = $2`,
      [
        input.hotelId,
        input.expectedRevision,
        input.aggregate.publishedCount,
        input.aggregate.ratingSum.toString(),
        input.aggregate.averageRatingCenti,
        input.at,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async aggregateOf(hotelId: string): Promise<AggregateRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT hotel_id, published_count, rating_sum, average_rating_centi, revision
         FROM platform.hotel_review_aggregate WHERE hotel_id = $1`,
      [hotelId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      hotelId: String(row['hotel_id']),
      publishedCount: Number(row['published_count']),
      ratingSum: BigInt(String(row['rating_sum'])),
      averageRatingCenti: Number(row['average_rating_centi']),
      revision: Number(row['revision']),
    };
  }

  // ------------------------------------------------------------- the report

  async createReport(input: {
    hotelId: string;
    reviewId: string;
    accountId: string;
    reason: ReportReason;
    note: string | null;
  }): Promise<ReportRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.review_report (hotel_id, review_id, account_id, reason, note)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
       RETURNING ${REPORT_COLUMNS}`,
      [input.hotelId, input.reviewId, input.accountId, input.reason, input.note],
    );
    const row = mapReport(result.rows[0]);
    if (row === undefined) throw new Error('the report insert returned no row');
    return row;
  }

  async lockReport(reportId: string): Promise<ReportRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REPORT_COLUMNS} FROM platform.review_report WHERE report_id = $1 FOR UPDATE`,
      [reportId],
    );
    return mapReport(result.rows[0]);
  }

  /** doc 10 §7.2: this account's open report on this review, if it has one. */
  async openReportBy(reviewId: string, accountId: string): Promise<ReportRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REPORT_COLUMNS} FROM platform.review_report
        WHERE review_id = $1 AND account_id = $2 AND state = 'OPEN'`,
      [reviewId, accountId],
    );
    return mapReport(result.rows[0]);
  }

  async openReportsFor(reviewId: string): Promise<readonly ReportRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${REPORT_COLUMNS} FROM platform.review_report
        WHERE review_id = $1 AND state = 'OPEN' ORDER BY created_at`,
      [reviewId],
    );
    return result.rows.map((row) => mapReport(row)).filter((r): r is ReportRow => r !== undefined);
  }

  /** The moderation queue: open reports across every hotel of this tenant scope. */
  async openReports(limit: number): Promise<readonly ReportRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${REPORT_COLUMNS} FROM platform.review_report
        WHERE state = 'OPEN' ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => mapReport(row)).filter((r): r is ReportRow => r !== undefined);
  }

  async resolveReport(input: {
    reportId: string;
    expectedRevision: number;
    resolution: ReportResolution;
    resolvedByAccountId: string;
    resolutionNote: string;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.review_report
          SET state = 'RESOLVED', resolved_at = $5, resolved_by_account_id = $3::uuid,
              resolution = $4, resolution_note = $6, revision = revision + 1
        WHERE report_id = $1 AND revision = $2 AND state = 'OPEN'`,
      [
        input.reportId,
        input.expectedRevision,
        input.resolvedByAccountId,
        input.resolution,
        input.at,
        input.resolutionNote,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async recordModeration(input: {
    hotelId: string;
    reviewId: string;
    reportId: string | null;
    action: 'HIDE' | 'RESTORE' | 'REPORT_RESOLVE';
    actorAccountId: string;
    reason: string;
    note: string;
    fromStatus: ReviewStatus | null;
    toStatus: ReviewStatus | null;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.review_moderation_event
         (hotel_id, review_id, report_id, action, actor_account_id, permission, reason, note,
          from_status, to_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'REVIEW_MODERATE', $6, $7, $8, $9)`,
      [
        input.hotelId,
        input.reviewId,
        input.reportId,
        input.action,
        input.actorAccountId,
        input.reason,
        input.note,
        input.fromStatus,
        input.toStatus,
      ],
    );
  }

  // -------------------------------------------------------------- the reply

  async createReply(input: {
    hotelId: string;
    reviewId: string;
    body: string;
    createdByAccountId: string;
  }): Promise<ReplyRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.hotel_review_reply (hotel_id, review_id, body, created_by_account_id)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
       RETURNING ${REPLY_COLUMNS}`,
      [input.hotelId, input.reviewId, input.body, input.createdByAccountId],
    );
    const row = mapReply(result.rows[0]);
    if (row === undefined) throw new Error('the reply insert returned no row');
    return row;
  }

  async lockReplyFor(reviewId: string): Promise<ReplyRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REPLY_COLUMNS} FROM platform.hotel_review_reply
        WHERE review_id = $1 FOR UPDATE`,
      [reviewId],
    );
    return mapReply(result.rows[0]);
  }

  async replyFor(reviewId: string): Promise<ReplyRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REPLY_COLUMNS} FROM platform.hotel_review_reply WHERE review_id = $1`,
      [reviewId],
    );
    return mapReply(result.rows[0]);
  }

  async updateReply(input: {
    replyId: string;
    expectedRevision: number;
    body?: string;
    state?: ReplyState;
    edited?: boolean;
    deletedAt?: Date | null;
    updatedByAccountId: string;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.hotel_review_reply
          SET body = COALESCE($3, body),
              state = COALESCE($4, state),
              edited = COALESCE($5, edited),
              deleted_at = CASE WHEN $8 THEN $6::timestamptz ELSE deleted_at END,
              updated_by_account_id = $7::uuid,
              updated_at = $9,
              revision = revision + 1
        WHERE reply_id = $1 AND revision = $2`,
      [
        input.replyId,
        input.expectedRevision,
        input.body ?? null,
        input.state ?? null,
        input.edited ?? null,
        input.deletedAt ?? null,
        input.updatedByAccountId,
        input.deletedAt !== undefined,
        input.at,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async recordReplyEvent(input: {
    hotelId: string;
    replyId: string;
    reviewId: string;
    action: 'CREATE' | 'EDIT' | 'DELETE' | 'RESTORE';
    actorAccountId: string;
    fromBody: string | null;
    toBody: string | null;
    fromState: string | null;
    toState: string | null;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.hotel_review_reply_event
         (hotel_id, reply_id, review_id, action, actor_account_id, from_body, to_body,
          from_state, to_state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8, $9)`,
      [
        input.hotelId,
        input.replyId,
        input.reviewId,
        input.action,
        input.actorAccountId,
        input.fromBody,
        input.toBody,
        input.fromState,
        input.toState,
      ],
    );
  }

  /** The hotel's own reviews, for the staff surface that replies to them. */
  async reviewsForHotel(hotelId: string, limit: number): Promise<readonly ReviewRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${REVIEW_COLUMNS} FROM platform.hotel_review
        WHERE hotel_id = $1 AND status = 'PUBLISHED'
        ORDER BY created_at DESC LIMIT $2`,
      [hotelId, limit],
    );
    return result.rows.map((row) => mapReview(row)).filter((r): r is ReviewRow => r !== undefined);
  }
}
