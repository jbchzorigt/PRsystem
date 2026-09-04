import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { TargetLine } from '../domain/inventory';
import { publishRefusals } from '../domain/versions';
import type { PublishRefusal } from '../domain/versions';
import { InventoryRepository } from '../repositories/inventory.repository';
import { ConfigurationRepository } from '../repositories/configuration.repository';
import type { ItemRow, VersionRow } from '../repositories/version.repository';
import { VersionRepository } from '../repositories/version.repository';
import type { CommandActor, MinibarDependencies, RequestContext } from './minibar-context';
import { MinibarServiceBase, claim } from './minibar-context';
import { probeSource } from '../../catalog/contracts/dependency-probe';
import { VERSION_STAY_SOURCE } from '../contracts/safe-point-sources';

/**
 * Template versions (doc 26 §§24–32, doc 07 §5; `RML-DEC-015`…`021`).
 *
 * Draft, publish, default, archive and the never-published delete. Every
 * command locks the template, then the version; `Set default` and `Archive`
 * lock the template's other versions in id order as well, because both move
 * or check the one-Default invariant. None of them touches a room, a change,
 * a task, a stock balance or a price snapshot — the tests assert that
 * absence (`RML-DEC-020`, `RML-DEC-021`).
 */

const DRAFT = 'hotel.minibar.template_draft';
const PUBLISH = 'hotel.minibar.template_publish';
const ARCHIVE = 'hotel.minibar.template_archive';
const VIEW = ['hotel.minibar.config_view', 'hotel.minibar.config_view.read'];

export interface VersionView {
  readonly versionId: string;
  readonly templateId: string;
  readonly versionNo: number;
  readonly state: VersionRow['state'];
  readonly isDefault: boolean;
  readonly clonedFromVersionId: string | null;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly revision: number;
  readonly items: readonly TargetLine[];
}

function view(row: VersionRow, items: readonly ItemRow[]): VersionView {
  return {
    versionId: row.versionId,
    templateId: row.templateId,
    versionNo: row.versionNo,
    state: row.state,
    isDefault: row.isDefault,
    clonedFromVersionId: row.clonedFromVersionId,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    revision: row.revision,
    items: items.map((item) => ({
      productId: item.productId,
      targetQuantity: item.targetQuantity,
    })),
  };
}

export interface VersionCommand {
  readonly hotelId: string;
  readonly templateId: string;
  readonly versionId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}

export class VersionService extends MinibarServiceBase {
  constructor(deps: MinibarDependencies) {
    super(deps);
  }

  /** A new draft, empty or cloned from any version of the same template. */
  async createDraft(
    input: {
      hotelId: string;
      templateId: string;
      idempotencyKey: string;
      cloneOfVersionId?: string;
      items?: readonly TargetLine[];
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<VersionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DRAFT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.create_draft', input.idempotencyKey, {
          templateId: input.templateId,
          cloneOfVersionId: input.cloneOfVersionId ?? null,
        });
        if (claimed.kind === 'replay') return claimed.body as VersionView;

