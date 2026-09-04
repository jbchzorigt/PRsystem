import type { UnitOfWork } from '@prsystem/db';
import { ScopedRepository } from '@prsystem/db';
import type { TargetLine } from '../domain/inventory';
import type { VersionState } from '../domain/versions';

/**
 * Template versions and their items.
 *
 * A version row is locked `FOR UPDATE` by every transition and by `Set default`,
 * and the template's other versions are locked in id order when a Default moves
 * — so the partial unique index on the Default is the last line, not the first.
 */

export interface TemplateRow {
  readonly templateId: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly revision: number;
}

export interface VersionRow {
  readonly versionId: string;
  readonly templateId: string;
  readonly versionNo: number;
  readonly state: VersionState;
  readonly isDefault: boolean;
  readonly clonedFromVersionId: string | null;
  readonly publishedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly revision: number;
}

export interface ItemRow extends TargetLine {
  readonly itemId: string;
}

const VERSION_COLUMNS = `version_id, template_id, version_no, state, is_default,
  cloned_from_version_id, published_at, archived_at, revision`;

function mapVersion(row: Record<string, unknown> | undefined): VersionRow | undefined {
  if (row === undefined) return undefined;
  return {
    versionId: row['version_id'] as string,
    templateId: row['template_id'] as string,
    versionNo: Number(row['version_no']),
    state: row['state'] as VersionState,
    isDefault: row['is_default'] === true,
    clonedFromVersionId: (row['cloned_from_version_id'] ?? null) as string | null,
    publishedAt: (row['published_at'] ?? null) as Date | null,
    archivedAt: (row['archived_at'] ?? null) as Date | null,
    revision: Number(row['revision']),
  };
}

export class VersionRepository extends ScopedRepository {
  constructor(uow: UnitOfWork) {
    super(uow);
  }

  get unitOfWork(): UnitOfWork {
    return this.uow;
  }

  // ------------------------------------------------------------- templates

