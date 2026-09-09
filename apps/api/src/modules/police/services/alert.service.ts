import { recordPoliceAudit } from '@prsystem/db';
import type { UnitOfWork } from '@prsystem/db';
import { decryptValue } from '@prsystem/ports';
import { maskRegistrationNumber, matchSmsBody } from '../domain/police';
import { PoliceRepository } from '../repositories/police.repository';
import type { PoliceDependencies, RequestContext } from './police-context';
import { PoliceServiceBase } from './police-context';

/**
 * Getting an alert to the people who must act on it (doc 13 §10).
 *
 * The rows are created with the match, by the same database function that
 * detected it — one per recipient per channel, and the recipients are every
 * active Police Admin plus the officers of the hotel district's approved group
 * (`POL-DEC-008`). What is left is the part a database should not do: read the
 * registration number, compose the one approved sentence, and hand it to a
 * provider.
 *
 * Two rules bound the whole service.
 *
 * **The body is the template and one value** (`POL-DEC-009`). No name, no case,
 * no hotel, no room, no address, no map, no link carrying an identifier. The
 * body is composed by the domain function, which takes exactly one argument.
 *
 * **What is stored is not what was sent** (doc 13 §10.2). A delivery row keeps
 * the provider's message id and a masked number; the body itself is held for
 * the length of the call and then dropped.
 */

export interface DeliveryOutcome {
  readonly sent: number;
  readonly failed: number;
}

interface PendingDelivery {
  readonly deliveryId: string;
  readonly alertId: string;
  readonly matchId: string;
  readonly recipientAccountId: string;
  readonly personId: string;
}

export class AlertService extends PoliceServiceBase {
  constructor(deps: PoliceDependencies) {
    super(deps);
  }

  /**
   * Sends the SMS half of every alert that has not been delivered yet.
   *
   * The send is idempotent on the provider side through the job id, and on this
   * side through `delivered_at`: a repeat finds nothing to do. A failure is
   * recorded on the row and left for the next pass — an officer not reached is
   * an operational fact, not an exception that should lose the alert.
   */
  async deliverPendingSms(limit = 50, request: RequestContext): Promise<DeliveryOutcome> {
    const pending = await this.inPoliceScope(request, async (uow) => {
      const rows = await uow.query<{
        delivery_id: string;
        alert_id: string;
        match_id: string;
        recipient_account_id: string;
        person_id: string;
      }>(
        `SELECT d.delivery_id, d.alert_id, a.match_id, d.recipient_account_id,
                m.wanted_person_id AS person_id
           FROM police.alert_delivery d
           JOIN police.match_alert a ON a.alert_id = d.alert_id
           JOIN police.police_match m ON m.match_id = a.match_id
          WHERE d.channel = 'SMS' AND d.delivered_at IS NULL AND d.failure_reason IS NULL
          ORDER BY d.created_at
          LIMIT $1::integer`,
        [limit],
      );
      return rows.rows.map((row): PendingDelivery => ({
        deliveryId: row.delivery_id,
        alertId: row.alert_id,
        matchId: row.match_id,
        recipientAccountId: row.recipient_account_id,
        personId: row.person_id,
      }));
    });

    let sent = 0;
    let failed = 0;
    for (const delivery of pending) {
      const outcome = await this.deliverOne(delivery, request);
      if (outcome) sent += 1;
      else failed += 1;
    }
    return { sent, failed };
  }

  private async deliverOne(delivery: PendingDelivery, request: RequestContext): Promise<boolean> {
    const material = await this.inPoliceScope(request, async (uow) => {
      const repository = new PoliceRepository(uow);
      const revision = await repository.currentRevision(delivery.personId);
      if (revision === undefined) return undefined;
      const phone = await this.phoneOf(uow, delivery.recipientAccountId);
      if (phone === undefined) return undefined;
      const number = await decryptValue(
        this.deps.keys,
        'pii.police',
        {
          ciphertext: revision.identifierCiphertext,
          wrappedDek: revision.identifierWrappedDek,
          keyVersion: revision.identifierKeyVersion,
        },
        {
          table: 'police.wanted_identity_revision',
          column: 'identifier_ciphertext',
          rowRef: revision.personId,
        },
      );
      return { number, phone };
    });

    if (material === undefined) {
      await this.recordFailure(delivery, 'NO_APPROVED_CONTACT', request);
      return false;
    }

    const result = await this.deps.sms.send(
      {
        jobId: delivery.deliveryId,
        recipients: [{ recipientRef: delivery.recipientAccountId, phone: material.phone }],
        body: matchSmsBody(material.number),
      },
      { correlationId: request.correlationId },
    );
    if (!result.ok) {
      await this.recordFailure(delivery, result.error.kind, request);
      return false;
    }

    const providerMessageId = result.value.messages[0]?.providerMessageId ?? null;
    const masked = maskRegistrationNumber(material.number);
    await this.inPoliceScope(request, async (uow) => {
      const now = this.now(uow);
      await uow.query(
        `UPDATE police.alert_delivery
            SET delivered_at = $2, provider_message_id = $3, masked_identifier = $4
          WHERE delivery_id = $1::uuid AND delivered_at IS NULL`,
        [delivery.deliveryId, now, providerMessageId, masked],
      );
      await recordPoliceAudit(uow, {
        action: 'police.alert.delivered',
        outcome: 'allowed',
        caseRef: delivery.matchId,
        // The masked number and the channel. Never the body (doc 13 §10.2).
        payload: { channel: 'SMS', masked, providerMessageId },
      });
    });
    return true;
  }

