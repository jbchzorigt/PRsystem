import { createHash } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import { OperationRepository } from '../repositories/operation.repository';
import type { RecipientFilters } from '../repositories/operation.repository';
import {
  SMS_MAX_CHARACTERS,
  SMS_MIN_CHARACTERS,
  estimatedCostMnt,
  normaliseContactPhone,
  smsAlphabet,
  smsBody,
  smsCharacterCount,
  smsSegments,
  smsStateFor,
} from '../domain/operation';
import type { CommandActor, OperationDependencies, RequestContext } from './operation-context';
import { REMINDER_SEND, OperationServiceBase, claim } from './operation-context';

/**
 * The reminder SMS tab (doc 14 §5, §6; `OPS-DEC-002`, `OPS-DEC-004`,
 * `OPS-DEC-010`).
 *
 * `OPS-DEC-010` is the rule the whole design turns on: **nothing sends an SMS
 * except an operator confirming a preview they can see.** There is no scheduler
 * entry, no state-transition hook and no job kind that reaches this service —
 * `platform.sms_send_job.confirmed_by_account_id` is `NOT NULL`, so a job with
 * no operator behind it is not a row this schema can hold.
 *
 * What a preview promises, a confirmation checks. The body's hash and the hash
 * of the resolved recipient set are stored with the preview, and the
 * confirmation recomputes both: a filter that has since matched another hotel,
 * or a text that has since been edited, is refused and a fresh preview is
 * required (doc 14 §5.4).
 *
 * Delivery is **one-way** (`OPS-DEC-004`). There is no inbound route, no inbox
 * and no reply surface anywhere in this module; what the provider may tell us
 * is a delivery status, and that is asked for rather than accepted unsolicited,
 * because `EXT-05` has approved no callback signature.
 */

export interface RecipientPreview {
  readonly hotelId: string;
  readonly hotelName: string;
  readonly phoneMasked: string;
  readonly status: string;
}

export interface PreviewView {
  readonly previewId: string;
  readonly characters: number;
  readonly alphabet: 'LATIN' | 'UNICODE';
  readonly segmentsPerRecipient: number;
  readonly recipientCount: number;
  readonly duplicateCount: number;
  readonly excludedCount: number;
  readonly totalSegments: number;
  readonly estimatedCostMnt: string | undefined;
  readonly expiresAt: Date;
  readonly recipients: readonly RecipientPreview[];
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class OperationSmsService extends OperationServiceBase {
  constructor(deps: OperationDependencies) {
    super(deps);
  }

  /**
   * doc 14 §5.4 steps 3–5: the counted body, the resolved recipients, the
   * duplicates and invalid numbers removed, and the estimate.
   *
   * A preview is a row rather than a computation, because step 6 has to confirm
   * *this* preview. Opening one is not sending: nothing here writes a job.
   */
  async preview(
    actor: CommandActor,
    input: { body: string; filters: RecipientFilters },
    request: RequestContext,
  ): Promise<PreviewView> {
    const body = smsBody(input.body);
    const characters = smsCharacterCount(body);
    if (characters < SMS_MIN_CHARACTERS || characters > SMS_MAX_CHARACTERS) {
      throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [
        { field: 'body', issue: `the message is ${String(characters)} of 300 characters` },
      ]);
    }
    return this.runOperationCommand(
      actor,
      REMINDER_SEND,
      { targetType: 'sms_preview', targetRef: 'draft' },
      request,
      async (uow) => {
        const repository = new OperationRepository(uow);
        const resolved = await this.resolve(repository, input.filters);
        const segmentsPerRecipient = smsSegments(body);
        const totalSegments = resolved.recipients.length * segmentsPerRecipient;
        const tariff = await repository.liveTariff();
        const cost = estimatedCostMnt(totalSegments, tariff?.pricePerSegmentMnt);

        const previewId = await repository.insertPreview({
          createdBy: actor.principal.accountId,
          body,
          bodyHash: hash(body),
          filterSnapshot: snapshotOf(input.filters),
          recipientHash: resolved.hash,
          recipientCount: resolved.recipients.length,
          excludedCount: resolved.excluded,
          segmentsPerRecipient,
          totalSegments,
          estimatedCostMnt: cost,
          tariffId: tariff?.tariffId,
          ttlSeconds: this.parameters.previewTtlSeconds,
        });

        await this.audit(uow, {
          action: 'operation.sms.preview_created',
          outcome: 'allowed',
          targetType: 'sms_preview',
          targetRef: previewId,
          payload: {
            recipients: resolved.recipients.length,
            excluded: resolved.excluded,
            duplicates: resolved.duplicates,
            segments: totalSegments,
          },
        });

        return {
          previewId,
          characters,
          alphabet: smsAlphabet(body),
          segmentsPerRecipient,
          recipientCount: resolved.recipients.length,
          duplicateCount: resolved.duplicates,
          excludedCount: resolved.excluded,
          totalSegments,
          estimatedCostMnt: cost === undefined ? undefined : String(cost),
          expiresAt: new Date(this.now(uow).getTime() + this.parameters.previewTtlSeconds * 1000),
          recipients: resolved.recipients.map((recipient) => ({
            hotelId: recipient.hotelId,
            hotelName: recipient.hotelName,
            phoneMasked: `****${recipient.phone.slice(-4)}`,
            status: recipient.status,
          })),
        };
      },
    );
  }