  async templateById(templateId: string): Promise<TemplateRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT template_id, name, description, state, revision FROM platform.minibar_template
        WHERE hotel_id = $1 AND template_id = $2`,
      [this.hotelId, templateId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      templateId: row['template_id'] as string,
      name: row['name'] as string,
      description: (row['description'] ?? null) as string | null,
      state: row['state'] as TemplateRow['state'],
      revision: Number(row['revision']),
    };
  }

  /** The template is the lock every version command takes first. */
  async lockTemplate(templateId: string): Promise<TemplateRow | undefined> {
    await this.uow.query(
      `SELECT template_id FROM platform.minibar_template
        WHERE hotel_id = $1 AND template_id = $2 FOR UPDATE`,
      [this.hotelId, templateId],
    );
    return this.templateById(templateId);
  }

  // -------------------------------------------------------------- versions

  async versionById(versionId: string): Promise<VersionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM platform.minibar_template_version
        WHERE hotel_id = $1 AND version_id = $2`,
      [this.hotelId, versionId],
    );
    return mapVersion(result.rows[0]);
  }

  async lockVersion(versionId: string): Promise<VersionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM platform.minibar_template_version
        WHERE hotel_id = $1 AND version_id = $2 FOR UPDATE`,
      [this.hotelId, versionId],
    );
    return mapVersion(result.rows[0]);
  }

  /** A share lock: a version a reconciliation or a snapshot is reading must not move under it. */
  async shareVersion(versionId: string): Promise<VersionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM platform.minibar_template_version
        WHERE hotel_id = $1 AND version_id = $2 FOR SHARE`,
      [this.hotelId, versionId],
    );
    return mapVersion(result.rows[0]);
  }

  async versionsOf(templateId: string): Promise<readonly VersionRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM platform.minibar_template_version
        WHERE hotel_id = $1 AND template_id = $2 ORDER BY version_no`,
      [this.hotelId, templateId],
    );
    return result.rows.map((row) => mapVersion(row) as VersionRow);
  }

  async defaultVersionOf(templateId: string): Promise<VersionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM platform.minibar_template_version
        WHERE hotel_id = $1 AND template_id = $2 AND is_default FOR UPDATE`,
      [this.hotelId, templateId],
    );
    return mapVersion(result.rows[0]);
  }

  async createDraft(input: {
    templateId: string;
    clonedFromVersionId?: string;
  }): Promise<VersionRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_template_version
         (hotel_id, template_id, version_no, cloned_from_version_id)
       VALUES ($1, $2,
               coalesce((SELECT max(version_no) FROM platform.minibar_template_version
                          WHERE hotel_id = $1 AND template_id = $2), 0) + 1,
               $3)
       RETURNING ${VERSION_COLUMNS}`,
      [this.hotelId, input.templateId, input.clonedFromVersionId ?? null],
    );
    const row = mapVersion(result.rows[0]);
    if (row === undefined) throw new Error('the version insert returned no row');
    return row;
  }

  async transitionVersion(input: {
    versionId: string;
    expectedRevision: number;
    toState: VersionState;
    isDefault?: boolean;
  }): Promise<VersionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_template_version
          SET state = $4,
              is_default = COALESCE($5, is_default),
              published_at = CASE WHEN $4 = 'PUBLISHED' THEN now() ELSE published_at END,
              archived_at = CASE WHEN $4 = 'ARCHIVED' THEN now() ELSE archived_at END,
              revision = revision + 1
        WHERE hotel_id = $1 AND version_id = $2 AND revision = $3
        RETURNING ${VERSION_COLUMNS}`,
      [
        this.hotelId,
        input.versionId,
        input.expectedRevision,
        input.toState,
        input.isDefault ?? null,
      ],
    );
    return mapVersion(result.rows[0]);
  }

  async setDefaultFlag(
    versionId: string,
    expectedRevision: number,
    isDefault: boolean,
  ): Promise<VersionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_template_version
          SET is_default = $4, revision = revision + 1
        WHERE hotel_id = $1 AND version_id = $2 AND revision = $3
        RETURNING ${VERSION_COLUMNS}`,
      [this.hotelId, versionId, expectedRevision, isDefault],
    );
    return mapVersion(result.rows[0]);
  }

  async deleteDraft(versionId: string, expectedRevision: number): Promise<boolean> {
    await this.uow.query(
      `DELETE FROM platform.minibar_template_version_item WHERE hotel_id = $1 AND version_id = $2`,
      [this.hotelId, versionId],
    );
    const result = await this.uow.query(
      `DELETE FROM platform.minibar_template_version
        WHERE hotel_id = $1 AND version_id = $2 AND revision = $3 AND state = 'DRAFT'`,
      [this.hotelId, versionId, expectedRevision],
    );
    return result.rowCount === 1;
  }

  // ----------------------------------------------------------------- items

  async itemsOf(versionId: string): Promise<readonly ItemRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT item_id, product_id, target_quantity FROM platform.minibar_template_version_item
        WHERE hotel_id = $1 AND version_id = $2 ORDER BY product_id`,
      [this.hotelId, versionId],
    );
    return result.rows.map((row) => ({
      itemId: row['item_id'] as string,
      productId: row['product_id'] as string,
      targetQuantity: Number(row['target_quantity']),
    }));
  }

  /** Replaces a draft's content wholesale; the trigger refuses it for any other state. */
  async replaceItems(versionId: string, items: readonly TargetLine[]): Promise<void> {
    await this.uow.query(
      `DELETE FROM platform.minibar_template_version_item WHERE hotel_id = $1 AND version_id = $2`,
      [this.hotelId, versionId],
    );
    for (const item of items) {
      await this.uow.query(
        `INSERT INTO platform.minibar_template_version_item
           (hotel_id, version_id, product_id, target_quantity)
         VALUES ($1, $2, $3, $4)`,
        [this.hotelId, versionId, item.productId, item.targetQuantity],
      );
    }
  }

  // ------------------------------------------------- references a version holds

  /** Rooms whose current version is this one. */
  async roomsOnVersion(versionId: string): Promise<number> {
    const result = await this.uow.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.room_minibar_configuration
        WHERE hotel_id = $1 AND current_version_id = $2`,
      [this.hotelId, versionId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  /** Non-terminal changes pinned to this version. */
  async pendingChangesOnVersion(versionId: string): Promise<number> {
    const result = await this.uow.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.room_configuration_change
        WHERE hotel_id = $1 AND target_version_id = $2
          AND state <> ALL (ARRAY['APPLIED', 'CANCELLED', 'ROLLED_BACK'])`,
      [this.hotelId, versionId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  /** Whether any row anywhere references the version: history that refuses a hard delete. */
  async versionReferenced(versionId: string): Promise<boolean> {
    const result = await this.uow.query<{ referenced: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM platform.room_minibar_configuration
                       WHERE hotel_id = $1 AND current_version_id = $2)
          OR EXISTS (SELECT 1 FROM platform.room_configuration_change
                       WHERE hotel_id = $1 AND target_version_id = $2)
          OR EXISTS (SELECT 1 FROM platform.rollout_batch
                       WHERE hotel_id = $1 AND target_version_id = $2)
          OR EXISTS (SELECT 1 FROM platform.minibar_template_version
                       WHERE hotel_id = $1 AND cloned_from_version_id = $2) AS referenced`,
      [this.hotelId, versionId],
    );
    return result.rows[0]?.referenced === true;
  }
}
