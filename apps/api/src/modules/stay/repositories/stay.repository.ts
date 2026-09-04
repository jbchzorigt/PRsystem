import type { UnitOfWork } from '@prsystem/db';
import type { StayType } from '../domain/timing';

/**
 * The stay, its primary guest revisions, its minibar price book and its
 * history (doc 05 §§2–3, §19.3; doc 25 §3; `RC-DEC-033`, `PRICE-DEC-001`).
 */

export type StayState = 'ACTIVE' | 'CHECKOUT_IN_PROGRESS' | 'COMPLETED';
export type StaySource = 'WALK_IN' | 'ONLINE';

export interface StayRow {
  readonly stayId: string;
  readonly roomId: string;
  readonly categoryId: string;
  readonly source: StaySource;
  readonly bookingRef: string | null;
  readonly stayType: StayType;
  readonly state: StayState;
  readonly actualCheckInAt: Date;
  readonly checkInRecordedAt: Date;
  readonly plannedCheckoutAt: Date;
  readonly halfHourUnits: number | null;
  readonly durationMinutes: number | null;
  readonly nightCount: number | null;
  readonly fixedCheckoutMinute: number | null;
  readonly cleaningBufferMinutes: number;
  readonly rateSnapshotId: string;
  readonly unitRateMnt: bigint;
  readonly roomChargeMnt: bigint;
  readonly pricingConfigVersion: number;
  readonly depositRequired: boolean;
  readonly shiftId: string;
  readonly checkedInByAccountId: string;
  readonly backdateMinutes: number;
  readonly backdateReasonCode: string | null;
  readonly backdateNote: string | null;
  readonly minibarApplicable: boolean;
  readonly actualCheckoutAt: Date | null;
  readonly checkoutRecordedByAccountId: string | null;
  readonly revision: number;
  readonly createdAt: Date;
}

const STAY_COLUMNS = `stay_id, room_id, category_id, source, booking_ref, stay_type, state,
  actual_check_in_at, check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
  night_count, fixed_checkout_minute, cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt,
  room_charge_mnt, pricing_config_version, deposit_required, shift_id, checked_in_by_account_id,
  backdate_minutes, backdate_reason_code, backdate_note, minibar_applicable, actual_checkout_at,
  checkout_recorded_by_account_id, revision, created_at`;

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function mapStay(row: Record<string, unknown> | undefined): StayRow | undefined {
  if (row === undefined) return undefined;
  return {
    stayId: row['stay_id'] as string,
    roomId: row['room_id'] as string,
    categoryId: row['category_id'] as string,
    source: row['source'] as StaySource,
    bookingRef: (row['booking_ref'] as string | null) ?? null,
    stayType: row['stay_type'] as StayType,
    state: row['state'] as StayState,
    actualCheckInAt: row['actual_check_in_at'] as Date,
    checkInRecordedAt: row['check_in_recorded_at'] as Date,
    plannedCheckoutAt: row['planned_checkout_at'] as Date,
    halfHourUnits: optionalNumber(row['half_hour_units']),
    durationMinutes: optionalNumber(row['duration_minutes']),
    nightCount: optionalNumber(row['night_count']),
    fixedCheckoutMinute: optionalNumber(row['fixed_checkout_minute']),
    cleaningBufferMinutes: Number(row['cleaning_buffer_minutes']),
    rateSnapshotId: row['rate_snapshot_id'] as string,
    unitRateMnt: BigInt(row['unit_rate_mnt'] as string),
    roomChargeMnt: BigInt(row['room_charge_mnt'] as string),
    pricingConfigVersion: Number(row['pricing_config_version']),
    depositRequired: row['deposit_required'] as boolean,
    shiftId: row['shift_id'] as string,
    checkedInByAccountId: row['checked_in_by_account_id'] as string,
    backdateMinutes: Number(row['backdate_minutes']),
    backdateReasonCode: (row['backdate_reason_code'] as string | null) ?? null,
    backdateNote: (row['backdate_note'] as string | null) ?? null,
    minibarApplicable: row['minibar_applicable'] as boolean,
    actualCheckoutAt: (row['actual_checkout_at'] as Date | null) ?? null,
    checkoutRecordedByAccountId: (row['checkout_recorded_by_account_id'] as string | null) ?? null,
    revision: Number(row['revision']),
    createdAt: row['created_at'] as Date,
  };
}

