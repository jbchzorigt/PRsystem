import type { UnitOfWork } from '@prsystem/db';
import { ScopedRepository } from '@prsystem/db';
import type { HotelRole } from '@prsystem/authz';

/**
 * The tenant-scoped half of IAM: memberships, role grants, invitations and the
 * per-hotel session scope.
 *
 * Every query carries its own `hotel_id` predicate as well as running under the
 * RLS policy (doc 06 §3, L2 and L4): two independent mechanisms, either of which
 * must hold.
 */

export type MembershipState = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';

export interface MembershipRow {
  readonly membershipId: string;
  readonly hotelId: string;
  readonly restaurantId: string | null;
  readonly accountId: string | null;
  readonly invitedEmailNormalized: string;
  readonly state: MembershipState;
  readonly isPrimaryAdmin: boolean;
  readonly membershipRevision: number;
}

export interface InvitationRow {
  readonly invitationId: string;
  readonly hotelId: string;
  readonly membershipId: string;
  readonly state: string;
  readonly tokenHash: string;
  readonly emailNormalized: string;
  readonly createdByAccountId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

function mapMembership(row: Record<string, unknown> | undefined): MembershipRow | undefined {
  if (row === undefined) return undefined;
  return {
    membershipId: String(row['membership_id']),
    hotelId: String(row['hotel_id']),
    restaurantId: (row['restaurant_id'] as string | null) ?? null,
    accountId: (row['account_id'] as string | null) ?? null,
    invitedEmailNormalized: String(row['invited_email_normalized']),
    state: row['state'] as MembershipState,
    isPrimaryAdmin: row['is_primary_admin'] === true,
    membershipRevision: Number(row['membership_revision']),
  };
}

const MEMBERSHIP_COLUMNS = `membership_id, hotel_id, restaurant_id, account_id,
                            invited_email_normalized, state, is_primary_admin, membership_revision`;

export class MembershipRepository extends ScopedRepository {
  constructor(uow: UnitOfWork) {
    super(uow);
  }

