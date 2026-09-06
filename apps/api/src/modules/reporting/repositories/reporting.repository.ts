import type { UnitOfWork } from '@prsystem/db';

/**
 * The reporting module's own storage: export jobs, download grants, retention
 * snapshots, legal holds and expense categories.
 *
 * Nothing else. Every fact a report is *about* belongs to another module and
 * arrives through a contract — this file writes only the rows Phase 17 itself
 * introduced.
 */

type Row = Record<string, unknown>;

export const EXPORT_KINDS = [
  'GUEST_REGISTRY',
  'ROOM_SALES',
  'MINIBAR_SALES',
  'EXPENSE',
  'PAYMENT_BREAKDOWN',
] as const;

export type ExportKind = (typeof EXPORT_KINDS)[number];

export type ExportState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface ExportJobRow {
  readonly jobId: string;
  readonly hotelId: string;
  readonly kind: ExportKind;
  readonly state: ExportState;
  readonly filters: Record<string, unknown>;
  readonly timeZone: string;
  readonly policyVersion: number;
  readonly rowCount: number | null;
  readonly storageKey: string | null;
  readonly contentHash: string | null;
  readonly requestedByAccountId: string;
  readonly requestedAt: Date;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
  readonly failureReason: string | null;
  readonly revision: number;
}

export interface RetentionRow {
  readonly stayId: string;
  readonly hotelId: string;
  readonly policyVersion: number;
  readonly retentionDays: number;
  readonly checkoutAt: Date;
  readonly retentionExpiresAt: Date;
  readonly anonymizedAt: Date | null;
  readonly revision: number;
}

export interface LegalHoldRow {
  readonly holdId: string;
  readonly hotelId: string;
  readonly stayId: string | null;
  readonly reason: string;
  readonly authorityReference: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly releasedAt: Date | null;
  readonly revision: number;
}

export interface ExpenseCategoryRow {
  readonly categoryId: string;
  readonly hotelId: string;
  readonly name: string;
  readonly kind: 'INVENTORY_PURCHASE' | 'OPERATING';
  readonly state: 'ACTIVE' | 'INACTIVE';
  readonly revision: number;
}

const JOB_COLUMNS = `job_id, hotel_id, kind, state, filters, timezone, policy_version,
  row_count, storage_key, content_hash, requested_by_account_id, requested_at,
  ready_at, expires_at, failure_reason, revision`;