export interface InsertStayInput {
  readonly stayId: string;
  readonly roomId: string;
  readonly categoryId: string;
  readonly source: StaySource;
  readonly bookingRef: string | null;
  readonly stayType: StayType;
  readonly actualCheckInAt: Date;
  readonly checkInRecordedAt: Date;
  readonly plannedCheckoutAt: Date;
  readonly halfHourUnits: number | null;
  readonly nightCount: number | null;
  readonly fixedCheckoutMinute: number | null;
  readonly cleaningBufferMinutes: number;
  readonly rateSnapshotId: string;
  readonly unitRateMnt: bigint;
  readonly roomChargeMnt: bigint;
  readonly pricingConfigVersion: number;
  readonly shiftId: string;
  readonly checkedInByAccountId: string;
  readonly backdateMinutes: number;
  readonly backdateReasonCode: string | null;
  readonly backdateNote: string | null;
  readonly minibarApplicable: boolean;
}

export interface GuestRow {
  readonly guestRecordId: string;
  readonly stayId: string;
  readonly revisionNo: number;
  readonly isCurrent: boolean;
  readonly identityType: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly dateOfBirth: string;
  readonly nationality: string;
  readonly provenance: string;
  readonly assurance: string;
  readonly lookupToken: string | null;
  readonly lookupNamespace: string | null;
  readonly documentCountry: string | null;
  readonly documentExpiresOn: string | null;
  readonly documentType: string | null;
  readonly documentAuthority: string | null;
  readonly noDocumentReason: string | null;
  readonly noDocumentNote: string | null;
  readonly ageAtCheckIn: number | null;
  readonly guardianName: string | null;
  readonly guardianPhone: string | null;
  readonly guardianRelationship: string | null;
  readonly policeMatchEligibility: string;
  readonly correctionReason: string | null;
  readonly recordedAt: Date;
}

/** Everything but the ciphertext: a read never carries the encrypted identifier out of the row. */
const GUEST_COLUMNS = `guest_record_id, stay_id, revision_no, is_current, identity_type, family_name,
  given_name, date_of_birth::text AS date_of_birth, nationality, provenance, assurance, lookup_token,
  lookup_namespace, document_country, document_expires_on::text AS document_expires_on, document_type,
  document_authority, no_document_reason, no_document_note, age_at_check_in, guardian_name,
  guardian_phone, guardian_relationship, police_match_eligibility, correction_reason, recorded_at`;

function mapGuest(row: Record<string, unknown> | undefined): GuestRow | undefined {
  if (row === undefined) return undefined;
  const text = (key: string): string | null => (row[key] as string | null) ?? null;
  return {
    guestRecordId: row['guest_record_id'] as string,
    stayId: row['stay_id'] as string,
    revisionNo: Number(row['revision_no']),
    isCurrent: row['is_current'] as boolean,
    identityType: row['identity_type'] as string,
    familyName: row['family_name'] as string,
    givenName: row['given_name'] as string,
    dateOfBirth: row['date_of_birth'] as string,
    nationality: row['nationality'] as string,
    provenance: row['provenance'] as string,
    assurance: row['assurance'] as string,
    lookupToken: text('lookup_token'),
    lookupNamespace: text('lookup_namespace'),
    documentCountry: text('document_country'),
    documentExpiresOn: text('document_expires_on'),
    documentType: text('document_type'),
    documentAuthority: text('document_authority'),
    noDocumentReason: text('no_document_reason'),
    noDocumentNote: text('no_document_note'),
    ageAtCheckIn: optionalNumber(row['age_at_check_in']),
    guardianName: text('guardian_name'),
    guardianPhone: text('guardian_phone'),
    guardianRelationship: text('guardian_relationship'),
    policeMatchEligibility: row['police_match_eligibility'] as string,
    correctionReason: text('correction_reason'),
    recordedAt: row['recorded_at'] as Date,
  };
}

