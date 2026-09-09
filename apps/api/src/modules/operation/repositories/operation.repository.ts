import type { UnitOfWork } from '@prsystem/db';

/**
 * Every statement Phase 19 issues against its own tables and its resolvers.
 *
 * Two conventions carried from the modules before it. Anything the dashboard
 * reads across hotels goes through a `SECURITY DEFINER` resolver, so the
 * registered email is masked before it leaves the database rather than after it
 * reaches the application; and anything that decides something locks its row
 * first and compares a revision, so two operators pressing the same button
 * produce one effect.
 */

// ------------------------------------------------------------------ the factor

export interface TotpFactorRow {
  readonly accountId: string;
  readonly secretCiphertext: Buffer;
  readonly secretWrappedDek: Buffer;
  readonly secretKeyVersion: string;
  readonly digits: number;
  readonly periodSeconds: number;
  readonly lastAcceptedStep: number | null;
  readonly revision: number;
}

export interface EnrolmentRow {
  readonly enrolmentId: string;
  readonly accountId: string;
  readonly state: string;
  readonly expiresAt: Date | null;
  readonly revision: number;
}

export interface ChangeRequestRow {
  readonly requestId: string;
  readonly hotelId: string;
  readonly subscriptionId: string;
  readonly state: string;
  readonly oldPhone: string;
  readonly newPhone: string;
  readonly requestedByAccountId: string;
  readonly oldPhoneVerifiedAt: Date | null;
  readonly newPhoneVerifiedAt: Date | null;
  readonly exceptionApprovedAt: Date | null;
  readonly revision: number;
}

export interface ContactCodeRow {
  readonly codeId: string;
  readonly requestId: string;
  readonly challenge: string;
  readonly phone: string;
  readonly codeHash: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface SubscriptionRow {
  readonly subscriptionId: string;
  readonly hotelId: string;
  readonly effectivePackage: string;
  readonly termMonths: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly suspendedAt: Date | null;
  readonly revision: number;
}

export interface KpiRow {
  readonly asOf: Date;
  readonly totalHotels: number;
  readonly statusActive: number;
  readonly statusExpiringSoon: number;
  readonly statusGrace: number;
  readonly statusExpired: number;
  readonly statusSuspended: number;
  readonly packageP20: number;
  readonly packageP25: number;
  readonly packageP30: number;
  readonly inactiveApplications: number;
}

/** doc 14 §3.1: the current hotel-local calendar month, counted per message. */
export interface SmsMonthCounts {
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
}

export interface SubscriptionListRow {
  readonly hotelId: string;
  readonly subscriptionId: string;
  readonly hotelName: string;
  readonly ownerType: string;
  readonly district: string;
  readonly addressLine: string;
  readonly contactPhone: string | null;
  readonly emailMasked: string;
  readonly effectivePackage: string;
  readonly termMonths: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly suspendedAt: Date | null;
  readonly status: string;
  readonly totalRows: number;
}

export interface ApplicationQueueRow {
  readonly applicationId: string;
  readonly state: string;
  readonly queueGroup: string;
  readonly hotelName: string;
  readonly ownerType: string;
  readonly district: string;
  readonly packageCode: string;
  readonly termMonths: number;
  readonly emailMasked: string;
  readonly createdAt: Date;
  readonly stateChangedAt: Date | null;
  readonly provisionAttempts: number;
  readonly totalRows: number;
}

export interface RecipientRow {
  readonly hotelId: string;
  readonly subscriptionId: string;
  readonly hotelName: string;
  readonly phone: string | null;
  readonly status: string;
}

export interface ReconciliationRow {
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly hotelId: string | null;
  readonly applicationId: string | null;
  readonly provider: string;
  readonly providerInvoiceId: string;
  readonly providerPaymentId: string | null;
  readonly amountMnt: string;
  readonly confirmedAt: Date | null;
  readonly state: string;
}

export interface SubscriptionFilters {
  readonly name?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly ownerType?: string;
  readonly district?: string;
  readonly package?: string;
  readonly termMonths?: number;
  readonly status?: string;
  readonly expiresFrom?: Date;
  readonly expiresTo?: Date;
}

export interface RecipientFilters {
  readonly hotelIds?: readonly string[];
  readonly package?: string;
  readonly status?: string;
  readonly expiresFrom?: Date;
  readonly expiresTo?: Date;
}

export interface SmsMessageRow {
  readonly messageId: string;
  readonly jobId: string;
  readonly hotelId: string;
  readonly phone: string;
  readonly segments: number;
  readonly state: string;
  readonly providerMessageId: string | null;
}

export class OperationRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ---------------------------------------------------------------- factor