  /**
   * doc 14 §5.4 step 6: the confirmation, and the only thing that creates a job.
   *
   * Two writes make the duplicate rules of §5.5 true rather than intended. The
   * preview is unique on the job, so a repeated confirmation finds the job that
   * already exists; and the recipient message is unique on `(job_id, phone)`,
   * so a filter that resolved one number twice writes one message.
   */
  async confirm(
    actor: CommandActor,
    input: { previewId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ jobId: string; recipientCount: number; dispatched: boolean }> {
    const prepared = await this.runOperationCommand(
      actor,
      REMINDER_SEND,
      { targetType: 'sms_send_job', targetRef: input.previewId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.sms.confirm', input.idempotencyKey, {
          previewId: input.previewId,
        });
        if (claimed.kind === 'replay') {
          return {
            outcome: claimed.body as { jobId: string; recipientCount: number; dispatched: boolean },
            send: undefined,
          };
        }

        const repository = new OperationRepository(uow);
        const preview = await repository.lockPreview(input.previewId);
        if (preview === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (preview.consumedAt !== null) {
          const existing = await repository.jobForPreview(input.previewId);
          if (existing === undefined) throw new ApiError('CONFLICT', 'this preview is spent');
          const outcome = {
            jobId: existing,
            recipientCount: preview.recipientCount,
            dispatched: true,
          };
          await this.complete(uow, claimed.idempotencyId, outcome);
          return { outcome, send: undefined };
        }
        if (preview.expiresAt.getTime() <= this.now(uow).getTime()) {
          throw new ApiError('CONFLICT', 'this preview has expired; take a new one');
        }

        // The recipients are resolved again, now. A preview that no longer
        // describes the same set is refused rather than sent (doc 14 §5.4).
        const filters = filtersOf(preview.filterSnapshot);
        const resolved = await this.resolve(repository, filters);
        if (resolved.hash !== preview.recipientHash || hash(preview.body) !== preview.bodyHash) {
          throw new ApiError(
            'CONFLICT',
            'the recipients or the text have changed; take a new preview',
          );
        }

        await repository.consumePreview(input.previewId);
        const jobId = await repository.insertJob({
          previewId: input.previewId,
          body: preview.body,
          filterSnapshot: preview.filterSnapshot,
          recipientCount: resolved.recipients.length,
          excludedCount: resolved.excluded,
          totalSegments: preview.totalSegments,
          estimatedCostMnt: preview.estimatedCostMnt,
          confirmedBy: actor.principal.accountId,
        });

        const segments = preview.segmentsPerRecipient;
        const messages: { messageId: string; phone: string }[] = [];
        for (const recipient of resolved.recipients) {
          const messageId = await repository.insertMessage({
            jobId,
            hotelId: recipient.hotelId,
            subscriptionId: recipient.subscriptionId,
            phone: recipient.phone,
            segments,
          });
          if (messageId === undefined) continue;
          await repository.recordMessageEvent({
            messageId,
            state: 'PENDING',
            source: 'CONFIRMATION',
          });
          messages.push({ messageId, phone: recipient.phone });
        }

        await this.audit(uow, {
          action: 'operation.sms.confirmed',
          outcome: 'allowed',
          targetType: 'sms_send_job',
          targetRef: jobId,
          payload: { recipients: messages.length, segments: preview.totalSegments },
        });

        const outcome = { jobId, recipientCount: messages.length, dispatched: false };
        await this.complete(uow, claimed.idempotencyId, outcome);
        return { outcome, send: { jobId, body: preview.body, messages } };
      },
    );

    if (prepared.send === undefined) return prepared.outcome;
    const dispatched = await this.dispatch(prepared.send, request);
    return { ...prepared.outcome, dispatched };
  }

