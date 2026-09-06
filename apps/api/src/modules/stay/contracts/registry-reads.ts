import type { UnitOfWork } from '@prsystem/db';
import type {
  RegistryFactsPort,
  RegistryFilter,
  RegistryPage,
  RegistryRow,
} from '../../reporting/contracts/registry-facts';

/**
 * The guest registry, answered by the module that owns the stay (doc 12).
 *
 * One row is one primary guest of one stay (`GUEST-DEC-004`), and the six
 * columns are the only ones this query selects. There is no registration
 * number, no telephone, no address and no identity ciphertext in the projection
 * at all — doc 12 §5 forbids them on the screen and in the file, and the
 * narrowest way to honour that is for the SQL never to read them.
 *
 * Three subtleties the requirements are specific about.
 *
 * **The effective check-in, not the recorded one.** doc 12 §5.1: the interval's
 * start is the latest *approved* actual-time amendment, or the original when
 * there is none. `check_in_recorded_at` is an audit timestamp and never stands
 * in for when the guest arrived.
 *
 * **The period's end depends on the state.** doc 12 §5.3: an active stay shows
 * its immutable planned checkout; a completed one shows what actually happened.
 *
 * **Only a real arrival appears.** doc 12 §3: a booking that was cancelled, was
 * a no-show, or never checked in has no stay, so it has no row — which is true
 * of this query because a stay is what it selects from.
 */

/**
 * The effective check-in, as SQL.
 *
 * A correlated subquery rather than a join, because a stay may have several
 * approved amendments over its life and only the newest decides — a join would
 * multiply the row.
 */
const EFFECTIVE_CHECK_IN = `COALESCE(
  (SELECT c.corrected_actual_check_in_at
     FROM platform.stay_time_correction c
    WHERE c.stay_id = s.stay_id AND c.state = 'APPROVED'
    ORDER BY c.decided_at DESC LIMIT 1),
  s.actual_check_in_at)`;

const ROW_COLUMNS = `s.stay_id,
  g.family_name,
  g.given_name,
  g.age_at_check_in,
  r.room_number,
  ${EFFECTIVE_CHECK_IN} AS effective_check_in_at,
  CASE WHEN s.state = 'COMPLETED' THEN s.actual_checkout_at ELSE s.planned_checkout_at END
    AS period_end_at,
  s.state`;

const FROM_AND_WHERE = `FROM platform.stay s
  JOIN platform.stay_guest g
    ON g.hotel_id = s.hotel_id AND g.stay_id = s.stay_id AND g.is_current
  JOIN platform.room r ON r.hotel_id = s.hotel_id AND r.room_id = s.room_id
 WHERE s.hotel_id = $1::uuid
   AND ${EFFECTIVE_CHECK_IN} >= $2::timestamptz
   AND ${EFFECTIVE_CHECK_IN} < $3::timestamptz
   AND ($4::text IS NULL OR s.state = $4::text)
   AND ($5::uuid IS NULL OR s.room_id = $5::uuid)
   AND ($6::text IS NULL
        OR g.family_name ILIKE '%' || $6::text || '%'
        OR g.given_name ILIKE '%' || $6::text || '%')`;

/**
 * doc 12 §4: newest effective check-in first, then the stay id.
 *
 * The second key is what makes paging safe: two stays that began at the same
 * instant would otherwise be free to swap places between two pages, and a guest
 * would be shown twice or not at all.
 */
const ORDER = ` ORDER BY effective_check_in_at DESC, s.stay_id`;

type Row = Record<string, unknown>;

function mapRow(row: Row): RegistryRow {
  return {
    stayId: String(row['stay_id']),
    familyName: String(row['family_name']),
    givenName: String(row['given_name']),
    ageAtCheckIn: row['age_at_check_in'] === null ? null : Number(row['age_at_check_in']),
    roomNumber: String(row['room_number']),
    effectiveCheckInAt: row['effective_check_in_at'] as Date,
    periodEndAt: row['period_end_at'] as Date,
    stayState: String(row['state']),
  };
}

function values(filter: RegistryFilter): unknown[] {
  return [
    filter.hotelId,
    filter.from,
    filter.to,
    filter.stayState ?? null,
    filter.roomId ?? null,
    filter.nameSearch ?? null,
  ];
}

export class RepositoryRegistryFacts implements RegistryFactsPort {
  async page(
    uow: UnitOfWork,
    filter: RegistryFilter,
    page: { offset: number; limit: number },
  ): Promise<RegistryPage> {
    const rows = await uow.query<Row>(
      `SELECT ${ROW_COLUMNS} ${FROM_AND_WHERE}${ORDER} LIMIT $7 OFFSET $8`,
      [...values(filter), page.limit, page.offset],
    );
    return { rows: rows.rows.map(mapRow), totalRows: await this.count(uow, filter) };
  }

  /**
   * The whole filtered result, for an export.
   *
   * `cap + 1` deliberately: the caller needs to know whether the result *would*
   * exceed the cap, and a query that stopped at exactly the cap could not tell
   * a full page from an overflowing one (`GUEST-DEC-006`).
   */
  async all(uow: UnitOfWork, filter: RegistryFilter, cap: number): Promise<readonly RegistryRow[]> {
    const rows = await uow.query<Row>(`SELECT ${ROW_COLUMNS} ${FROM_AND_WHERE}${ORDER} LIMIT $7`, [
      ...values(filter),
      cap + 1,
    ]);
    return rows.rows.map(mapRow);
  }

  async count(uow: UnitOfWork, filter: RegistryFilter): Promise<number> {
    const rows = await uow.query<{ n: string }>(
      `SELECT count(*)::text AS n ${FROM_AND_WHERE}`,
      values(filter),
    );
    return Number(rows.rows[0]?.n ?? '0');
  }

  /**
   * `GUEST-DEC-008`: the identity leaves product access, and the row stays.
   *
   * The name becomes a constant, the date of birth and the age go, and every
   * encrypted identifier and lookup token is cleared — so the stay can still be
   * counted, and nobody can be found through it. What is not touched is the
   * stay itself: doc 12 §9 keeps the non-identifying reference a financial or
   * audit event needs, under its own policy.
   */
  async anonymize(uow: UnitOfWork, stayId: string, at: Date): Promise<boolean> {
    const result = await uow.query(
      `UPDATE platform.stay_guest
          SET family_name = 'Устгасан',
              given_name = 'Устгасан',
              date_of_birth = '1900-01-01'::date,
              age_at_check_in = NULL,
              -- After the purge there is no document, and the row has to say
              -- so: the shape constraints of doc 05 §3 tie an identity type to
              -- the ciphertext that proves it, so removing one moves the other.
              identity_type = 'NO_DOCUMENT',
              assurance = 'LOW_ASSURANCE',
              provenance = 'MANUAL',
              no_document_reason = 'RETENTION_ANONYMISED',
              -- And a row with no registration number is not Police-matchable,
              -- which is what the eligibility column already means.
              police_match_eligibility = 'NOT_ELIGIBLE_EXACT_RD',
              identifier_ciphertext = NULL,
              identifier_wrapped_dek = NULL,
              identifier_key_version = NULL,
              lookup_token = NULL,
              lookup_key_version = NULL,
              lookup_namespace = NULL,
              document_country = NULL,
              document_expires_on = NULL,
              document_type = NULL,
              document_authority = NULL,
              guardian_name = NULL,
              guardian_phone = NULL,
              guardian_relationship = NULL
        WHERE stay_id = $1::uuid AND is_current AND lookup_token IS NOT NULL`,
      [stayId],
    );
    void at;
    return (result.rowCount ?? 0) >= 1;
  }
}
