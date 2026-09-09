import type { UnitOfWork } from '@prsystem/db';
import type { CaseState, MatchOutcome, MatchWorkflow } from '../domain/police';

/**
 * The Police module's own rows (doc 13 §6.3, §8.4).
 *
 * Everything here is in the `police` schema. Nothing in this file selects a
 * hotel table: what the Police realm may see of the hotel world it sees through
 * the three `SECURITY DEFINER` functions of migration 0019, and those are
 * called by name from the services that are allowed to.
 */

type Row = Record<string, unknown>;

export interface WantedPersonRow {
  readonly personId: string;
  readonly identityToken: string;
  readonly matchToken: string;
  readonly matchKeyVersion: string;
  readonly matchNamespace: string;
  readonly createdByAccountId: string;
  readonly revision: number;
}

export interface IdentityRevisionRow {
  readonly revisionId: string;
  readonly personId: string;
  readonly revisionNo: number;
  readonly isCurrent: boolean;
  readonly familyName: string;
  readonly parentName: string;
  readonly givenName: string;
  readonly dateOfBirth: string;
  readonly homeAddress: string | null;
  readonly homeDistrict: string | null;
  readonly identifierCiphertext: Uint8Array;
  readonly identifierWrappedDek: Uint8Array;
  readonly identifierKeyVersion: string;
  readonly provenance: 'XYP_VERIFIED' | 'MANUAL';
  readonly approvalState: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  readonly createdByAccountId: string;
  readonly decidedByAccountId: string | null;
}

export interface WantedCaseRow {
  readonly caseId: string;
  readonly personId: string;
  readonly reasonText: string;
  readonly crimeCategory: string;
  readonly owningUnitRef: string;
  readonly state: CaseState;
  readonly activatedAt: Date | null;
  readonly createdByAccountId: string;
  readonly revision: number;
}

export interface MatchRow {
  readonly matchId: string;
  readonly stayId: string;
  readonly wantedPersonId: string;
  readonly hotelId: string;
  readonly hotelName: string;
  readonly hotelDistrict: string;
  readonly hotelAddressLine: string;
  readonly latitudeMicro: number | null;
  readonly longitudeMicro: number | null;
  readonly roomNumber: string;
  readonly detectedAt: Date;
  readonly checkInRecordedAt: Date;
  readonly actualCheckInAt: Date;
  readonly workflowState: MatchWorkflow;
  readonly outcome: MatchOutcome;
  readonly firstAcknowledgedByAccountId: string | null;
  readonly firstAcknowledgedAt: Date | null;
  readonly originatingUnitRef: string;
  readonly falseMatchReviewPending: boolean;
  readonly revision: number;
}

export interface FoundRow {
  readonly foundId: string;
  readonly matchId: string;
  readonly foundByAccountId: string;
  readonly confirmedAt: Date;
  readonly locationKind: 'AT_MATCH_HOTEL' | 'OTHER_LOCATION';
  readonly state: 'ACTIVE' | 'CORRECTED';
}

export interface DecisionRow {
  readonly requestId: string;
  readonly matchId: string;
  readonly requestedByAccountId: string;
  readonly state: 'PENDING' | 'APPROVED' | 'REJECTED';
  readonly decidedByAccountId: string | null;
}

export interface BootstrapCodeRow {
  readonly codeId: string;
  readonly accountId: string;
  readonly purpose: 'ACCOUNT_ACTIVATION' | 'PASSWORD_RESET';
  readonly codeHash: Uint8Array;
  readonly hashKeyVersion: string;
  readonly phoneVersion: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
  readonly invalidatedAt: Date | null;
  readonly lockedUntil: Date | null;
}

function person(row: Row | undefined): WantedPersonRow | undefined {
  if (row === undefined) return undefined;
  return {
    personId: row['person_id'] as string,
    identityToken: row['identity_token'] as string,
    matchToken: row['match_token'] as string,
    matchKeyVersion: row['match_key_version'] as string,
    matchNamespace: row['match_namespace'] as string,
    createdByAccountId: row['created_by_account_id'] as string,
    revision: Number(row['revision']),
  };
}

