import { ApiError } from '@prsystem/contracts';
import { recordPoliceAudit } from '@prsystem/db';
import { decryptValue } from '@prsystem/ports';
import { MAX_HISTORICAL_WINDOW_DAYS, refuseHistoricalWindow } from '../domain/police';
import type { CommandActor, PoliceDependencies, RequestContext } from './police-context';
import { CHECKIN_LIST, PoliceServiceBase } from './police-context';

/**
 * The all-hotel check-in list (doc 13 §4.1, `POL-DEC-010`).
 *
 * The most sensitive read in the platform, and the one with the most rules.
 *
 * **Police Admin only.** Not a tab an Officer cannot see — an action an Officer
 * has no permission for, refused by the pipeline before this service does
 * anything. doc 18 §6 denies the row to the Officer column outright.
 *
 * **Active stays by default.** Opening the list shows who is in a hotel now.
 * Reaching a checked-out stay is a *historical search*, and a historical search
 * needs a reason, a start and an end, and at most 31 days between them.
 *
 * **No export, at all.** doc 13 §4.1 closes bulk export to both Police roles in
 * the MVP, and there is no method here that produces a file — not a hidden one,
 * not a paginated one a caller could walk.
 *
 * **Every open, filter and detail is audited**, with the account, the time, the
 * device and the scope, and without the identifiers the list itself shows.
 */

export interface CheckInRow {
  readonly rowNumber: number;
  readonly hotelName: string;
  readonly district: string;
  readonly familyName: string;
  readonly givenName: string;
  /** doc 13 §4.1: unmasked for the Police Admin, and for nobody else. */
  readonly registrationNumber: string | null;
  readonly roomNumber: string;
  readonly checkInAt: Date;
  readonly plannedCheckoutAt: Date;
  readonly stayType: string;
  readonly source: string;
  readonly stayState: string;
}

export interface CheckInPage {
  readonly rows: readonly CheckInRow[];
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly historical: boolean;
}

export const CHECKIN_PAGE_SIZE = 50;

export class CheckInListService extends PoliceServiceBase {
  constructor(deps: PoliceDependencies) {
    super(deps);
  }