export interface InsertGuestInput {
  /** Generated by the caller: the envelope's authenticated data binds the ciphertext to it. */
  readonly guestRecordId: string;
  readonly stayId: string;
  readonly revisionNo: number;
  readonly identityType: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly dateOfBirth: string;
  readonly nationality: string;
  readonly provenance: string;
  readonly assurance: string;
  readonly identifier: {
    readonly ciphertext: Uint8Array;
    readonly wrappedDek: Uint8Array;
    readonly keyVersion: string;
    readonly lookupToken: string;
    readonly lookupKeyVersion: string;
    readonly lookupNamespace: string;
  } | null;
  readonly documentCountry: string | null;
  readonly documentExpiresOn: string | null;
  readonly documentType: string | null;
  readonly documentAuthority: string | null;
  readonly noDocumentReason: string | null;
  readonly noDocumentNote: string | null;
  readonly ageAtCheckIn: number | null;
  readonly guardian: { name: string; phone: string; relationship: string } | null;
  readonly policeMatchEligibility: string;
  readonly correctionReason: string | null;
  readonly recordedByAccountId: string;
}

export interface PriceLine {
  readonly productId: string;
  readonly productName: string;
  readonly productCategory: string | null;
  readonly productUnit: string | null;
  readonly sellingPriceMnt: bigint;
  readonly targetQuantity: number;
  readonly openingQuantity: number;
}

export interface PriceBook {
  readonly stayId: string;
  readonly roomId: string;
  readonly templateId: string;
  readonly versionId: string;
  readonly snapshotAt: Date;
  readonly lines: readonly PriceLine[];
}

export interface StayEventInput {
  readonly stayId: string;
  readonly eventType: string;
  readonly fromState?: string;
  readonly toState?: string;
  readonly reason?: string;
  readonly payload?: Record<string, unknown>;
  readonly actorAccountId: string | null;
  readonly occurredAt?: Date;
}