function mapJob(row: Row | undefined): ExportJobRow | undefined {
  if (row === undefined) return undefined;
  return {
    jobId: String(row['job_id']),
    hotelId: String(row['hotel_id']),
    kind: row['kind'] as ExportKind,
    state: row['state'] as ExportState,
    filters: (row['filters'] as Record<string, unknown>) ?? {},
    timeZone: String(row['timezone']),
    policyVersion: Number(row['policy_version']),
    rowCount: row['row_count'] === null ? null : Number(row['row_count']),
    storageKey: (row['storage_key'] as string | null) ?? null,
    contentHash: (row['content_hash'] as string | null) ?? null,
    requestedByAccountId: String(row['requested_by_account_id']),
    requestedAt: row['requested_at'] as Date,
    readyAt: (row['ready_at'] as Date | null) ?? null,
    expiresAt: (row['expires_at'] as Date | null) ?? null,
    failureReason: (row['failure_reason'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

export class ReportingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ----------------------------------------------------------- export jobs

  async createJob(input: {
    hotelId: string;
    kind: ExportKind;
    filters: Record<string, unknown>;
    timeZone: string;
    policyVersion: number;
    requestedByAccountId: string;
  }): Promise<ExportJobRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.report_export_job
         (hotel_id, kind, filters, timezone, policy_version, requested_by_account_id)
       VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6::uuid)
       RETURNING ${JOB_COLUMNS}`,
      [
        input.hotelId,
        input.kind,
        JSON.stringify(input.filters),
        input.timeZone,
        input.policyVersion,
        input.requestedByAccountId,
      ],
    );
    const row = mapJob(result.rows[0]);
    if (row === undefined) throw new Error('the export job insert returned no row');
    return row;
  }

  async lockJob(jobId: string): Promise<ExportJobRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${JOB_COLUMNS} FROM platform.report_export_job WHERE job_id = $1 FOR UPDATE`,
      [jobId],
    );
    return mapJob(result.rows[0]);
  }

  async jobById(jobId: string): Promise<ExportJobRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${JOB_COLUMNS} FROM platform.report_export_job WHERE job_id = $1`,
      [jobId],
    );
    return mapJob(result.rows[0]);
  }

  async jobsFor(hotelId: string, limit: number): Promise<readonly ExportJobRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${JOB_COLUMNS} FROM platform.report_export_job
        WHERE hotel_id = $1 ORDER BY requested_at DESC LIMIT $2`,
      [hotelId, limit],
    );
    return result.rows.map((row) => mapJob(row)).filter((r): r is ExportJobRow => r !== undefined);
  }

  async startJob(jobId: string, expectedRevision: number, at: Date): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.report_export_job
          SET state = 'RUNNING', started_at = $3, revision = revision + 1
        WHERE job_id = $1 AND revision = $2 AND state = 'QUEUED'`,
      [jobId, expectedRevision, at],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * The file is ready: its count, its key, its hash, and the hour it lives.
   *
   * The expiry is written from `ready_at` here and the CHECK recomputes it, so
   * a caller cannot hand in an hour of its own choosing.
   */
  async completeJob(input: {
    jobId: string;
    expectedRevision: number;
    rowCount: number;
    storageKey: string;
    contentHash: string;
    readyAt: Date;
    expiresAt: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.report_export_job
          SET state = 'COMPLETED', row_count = $3, storage_key = $4, content_hash = $5,
              ready_at = $6, expires_at = $7, revision = revision + 1
        WHERE job_id = $1 AND revision = $2 AND state = 'RUNNING'`,
      [
        input.jobId,
        input.expectedRevision,
        input.rowCount,
        input.storageKey,
        input.contentHash,
        input.readyAt,
        input.expiresAt,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async failJob(input: {
    jobId: string;
    expectedRevision: number;
    reason: string;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.report_export_job
          SET state = 'FAILED', failed_at = $4, failure_reason = $3, revision = revision + 1
        WHERE job_id = $1 AND revision = $2 AND state <> ALL (ARRAY['COMPLETED', 'EXPIRED'])`,
      [input.jobId, input.expectedRevision, input.reason.slice(0, 500), input.at],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** The file is gone; the job says so and keeps its count and its hash. */
  async expireJob(jobId: string, expectedRevision: number, at: Date): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.report_export_job
          SET state = 'EXPIRED', expired_at = $3, storage_key = NULL, revision = revision + 1
        WHERE job_id = $1 AND revision = $2 AND state = 'COMPLETED'`,
      [jobId, expectedRevision, at],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** One signed URL handed out. Append-only, and it touches no job column. */
  async recordGrant(input: {
    hotelId: string;
    jobId: string;
    issuedByAccountId: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<string> {
    const result = await this.uow.query<{ grant_id: string }>(
      `INSERT INTO platform.report_export_grant
         (hotel_id, job_id, issued_by_account_id, issued_at, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
       RETURNING grant_id`,
      [input.hotelId, input.jobId, input.issuedByAccountId, input.issuedAt, input.expiresAt],
    );
    const id = result.rows[0]?.grant_id;
    if (id === undefined) throw new Error('the download grant insert returned no row');
    return id;
  }

  async grantsFor(jobId: string): Promise<readonly { issuedAt: Date; expiresAt: Date }[]> {
    const result = await this.uow.query<Row>(
      `SELECT issued_at, expires_at FROM platform.report_export_grant
        WHERE job_id = $1 ORDER BY issued_at DESC`,
      [jobId],
    );
    return result.rows.map((row) => ({
      issuedAt: row['issued_at'] as Date,
      expiresAt: row['expires_at'] as Date,
    }));
  }

  // ------------------------------------------------------------- retention

  /** The hotel's current policy, created at the MVP default on first use. */
  async currentPolicy(
    hotelId: string,
    defaultDays: number,
    at: Date,
  ): Promise<{
    version: number;
    retentionDays: number;
  }> {
    const existing = await this.uow.query<{ version: number; retention_days: number }>(
      `SELECT version, retention_days FROM platform.retention_policy
        WHERE hotel_id = $1 AND effective_at <= $2
        ORDER BY version DESC LIMIT 1`,
      [hotelId, at],
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      return { version: Number(found.version), retentionDays: Number(found.retention_days) };
    }
    const created = await this.uow.query<{ version: number; retention_days: number }>(
      `INSERT INTO platform.retention_policy
         (hotel_id, version, retention_days, effective_at, owner, legal_basis)
       VALUES ($1::uuid, 1, $2, $3, 'platform product default',
               'doc 12 §9 MVP product retention, pending the EXT-08 legal basis')
       ON CONFLICT (hotel_id, version) DO NOTHING
       RETURNING version, retention_days`,
      [hotelId, defaultDays, at],
    );
    const row = created.rows[0];
    if (row !== undefined) {
      return { version: Number(row.version), retentionDays: Number(row.retention_days) };
    }
    // Another transaction created version 1 first; read what it wrote.
    return this.currentPolicy(hotelId, defaultDays, at);
  }

  async recordRetention(input: {
    stayId: string;
    hotelId: string;
    policyVersion: number;
    retentionDays: number;
    checkoutAt: Date;
    retentionExpiresAt: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `INSERT INTO platform.stay_retention
         (stay_id, hotel_id, retention_policy_version, retention_days, checkout_at,
          retention_expires_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
       ON CONFLICT (stay_id) DO NOTHING`,
      [
        input.stayId,
        input.hotelId,
        input.policyVersion,
        input.retentionDays,
        input.checkoutAt,
        input.retentionExpiresAt,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async lockRetention(stayId: string): Promise<RetentionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT stay_id, hotel_id, retention_policy_version, retention_days, checkout_at,
              retention_expires_at, anonymized_at, revision
         FROM platform.stay_retention WHERE stay_id = $1 FOR UPDATE`,
      [stayId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      stayId: String(row['stay_id']),
      hotelId: String(row['hotel_id']),
      policyVersion: Number(row['retention_policy_version']),
      retentionDays: Number(row['retention_days']),
      checkoutAt: row['checkout_at'] as Date,
      retentionExpiresAt: row['retention_expires_at'] as Date,
      anonymizedAt: (row['anonymized_at'] as Date | null) ?? null,
      revision: Number(row['revision']),
    };
  }

  async markAnonymized(input: {
    stayId: string;
    expectedRevision: number;
    at: Date;
    reason: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.stay_retention
          SET anonymized_at = $3, anonymized_reason = $4, revision = revision + 1
        WHERE stay_id = $1 AND revision = $2 AND anonymized_at IS NULL`,
      [input.stayId, input.expectedRevision, input.at, input.reason],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** doc 12 §9: a live hold covering this stay, or the whole hotel. */
  async liveHoldFor(stayId: string, at: Date): Promise<LegalHoldRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT hold_id, hotel_id, stay_id, reason, authority_reference, starts_at, ends_at,
              released_at, revision
         FROM platform.retention_legal_hold
        WHERE (stay_id = $1::uuid OR stay_id IS NULL)
          AND released_at IS NULL
          AND starts_at <= $2
          AND (ends_at IS NULL OR ends_at > $2)
        ORDER BY starts_at LIMIT 1`,
      [stayId, at],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      holdId: String(row['hold_id']),
      hotelId: String(row['hotel_id']),
      stayId: (row['stay_id'] as string | null) ?? null,
      reason: String(row['reason']),
      authorityReference: String(row['authority_reference']),
      startsAt: row['starts_at'] as Date,
      endsAt: (row['ends_at'] as Date | null) ?? null,
      releasedAt: (row['released_at'] as Date | null) ?? null,
      revision: Number(row['revision']),
    };
  }

  async createHold(input: {
    hotelId: string;
    stayId: string | null;
    reason: string;
    authorityReference: string;
    imposedByAccountId: string;
    endsAt: Date | null;
  }): Promise<string> {
    const result = await this.uow.query<{ hold_id: string }>(
      `INSERT INTO platform.retention_legal_hold
         (hotel_id, stay_id, reason, authority_reference, imposed_by_account_id, ends_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
       RETURNING hold_id`,
      [
        input.hotelId,
        input.stayId,
        input.reason,
        input.authorityReference,
        input.imposedByAccountId,
        input.endsAt,
      ],
    );
    const id = result.rows[0]?.hold_id;
    if (id === undefined) throw new Error('the legal hold insert returned no row');
    return id;
  }

  async releaseHold(input: {
    holdId: string;
    expectedRevision: number;
    releasedByAccountId: string;
    reason: string;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.retention_legal_hold
          SET released_at = $5, released_by_account_id = $3::uuid, released_reason = $4,
              revision = revision + 1
        WHERE hold_id = $1 AND revision = $2 AND released_at IS NULL`,
      [input.holdId, input.expectedRevision, input.releasedByAccountId, input.reason, input.at],
    );
    return (result.rowCount ?? 0) === 1;
  }

  // ------------------------------------------------------ expense category

  async createCategory(input: {
    hotelId: string;
    name: string;
    kind: 'INVENTORY_PURCHASE' | 'OPERATING';
    createdByAccountId: string;
  }): Promise<ExpenseCategoryRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.expense_category (hotel_id, name, kind, created_by_account_id)
       VALUES ($1::uuid, $2, $3, $4::uuid)
       RETURNING category_id, hotel_id, name, kind, state, revision`,
      [input.hotelId, input.name, input.kind, input.createdByAccountId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the expense category insert returned no row');
    return {
      categoryId: String(row['category_id']),
      hotelId: String(row['hotel_id']),
      name: String(row['name']),
      kind: row['kind'] as 'INVENTORY_PURCHASE' | 'OPERATING',
      state: row['state'] as 'ACTIVE' | 'INACTIVE',
      revision: Number(row['revision']),
    };
  }

  async categories(hotelId: string): Promise<readonly ExpenseCategoryRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT category_id, hotel_id, name, kind, state, revision
         FROM platform.expense_category WHERE hotel_id = $1 ORDER BY name`,
      [hotelId],
    );
    return result.rows.map((row) => ({
      categoryId: String(row['category_id']),
      hotelId: String(row['hotel_id']),
      name: String(row['name']),
      kind: row['kind'] as 'INVENTORY_PURCHASE' | 'OPERATING',
      state: row['state'] as 'ACTIVE' | 'INACTIVE',
      revision: Number(row['revision']),
    }));
  }

  async lockCategory(categoryId: string): Promise<ExpenseCategoryRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT category_id, hotel_id, name, kind, state, revision
         FROM platform.expense_category WHERE category_id = $1 FOR UPDATE`,
      [categoryId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      categoryId: String(row['category_id']),
      hotelId: String(row['hotel_id']),
      name: String(row['name']),
      kind: row['kind'] as 'INVENTORY_PURCHASE' | 'OPERATING',
      state: row['state'] as 'ACTIVE' | 'INACTIVE',
      revision: Number(row['revision']),
    };
  }

  /** doc 23 §4.4: a used category is deactivated, and reactivated, not deleted. */
  async setCategoryState(input: {
    categoryId: string;
    expectedRevision: number;
    state: 'ACTIVE' | 'INACTIVE';
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.expense_category
          SET state = $3,
              deactivated_at = CASE WHEN $3 = 'INACTIVE' THEN $4::timestamptz ELSE NULL END,
              revision = revision + 1
        WHERE category_id = $1 AND revision = $2`,
      [input.categoryId, input.expectedRevision, input.state, input.at],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