  /**
   * Every membership an account holds, across hotels.
   *
   * Reachable under the account policy on `staff_membership`, which is what
   * makes deriving scope from membership possible before any hotel scope exists
   * (doc 06 §2). It is a read: the write policy still requires the tenant scope.
   */
  async forAccount(accountId: string): Promise<readonly MembershipRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM platform.staff_membership
        WHERE account_id = $1
        ORDER BY hotel_id, restaurant_id NULLS FIRST`,
      [accountId],
    );
    return result.rows.map((row) => mapMembership(row)!);
  }

  async rolesFor(
    hotelId: string,
    membershipIds: readonly string[],
  ): Promise<Map<string, HotelRole[]>> {
    const byMembership = new Map<string, HotelRole[]>();
    if (membershipIds.length === 0) return byMembership;
    const result = await this.uow.query<{ membership_id: string; role: string }>(
      `SELECT membership_id, role FROM platform.membership_role_grant
        WHERE hotel_id = $1 AND membership_id = ANY($2::uuid[]) AND revoked_at IS NULL
        ORDER BY membership_id, role`,
      [hotelId, [...membershipIds]],
    );
    for (const row of result.rows) {
      const list = byMembership.get(row.membership_id) ?? [];
      list.push(row.role as HotelRole);
      byMembership.set(row.membership_id, list);
    }
    return byMembership;
  }

  /**
   * Active roles for one account across every hotel it belongs to.
   *
   * Read through the account policy, which is scoped by `account_id`; the
   * per-hotel grants are then attached to the membership they belong to and
   * never merged (doc 06 §6).
   */
  async rolesForAccount(accountId: string): Promise<Map<string, HotelRole[]>> {
    const result = await this.uow.query<{ membership_id: string; role: string }>(
      `SELECT g.membership_id, g.role
         FROM platform.membership_role_grant g
         JOIN platform.staff_membership m
           ON m.hotel_id = g.hotel_id AND m.membership_id = g.membership_id
        WHERE m.account_id = $1 AND g.revoked_at IS NULL
        ORDER BY g.membership_id, g.role`,
      [accountId],
    );
    const byMembership = new Map<string, HotelRole[]>();
    for (const row of result.rows) {
      const list = byMembership.get(row.membership_id) ?? [];
      list.push(row.role as HotelRole);
      byMembership.set(row.membership_id, list);
    }
    return byMembership;
  }

  /** Locks one membership row. Every lifecycle command serialises here. */
  async lock(membershipId: string): Promise<MembershipRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM platform.staff_membership
        WHERE hotel_id = $1 AND membership_id = $2
          FOR UPDATE`,
      [this.hotelId, membershipId],
    );
    return mapMembership(result.rows[0]);
  }

  /** Reads one membership without taking its row lock. */
  async find(membershipId: string): Promise<MembershipRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM platform.staff_membership
        WHERE hotel_id = $1 AND membership_id = $2`,
      [this.hotelId, membershipId],
    );
    return mapMembership(result.rows[0]);
  }

  async findByScopeEmail(
    restaurantId: string | null,
    emailNormalized: string,
  ): Promise<MembershipRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM platform.staff_membership
        WHERE hotel_id = $1
          AND invited_email_normalized = $2
          AND restaurant_id IS NOT DISTINCT FROM $3::uuid
          FOR UPDATE`,
      [this.hotelId, emailNormalized, restaurantId],
    );
    return mapMembership(result.rows[0]);
  }

  async create(input: {
    restaurantId: string | null;
    invitedEmailNormalized: string;
    createdByAccountId: string;
  }): Promise<MembershipRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.staff_membership
         (hotel_id, restaurant_id, invited_email_normalized, created_by_account_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${MEMBERSHIP_COLUMNS}`,
      [this.hotelId, input.restaurantId, input.invitedEmailNormalized, input.createdByAccountId],
    );
    const row = mapMembership(result.rows[0]);
    if (row === undefined) throw new Error('the membership insert returned no row');
    return row;
  }

  /**
   * Compare-and-set on `membership_revision` (`STAFF-DEC-008`).
   *
   * Every lifecycle command routes through here, so invitation acceptance, role
   * changes, suspension, termination and reactivation all serialise on the same
   * value. A stale request updates nothing and is reported as a conflict rather
   * than overwriting the newer state.
   */
  async transition(input: {
    membershipId: string;
    expectedRevision: number;
    state?: MembershipState;
    accountId?: string;
    reason?: string | null;
  }): Promise<boolean> {
    const assignments: string[] = ['membership_revision = membership_revision + 1'];
    const values: unknown[] = [this.hotelId, input.membershipId, input.expectedRevision];
    if (input.state !== undefined) {
      values.push(input.state);
      assignments.push(`state = $${String(values.length)}`, 'state_changed_at = now()');
      if (input.state === 'ACTIVE')
        assignments.push('activated_at = coalesce(activated_at, now())');
    }
    if (input.accountId !== undefined) {
      values.push(input.accountId);
      assignments.push(`account_id = $${String(values.length)}`);
    }
    if (input.reason !== undefined) {
      values.push(input.reason);
      assignments.push(`state_reason = $${String(values.length)}`);
    }

    const result = await this.uow.query(
      `UPDATE platform.staff_membership
          SET ${assignments.join(', ')}
        WHERE hotel_id = $1 AND membership_id = $2 AND membership_revision = $3`,
      values,
    );
    return result.rowCount === 1;
  }

  // --------------------------------------------------------------- role grants
  async grantRole(
    membershipId: string,
    role: HotelRole,
    grantedByAccountId: string,
  ): Promise<boolean> {
    const result = await this.uow.query(
      `INSERT INTO platform.membership_role_grant
         (hotel_id, membership_id, role, granted_by_account_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [this.hotelId, membershipId, role, grantedByAccountId],
    );
    return result.rowCount === 1;
  }

  /** Revokes a live grant. The row stays: history is never rewritten. */
  async revokeRole(
    membershipId: string,
    role: HotelRole,
    revokedByAccountId: string,
    reason: string,
  ): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.membership_role_grant
          SET revoked_at = now(), revoked_by_account_id = $4, revoked_reason = $5
        WHERE hotel_id = $1 AND membership_id = $2 AND role = $3 AND revoked_at IS NULL`,
      [this.hotelId, membershipId, role, revokedByAccountId, reason],
    );
    return result.rowCount === 1;
  }

  async revokeAllRoles(
    membershipId: string,
    revokedByAccountId: string,
    reason: string,
  ): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.membership_role_grant
          SET revoked_at = now(), revoked_by_account_id = $3, revoked_reason = $4
        WHERE hotel_id = $1 AND membership_id = $2 AND revoked_at IS NULL`,
      [this.hotelId, membershipId, revokedByAccountId, reason],
    );
    return result.rowCount;
  }

  // --------------------------------------------------------------- invitations
  async activeInvitation(membershipId: string): Promise<InvitationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT invitation_id, hotel_id, membership_id, state, token_hash,
              email_normalized, created_by_account_id, expires_at, created_at
         FROM platform.staff_invitation
        WHERE hotel_id = $1 AND membership_id = $2 AND state = 'ACTIVE'
          FOR UPDATE`,
      [this.hotelId, membershipId],
    );
    return mapInvitation(result.rows[0]);
  }

  async findInvitationByHash(tokenHash: string): Promise<InvitationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT invitation_id, hotel_id, membership_id, state, token_hash,
              email_normalized, created_by_account_id, expires_at, created_at
         FROM platform.staff_invitation
        WHERE hotel_id = $1 AND token_hash = $2`,
      [this.hotelId, tokenHash],
    );
    return mapInvitation(result.rows[0]);
  }

  async createInvitation(input: {
    membershipId: string;
    tokenHash: string;
    tokenKeyVersion: string;
    emailNormalized: string;
    createdByAccountId: string;
    ttlSeconds: number;
    roles: readonly HotelRole[];
  }): Promise<InvitationRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.staff_invitation
         (hotel_id, membership_id, token_hash, token_key_version, email_normalized,
          created_by_account_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
       RETURNING invitation_id, hotel_id, membership_id, state, token_hash,
                 email_normalized, created_by_account_id, expires_at, created_at`,
      [
        this.hotelId,
        input.membershipId,
        input.tokenHash,
        input.tokenKeyVersion,
        input.emailNormalized,
        input.createdByAccountId,
        input.ttlSeconds,
      ],
    );
    const row = mapInvitation(result.rows[0]);
    if (row === undefined) throw new Error('the invitation insert returned no row');

    for (const role of input.roles) {
      await this.uow.query(
        `INSERT INTO platform.invitation_requested_role (hotel_id, invitation_id, role)
         VALUES ($1, $2, $3)`,
        [this.hotelId, row.invitationId, role],
      );
    }
    return row;
  }

  async invitationRoles(invitationId: string): Promise<readonly HotelRole[]> {
    const result = await this.uow.query<{ role: string }>(
      `SELECT role FROM platform.invitation_requested_role
        WHERE hotel_id = $1 AND invitation_id = $2
        ORDER BY role`,
      [this.hotelId, invitationId],
    );
    return result.rows.map((row) => row.role as HotelRole);
  }

  async terminaliseInvitation(
    invitationId: string,
    state: 'ACCEPTED' | 'SUPERSEDED' | 'EXPIRED' | 'REVOKED',
    reason: string,
    supersededBy?: string,
  ): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.staff_invitation
          SET state = $3, terminal_at = now(), terminal_reason = $4,
              superseded_by_invitation_id = $5
        WHERE hotel_id = $1 AND invitation_id = $2 AND state = 'ACTIVE'`,
      [this.hotelId, invitationId, state, reason, supersededBy ?? null],
    );
    return result.rowCount === 1;
  }

  // -------------------------------------------------------- session scope grants
  async grantScope(input: {
    accountId: string;
    sessionId: string;
    membershipId: string;
    membershipRevision: number;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.session_scope_grant
         (hotel_id, account_id, session_id, membership_id, membership_revision)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        this.hotelId,
        input.accountId,
        input.sessionId,
        input.membershipId,
        input.membershipRevision,
      ],
    );
  }

  async liveScopeGrant(
    sessionId: string,
    membershipId: string,
  ): Promise<{ membershipRevision: number } | undefined> {
    const result = await this.uow.query<{ membership_revision: number }>(
      `SELECT membership_revision FROM platform.session_scope_grant
        WHERE hotel_id = $1 AND session_id = $2 AND membership_id = $3 AND revoked_at IS NULL`,
      [this.hotelId, sessionId, membershipId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { membershipRevision: Number(row.membership_revision) };
  }

  /**
   * Closes every live scope grant for one membership.
   *
   * doc 19 §10: a role change, a suspension or a termination closes the session
   * **in that scope only**. The same session's grants in other hotels are not
   * touched, and the account's credential is unaffected.
   */
  async revokeScopeGrants(membershipId: string, reason: string): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.session_scope_grant
          SET revoked_at = now(), revoked_reason = $3
        WHERE hotel_id = $1 AND membership_id = $2 AND revoked_at IS NULL`,
      [this.hotelId, membershipId, reason],
    );
    return result.rowCount;
  }

  /** Closes every scope grant an account holds, in any hotel. */
  async revokeAllScopeGrantsForAccount(accountId: string, reason: string): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.session_scope_grant
          SET revoked_at = now(), revoked_reason = $2
        WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, reason],
    );
    return result.rowCount;
  }
}

function mapInvitation(row: Record<string, unknown> | undefined): InvitationRow | undefined {
  if (row === undefined) return undefined;
  return {
    invitationId: String(row['invitation_id']),
    hotelId: String(row['hotel_id']),
    membershipId: String(row['membership_id']),
    state: String(row['state']),
    tokenHash: String(row['token_hash']),
    emailNormalized: String(row['email_normalized']),
    createdByAccountId: String(row['created_by_account_id']),
    expiresAt: row['expires_at'] as Date,
    createdAt: row['created_at'] as Date,
  };
}