function revisionOf(row: Row | undefined): IdentityRevisionRow | undefined {
  if (row === undefined) return undefined;
  return {
    revisionId: row['revision_id'] as string,
    personId: row['person_id'] as string,
    revisionNo: Number(row['revision_no']),
    isCurrent: row['is_current'] === true,
    familyName: row['family_name'] as string,
    parentName: row['parent_name'] as string,
    givenName: row['given_name'] as string,
    dateOfBirth: String(row['date_of_birth']).slice(0, 10),
    homeAddress: (row['home_address'] as string | null) ?? null,
    homeDistrict: (row['home_district'] as string | null) ?? null,
    identifierCiphertext: row['identifier_ciphertext'] as Uint8Array,
    identifierWrappedDek: row['identifier_wrapped_dek'] as Uint8Array,
    identifierKeyVersion: row['identifier_key_version'] as string,
    provenance: row['provenance'] as 'XYP_VERIFIED' | 'MANUAL',
    approvalState: row['approval_state'] as 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED',
    createdByAccountId: row['created_by_account_id'] as string,
    decidedByAccountId: (row['decided_by_account_id'] as string | null) ?? null,
  };
}

function caseOf(row: Row | undefined): WantedCaseRow | undefined {
  if (row === undefined) return undefined;
  return {
    caseId: row['case_id'] as string,
    personId: row['person_id'] as string,
    reasonText: row['reason_text'] as string,
    crimeCategory: row['crime_category'] as string,
    owningUnitRef: row['owning_unit_ref'] as string,
    state: row['state'] as CaseState,
    activatedAt: (row['activated_at'] as Date | null) ?? null,
    createdByAccountId: row['created_by_account_id'] as string,
    revision: Number(row['revision']),
  };
}

function matchOf(row: Row | undefined): MatchRow | undefined {
  if (row === undefined) return undefined;
  return {
    matchId: row['match_id'] as string,
    stayId: row['stay_id'] as string,
    wantedPersonId: row['wanted_person_id'] as string,
    hotelId: row['hotel_id'] as string,
    hotelName: row['hotel_name'] as string,
    hotelDistrict: row['hotel_district'] as string,
    hotelAddressLine: row['hotel_address_line'] as string,
    latitudeMicro: (row['latitude_micro'] as number | null) ?? null,
    longitudeMicro: (row['longitude_micro'] as number | null) ?? null,
    roomNumber: row['room_number'] as string,
    detectedAt: row['detected_at'] as Date,
    checkInRecordedAt: row['check_in_recorded_at'] as Date,
    actualCheckInAt: row['actual_check_in_at'] as Date,
    workflowState: row['workflow_state'] as MatchWorkflow,
    outcome: row['outcome'] as MatchOutcome,
    firstAcknowledgedByAccountId:
      (row['first_acknowledged_by_account_id'] as string | null) ?? null,
    firstAcknowledgedAt: (row['first_acknowledged_at'] as Date | null) ?? null,
    originatingUnitRef: row['originating_unit_ref'] as string,
    falseMatchReviewPending: row['false_match_review_pending'] === true,
    revision: Number(row['revision']),
  };
}

const PERSON_COLUMNS = `person_id, identity_namespace, identity_token, identity_key_version,
  match_namespace, match_token, match_key_version, created_by_account_id, revision`;
const REVISION_COLUMNS = `revision_id, person_id, revision_no, is_current, family_name,
  parent_name, given_name, date_of_birth, home_address, home_district, identifier_ciphertext,
  identifier_wrapped_dek, identifier_key_version, provenance, approval_state,
  created_by_account_id, decided_by_account_id, decided_at`;
const CASE_COLUMNS = `case_id, person_id, reason_text, crime_category, owning_unit_ref, state,
  activated_at, terminal_at, created_by_account_id, revision`;
const MATCH_COLUMNS = `match_id, stay_id, wanted_person_id, hotel_id, hotel_name, hotel_district,
  hotel_address_line, latitude_micro, longitude_micro, room_number, detected_at,
  check_in_recorded_at, actual_check_in_at, workflow_state, outcome,
  first_acknowledged_by_account_id, first_acknowledged_at, originating_unit_ref,
  false_match_review_pending, revision`;

