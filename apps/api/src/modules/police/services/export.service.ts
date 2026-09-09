import { randomBytes } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPoliceAudit } from '@prsystem/db';
import { decryptValue } from '@prsystem/ports';
import { buildWorkbook } from '../../../common/workbook';
import { exportIdentifier } from '../domain/police';
import type { CommandActor, PoliceDependencies, RequestContext } from './police-context';
import { CASE_EXPORT, EXPORT_FULL_IDENTIFIER, PoliceServiceBase, claim } from './police-context';

/**
 * The Wanted Case Excel (doc 13 §12.2, §12.3, `POL-DEC-021`).
 *
 * One row per case, not per person: a person with three cases appears three
 * times with their identity repeated, grouped by their id, because a case is
 * what an export is about.
 *
 * **Masked by default.** The registration number is masked unless the account
 * holds `WANTED_CASE_EXPORT` *and* `WANTED_EXPORT_FULL_IDENTIFIER` *and* has
 * stepped up in the last ten minutes — three conditions, and the third is the
 * pipeline's, applied to the row this command runs under.
 *
 * **Every export states why.** A purpose and a case or task reference are
 * mandatory columns of the job, not optional metadata, and both are audited
 * with the row count and the file's hash.
 *
 * **A link lives five minutes and the file an hour**, exactly as Phase 17's
 * exports do, and re-issuing a link cannot extend the file.
 */

const HEADERS = [
  'Дэс дугаар',
  'Wanted Person ID',
  'Wanted Case ID',
  'Ургийн овог',
  'Эцэг/эхийн нэр',
  'Өөрийн нэр',
  'Төрсөн огноо',
  'Гэрийн хаяг',
  'Регистр',
  'Эрэн сурвалжлах үндэслэл',
  'Гэмт хэргийн ангилал',
  'Case төлөв',
  'Харьяалах нэгж',
] as const;

/** doc 13 §12.3: the ceiling a protected configuration may not exceed. */
export const EXPORT_ROW_CAP = 10_000;

export interface ExportView {
  readonly jobId: string;
  readonly state: string;
  readonly rowCount: number | null;
  readonly fullIdentifier: boolean;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
}

export class WantedExportService extends PoliceServiceBase {
  constructor(deps: PoliceDependencies) {
    super(deps);
  }