export class StayRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  // ------------------------------------------------------------------ stay

  async insert(input: InsertStayInput): Promise<StayRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.stay
         (stay_id, hotel_id, room_id, category_id, source, booking_ref, stay_type,
          actual_check_in_at, check_in_recorded_at, planned_checkout_at, half_hour_units,
          duration_minutes, night_count, fixed_checkout_minute, cleaning_buffer_minutes,
          rate_snapshot_id, unit_rate_mnt, room_charge_mnt, pricing_config_version,
          deposit_required, shift_id, checked_in_by_account_id, backdate_minutes,
          backdate_reason_code, backdate_note, minibar_applicable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26)
       RETURNING ${STAY_COLUMNS}`,
      [
        input.stayId,
        this.hotelId,
        input.roomId,
        input.categoryId,
        input.source,
        input.bookingRef,
        input.stayType,
        input.actualCheckInAt,
        input.checkInRecordedAt,
        input.plannedCheckoutAt,
        input.halfHourUnits,
        input.halfHourUnits === null ? null : input.halfHourUnits * 30,
        input.nightCount,
        input.fixedCheckoutMinute,
        input.cleaningBufferMinutes,
        input.rateSnapshotId,
        input.unitRateMnt.toString(),
        input.roomChargeMnt.toString(),
        input.pricingConfigVersion,
        input.source === 'WALK_IN',
        input.shiftId,
        input.checkedInByAccountId,
        input.backdateMinutes,
        input.backdateReasonCode,
        input.backdateNote,
        input.minibarApplicable,
      ],
    );
    const row = mapStay(result.rows[0]);
    if (row === undefined) throw new Error('the stay insert returned no row');
    return row;
  }

  async byId(stayId: string): Promise<StayRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STAY_COLUMNS} FROM platform.stay WHERE hotel_id = $1 AND stay_id = $2`,
      [this.hotelId, stayId],
    );
    return mapStay(result.rows[0]);
  }

  async lock(stayId: string): Promise<StayRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STAY_COLUMNS} FROM platform.stay WHERE hotel_id = $1 AND stay_id = $2 FOR UPDATE`,
      [this.hotelId, stayId],
    );
    return mapStay(result.rows[0]);
  }

  /** The stay occupying a room now: active, or in checkout (doc 05 §22.2). */
  async liveOfRoom(roomId: string): Promise<StayRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STAY_COLUMNS} FROM platform.stay
        WHERE hotel_id = $1 AND room_id = $2 AND state <> 'COMPLETED'`,
      [this.hotelId, roomId],
    );
    return mapStay(result.rows[0]);
  }

  async liveStays(): Promise<readonly StayRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STAY_COLUMNS} FROM platform.stay WHERE hotel_id = $1 AND state <> 'COMPLETED'`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapStay(row) as StayRow);
  }

  /** The most recently completed stay of a room: its checkout anchors readiness. */
  async lastCompletedOfRoom(roomId: string): Promise<StayRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${STAY_COLUMNS} FROM platform.stay
        WHERE hotel_id = $1 AND room_id = $2 AND state = 'COMPLETED'
        ORDER BY actual_checkout_at DESC LIMIT 1`,
      [this.hotelId, roomId],
    );
    return mapStay(result.rows[0]);
  }

  async lastCompletedOfRooms(roomIds: readonly string[]): Promise<Map<string, StayRow>> {
    if (roomIds.length === 0) return new Map();
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (room_id) ${STAY_COLUMNS} FROM platform.stay
        WHERE hotel_id = $1 AND room_id = ANY($2::uuid[]) AND state = 'COMPLETED'
        ORDER BY room_id, actual_checkout_at DESC`,
      [this.hotelId, roomIds],
    );
    return new Map(result.rows.map((row) => [row['room_id'] as string, mapStay(row) as StayRow]));
  }

  async transition(input: {
    stayId: string;
    expectedRevision: number;
    toState: StayState;
    actualCheckoutAt?: Date;
    checkoutRecordedByAccountId?: string;
  }): Promise<StayRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.stay
          SET state = $4,
              actual_checkout_at = COALESCE($5, actual_checkout_at),
              checkout_recorded_by_account_id = COALESCE($6, checkout_recorded_by_account_id),
              revision = revision + 1
        WHERE hotel_id = $1 AND stay_id = $2 AND revision = $3
        RETURNING ${STAY_COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.expectedRevision,
        input.toState,
        input.actualCheckoutAt ?? null,
        input.checkoutRecordedByAccountId ?? null,
      ],
    );
    return mapStay(result.rows[0]);
  }

  // ----------------------------------------------------------------- guest

  async insertGuest(input: InsertGuestInput): Promise<GuestRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.stay_guest
         (guest_record_id, hotel_id, stay_id, revision_no, is_current, identity_type, family_name, given_name,
          date_of_birth, nationality, provenance, assurance, identifier_ciphertext,
          identifier_wrapped_dek, identifier_key_version, lookup_token, lookup_key_version,
          lookup_namespace, document_country, document_expires_on, document_type,
          document_authority, no_document_reason, no_document_note, age_at_check_in,
          guardian_name, guardian_phone, guardian_relationship, police_match_eligibility,
          correction_reason, recorded_by_account_id)
       VALUES ($30, $1, $2, $3, true, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18::date, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
       RETURNING ${GUEST_COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.revisionNo,
        input.identityType,
        input.familyName,
        input.givenName,
        input.dateOfBirth,
        input.nationality,
        input.provenance,
        input.assurance,
        input.identifier === null ? null : Buffer.from(input.identifier.ciphertext),
        input.identifier === null ? null : Buffer.from(input.identifier.wrappedDek),
        input.identifier?.keyVersion ?? null,
        input.identifier?.lookupToken ?? null,
        input.identifier?.lookupKeyVersion ?? null,
        input.identifier?.lookupNamespace ?? null,
        input.documentCountry,
        input.documentExpiresOn,
        input.documentType,
        input.documentAuthority,
        input.noDocumentReason,
        input.noDocumentNote,
        input.ageAtCheckIn,
        input.guardian?.name ?? null,
        input.guardian?.phone ?? null,
        input.guardian?.relationship ?? null,
        input.policeMatchEligibility,
        input.correctionReason,
        input.recordedByAccountId,
        input.guestRecordId,
      ],
    );
    const row = mapGuest(result.rows[0]);
    if (row === undefined) throw new Error('the guest insert returned no row');
    return row;
  }

  async currentGuest(stayId: string): Promise<GuestRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${GUEST_COLUMNS} FROM platform.stay_guest
        WHERE hotel_id = $1 AND stay_id = $2 AND is_current IS TRUE`,
      [this.hotelId, stayId],
    );
    return mapGuest(result.rows[0]);
  }

  async lockCurrentGuest(stayId: string): Promise<GuestRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${GUEST_COLUMNS} FROM platform.stay_guest
        WHERE hotel_id = $1 AND stay_id = $2 AND is_current IS TRUE FOR UPDATE`,
      [this.hotelId, stayId],
    );
    return mapGuest(result.rows[0]);
  }

  /** The one update the guard admits: retiring the current revision before the next is written. */
  async retireGuestRevision(guestRecordId: string): Promise<void> {
    await this.uow.query(
      `UPDATE platform.stay_guest SET is_current = false
        WHERE hotel_id = $1 AND guest_record_id = $2 AND is_current IS TRUE`,
      [this.hotelId, guestRecordId],
    );
  }

  async guestRevisions(stayId: string): Promise<readonly GuestRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${GUEST_COLUMNS} FROM platform.stay_guest
        WHERE hotel_id = $1 AND stay_id = $2 ORDER BY revision_no`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => mapGuest(row) as GuestRow);
  }

  // ------------------------------------------------------------ price book

  async insertPriceBook(input: {
    stayId: string;
    roomId: string;
    templateId: string;
    versionId: string;
    snapshotAt: Date;
    lines: readonly PriceLine[];
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.stay_minibar_snapshot (stay_id, hotel_id, room_id, template_id, version_id, snapshot_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.stayId,
        this.hotelId,
        input.roomId,
        input.templateId,
        input.versionId,
        input.snapshotAt,
      ],
    );
    for (const line of input.lines) {
      await this.uow.query(
        `INSERT INTO platform.stay_minibar_price
           (stay_id, product_id, hotel_id, product_name, product_category, product_unit,
            selling_price_mnt, target_quantity, opening_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.stayId,
          line.productId,
          this.hotelId,
          line.productName,
          line.productCategory,
          line.productUnit,
          line.sellingPriceMnt.toString(),
          line.targetQuantity,
          line.openingQuantity,
        ],
      );
    }
  }

  async priceBook(stayId: string): Promise<PriceBook | undefined> {
    const header = await this.uow.query<Record<string, unknown>>(
      `SELECT stay_id, room_id, template_id, version_id, snapshot_at
         FROM platform.stay_minibar_snapshot WHERE hotel_id = $1 AND stay_id = $2`,
      [this.hotelId, stayId],
    );
    const row = header.rows[0];
    if (row === undefined) return undefined;
    const lines = await this.uow.query<Record<string, unknown>>(
      `SELECT product_id, product_name, product_category, product_unit, selling_price_mnt,
              target_quantity, opening_quantity
         FROM platform.stay_minibar_price WHERE hotel_id = $1 AND stay_id = $2
        ORDER BY product_name, product_id`,
      [this.hotelId, stayId],
    );
    return {
      stayId: row['stay_id'] as string,
      roomId: row['room_id'] as string,
      templateId: row['template_id'] as string,
      versionId: row['version_id'] as string,
      snapshotAt: row['snapshot_at'] as Date,
      lines: lines.rows.map((line) => ({
        productId: line['product_id'] as string,
        productName: line['product_name'] as string,
        productCategory: (line['product_category'] as string | null) ?? null,
        productUnit: (line['product_unit'] as string | null) ?? null,
        sellingPriceMnt: BigInt(line['selling_price_mnt'] as string),
        targetQuantity: Number(line['target_quantity']),
        openingQuantity: Number(line['opening_quantity']),
      })),
    };
  }

  // --------------------------------------------------------------- history

  async appendEvent(input: StayEventInput): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.stay_event
         (hotel_id, stay_id, event_type, from_state, to_state, reason, payload, actor_account_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, COALESCE($9, now()))`,
      [
        this.hotelId,
        input.stayId,
        input.eventType,
        input.fromState ?? null,
        input.toState ?? null,
        input.reason ?? null,
        JSON.stringify(input.payload ?? {}),
        input.actorAccountId,
        input.occurredAt ?? null,
      ],
    );
  }

  async events(stayId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT event_type, from_state, to_state, reason, payload, actor_account_id, occurred_at
         FROM platform.stay_event WHERE hotel_id = $1 AND stay_id = $2 ORDER BY occurred_at, event_id`,
      [this.hotelId, stayId],
    );
    return result.rows;
  }
}