export class PoliceRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // ------------------------------------------------------------ wanted person

  async personByIdentityToken(token: string): Promise<WantedPersonRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${PERSON_COLUMNS} FROM police.wanted_person WHERE identity_token = $1`,
      [token],
    );
    return person(result.rows[0]);
  }

  async lockPerson(personId: string): Promise<WantedPersonRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${PERSON_COLUMNS} FROM police.wanted_person WHERE person_id = $1 FOR UPDATE`,
      [personId],
    );
    return person(result.rows[0]);
  }

  async insertPerson(input: {
    identityNamespace: string;
    identityToken: string;
    identityKeyVersion: string;
    matchNamespace: string;
    matchToken: string;
    matchKeyVersion: string;
    createdByAccountId: string;
  }): Promise<WantedPersonRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO police.wanted_person
         (identity_namespace, identity_token, identity_key_version,
          match_namespace, match_token, match_key_version, created_by_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
       RETURNING ${PERSON_COLUMNS}`,
      [
        input.identityNamespace,
        input.identityToken,
        input.identityKeyVersion,
        input.matchNamespace,
        input.matchToken,
        input.matchKeyVersion,
        input.createdByAccountId,
      ],
    );
    return person(result.rows[0]) as WantedPersonRow;
  }

  // -------------------------------------------------------- identity revision

  async insertRevision(input: {
    personId: string;
    revisionNo: number;
    isCurrent: boolean;
    familyName: string;
    parentName: string;
    givenName: string;
    dateOfBirth: string;
    homeAddress: string | null;
    homeDistrict: string | null;
    identifierCiphertext: Uint8Array;
    identifierWrappedDek: Uint8Array;
    identifierKeyVersion: string;
    provenance: 'XYP_VERIFIED' | 'MANUAL';
    approvalState: 'PENDING_APPROVAL' | 'APPROVED';
    createdByAccountId: string;
  }): Promise<IdentityRevisionRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO police.wanted_identity_revision
         (person_id, revision_no, is_current, family_name, parent_name, given_name,
          date_of_birth, home_address, home_district, identifier_ciphertext,
          identifier_wrapped_dek, identifier_key_version, provenance, approval_state,
          created_by_account_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15::uuid)
       RETURNING ${REVISION_COLUMNS}`,
      [
        input.personId,
        input.revisionNo,
        input.isCurrent,
        input.familyName,
        input.parentName,
        input.givenName,
        input.dateOfBirth,
        input.homeAddress,
        input.homeDistrict,
        Buffer.from(input.identifierCiphertext),
        Buffer.from(input.identifierWrappedDek),
        input.identifierKeyVersion,
        input.provenance,
        input.approvalState,
        input.createdByAccountId,
      ],
    );
    return revisionOf(result.rows[0]) as IdentityRevisionRow;
  }

  async nextRevisionNo(personId: string): Promise<number> {
    const result = await this.uow.query<{ next: string }>(
      `SELECT coalesce(max(revision_no), 0)::text AS next
         FROM police.wanted_identity_revision WHERE person_id = $1::uuid`,
      [personId],
    );
    return Number(result.rows[0]?.next ?? '0') + 1;
  }

  async currentRevision(personId: string): Promise<IdentityRevisionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REVISION_COLUMNS} FROM police.wanted_identity_revision
        WHERE person_id = $1::uuid AND is_current`,
      [personId],
    );
    return revisionOf(result.rows[0]);
  }

  async lockRevision(revisionId: string): Promise<IdentityRevisionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REVISION_COLUMNS} FROM police.wanted_identity_revision
        WHERE revision_id = $1::uuid FOR UPDATE`,
      [revisionId],
    );
    return revisionOf(result.rows[0]);
  }

  async pendingRevision(personId: string): Promise<IdentityRevisionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REVISION_COLUMNS} FROM police.wanted_identity_revision
        WHERE person_id = $1::uuid AND approval_state = 'PENDING_APPROVAL'`,
      [personId],
    );
    return revisionOf(result.rows[0]);
  }

  /** The approval decision: the one update the revision guard permits. */
  async decideRevision(input: {
    revisionId: string;
    approved: boolean;
    decidedByAccountId: string;
    decidedAt: Date;
    reason: string;
  }): Promise<void> {
    await this.uow.query(
      `UPDATE police.wanted_identity_revision
          SET approval_state = $2, decided_by_account_id = $3::uuid,
              decided_at = $4, decision_reason = $5
        WHERE revision_id = $1::uuid AND approval_state = 'PENDING_APPROVAL'`,
      [
        input.revisionId,
        input.approved ? 'APPROVED' : 'REJECTED',
        input.decidedByAccountId,
        input.decidedAt,
        input.reason,
      ],
    );
  }

  async makeCurrent(personId: string, revisionId: string): Promise<void> {
    await this.uow.query(
      `UPDATE police.wanted_identity_revision SET is_current = false
        WHERE person_id = $1::uuid AND is_current AND revision_id <> $2::uuid`,
      [personId, revisionId],
    );
    await this.uow.query(
      `UPDATE police.wanted_identity_revision SET is_current = true
        WHERE revision_id = $1::uuid AND approval_state = 'APPROVED'`,
      [revisionId],
    );
  }

  // --------------------------------------------------------------- the case

  async insertCase(input: {
    personId: string;
    reasonText: string;
    crimeCategory: string;
    owningUnitRef: string;
    createdByAccountId: string;
  }): Promise<WantedCaseRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO police.wanted_case
         (person_id, reason_text, crime_category, owning_unit_ref, created_by_account_id)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid)
       RETURNING ${CASE_COLUMNS}`,
      [
        input.personId,
        input.reasonText,
        input.crimeCategory,
        input.owningUnitRef,
        input.createdByAccountId,
      ],
    );
    return caseOf(result.rows[0]) as WantedCaseRow;
  }

  async lockCase(caseId: string): Promise<WantedCaseRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${CASE_COLUMNS} FROM police.wanted_case WHERE case_id = $1::uuid FOR UPDATE`,
      [caseId],
    );
    return caseOf(result.rows[0]);
  }

  async caseById(caseId: string): Promise<WantedCaseRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${CASE_COLUMNS} FROM police.wanted_case WHERE case_id = $1::uuid`,
      [caseId],
    );
    return caseOf(result.rows[0]);
  }

  async casesOf(personId: string): Promise<readonly WantedCaseRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${CASE_COLUMNS} FROM police.wanted_case
        WHERE person_id = $1::uuid ORDER BY created_at`,
      [personId],
    );
    return result.rows.map((row) => caseOf(row) as WantedCaseRow);
  }

  /** A compare-and-set on the case's revision: two lifecycle commands cannot both win. */
  async moveCase(input: {
    caseId: string;
    expectedRevision: number;
    to: CaseState;
    at: Date;
    terminal: boolean;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE police.wanted_case
          SET state = $3,
              activated_at = CASE WHEN $3 = 'ACTIVE' AND activated_at IS NULL
                                  THEN $4 ELSE activated_at END,
              terminal_at = CASE WHEN $5 THEN $4 ELSE NULL END,
              revision = revision + 1
        WHERE case_id = $1::uuid AND revision = $2`,
      [input.caseId, input.expectedRevision, input.to, input.at, input.terminal],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async appendCaseEvent(input: {
    caseId: string;
    fromState: CaseState;
    toState: CaseState;
    reason: string;
    actorAccountId: string;
    at: Date;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO police.wanted_case_event
         (case_id, from_state, to_state, reason, actor_account_id, occurred_at)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)`,
      [input.caseId, input.fromState, input.toState, input.reason, input.actorAccountId, input.at],
    );
  }

  // -------------------------------------------------------------- the match

  async matchById(matchId: string): Promise<MatchRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${MATCH_COLUMNS} FROM police.police_match WHERE match_id = $1::uuid`,
      [matchId],
    );
    return matchOf(result.rows[0]);
  }

  async lockMatch(matchId: string): Promise<MatchRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${MATCH_COLUMNS} FROM police.police_match WHERE match_id = $1::uuid FOR UPDATE`,
      [matchId],
    );
    return matchOf(result.rows[0]);
  }

  /** doc 13 §9: the exact search — a whole registration token, or a whole match id. */
  async activeMatchByPersonToken(identityToken: string): Promise<MatchRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${MATCH_COLUMNS} FROM police.police_match m
        WHERE m.wanted_person_id = (SELECT p.person_id FROM police.wanted_person p
                                     WHERE p.identity_token = $1)
          AND m.workflow_state <> 'RESOLVED'
        ORDER BY m.detected_at DESC LIMIT 1`,
      [identityToken],
    );
    return matchOf(result.rows[0]);
  }

  async matchesOfStay(stayId: string): Promise<readonly MatchRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${MATCH_COLUMNS} FROM police.police_match WHERE stay_id = $1::uuid`,
      [stayId],
    );
    return result.rows.map((row) => matchOf(row) as MatchRow);
  }

  async acknowledgeMatch(input: {
    matchId: string;
    expectedRevision: number;
    accountId: string;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE police.police_match
          SET workflow_state = 'ACKNOWLEDGED',
              first_acknowledged_by_account_id
                = coalesce(first_acknowledged_by_account_id, $3::uuid),
              first_acknowledged_at = coalesce(first_acknowledged_at, $4),
              revision = revision + 1
        WHERE match_id = $1::uuid AND revision = $2 AND workflow_state = 'NEW'`,
      [input.matchId, input.expectedRevision, input.accountId, input.at],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async setMatchWorkflow(input: {
    matchId: string;
    expectedRevision: number;
    workflow: MatchWorkflow;
    outcome: MatchOutcome;
    falseMatchReviewPending?: boolean;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE police.police_match
          SET workflow_state = $3, outcome = $4,
              false_match_review_pending
                = coalesce($5::boolean, false_match_review_pending),
              revision = revision + 1
        WHERE match_id = $1::uuid AND revision = $2`,
      [
        input.matchId,
        input.expectedRevision,
        input.workflow,
        input.outcome,
        input.falseMatchReviewPending ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async appendMatchEvent(input: {
    matchId: string;
    eventType: string;
    payload?: Record<string, unknown>;
    actorAccountId?: string;
    at: Date;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO police.match_event (match_id, event_type, payload, actor_account_id, occurred_at)
       VALUES ($1::uuid, $2, $3::jsonb, $4::uuid, $5)`,
      [
        input.matchId,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        input.actorAccountId ?? null,
        input.at,
      ],
    );
  }

  async linkCase(matchId: string, caseId: string, at: Date): Promise<boolean> {
    const result = await this.uow.query(
      `INSERT INTO police.match_case_link (match_id, case_id, linked_at)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (match_id, case_id) DO NOTHING`,
      [matchId, caseId, at],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async linkedCases(matchId: string): Promise<readonly string[]> {
    const result = await this.uow.query<{ case_id: string }>(
      `SELECT case_id FROM police.match_case_link WHERE match_id = $1::uuid ORDER BY linked_at`,
      [matchId],
    );
    return result.rows.map((row) => row.case_id);
  }

  async matchEvents(matchId: string): Promise<readonly { type: string; at: Date }[]> {
    const result = await this.uow.query<{ event_type: string; occurred_at: Date }>(
      `SELECT event_type, occurred_at FROM police.match_event
        WHERE match_id = $1::uuid ORDER BY occurred_at, event_id`,
      [matchId],
    );
    return result.rows.map((row) => ({ type: row.event_type, at: row.occurred_at }));
  }

  // ------------------------------------------------------------------ found

  async insertFound(input: {
    matchId: string;
    foundByAccountId: string;
    foundByUnitRef: string;
    confirmedAt: Date;
    locationKind: 'AT_MATCH_HOTEL' | 'OTHER_LOCATION';
    locationNote: string | null;
    taskReference: string | null;
    note: string | null;
  }): Promise<string> {
    const result = await this.uow.query<{ found_id: string }>(
      `INSERT INTO police.found_confirmation
         (match_id, found_by_account_id, found_by_unit_ref, confirmed_at,
          location_kind, location_note, task_reference, note)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
       RETURNING found_id`,
      [
        input.matchId,
        input.foundByAccountId,
        input.foundByUnitRef,
        input.confirmedAt,
        input.locationKind,
        input.locationNote,
        input.taskReference,
        input.note,
      ],
    );
    return result.rows[0]?.found_id as string;
  }

  async activeFound(matchId: string): Promise<FoundRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT found_id, match_id, found_by_account_id, confirmed_at, location_kind, state
         FROM police.found_confirmation
        WHERE match_id = $1::uuid AND state = 'ACTIVE'`,
      [matchId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      foundId: row['found_id'] as string,
      matchId: row['match_id'] as string,
      foundByAccountId: row['found_by_account_id'] as string,
      confirmedAt: row['confirmed_at'] as Date,
      locationKind: row['location_kind'] as 'AT_MATCH_HOTEL' | 'OTHER_LOCATION',
      state: row['state'] as 'ACTIVE' | 'CORRECTED',
    };
  }

  async markFoundCorrected(foundId: string, at: Date): Promise<void> {
    await this.uow.query(
      `UPDATE police.found_confirmation SET state = 'CORRECTED', corrected_at = $2
        WHERE found_id = $1::uuid AND state = 'ACTIVE'`,
      [foundId, at],
    );
  }

  // ------------------------------------------------ the two-person decisions

  async insertFoundCorrection(input: {
    matchId: string;
    foundId: string;
    requestedByAccountId: string;
    reason: string;
    at: Date;
  }): Promise<string> {
    const result = await this.uow.query<{ request_id: string }>(
      `INSERT INTO police.found_correction_request
         (match_id, found_id, requested_by_account_id, reason, requested_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
       RETURNING request_id`,
      [input.matchId, input.foundId, input.requestedByAccountId, input.reason, input.at],
    );
    return result.rows[0]?.request_id as string;
  }

  async pendingFoundCorrection(matchId: string): Promise<DecisionRow | undefined> {
    return this.pendingDecision('found_correction_request', matchId);
  }

  async lockFoundCorrection(requestId: string): Promise<DecisionRow | undefined> {
    return this.lockDecision('found_correction_request', requestId);
  }

  async decideFoundCorrection(input: {
    requestId: string;
    approved: boolean;
    decidedByAccountId: string;
    decidedAt: Date;
    note: string;
  }): Promise<boolean> {
    return this.decide('found_correction_request', input);
  }

  async insertFalseMatch(input: {
    matchId: string;
    requestedByAccountId: string;
    reasonCode: string;
    reasonNote: string;
    at: Date;
  }): Promise<string> {
    const result = await this.uow.query<{ request_id: string }>(
      `INSERT INTO police.false_match_request
         (match_id, requested_by_account_id, reason_code, reason_note, requested_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)
       RETURNING request_id`,
      [input.matchId, input.requestedByAccountId, input.reasonCode, input.reasonNote, input.at],
    );
    return result.rows[0]?.request_id as string;
  }

  async pendingFalseMatch(matchId: string): Promise<DecisionRow | undefined> {
    return this.pendingDecision('false_match_request', matchId);
  }

  async lockFalseMatch(requestId: string): Promise<DecisionRow | undefined> {
    return this.lockDecision('false_match_request', requestId);
  }

  async decideFalseMatch(input: {
    requestId: string;
    approved: boolean;
    decidedByAccountId: string;
    decidedAt: Date;
    note: string;
  }): Promise<boolean> {
    return this.decide('false_match_request', input);
  }

  private async pendingDecision(table: string, matchId: string): Promise<DecisionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT request_id, match_id, requested_by_account_id, state, decided_by_account_id
         FROM police.${table} WHERE match_id = $1::uuid AND state = 'PENDING'`,
      [matchId],
    );
    return decision(result.rows[0]);
  }

  private async lockDecision(table: string, requestId: string): Promise<DecisionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT request_id, match_id, requested_by_account_id, state, decided_by_account_id
         FROM police.${table} WHERE request_id = $1::uuid FOR UPDATE`,
      [requestId],
    );
    return decision(result.rows[0]);
  }

  private async decide(
    table: string,
    input: {
      requestId: string;
      approved: boolean;
      decidedByAccountId: string;
      decidedAt: Date;
      note: string;
    },
  ): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE police.${table}
          SET state = $2, decided_by_account_id = $3::uuid, decided_at = $4, decision_note = $5
        WHERE request_id = $1::uuid AND state = 'PENDING'`,
      [
        input.requestId,
        input.approved ? 'APPROVED' : 'REJECTED',
        input.decidedByAccountId,
        input.decidedAt,
        input.note,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }
}

function decision(row: Row | undefined): DecisionRow | undefined {
  if (row === undefined) return undefined;
  return {
    requestId: row['request_id'] as string,
    matchId: row['match_id'] as string,
    requestedByAccountId: row['requested_by_account_id'] as string,
    state: row['state'] as 'PENDING' | 'APPROVED' | 'REJECTED',
    decidedByAccountId: (row['decided_by_account_id'] as string | null) ?? null,
  };
}