  async lockFactor(accountId: string): Promise<TotpFactorRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT account_id, secret_ciphertext, secret_wrapped_dek, secret_key_version,
              digits, period_seconds, last_accepted_step, revision
         FROM platform.operation_totp_factor
        WHERE account_id = $1
          FOR UPDATE`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      accountId: String(row['account_id']),
      secretCiphertext: row['secret_ciphertext'] as Buffer,
      secretWrappedDek: row['secret_wrapped_dek'] as Buffer,
      secretKeyVersion: String(row['secret_key_version']),
      digits: Number(row['digits']),
      periodSeconds: Number(row['period_seconds']),
      lastAcceptedStep:
        row['last_accepted_step'] === null ? null : Number(row['last_accepted_step']),
      revision: Number(row['revision']),
    };
  }

  async insertFactor(input: {
    accountId: string;
    ciphertext: Uint8Array;
    wrappedDek: Uint8Array;
    keyVersion: string;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.operation_totp_factor
         (account_id, secret_ciphertext, secret_wrapped_dek, secret_key_version)
       VALUES ($1, $2, $3, $4)`,
      [
        input.accountId,
        Buffer.from(input.ciphertext),
        Buffer.from(input.wrappedDek),
        input.keyVersion,
      ],
    );
  }

  /**
   * Records the step a code was accepted at, fenced on the revision.
   *
   * This is what makes a code single-use: two requests carrying the same six
   * digits race here, one writes and the other finds the step already consumed.
   */
  async consumeStep(accountId: string, step: number, expectedRevision: number): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.operation_totp_factor
          SET last_accepted_step = $2, revision = revision + 1
        WHERE account_id = $1 AND revision = $3
          AND (last_accepted_step IS NULL OR last_accepted_step < $2)`,
      [accountId, step, expectedRevision],
    );
    return result.rowCount === 1;
  }

  // ------------------------------------------------------------- enrolment

  async createEnrolment(input: {
    accountId: string;
    tokenHash: string;
    tokenKeyVersion: string;
    ttlSeconds: number;
    createdBy: string;
  }): Promise<string> {
    const result = await this.uow.query<{ enrolment_id: string }>(
      `INSERT INTO platform.operation_account_enrolment
         (account_id, token_hash, token_key_version, expires_at, created_by_account_id)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)
       RETURNING enrolment_id`,
      [input.accountId, input.tokenHash, input.tokenKeyVersion, input.ttlSeconds, input.createdBy],
    );
    const id = result.rows[0]?.enrolment_id;
    if (id === undefined) throw new Error('the enrolment insert returned no row');
    return id;
  }

  async lockEnrolmentByHash(tokenHash: string): Promise<EnrolmentRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT enrolment_id, account_id, state, expires_at, revision
         FROM platform.operation_account_enrolment
        WHERE token_hash = $1
          FOR UPDATE`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      enrolmentId: String(row['enrolment_id']),
      accountId: String(row['account_id']),
      state: String(row['state']),
      expiresAt: (row['expires_at'] as Date | null) ?? null,
      revision: Number(row['revision']),
    };
  }

  /** Completes the enrolment and destroys its token in one fenced write. */
  async completeEnrolment(enrolmentId: string, expectedRevision: number): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.operation_account_enrolment
          SET state = 'COMPLETED', completed_at = now(),
              token_hash = NULL, token_key_version = NULL, expires_at = NULL,
              revision = revision + 1
        WHERE enrolment_id = $1 AND revision = $2 AND state = 'PENDING'`,
      [enrolmentId, expectedRevision],
    );
    return result.rowCount === 1;
  }

  async cancelPendingEnrolments(accountId: string): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.operation_account_enrolment
          SET state = 'CANCELLED', token_hash = NULL, token_key_version = NULL,
              expires_at = NULL, revision = revision + 1
        WHERE account_id = $1 AND state = 'PENDING'`,
      [accountId],
    );
    return result.rowCount ?? 0;
  }

  // ------------------------------------------------------------- dashboard

  async kpi(asOf: Date | undefined): Promise<KpiRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT * FROM platform.operation_kpi($1::timestamptz)`,
      [asOf ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the KPI resolver returned no row');
    return {
      asOf: row['as_of'] as Date,
      totalHotels: Number(row['total_hotels']),
      statusActive: Number(row['status_active']),
      statusExpiringSoon: Number(row['status_expiring_soon']),
      statusGrace: Number(row['status_grace']),
      statusExpired: Number(row['status_expired']),
      statusSuspended: Number(row['status_suspended']),
      packageP20: Number(row['package_p20']),
      packageP25: Number(row['package_p25']),
      packageP30: Number(row['package_p30']),
      inactiveApplications: Number(row['inactive_applications']),
    };
  }

  /**
   * The SMS counters, read directly rather than through the resolver.
   *
   * These rows are the Operation realm's own and its policy admits them, so a
   * definer would be handing the login-less function owner a privilege it does
   * not need. The month is the hotel-local one doc 14 §3.1 names, and the unit
   * is the recipient message rather than the job.
   */
  async smsMonthCounts(asOf: Date | undefined): Promise<SmsMonthCounts> {
    const result = await this.uow.query<Record<string, unknown>>(
      `WITH moment AS (SELECT COALESCE($1::timestamptz, now()) AS at),
       month_window AS (
         SELECT (date_trunc('month', m.at AT TIME ZONE 'Asia/Ulaanbaatar')
                   AT TIME ZONE 'Asia/Ulaanbaatar') AS from_at,
                m.at AS to_at
           FROM moment m
       )
       SELECT count(*) FILTER (WHERE r.state = 'SENT')      AS sent,
              count(*) FILTER (WHERE r.state = 'DELIVERED') AS delivered,
              count(*) FILTER (WHERE r.state = 'FAILED')    AS failed
         FROM platform.sms_recipient_message r
        CROSS JOIN month_window w
        WHERE r.created_at >= w.from_at AND r.created_at <= w.to_at`,
      [asOf ?? null],
    );
    const row = result.rows[0];
    return {
      sent: Number(row?.['sent'] ?? 0),
      delivered: Number(row?.['delivered'] ?? 0),
      failed: Number(row?.['failed'] ?? 0),
    };
  }

  /** doc 14 §2.1, §2.2: the subscription account, named but not readable. */
  async subscriptionAccount(
    hotelId: string,
  ): Promise<{ accountId: string; emailMasked: string } | undefined> {
    const result = await this.uow.query<{ account_id: string; email_masked: string }>(
      `SELECT * FROM platform.operation_subscription_account($1::uuid)`,
      [hotelId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { accountId: row.account_id, emailMasked: row.email_masked };
  }

  async subscriptionPage(
    filters: SubscriptionFilters,
    page: { limit: number; offset: number; asOf?: Date },
  ): Promise<readonly SubscriptionListRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT * FROM platform.operation_subscription_page(
         $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::integer, $8::text,
         $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::integer, $13::integer)`,
      [
        filters.name ?? null,
        filters.phone ?? null,
        filters.email ?? null,
        filters.ownerType ?? null,
        filters.district ?? null,
        filters.package ?? null,
        filters.termMonths ?? null,
        filters.status ?? null,
        filters.expiresFrom ?? null,
        filters.expiresTo ?? null,
        page.asOf ?? null,
        page.limit,
        page.offset,
      ],
    );
    return result.rows.map((row) => ({
      hotelId: String(row['hotel_id']),
      subscriptionId: String(row['subscription_id']),
      hotelName: String(row['hotel_name']),
      ownerType: String(row['owner_type']),
      district: String(row['district']),
      addressLine: String(row['address_line']),
      contactPhone: (row['contact_phone'] as string | null) ?? null,
      emailMasked: String(row['email_masked']),
      effectivePackage: String(row['effective_package']),
      termMonths: Number(row['term_months']),
      startsAt: row['starts_at'] as Date,
      expiresAt: row['expires_at'] as Date,
      suspendedAt: (row['suspended_at'] as Date | null) ?? null,
      status: String(row['status']),
      totalRows: Number(row['total_rows']),
    }));
  }

  async applicationQueue(
    group: string | undefined,
    page: { limit: number; offset: number },
  ): Promise<readonly ApplicationQueueRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT * FROM platform.operation_application_queue($1::text, $2::integer, $3::integer)`,
      [group ?? null, page.limit, page.offset],
    );
    return result.rows.map((row) => ({
      applicationId: String(row['application_id']),
      state: String(row['state']),
      queueGroup: String(row['queue_group']),
      hotelName: String(row['hotel_name']),
      ownerType: String(row['owner_type']),
      district: String(row['district']),
      packageCode: String(row['package_code']),
      termMonths: Number(row['term_months']),
      emailMasked: String(row['email_masked']),
      createdAt: row['created_at'] as Date,
      stateChangedAt: (row['state_changed_at'] as Date | null) ?? null,
      provisionAttempts: Number(row['provision_attempts']),
      totalRows: Number(row['total_rows']),
    }));
  }

  async smsRecipients(filters: RecipientFilters, asOf?: Date): Promise<readonly RecipientRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT * FROM platform.operation_sms_recipients(
         $1::uuid[], $2::text, $3::text, $4::timestamptz, $5::timestamptz, $6::timestamptz)`,
      [
        filters.hotelIds === undefined ? null : [...filters.hotelIds],
        filters.package ?? null,
        filters.status ?? null,
        filters.expiresFrom ?? null,
        filters.expiresTo ?? null,
        asOf ?? null,
      ],
    );
    return result.rows.map((row) => ({
      hotelId: String(row['hotel_id']),
      subscriptionId: String(row['subscription_id']),
      hotelName: String(row['hotel_name']),
      phone: (row['phone'] as string | null) ?? null,
      status: String(row['status']),
    }));
  }

  async reconciliationQueue(limit: number): Promise<readonly ReconciliationRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT * FROM platform.operation_reconciliation_queue($1::integer)`,
      [limit],
    );
    return result.rows.map((row) => ({
      subjectKind: String(row['subject_kind']),
      subjectId: String(row['subject_id']),
      hotelId: (row['hotel_id'] as string | null) ?? null,
      applicationId: (row['application_id'] as string | null) ?? null,
      provider: String(row['provider']),
      providerInvoiceId: String(row['provider_invoice_id']),
      providerPaymentId: (row['provider_payment_id'] as string | null) ?? null,
      amountMnt: String(row['amount_mnt']),
      confirmedAt: (row['confirmed_at'] as Date | null) ?? null,
      state: String(row['state']),
    }));
  }

  // ---------------------------------------------------------- password reset

  /**
   * `OPS-DEC-008`: the address is read, queued and masked inside the resolver,
   * so it never reaches this process at all.
   */
  async queuePasswordReset(
    hotelId: string,
    initiatorAccountId: string,
  ): Promise<{ intakeId: string; accountId: string; emailMasked: string } | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT * FROM platform.operation_queue_password_reset($1::uuid, $2::uuid)`,
      [hotelId, initiatorAccountId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      intakeId: String(row['intake_id']),
      accountId: String(row['account_id']),
      emailMasked: String(row['email_masked']),
    };
  }

  // ------------------------------------------------------------- suspension

  async lockSubscription(hotelId: string): Promise<SubscriptionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT subscription_id, hotel_id, effective_package, term_months,
              starts_at, expires_at, suspended_at, revision
         FROM platform.hotel_subscription
        WHERE hotel_id = $1
          FOR UPDATE`,
      [hotelId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      subscriptionId: String(row['subscription_id']),
      hotelId: String(row['hotel_id']),
      effectivePackage: String(row['effective_package']),
      termMonths: Number(row['term_months']),
      startsAt: row['starts_at'] as Date,
      expiresAt: row['expires_at'] as Date,
      suspendedAt: (row['suspended_at'] as Date | null) ?? null,
      revision: Number(row['revision']),
    };
  }

  /**
   * Sets or clears the suspension, fenced on the revision.
   *
   * `starts_at` and `expires_at` are not in the SET list, and that is the whole
   * of `OPS-DEC-016`'s "never pauses or extends": there is no code path here
   * through which the calendar could move.
   */
  async setSuspension(input: {
    hotelId: string;
    suspend: boolean;
    reason: string;
    expectedRevision: number;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.hotel_subscription
          SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END,
              suspension_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
              revision = revision + 1
        WHERE hotel_id = $1 AND revision = $4`,
      [input.hotelId, input.suspend, input.reason, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  async recordSuspensionEvent(input: {
    hotelId: string;
    subscriptionId: string;
    action: 'SUSPEND' | 'REACTIVATE';
    reasonCode: string;
    note: string;
    actorAccountId: string;
    suspendedBefore: boolean;
    startsAt: Date;
    expiresAt: Date;
    sessionsRevoked: number;
  }): Promise<string> {
    const result = await this.uow.query<{ event_id: string }>(
      `INSERT INTO platform.subscription_suspension_event
         (hotel_id, subscription_id, action, reason_code, note, actor_account_id,
          suspended_before, suspended_after, starts_at_snapshot, expires_at_snapshot,
          sessions_revoked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING event_id`,
      [
        input.hotelId,
        input.subscriptionId,
        input.action,
        input.reasonCode,
        input.note,
        input.actorAccountId,
        input.suspendedBefore,
        input.action === 'SUSPEND',
        input.startsAt,
        input.expiresAt,
        input.sessionsRevoked,
      ],
    );
    const id = result.rows[0]?.event_id;
    if (id === undefined) throw new Error('the suspension event insert returned no row');
    return id;
  }

  /** doc 14 §4.1: the hotel's staff authority ends at once, and no other hotel's does. */
  async revokeHotelScope(hotelId: string): Promise<number> {
    const result = await this.uow.query<{ operation_revoke_hotel_scope: number }>(
      `SELECT platform.operation_revoke_hotel_scope($1::uuid)`,
      [hotelId],
    );
    return Number(result.rows[0]?.operation_revoke_hotel_scope ?? 0);
  }

  // --------------------------------------------------------- reconciliation

  /**
   * Closes one paid record with its evidence, fenced on the state.
   *
   * The `reconciliation_outcome IS NULL` predicate is what makes a second
   * operator's decision a no-op rather than an overwrite: doc 14 §4.2 gives one
   * payment record exactly one terminal resolution.
   */
  async closeReconciliation(input: {
    subjectKind: 'ONBOARDING_ATTEMPT' | 'SUBSCRIPTION_INTENT';
    subjectId: string;
    outcome: string;
    reference: string;
    note: string;
    actorAccountId: string;
  }): Promise<boolean> {
    const table =
      input.subjectKind === 'ONBOARDING_ATTEMPT'
        ? { name: 'platform.onboarding_payment_attempt', key: 'attempt_id' }
        : { name: 'platform.subscription_billing_intent', key: 'intent_id' };
    const result = await this.uow.query(
      `UPDATE ${table.name}
          SET reconciliation_outcome = $2, reconciled_by_account_id = $3,
              reconciled_at = now(), reconciliation_reason = $4,
              reconciliation_reference = $5, revision = revision + 1
        WHERE ${table.key} = $1
          AND state = 'PAID_REQUIRES_RECONCILIATION'
          AND reconciliation_outcome IS NULL`,
      [input.subjectId, input.outcome, input.actorAccountId, input.note, input.reference],
    );
    return result.rowCount === 1;
  }

  // ---------------------------------------------------------------- recovery

  async createRecoveryRequest(input: {
    accountId: string;
    caseReference: string;
    note: string;
    requestedBy: string;
  }): Promise<string> {
    const result = await this.uow.query<{ request_id: string }>(
      `INSERT INTO platform.account_recovery_request
         (account_id, case_reference, request_note, requested_by_account_id)
       VALUES ($1, $2, $3, $4)
       RETURNING request_id`,
      [input.accountId, input.caseReference, input.note, input.requestedBy],
    );
    const id = result.rows[0]?.request_id;
    if (id === undefined) throw new Error('the recovery request insert returned no row');
    return id;
  }

  async lockRecoveryRequest(requestId: string): Promise<
    | {
        requestId: string;
        accountId: string;
        state: string;
        requestedByAccountId: string;
        revision: number;
      }
    | undefined
  > {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT request_id, account_id, state, requested_by_account_id, revision
         FROM platform.account_recovery_request
        WHERE request_id = $1
          FOR UPDATE`,
      [requestId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      requestId: String(row['request_id']),
      accountId: String(row['account_id']),
      state: String(row['state']),
      requestedByAccountId: String(row['requested_by_account_id']),
      revision: Number(row['revision']),
    };
  }

  async decideRecoveryRequest(input: {
    requestId: string;
    decision: 'APPROVED' | 'REFUSED';
    reason: string;
    decidedBy: string;
    expectedRevision: number;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.account_recovery_request
          SET state = $2, decided_by_account_id = $3, decision_reason = $4,
              decided_at = now(), revision = revision + 1
        WHERE request_id = $1 AND revision = $5 AND state = 'PENDING'`,
      [input.requestId, input.decision, input.decidedBy, input.reason, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  // ----------------------------------------------------------------- contact

  async currentContact(
    subscriptionId: string,
  ): Promise<{ contactId: string; phone: string } | undefined> {
    const result = await this.uow.query<{ contact_id: string; phone: string }>(
      `SELECT contact_id, phone FROM platform.subscription_contact
        WHERE subscription_id = $1 AND is_current IS TRUE`,
      [subscriptionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { contactId: row.contact_id, phone: row.phone };
  }

  async seedContact(input: {
    hotelId: string;
    subscriptionId: string;
    phone: string;
  }): Promise<string> {
    const result = await this.uow.query<{ contact_id: string }>(
      `INSERT INTO platform.subscription_contact
         (hotel_id, subscription_id, phone, source)
       VALUES ($1, $2, $3, 'PROVISIONING')
       ON CONFLICT DO NOTHING
       RETURNING contact_id`,
      [input.hotelId, input.subscriptionId, input.phone],
    );
    return result.rows[0]?.contact_id ?? '';
  }

  async openChangeRequest(subscriptionId: string): Promise<ChangeRequestRow | undefined> {
    return this.mapChangeRequest(
      await this.uow.query<Record<string, unknown>>(
        `SELECT ${CHANGE_REQUEST_COLUMNS}
           FROM platform.subscription_contact_change_request
          WHERE subscription_id = $1
            AND state = ANY (ARRAY['AWAITING_OLD_PHONE', 'AWAITING_NEW_PHONE'])
            FOR UPDATE`,
        [subscriptionId],
      ),
    );
  }

  async lockChangeRequest(requestId: string): Promise<ChangeRequestRow | undefined> {
    return this.mapChangeRequest(
      await this.uow.query<Record<string, unknown>>(
        `SELECT ${CHANGE_REQUEST_COLUMNS}
           FROM platform.subscription_contact_change_request
          WHERE request_id = $1
            FOR UPDATE`,
        [requestId],
      ),
    );
  }

  private mapChangeRequest(result: {
    rows: Record<string, unknown>[];
  }): ChangeRequestRow | undefined {
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      requestId: String(row['request_id']),
      hotelId: String(row['hotel_id']),
      subscriptionId: String(row['subscription_id']),
      state: String(row['state']),
      oldPhone: String(row['old_phone']),
      newPhone: String(row['new_phone']),
      requestedByAccountId: String(row['requested_by_account_id']),
      oldPhoneVerifiedAt: (row['old_phone_verified_at'] as Date | null) ?? null,
      newPhoneVerifiedAt: (row['new_phone_verified_at'] as Date | null) ?? null,
      exceptionApprovedAt: (row['exception_approved_at'] as Date | null) ?? null,
      revision: Number(row['revision']),
    };
  }

  async createChangeRequest(input: {
    hotelId: string;
    subscriptionId: string;
    oldPhone: string;
    newPhone: string;
    requestedBy: string;
  }): Promise<string> {
    const result = await this.uow.query<{ request_id: string }>(
      `INSERT INTO platform.subscription_contact_change_request
         (hotel_id, subscription_id, old_phone, new_phone, requested_by_account_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING request_id`,
      [input.hotelId, input.subscriptionId, input.oldPhone, input.newPhone, input.requestedBy],
    );
    const id = result.rows[0]?.request_id;
    if (id === undefined) throw new Error('the contact change insert returned no row');
    return id;
  }

  async markChallengePassed(input: {
    requestId: string;
    challenge: 'OLD_PHONE' | 'NEW_PHONE';
    expectedRevision: number;
  }): Promise<boolean> {
    const column =
      input.challenge === 'OLD_PHONE' ? 'old_phone_verified_at' : 'new_phone_verified_at';
    const nextState = input.challenge === 'OLD_PHONE' ? 'AWAITING_NEW_PHONE' : 'AWAITING_NEW_PHONE';
    const result = await this.uow.query(
      `UPDATE platform.subscription_contact_change_request
          SET ${column} = now(), state = $2, revision = revision + 1
        WHERE request_id = $1 AND revision = $3`,
      [input.requestId, nextState, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  async approveException(input: {
    requestId: string;
    approvedBy: string;
    reference: string;
    reason: string;
    expectedRevision: number;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.subscription_contact_change_request
          SET exception_approved_by_account_id = $2, exception_reference = $3,
              exception_reason = $4, exception_approved_at = now(),
              state = 'AWAITING_NEW_PHONE', revision = revision + 1
        WHERE request_id = $1 AND revision = $5
          AND state = 'AWAITING_OLD_PHONE'
          AND old_phone_verified_at IS NULL`,
      [input.requestId, input.approvedBy, input.reference, input.reason, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  /** Ends a request without applying it. */
  async terminateChangeRequest(input: {
    requestId: string;
    state: 'CANCELLED' | 'EXPIRED';
    reason: string;
    expectedRevision: number;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.subscription_contact_change_request
          SET state = $2, terminal_at = now(), terminal_reason = $3, revision = revision + 1
        WHERE request_id = $1 AND revision = $4
          AND state = ANY (ARRAY['AWAITING_OLD_PHONE', 'AWAITING_NEW_PHONE'])`,
      [input.requestId, input.state, input.reason, input.expectedRevision],
    );
    return result.rowCount === 1;
  }

  /** The atomic swap of doc 14 §2.3: supersede, insert, and mark applied. */
  async applyChange(input: {
    requestId: string;
    hotelId: string;
    subscriptionId: string;
    newPhone: string;
    actorAccountId: string;
    currentContactId: string | undefined;
    expectedRevision: number;
  }): Promise<string | undefined> {
    if (input.currentContactId !== undefined) {
      const superseded = await this.uow.query(
        `UPDATE platform.subscription_contact
            SET is_current = false, superseded_at = now()
          WHERE contact_id = $1 AND is_current IS TRUE`,
        [input.currentContactId],
      );
      if (superseded.rowCount !== 1) return undefined;
    }
    const inserted = await this.uow.query<{ contact_id: string }>(
      `INSERT INTO platform.subscription_contact
         (hotel_id, subscription_id, phone, source, change_request_id, changed_by_account_id)
       VALUES ($1, $2, $3, 'CONTACT_CHANGE', $4, $5)
       RETURNING contact_id`,
      [input.hotelId, input.subscriptionId, input.newPhone, input.requestId, input.actorAccountId],
    );
    const contactId = inserted.rows[0]?.contact_id;
    if (contactId === undefined) return undefined;
    const applied = await this.uow.query(
      `UPDATE platform.subscription_contact_change_request
          SET state = 'APPLIED', applied_contact_id = $2, terminal_at = now(),
              terminal_reason = 'applied', revision = revision + 1
        WHERE request_id = $1 AND revision = $3 AND state = 'AWAITING_NEW_PHONE'`,
      [input.requestId, contactId, input.expectedRevision],
    );
    return applied.rowCount === 1 ? contactId : undefined;
  }

  // ------------------------------------------------------------------- codes

  async currentCode(
    requestId: string,
    challenge: 'OLD_PHONE' | 'NEW_PHONE',
  ): Promise<ContactCodeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT code_id, request_id, challenge, phone, code_hash, attempts, max_attempts,
              issued_at, expires_at
         FROM platform.subscription_contact_code
        WHERE request_id = $1 AND challenge = $2 AND is_current IS TRUE
          FOR UPDATE`,
      [requestId, challenge],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      codeId: String(row['code_id']),
      requestId: String(row['request_id']),
      challenge: String(row['challenge']),
      phone: String(row['phone']),
      codeHash: String(row['code_hash']),
      attempts: Number(row['attempts']),
      maxAttempts: Number(row['max_attempts']),
      issuedAt: row['issued_at'] as Date,
      expiresAt: row['expires_at'] as Date,
    };
  }

  async supersedeCode(codeId: string): Promise<void> {
    await this.uow.query(
      `UPDATE platform.subscription_contact_code
          SET is_current = false, superseded_at = now()
        WHERE code_id = $1 AND is_current IS TRUE`,
      [codeId],
    );
  }

  async consumeCode(codeId: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.subscription_contact_code
          SET is_current = false, consumed_at = now()
        WHERE code_id = $1 AND is_current IS TRUE`,
      [codeId],
    );
    return result.rowCount === 1;
  }

  async countAttempt(codeId: string): Promise<number> {
    const result = await this.uow.query<{ attempts: number }>(
      `UPDATE platform.subscription_contact_code
          SET attempts = attempts + 1
        WHERE code_id = $1 AND is_current IS TRUE AND attempts < max_attempts
        RETURNING attempts`,
      [codeId],
    );
    return Number(result.rows[0]?.attempts ?? -1);
  }

  async issueCode(input: {
    hotelId: string;
    requestId: string;
    challenge: 'OLD_PHONE' | 'NEW_PHONE';
    phone: string;
    codeHash: string;
    codeKeyVersion: string;
    ttlSeconds: number;
  }): Promise<string> {
    const result = await this.uow.query<{ code_id: string }>(
      `INSERT INTO platform.subscription_contact_code
         (hotel_id, request_id, challenge, phone, code_hash, code_key_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
       RETURNING code_id`,
      [
        input.hotelId,
        input.requestId,
        input.challenge,
        input.phone,
        input.codeHash,
        input.codeKeyVersion,
        input.ttlSeconds,
      ],
    );
    const id = result.rows[0]?.code_id;
    if (id === undefined) throw new Error('the contact code insert returned no row');
    return id;
  }

  // --------------------------------------------------------------------- SMS

  async liveTariff(): Promise<{ tariffId: string; pricePerSegmentMnt: number } | undefined> {
    const result = await this.uow.query<{ tariff_id: string; price_per_segment_mnt: string }>(
      `SELECT tariff_id, price_per_segment_mnt
         FROM platform.sms_tariff
        WHERE provider = 'CALLPRO' AND effective_to IS NULL AND effective_from <= now()`,
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { tariffId: row.tariff_id, pricePerSegmentMnt: Number(row.price_per_segment_mnt) };
  }

  async insertPreview(input: {
    createdBy: string;
    body: string;
    bodyHash: string;
    filterSnapshot: Record<string, unknown>;
    recipientHash: string;
    recipientCount: number;
    excludedCount: number;
    segmentsPerRecipient: number;
    totalSegments: number;
    estimatedCostMnt: number | undefined;
    tariffId: string | undefined;
    ttlSeconds: number;
  }): Promise<string> {
    const result = await this.uow.query<{ preview_id: string }>(
      `INSERT INTO platform.sms_preview
         (created_by_account_id, body, body_hash, filter_snapshot, recipient_hash,
          recipient_count, excluded_count, segments_per_recipient, total_segments,
          estimated_cost_mnt, tariff_id, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11,
               now() + make_interval(secs => $12))
       RETURNING preview_id`,
      [
        input.createdBy,
        input.body,
        input.bodyHash,
        JSON.stringify(input.filterSnapshot),
        input.recipientHash,
        input.recipientCount,
        input.excludedCount,
        input.segmentsPerRecipient,
        input.totalSegments,
        input.estimatedCostMnt ?? null,
        input.tariffId ?? null,
        input.ttlSeconds,
      ],
    );
    const id = result.rows[0]?.preview_id;
    if (id === undefined) throw new Error('the preview insert returned no row');
    return id;
  }

  async lockPreview(previewId: string): Promise<
    | {
        previewId: string;
        createdBy: string;
        body: string;
        bodyHash: string;
        filterSnapshot: Record<string, unknown>;
        recipientHash: string;
        recipientCount: number;
        excludedCount: number;
        segmentsPerRecipient: number;
        totalSegments: number;
        estimatedCostMnt: number | null;
        expiresAt: Date;
        consumedAt: Date | null;
      }
    | undefined
  > {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT preview_id, created_by_account_id, body, body_hash, filter_snapshot,
              recipient_hash, recipient_count, excluded_count, segments_per_recipient,
              total_segments, estimated_cost_mnt, expires_at, consumed_at
         FROM platform.sms_preview
        WHERE preview_id = $1
          FOR UPDATE`,
      [previewId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      previewId: String(row['preview_id']),
      createdBy: String(row['created_by_account_id']),
      body: String(row['body']),
      bodyHash: String(row['body_hash']),
      filterSnapshot: row['filter_snapshot'] as Record<string, unknown>,
      recipientHash: String(row['recipient_hash']),
      recipientCount: Number(row['recipient_count']),
      excludedCount: Number(row['excluded_count']),
      segmentsPerRecipient: Number(row['segments_per_recipient']),
      totalSegments: Number(row['total_segments']),
      estimatedCostMnt:
        row['estimated_cost_mnt'] === null ? null : Number(row['estimated_cost_mnt']),
      expiresAt: row['expires_at'] as Date,
      consumedAt: (row['consumed_at'] as Date | null) ?? null,
    };
  }

  async consumePreview(previewId: string): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.sms_preview SET consumed_at = now()
        WHERE preview_id = $1 AND consumed_at IS NULL`,
      [previewId],
    );
    return result.rowCount === 1;
  }

  async jobForPreview(previewId: string): Promise<string | undefined> {
    const result = await this.uow.query<{ job_id: string }>(
      `SELECT job_id FROM platform.sms_send_job WHERE preview_id = $1`,
      [previewId],
    );
    return result.rows[0]?.job_id;
  }

  async insertJob(input: {
    previewId: string;
    body: string;
    filterSnapshot: Record<string, unknown>;
    recipientCount: number;
    excludedCount: number;
    totalSegments: number;
    estimatedCostMnt: number | null;
    confirmedBy: string;
  }): Promise<string> {
    const result = await this.uow.query<{ job_id: string }>(
      `INSERT INTO platform.sms_send_job
         (preview_id, body, filter_snapshot, recipient_count, excluded_count,
          total_segments, estimated_cost_mnt, confirmed_by_account_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
       RETURNING job_id`,
      [
        input.previewId,
        input.body,
        JSON.stringify(input.filterSnapshot),
        input.recipientCount,
        input.excludedCount,
        input.totalSegments,
        input.estimatedCostMnt,
        input.confirmedBy,
      ],
    );
    const id = result.rows[0]?.job_id;
    if (id === undefined) throw new Error('the send job insert returned no row');
    return id;
  }

  /**
   * One message per phone per job.
   *
   * `ON CONFLICT DO NOTHING` on `(job_id, phone)` is the deduplication doc 14
   * §5.5 requires, applied by the database rather than by the loop above it: a
   * filter that resolved the same number twice writes one row.
   */
  async insertMessage(input: {
    jobId: string;
    hotelId: string;
    subscriptionId: string;
    phone: string;
    segments: number;
  }): Promise<string | undefined> {
    const result = await this.uow.query<{ message_id: string }>(
      `INSERT INTO platform.sms_recipient_message
         (job_id, hotel_id, subscription_id, phone, segments)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id, phone) DO NOTHING
       RETURNING message_id`,
      [input.jobId, input.hotelId, input.subscriptionId, input.phone, input.segments],
    );
    return result.rows[0]?.message_id;
  }

  async messagesForJob(jobId: string): Promise<readonly SmsMessageRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT message_id, job_id, hotel_id, phone, segments, state, provider_message_id
         FROM platform.sms_recipient_message
        WHERE job_id = $1
        ORDER BY created_at, message_id`,
      [jobId],
    );
    return result.rows.map((row) => ({
      messageId: String(row['message_id']),
      jobId: String(row['job_id']),
      hotelId: String(row['hotel_id']),
      phone: String(row['phone']),
      segments: Number(row['segments']),
      state: String(row['state']),
      providerMessageId: (row['provider_message_id'] as string | null) ?? null,
    }));
  }

  /**
   * Moves one message forward, and refuses to move it back.
   *
   * The predicate mirrors the trigger rather than replacing it: the trigger is
   * what makes the rule true for every writer, and this is what makes a late
   * status a no-op instead of an error.
   */
  async advanceMessage(input: {
    messageId: string;
    state: 'SENT' | 'DELIVERED' | 'FAILED';
    providerMessageId?: string;
    failureCode?: string;
  }): Promise<boolean> {
    const rank = { PENDING: 0, SENT: 1, DELIVERED: 2, FAILED: 2 } as const;
    const result = await this.uow.query(
      `UPDATE platform.sms_recipient_message
          SET state = $2,
              provider_message_id = COALESCE($3, provider_message_id),
              failure_code = CASE WHEN $2 = 'FAILED' THEN $4 ELSE NULL END,
              state_changed_at = now(),
              revision = revision + 1
        WHERE message_id = $1
          AND CASE state WHEN 'PENDING' THEN 0 WHEN 'SENT' THEN 1 ELSE 2 END < $5`,
      [
        input.messageId,
        input.state,
        input.providerMessageId ?? null,
        input.failureCode ?? null,
        rank[input.state],
      ],
    );
    return result.rowCount === 1;
  }

  async recordMessageEvent(input: {
    messageId: string;
    state: string;
    source: 'CONFIRMATION' | 'PROVIDER_SEND' | 'PROVIDER_STATUS_QUERY';
    providerMessageId?: string;
    detail?: string;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.sms_message_event
         (message_id, state, source, provider_message_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.messageId,
        input.state,
        input.source,
        input.providerMessageId ?? null,
        input.detail ?? null,
      ],
    );
  }

  async markJobDispatched(jobId: string, providerReference: string | null): Promise<void> {
    await this.uow.query(
      `UPDATE platform.sms_send_job
          SET state = 'DISPATCHED', dispatched_at = now(), provider_reference = $2,
              revision = revision + 1
        WHERE job_id = $1 AND state = 'CONFIRMED'`,
      [jobId, providerReference],
    );
  }

  async markJobFailed(jobId: string, error: string): Promise<void> {
    await this.uow.query(
      `UPDATE platform.sms_send_job
          SET state = 'FAILED', dispatched_at = now(), last_error = $2,
              revision = revision + 1
        WHERE job_id = $1 AND state = 'CONFIRMED'`,
      [jobId, error],
    );
  }

  async jobHistory(page: { limit: number; offset: number }): Promise<
    readonly {
      jobId: string;
      state: string;
      body: string;
      filterSnapshot: Record<string, unknown>;
      recipientCount: number;
      excludedCount: number;
      totalSegments: number;
      estimatedCostMnt: number | null;
      confirmedByAccountId: string;
      confirmedAt: Date;
      dispatchedAt: Date | null;
      providerReference: string | null;
      pending: number;
      sent: number;
      delivered: number;
      failed: number;
      totalRows: number;
    }[]
  > {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT j.job_id, j.state, j.body, j.filter_snapshot, j.recipient_count, j.excluded_count,
              j.total_segments, j.estimated_cost_mnt, j.confirmed_by_account_id, j.confirmed_at,
              j.dispatched_at, j.provider_reference,
              count(*) FILTER (WHERE m.state = 'PENDING')   AS pending,
              count(*) FILTER (WHERE m.state = 'SENT')      AS sent,
              count(*) FILTER (WHERE m.state = 'DELIVERED') AS delivered,
              count(*) FILTER (WHERE m.state = 'FAILED')    AS failed,
              count(*) OVER () AS total_rows
         FROM platform.sms_send_job j
         LEFT JOIN platform.sms_recipient_message m ON m.job_id = j.job_id
        GROUP BY j.job_id
        ORDER BY j.confirmed_at DESC, j.job_id
        LIMIT $1 OFFSET $2`,
      [page.limit, page.offset],
    );
    return result.rows.map((row) => ({
      jobId: String(row['job_id']),
      state: String(row['state']),
      body: String(row['body']),
      filterSnapshot: row['filter_snapshot'] as Record<string, unknown>,
      recipientCount: Number(row['recipient_count']),
      excludedCount: Number(row['excluded_count']),
      totalSegments: Number(row['total_segments']),
      estimatedCostMnt:
        row['estimated_cost_mnt'] === null ? null : Number(row['estimated_cost_mnt']),
      confirmedByAccountId: String(row['confirmed_by_account_id']),
      confirmedAt: row['confirmed_at'] as Date,
      dispatchedAt: (row['dispatched_at'] as Date | null) ?? null,
      providerReference: (row['provider_reference'] as string | null) ?? null,
      pending: Number(row['pending']),
      sent: Number(row['sent']),
      delivered: Number(row['delivered']),
      failed: Number(row['failed']),
      totalRows: Number(row['total_rows']),
    }));
  }

  /** Every message the provider has accepted but not yet reported on. */
  async unsettledMessages(limit: number): Promise<readonly SmsMessageRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT message_id, job_id, hotel_id, phone, segments, state, provider_message_id
         FROM platform.sms_recipient_message
        WHERE state = 'SENT' AND provider_message_id IS NOT NULL
        ORDER BY state_changed_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      messageId: String(row['message_id']),
      jobId: String(row['job_id']),
      hotelId: String(row['hotel_id']),
      phone: String(row['phone']),
      segments: Number(row['segments']),
      state: String(row['state']),
      providerMessageId: (row['provider_message_id'] as string | null) ?? null,
    }));
  }
}

const CHANGE_REQUEST_COLUMNS = `request_id, hotel_id, subscription_id, state, old_phone, new_phone,
        requested_by_account_id, old_phone_verified_at, new_phone_verified_at,
        exception_approved_at, revision`;