  /**
   * Hands one job's messages to the provider, after its transaction committed.
   *
   * The port is called once with the whole job and its stable `jobId`, so a
   * retry after a lost acknowledgement is recognised by the provider rather
   * than sent again — the same shape Phase 05's activation delivery uses.
   * `EXT-05` keeps the production adapter disabled, so in production every
   * message is recorded `FAILED` with the gate as its reason and nothing is
   * sent, which is what a blocked provider should look like.
   */
  private async dispatch(
    send: {
      jobId: string;
      body: string;
      messages: readonly { messageId: string; phone: string }[];
    },
    request: RequestContext,
  ): Promise<boolean> {
    if (send.messages.length === 0) {
      await this.inOperationScope(request, async (uow) => {
        await new OperationRepository(uow).markJobDispatched(send.jobId, null);
      });
      return true;
    }
    const result = await this.deps.sms.send(
      {
        jobId: send.jobId,
        recipients: send.messages.map((message) => ({
          recipientRef: message.messageId,
          phone: message.phone,
        })),
        body: send.body,
      },
      { correlationId: request.correlationId },
    );

    return this.inOperationScope(request, async (uow) => {
      const repository = new OperationRepository(uow);
      if (!result.ok) {
        for (const message of send.messages) {
          await repository.advanceMessage({
            messageId: message.messageId,
            state: 'FAILED',
            failureCode: result.error.kind,
          });
          await repository.recordMessageEvent({
            messageId: message.messageId,
            state: 'FAILED',
            source: 'PROVIDER_SEND',
            detail: result.error.kind,
          });
        }
        await repository.markJobFailed(send.jobId, result.error.kind);
        return false;
      }
      for (const accepted of result.value.messages) {
        await repository.advanceMessage({
          messageId: accepted.recipientRef,
          state: 'SENT',
          providerMessageId: accepted.providerMessageId,
        });
        await repository.recordMessageEvent({
          messageId: accepted.recipientRef,
          state: 'SENT',
          source: 'PROVIDER_SEND',
          providerMessageId: accepted.providerMessageId,
        });
      }
      await repository.markJobDispatched(send.jobId, send.jobId);
      return true;
    });
  }

  /**
   * doc 14 §5.6: the delivery status, asked for rather than accepted.
   *
   * `EXT-05` has approved no callback signature, so there is no inbound route
   * to verify one on. This asks the provider about messages it has accepted and
   * moves each forward — never backward, which the row's trigger enforces, so a
   * repeated or late answer cannot break a message's history (doc 14 §5.5).
   */
  async refreshDeliveryStatus(
    actor: CommandActor,
    request: RequestContext,
    limit = 200,
  ): Promise<{ examined: number; advanced: number }> {
    const pending = await this.runOperationCommand(
      actor,
      REMINDER_SEND,
      { targetType: 'sms_recipient_message', targetRef: 'status' },
      request,
      (uow) => new OperationRepository(uow).unsettledMessages(limit),
    );

    let advanced = 0;
    for (const message of pending) {
      if (message.providerMessageId === null) continue;
      const answer = await this.deps.sms.queryStatus(message.providerMessageId, {
        correlationId: request.correlationId,
      });
      if (!answer.ok) continue;
      const next = smsStateFor(answer.value.status);
      if (next === undefined || next === 'PENDING' || next === 'SENT') continue;
      const moved = await this.inOperationScope(request, async (uow) => {
        const repository = new OperationRepository(uow);
        const changed = await repository.advanceMessage({
          messageId: message.messageId,
          state: next,
        });
        if (changed) {
          await repository.recordMessageEvent({
            messageId: message.messageId,
            state: next,
            source: 'PROVIDER_STATUS_QUERY',
            ...(message.providerMessageId === null
              ? {}
              : { providerMessageId: message.providerMessageId }),
          });
        }
        return changed;
      });
      if (moved) advanced += 1;
    }
    return { examined: pending.length, advanced };
  }