  /**
   * Builds the file inside the command.
   *
   * Phase 17's exports are queued because a hotel's registry can be ten
   * thousand rows of a live list; a wanted-case export is a small, bounded read
   * of this schema's own tables, and doc 13 §12.3 asks for a short-lived link
   * rather than a job queue. So the row cap is enforced before anything is
   * built, and what the caller gets back is a finished job.
   */
  async run(
    input: {
      purpose: string;
      taskReference: string;
      fullIdentifier: boolean;
      state?: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ExportView> {
    const prepared = await this.runPoliceCommand(
      actor,
      CASE_EXPORT,
      request,
      async (uow, authorize) => {
        const claimed = await claim(uow, 'police.wanted_export', input.idempotencyKey, {
          taskReference: input.taskReference,
        });
        if (claimed.kind === 'replay') {
          return { replay: claimed.body as ExportView, job: undefined };
        }
        await authorize();

        // doc 13 §12.2: the second permission, on top of the row. Holding the
        // export right does not unmask anything by itself.
        if (
          input.fullIdentifier &&
          !actor.principal.directPermissions.includes(EXPORT_FULL_IDENTIFIER)
        ) {
          throw new ApiError(
            'FORBIDDEN',
            'FULL_IDENTIFIER_NOT_GRANTED: the export is masked without that permission',
          );
        }

        const now = this.now(uow);
        const rows = await uow.query<{
          person_id: string;
          case_id: string;
          family_name: string;
          parent_name: string;
          given_name: string;
          date_of_birth: string;
          home_address: string | null;
          reason_text: string;
          crime_category: string;
          state: string;
          owning_unit_ref: string;
          identifier_ciphertext: Uint8Array;
          identifier_wrapped_dek: Uint8Array;
          identifier_key_version: string;
        }>(
          `SELECT r.person_id, c.case_id, r.family_name, r.parent_name, r.given_name,
                  r.date_of_birth::text AS date_of_birth, r.home_address,
                  c.reason_text, c.crime_category, c.state, c.owning_unit_ref,
                  r.identifier_ciphertext, r.identifier_wrapped_dek, r.identifier_key_version
             FROM police.wanted_case c
             JOIN police.wanted_identity_revision r
               ON r.person_id = c.person_id AND r.is_current
            WHERE ($1::text IS NULL OR c.state = $1::text)
            ORDER BY r.person_id, c.created_at
            LIMIT $2::integer`,
          [input.state ?? null, EXPORT_ROW_CAP + 1],
        );
        if (rows.rows.length > EXPORT_ROW_CAP) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            `EXPORT_TOO_LARGE: narrow the filter; at most ${String(EXPORT_ROW_CAP)} rows`,
          );
        }

        const body: string[][] = [];
        let index = 0;
        for (const row of rows.rows) {
          index += 1;
          const number = await decryptValue(
            this.deps.keys,
            'pii.police',
            {
              ciphertext: row.identifier_ciphertext,
              wrappedDek: row.identifier_wrapped_dek,
              keyVersion: row.identifier_key_version,
            },
            {
              table: 'police.wanted_identity_revision',
              column: 'identifier_ciphertext',
              rowRef: row.person_id,
            },
          );
          body.push([
            String(index),
            row.person_id,
            row.case_id,
            row.family_name,
            row.parent_name,
            row.given_name,
            row.date_of_birth,
            row.home_address ?? '',
            exportIdentifier(number, input.fullIdentifier),
            row.reason_text,
            row.crime_category,
            row.state,
            row.owning_unit_ref,
          ]);
        }

        const created = await uow.query<{ job_id: string }>(
          `INSERT INTO police.wanted_export_job
             (requested_by_account_id, requested_at, purpose, task_reference, filters,
              full_identifier, state)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, 'RUNNING')
           RETURNING job_id`,
          [
            actor.principal.accountId,
            now,
            input.purpose,
            input.taskReference,
            JSON.stringify({ state: input.state ?? null }),
            input.fullIdentifier,
          ],
        );
        const jobId = created.rows[0]?.job_id as string;
        await completeIdempotencyKey(uow, claimed.idempotencyId, 202, { jobId });
        return {
          replay: undefined,
          job: { jobId, rows: body, count: body.length, fullIdentifier: input.fullIdentifier },
        };
      },
    );
    if (prepared.replay !== undefined) return prepared.replay;
    const job = prepared.job;
    if (job === undefined) throw new ApiError('INTERNAL_ERROR', 'the export produced no job');

    // The file is written outside the transaction: storage is a network call,
    // and it has no business inside a lock.
    const bytes = buildWorkbook('Эрэн сурвалжлалт', [...HEADERS], job.rows);
    const key = `police-exports/${job.jobId}/${randomBytes(16).toString('hex')}.xlsx`;
    const stored = await this.deps.storage.put({
      key,
      body: bytes,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    return this.inPoliceScope(request, async (uow) => {
      const now = this.now(uow);
      if (!stored.ok) {
        await uow.query(
          `UPDATE police.wanted_export_job SET state = 'FAILED', failure_reason = $2,
                  revision = revision + 1
            WHERE job_id = $1::uuid`,
          [job.jobId, `storage ${stored.error.kind}`],
        );
        throw new ApiError('PRECONDITION_FAILED', `STORAGE_UNAVAILABLE: ${stored.error.kind}`);
      }
      await uow.query(
        `UPDATE police.wanted_export_job
            SET state = 'COMPLETED', row_count = $2, storage_key = $3, content_hash = $4,
                ready_at = $5::timestamptz,
                expires_at = $5::timestamptz + interval '1 hour', revision = revision + 1
          WHERE job_id = $1::uuid`,
        [job.jobId, job.count, stored.value.key, stored.value.contentHash, now],
      );
      await recordPoliceAudit(uow, {
        action: 'police.wanted_export.completed',
        outcome: 'allowed',
        caseRef: job.jobId,
        // The purpose, the task, the count and the hash — never a row of it.
        payload: {
          rows: job.count,
          fullIdentifier: job.fullIdentifier,
          contentHash: stored.value.contentHash,
          device: request.deviceRef ?? null,
        },
      });
      return {
        jobId: job.jobId,
        state: 'COMPLETED',
        rowCount: job.count,
        fullIdentifier: job.fullIdentifier,
        readyAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      };
    });
  }

  /** doc 13 §12.3: one short-lived link, and the file's own hour is untouched. */
  async download(
    jobId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ url: string; expiresAt: Date }> {
    const prepared = await this.runPoliceCommand(
      actor,
      CASE_EXPORT,
      request,
      async (uow, authorize) => {
        await authorize({ targetRef: jobId });
        const found = await uow.query<{
          storage_key: string | null;
          state: string;
          expires_at: Date | null;
        }>(
          `SELECT storage_key, state, expires_at FROM police.wanted_export_job
          WHERE job_id = $1::uuid FOR UPDATE`,
          [jobId],
        );
        const row = found.rows[0];
        if (row === undefined) throw new ApiError('NOT_FOUND', 'no such export');
        const now = this.now(uow);
        if (row.state !== 'COMPLETED' || row.storage_key === null || row.expires_at === null) {
          throw new ApiError('PRECONDITION_FAILED', `NOT_READY: the export is ${row.state}`);
        }
        if (row.expires_at.getTime() <= now.getTime()) {
          throw new ApiError('PRECONDITION_FAILED', 'EXPIRED: that export file is no longer kept');
        }
        const expiresAt = new Date(now.getTime() + 5 * 60_000);
        await uow.query(
          `INSERT INTO police.wanted_export_grant (job_id, issued_by_account_id, issued_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4)`,
          [jobId, actor.principal.accountId, now, expiresAt],
        );
        await recordPoliceAudit(uow, {
          action: 'police.wanted_export.downloaded',
          outcome: 'allowed',
          caseRef: jobId,
          payload: { device: request.deviceRef ?? null },
        });
        return { storageKey: row.storage_key, expiresAt };
      },
    );

    const signed = await this.deps.storage.signedUrl({
      key: prepared.storageKey,
      expiresInSeconds: 300,
    });
    if (!signed.ok) {
      throw new ApiError('PRECONDITION_FAILED', 'EXPIRED: that export file is no longer kept');
    }
    return { url: signed.value.url, expiresAt: prepared.expiresAt };
  }
}