  async list(
    input: {
      /** Absent means the active stays, which is what opening the list shows. */
      readonly from?: Date;
      readonly to?: Date;
      /** Mandatory for a historical search, and meaningless without one. */
      readonly searchReason?: string;
      readonly page?: number;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CheckInPage> {
    const historical = input.from !== undefined || input.to !== undefined;
    return this.runPoliceCommand(actor, CHECKIN_LIST, request, async (uow, authorize) => {
      await authorize();

      if (historical) {
        const refusal = refuseHistoricalWindow(input.from, input.to);
        if (refusal !== undefined) {
          await this.auditAttempt(uow, actor, request, refusal, historical);
          throw new ApiError(
            'VALIDATION_FAILED',
            refusal === 'RANGE_TOO_LONG'
              ? `RANGE_TOO_LONG: a historical search covers at most ${String(MAX_HISTORICAL_WINDOW_DAYS)} days`
              : 'a historical search states a start and an end',
          );
        }
        if ((input.searchReason ?? '').trim().length < 10) {
          await this.auditAttempt(uow, actor, request, 'REASON_REQUIRED', historical);
          throw new ApiError('VALIDATION_FAILED', 'a historical search states its reason');
        }
        // doc 13 §4.1: without an approved retention configuration the
        // historical search is not enabled. The absence of the row is the
        // switch, so production cannot acquire the capability by deploying.
        const policy = await uow.query<{ retention_days: number }>(
          `SELECT retention_days FROM police.checkin_retention_policy
            WHERE effective_at <= now() ORDER BY version DESC LIMIT 1`,
        );
        if (policy.rows[0] === undefined) {
          await this.auditAttempt(uow, actor, request, 'RETENTION_NOT_APPROVED', historical);
          throw new ApiError(
            'PRECONDITION_FAILED',
            'RETENTION_NOT_APPROVED: historical search is disabled until a retention policy is approved',
          );
        }
      }

      const page = Math.max(1, input.page ?? 1);
      const offset = (page - 1) * CHECKIN_PAGE_SIZE;
      const result = await uow.query<{
        stay_id: string;
        guest_record_id: string;
        hotel_name: string;
        district: string;
        family_name: string;
        given_name: string;
        identifier_ciphertext: Uint8Array | null;
        identifier_wrapped_dek: Uint8Array | null;
        identifier_key_version: string | null;
        identity_type: string;
        room_number: string;
        check_in_at: Date;
        planned_checkout_at: Date;
        stay_type: string;
        source: string;
        stay_state: string;
        total_rows: string;
      }>(
        `SELECT * FROM police.check_in_list($1::timestamptz, $2::timestamptz, $3::boolean,
                                            $4::integer, $5::integer)`,
        [
          input.from ?? new Date(0),
          input.to ?? new Date(0),
          !historical,
          CHECKIN_PAGE_SIZE,
          offset,
        ],
      );

      const rows: CheckInRow[] = [];
      let index = offset;
      for (const row of result.rows) {
        index += 1;
        rows.push({
          rowNumber: index,
          hotelName: row.hotel_name,
          district: row.district,
          familyName: row.family_name,
          givenName: row.given_name,
          registrationNumber: await this.identifierOf(row),
          roomNumber: row.room_number,
          checkInAt: row.check_in_at,
          plannedCheckoutAt: row.planned_checkout_at,
          stayType: row.stay_type,
          source: row.source,
          stayState: row.stay_state,
        });
      }

      await recordPoliceAudit(uow, {
        action: historical ? 'police.checkin_list.historical' : 'police.checkin_list.active',
        outcome: 'allowed',
        ...(input.searchReason === undefined ? {} : { reason: input.searchReason }),
        payload: {
          page,
          rows: rows.length,
          device: request.deviceRef ?? null,
          ...(historical
            ? {
                from: input.from?.toISOString() ?? null,
                to: input.to?.toISOString() ?? null,
              }
            : {}),
        },
      });

      return {
        rows,
        totalRows: Number(result.rows[0]?.total_rows ?? '0'),
        page,
        pageSize: CHECKIN_PAGE_SIZE,
        historical,
      };
    });
  }

  /**
   * The guest's registration number, decrypted under the *hotel* key scope.
   *
   * The ciphertext belongs to `platform.stay_guest` and was sealed by the check-
   * in that wrote it, so this reads it under the scope it was written with. A
   * guest with no document has none, and the column is then simply empty.
   */
  private async identifierOf(row: {
    guest_record_id: string;
    identity_type: string;
    identifier_ciphertext: Uint8Array | null;
    identifier_wrapped_dek: Uint8Array | null;
    identifier_key_version: string | null;
  }): Promise<string | null> {
    if (
      row.identifier_ciphertext === null ||
      row.identifier_wrapped_dek === null ||
      row.identifier_key_version === null
    ) {
      return null;
    }
    return decryptValue(
      this.deps.keys,
      'pii.hotel_guest',
      {
        ciphertext: row.identifier_ciphertext,
        wrappedDek: row.identifier_wrapped_dek,
        keyVersion: row.identifier_key_version,
      },
      {
        table: 'platform.stay_guest',
        column: 'identifier_ciphertext',
        rowRef: row.guest_record_id,
      },
    );
  }

  /** A refused attempt is audited as loudly as a successful read (doc 13 §4.1). */
  private async auditAttempt(
    uow: Parameters<typeof recordPoliceAudit>[0],
    actor: CommandActor,
    request: RequestContext,
    reason: string,
    historical: boolean,
  ): Promise<void> {
    await recordPoliceAudit(uow, {
      action: 'police.checkin_list.refused',
      outcome: 'denied',
      reason,
      payload: {
        historical,
        device: request.deviceRef ?? null,
        account: actor.principal.accountId,
      },
    });
  }
}