  /** doc 14 §6: the send history, server-paginated. */
  async history(
    actor: CommandActor,
    input: { limit?: number; offset?: number },
    request: RequestContext,
  ): Promise<{ items: readonly Record<string, unknown>[]; total: number }> {
    const limit = Math.min(Math.max(1, input.limit ?? this.parameters.defaultPageSize), 100);
    const offset = Math.max(0, input.offset ?? 0);
    return this.runOperationCommand(
      actor,
      REMINDER_SEND,
      { targetType: 'sms_send_job', targetRef: 'history' },
      request,
      async (uow) => {
        const rows = await new OperationRepository(uow).jobHistory({ limit, offset });
        return {
          items: rows.map(({ totalRows: _total, ...rest }) => ({ ...rest })),
          total: rows[0]?.totalRows ?? 0,
        };
      },
    );
  }

  /**
   * The recipients a filter resolves to, deduplicated and validated.
   *
   * `Бүх хэрэглэгч` is not a shape this can produce: a filter that names
   * nothing still resolves to the provisioned subscriptions it matched, and the
   * operator sees the count before anything is confirmed (doc 14 §5.2).
   */
  private async resolve(
    repository: OperationRepository,
    filters: RecipientFilters,
  ): Promise<{
    recipients: readonly {
      hotelId: string;
      subscriptionId: string;
      hotelName: string;
      phone: string;
      status: string;
    }[];
    duplicates: number;
    excluded: number;
    hash: string;
  }> {
    const rows = await repository.smsRecipients(filters);
    const seen = new Set<string>();
    const recipients: {
      hotelId: string;
      subscriptionId: string;
      hotelName: string;
      phone: string;
      status: string;
    }[] = [];
    let duplicates = 0;
    let excluded = 0;
    for (const row of rows) {
      const phone = row.phone === null ? undefined : normaliseContactPhone(row.phone);
      if (phone === undefined) {
        // No confirmed contact, or a number that is not a valid destination.
        excluded += 1;
        continue;
      }
      if (seen.has(phone)) {
        duplicates += 1;
        continue;
      }
      seen.add(phone);
      recipients.push({
        hotelId: row.hotelId,
        subscriptionId: row.subscriptionId,
        hotelName: row.hotelName,
        phone,
        status: row.status,
      });
    }
    return {
      recipients,
      duplicates,
      excluded,
      // The set, not the order: the confirmation compares this against what the
      // preview saw, and a re-sorted list is not a changed audience.
      hash: hash([...seen].sort().join(',')),
    };
  }
}

function snapshotOf(filters: RecipientFilters): Record<string, unknown> {
  return {
    ...(filters.hotelIds === undefined ? {} : { hotelIds: [...filters.hotelIds].sort() }),
    ...(filters.package === undefined ? {} : { package: filters.package }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.expiresFrom === undefined
      ? {}
      : { expiresFrom: filters.expiresFrom.toISOString() }),
    ...(filters.expiresTo === undefined ? {} : { expiresTo: filters.expiresTo.toISOString() }),
  };
}

function filtersOf(snapshot: Record<string, unknown>): RecipientFilters {
  const hotelIds = snapshot['hotelIds'];
  const from = snapshot['expiresFrom'];
  const to = snapshot['expiresTo'];
  return {
    ...(Array.isArray(hotelIds) ? { hotelIds: hotelIds as readonly string[] } : {}),
    ...(typeof snapshot['package'] === 'string' ? { package: snapshot['package'] } : {}),
    ...(typeof snapshot['status'] === 'string' ? { status: snapshot['status'] } : {}),
    ...(typeof from === 'string' ? { expiresFrom: new Date(from) } : {}),
    ...(typeof to === 'string' ? { expiresTo: new Date(to) } : {}),
  };
}