  private async recordFailure(
    delivery: PendingDelivery,
    reason: string,
    request: RequestContext,
  ): Promise<void> {
    await this.inPoliceScope(request, async (uow) => {
      await uow.query(
        `UPDATE police.alert_delivery SET failure_reason = $2
          WHERE delivery_id = $1::uuid AND delivered_at IS NULL`,
        [delivery.deliveryId, reason.slice(0, 200)],
      );
      await recordPoliceAudit(uow, {
        action: 'police.alert.delivery_failed',
        outcome: 'denied',
        caseRef: delivery.matchId,
        reason,
        payload: { channel: 'SMS' },
      });
    });
  }

  /**
   * doc 13 §10.1: the escalation nobody has approved yet.
   *
   * The minutes are a configuration row, and there is none — so this answers
   * zero and records why. It is written as the whole operation rather than as a
   * stub: when ЦЕГ approves a value, the row appears and this begins to work,
   * with no code change and no new decision.
   */
  async escalateUnacknowledged(limit = 50, request: RequestContext): Promise<number> {
    return this.inPoliceScope(request, async (uow) => {
      const policy = await uow.query<{ minutes: number }>(
        `SELECT minutes FROM police.escalation_policy
          WHERE effective_at <= now() ORDER BY version DESC LIMIT 1`,
      );
      const minutes = policy.rows[0]?.minutes;
      if (minutes === undefined) return 0;

      const due = await uow.query<{ alert_id: string; match_id: string }>(
        `SELECT a.alert_id, a.match_id
           FROM police.match_alert a
           JOIN police.police_match m ON m.match_id = a.match_id
          WHERE m.first_acknowledged_at IS NULL
            AND m.workflow_state = 'NEW'
            AND a.escalation_stage = 0
            AND a.created_at < now() - make_interval(mins => $1::integer)
          ORDER BY a.created_at
          LIMIT $2::integer`,
        [minutes, limit],
      );
      const now = this.now(uow);
      let escalated = 0;
      for (const row of due.rows) {
        const moved = await uow.query(
          `UPDATE police.match_alert
              SET escalation_stage = escalation_stage + 1, escalated_at = $2,
                  revision = revision + 1
            WHERE alert_id = $1::uuid AND escalation_stage = 0`,
          [row.alert_id, now],
        );
        if ((moved.rowCount ?? 0) !== 1) continue;
        // doc 13 §10.1: escalating notifies; it never acknowledges, resolves or
        // finds anything on anybody's behalf.
        await uow.query(
          `INSERT INTO police.alert_delivery
             (alert_id, recipient_account_id, recipient_kind, channel)
           SELECT $1::uuid, a.account_id, 'DUTY_SUPERVISOR', 'IN_APP'
             FROM platform.user_account a
            WHERE a.realm = 'police' AND a.state = 'ACTIVE' AND a.realm_role = 'POLICE_ADMIN'
           ON CONFLICT (alert_id, recipient_account_id, channel) DO NOTHING`,
          [row.alert_id],
        );
        await recordPoliceAudit(uow, {
          action: 'police.alert.escalated',
          outcome: 'allowed',
          caseRef: row.match_id,
          payload: { stage: 1, minutes },
        });
        escalated += 1;
      }
      return escalated;
    });
  }

  /** The current approved number of one Police account, in plaintext. */
  private async phoneOf(uow: UnitOfWork, accountId: string): Promise<string | undefined> {
    const result = await uow.query<{
      phone_ciphertext: Uint8Array;
      phone_wrapped_dek: Uint8Array;
      phone_key_version: string;
      contact_id: string;
    }>(
      `SELECT contact_id, phone_ciphertext, phone_wrapped_dek, phone_key_version
         FROM police.police_contact
        WHERE account_id = $1::uuid AND is_current AND verified_at IS NOT NULL`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return decryptValue(
      this.deps.keys,
      'pii.police',
      {
        ciphertext: row.phone_ciphertext,
        wrappedDek: row.phone_wrapped_dek,
        keyVersion: row.phone_key_version,
      },
      {
        table: 'police.police_contact',
        column: 'phone_ciphertext',
        rowRef: row.contact_id,
      },
    );
  }
}