        const versions = new VersionRepository(uow);
        const template = await versions.lockTemplate(input.templateId);
        await authorize();
        if (template === undefined) throw new ApiError('NOT_FOUND', 'not found');
        let items: readonly TargetLine[] = input.items ?? [];
        if (input.cloneOfVersionId !== undefined) {
          const source = await versions.versionById(input.cloneOfVersionId);
          if (source === undefined || source.templateId !== input.templateId) {
            throw new ApiError('NOT_FOUND', 'not found');
          }
          items = await versions.itemsOf(source.versionId);
        }
        this.validateItems(items);
        const created = await versions.createDraft({
          templateId: input.templateId,
          ...(input.cloneOfVersionId === undefined
            ? {}
            : { clonedFromVersionId: input.cloneOfVersionId }),
        });
        await versions.replaceItems(created.versionId, items);
        await this.record(uow, gate.principal.accountId, created.versionId, {
          eventType: 'DRAFT_CREATED',
          toState: 'DRAFT',
          action: 'minibar.version.draft_create',
          payload: { templateId: input.templateId, clonedFrom: input.cloneOfVersionId ?? null },
        });
        const result = view(created, await versions.itemsOf(created.versionId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** Replaces a draft's product list and targets. Refused for any other state by the trigger too. */
  async replaceDraftItems(
    input: VersionCommand & { items: readonly TargetLine[] },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<VersionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DRAFT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.replace_draft_items', input.idempotencyKey, {
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
          items: input.items,
        });
        if (claimed.kind === 'replay') return claimed.body as VersionView;
        const versions = new VersionRepository(uow);
        await versions.lockTemplate(input.templateId);
        const version = await versions.lockVersion(input.versionId);
        await authorize();
        if (version === undefined || version.templateId !== input.templateId) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (version.state !== 'DRAFT') {
          throw new ApiError(
            'CONFLICT',
            `a ${version.state} version is immutable; create a new draft`,
          );
        }
        this.validateItems(input.items);
        await versions.replaceItems(input.versionId, input.items);
        const moved = await versions.transitionVersion({
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
          toState: 'DRAFT',
        });
        if (moved === undefined) throw new ApiError('CONFLICT', 'the version moved; re-read it');
        await this.record(uow, gate.principal.accountId, input.versionId, {
          eventType: 'DRAFT_EDITED',
          action: 'minibar.version.draft_edit',
          payload: { itemCount: input.items.length },
        });
        const result = view(moved, await versions.itemsOf(input.versionId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 26 §27 / `RML-DEC-018`, `-019`: every rule evaluated, the whole list
   * refused at once, and the first published version becomes the template's
   * one Default inside the same transaction.
   */
  async publish(
    input: VersionCommand,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<VersionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PUBLISH,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.publish', input.idempotencyKey, {
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as VersionView;

        const versions = new VersionRepository(uow);
        const inventory = new InventoryRepository(uow);
        const template = await versions.lockTemplate(input.templateId);
        const version = await versions.lockVersion(input.versionId);
        await authorize();
        if (
          template === undefined ||
          version === undefined ||
          version.templateId !== input.templateId
        ) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (version.state !== 'DRAFT') {
          throw new ApiError(
            'CONFLICT',
            `only a DRAFT is published; this version is ${version.state}`,
          );
        }
        const items = await versions.itemsOf(input.versionId);
        const products = await inventory.productsByIds(items.map((item) => item.productId));
        const refusals = publishRefusals({
          parentState: template.state,
          hotelId: input.hotelId,
          items: items.map((item) => {
            const product = products.get(item.productId);
            return {
              productId: item.productId,
              targetQuantity: item.targetQuantity,
              productState: product?.state ?? 'INACTIVE',
              productHotelId: product === undefined ? '' : input.hotelId,
              priced: product?.sellingPriceMnt !== null && product?.sellingPriceMnt !== undefined,
            };
          }),
        });
        if (refusals.length > 0) throw publishRefused(refusals);

        // The first Published version of the template is its Default; a later
        // one leaves the Default alone (`RML-DEC-019`).
        const hasDefault = (await versions.defaultVersionOf(input.templateId)) !== undefined;
        const published = await versions.transitionVersion({
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
          toState: 'PUBLISHED',
          isDefault: !hasDefault,
        });
        if (published === undefined)
          throw new ApiError('CONFLICT', 'the version moved; re-read it');
        await this.record(uow, gate.principal.accountId, input.versionId, {
          eventType: 'PUBLISHED',
          fromState: 'DRAFT',
          toState: 'PUBLISHED',
          action: 'minibar.version.publish',
          payload: {
            templateId: input.templateId,
            becameDefault: !hasDefault,
            items: items.map((item) => ({
              productId: item.productId,
              targetQuantity: item.targetQuantity,
            })),
            validation: 'passed',
          },
        });
        const result = view(published, items);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** `Set default`: one atomic move of the flag inside the template (`RML-DEC-019`). */
  async setDefault(
    input: VersionCommand,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<VersionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PUBLISH,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.set_default', input.idempotencyKey, {
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as VersionView;

        const versions = new VersionRepository(uow);
        const template = await versions.lockTemplate(input.templateId);
        const version = await versions.lockVersion(input.versionId);
        await authorize();
        if (
          template === undefined ||
          version === undefined ||
          version.templateId !== input.templateId
        ) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (version.state !== 'PUBLISHED') {
          throw new ApiError('CONFLICT', 'only a PUBLISHED version can be the Default');
        }
        if (version.isDefault) {
          const same = view(version, await versions.itemsOf(input.versionId));
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, same);
          return same;
        }
        const previous = await versions.defaultVersionOf(input.templateId);
        if (previous !== undefined) {
          const cleared = await versions.setDefaultFlag(
            previous.versionId,
            previous.revision,
            false,
          );
          if (cleared === undefined) throw new ApiError('CONFLICT', 'the Default moved; retry');
        }
        const moved = await versions.setDefaultFlag(input.versionId, input.expectedRevision, true);
        if (moved === undefined) throw new ApiError('CONFLICT', 'the version moved; re-read it');
        await this.record(uow, gate.principal.accountId, input.versionId, {
          eventType: 'DEFAULT_SET',
          action: 'minibar.version.set_default',
          payload: {
            templateId: input.templateId,
            previousDefaultVersionId: previous?.versionId ?? null,
          },
        });
        const result = view(moved, await versions.itemsOf(input.versionId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** doc 26 §30 / `RML-DEC-021`: the five blockers, rechecked under lock, then one atomic transition. */
  async archive(
    input: VersionCommand,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<VersionView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      ARCHIVE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.archive', input.idempotencyKey, {
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as VersionView;

        const versions = new VersionRepository(uow);
        const template = await versions.lockTemplate(input.templateId);
        const version = await versions.lockVersion(input.versionId);
        await authorize();
        if (
          template === undefined ||
          version === undefined ||
          version.templateId !== input.templateId
        ) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (version.state !== 'PUBLISHED') {
          throw new ApiError(
            'CONFLICT',
            `only a PUBLISHED version is archived; this one is ${version.state}`,
          );
        }
        const blockers: { field: string; issue: string }[] = [];
        if (version.isDefault)
          blockers.push({
            field: 'default',
            issue: 'the version is the Default; set another first',
          });
        const rooms = await versions.roomsOnVersion(input.versionId);
        if (rooms > 0)
          blockers.push({ field: 'rooms', issue: `${String(rooms)} room(s) are on this version` });
        const pending = await versions.pendingChangesOnVersion(input.versionId);
        if (pending > 0) {
          blockers.push({
            field: 'pending',
            issue: `${String(pending)} pending change(s) target this version`,
          });
        }
        // An active stay pinned to the version is Phase 08's relation; probed
        // as evidence, and unavailable evidence refuses (`RML-DEC-003`).
        const stayFacts = await this.activeStaysOnVersion(uow, input.versionId);
        if (stayFacts === 'unavailable') {
          throw new ApiError('DEPENDENCY_UNAVAILABLE', 'stay references could not be read');
        }
        if (stayFacts > 0)
          blockers.push({ field: 'stays', issue: 'an active stay uses this version' });
        if (blockers.length > 0) {
          throw new ApiError(
            'CONFLICT',
            'ARCHIVE_BLOCKED: the version is still referenced',
            blockers,
          );
        }
        const archived = await versions.transitionVersion({
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
          toState: 'ARCHIVED',
        });
        if (archived === undefined) throw new ApiError('CONFLICT', 'the version moved; re-read it');
        await this.record(uow, gate.principal.accountId, input.versionId, {
          eventType: 'ARCHIVED',
          fromState: 'PUBLISHED',
          toState: 'ARCHIVED',
          action: 'minibar.version.archive',
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: {
            templateId: input.templateId,
            blockersChecked: ['default', 'rooms', 'pending', 'stays'],
          },
        });
        const result = view(archived, await versions.itemsOf(input.versionId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** A never-published, unreferenced draft may be removed (doc 26 §24.4). */
  async deleteDraft(
    input: VersionCommand,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ readonly versionId: string; readonly deleted: true }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DRAFT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.delete_draft', input.idempotencyKey, {
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as { versionId: string; deleted: true };
        const versions = new VersionRepository(uow);
        await versions.lockTemplate(input.templateId);
        const version = await versions.lockVersion(input.versionId);
        await authorize();
        if (version === undefined || version.templateId !== input.templateId) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        if (version.state !== 'DRAFT') {
          throw new ApiError(
            'CONFLICT',
            'only a never-published draft is deleted; archive a published version',
          );
        }
        if (await versions.versionReferenced(input.versionId)) {
          throw new ApiError('CONFLICT', 'ENTITY_REFERENCED: the draft is referenced');
        }
        if (!(await versions.deleteDraft(input.versionId, input.expectedRevision))) {
          throw new ApiError('CONFLICT', 'the version moved; re-read it');
        }
        await this.record(uow, gate.principal.accountId, input.versionId, {
          eventType: 'DRAFT_DELETED',
          fromState: 'DRAFT',
          action: 'minibar.version.draft_delete',
          payload: { templateId: input.templateId },
        });
        const result = { versionId: input.versionId, deleted: true as const };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  async listVersions(
    target: { hotelId: string; templateId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly VersionView[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const versions = new VersionRepository(uow);
        if ((await versions.templateById(target.templateId)) === undefined) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const rows = await versions.versionsOf(target.templateId);
        const out: VersionView[] = [];
        for (const row of rows) out.push(view(row, await versions.itemsOf(row.versionId)));
        return out;
      },
    );
  }

  // ------------------------------------------------------------ internals

  private validateItems(items: readonly TargetLine[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (!Number.isInteger(item.targetQuantity) || item.targetQuantity < 1) {
        throw new ApiError('VALIDATION_FAILED', 'every target quantity is a positive integer', [
          { field: item.productId, issue: 'target' },
        ]);
      }
      if (seen.has(item.productId)) {
        throw new ApiError('VALIDATION_FAILED', 'a product appears once in a version', [
          { field: item.productId, issue: 'duplicate' },
        ]);
      }
      seen.add(item.productId);
    }
  }

  private async activeStaysOnVersion(
    uow: UnitOfWork,
    versionId: string,
  ): Promise<number | 'unavailable'> {
    const fact = await probeSource(uow, VERSION_STAY_SOURCE, versionId);
    if (fact.state === 'unavailable') return 'unavailable';
    return fact.count ?? 0;
  }

  private async record(
    uow: UnitOfWork,
    actorAccountId: string,
    versionId: string,
    detail: {
      eventType: string;
      fromState?: string;
      toState?: string;
      action: string;
      reason?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await new ConfigurationRepository(uow).appendEvent({
      entityType: 'TEMPLATE_VERSION',
      entityId: versionId,
      eventType: detail.eventType,
      ...(detail.fromState === undefined ? {} : { fromState: detail.fromState }),
      ...(detail.toState === undefined ? {} : { toState: detail.toState }),
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      payload: detail.payload,
      actorAccountId,
    });
    await recordPlatformAudit(uow, {
      action: detail.action,
      outcome: 'allowed',
      targetType: 'minibar_template_version',
      targetRef: versionId,
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      payload: detail.payload,
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'minibar_template_version',
      aggregateId: versionId,
      eventType: `minibar.version.${detail.eventType.toLowerCase()}`,
      payload: detail.payload,
    });
  }
}

function publishRefused(refusals: readonly PublishRefusal[]): ApiError {
  return new ApiError(
    'PRECONDITION_FAILED',
    'PUBLISH_REFUSED: the draft does not meet the publish rules',
    refusals.map((refusal) => ({ field: refusal.productId ?? 'version', issue: refusal.code })),
  );
}
