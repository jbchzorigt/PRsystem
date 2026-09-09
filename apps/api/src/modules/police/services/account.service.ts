import { randomInt, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPoliceAudit } from '@prsystem/db';
import type { UnitOfWork } from '@prsystem/db';
import { decryptValue, encryptValue } from '@prsystem/ports';
import {
  codeExpiry,
  lockUntil,
  maskRegistrationNumber,
  refuseCode,
  refuseIssue,
} from '../domain/police';
import type { PoliceAccountPort } from '../contracts/police-accounts';
import type { CommandActor, PoliceDependencies, RequestContext } from './police-context';
import { ACCOUNT_MANAGE, PoliceServiceBase, claim } from './police-context';

/**
 * Police accounts, and the four-digit code that bootstraps them
 * (doc 13 §5, `POL-DEC-004`, `POL-DEC-022`).
 *
 * A four-digit code is ten thousand guesses, and doc 13 §5.3 is explicit that
 * the compensating controls are not optional decoration — they are the reason
 * the code is allowed to be four digits. Every one of them is here or in the
 * schema: five minutes, one use, three attempts, a thirty-minute lock on the
 * third failure, a minute between resends, three an hour and five a day, a new
 * code invalidating the last, a keyed digest instead of the code, and the same
 * generic answer whether or not the account exists.
 *
 * The code is never stored, never logged and never audited. What is stored is
 * an HMAC under a key of its own, so a digest read out of this table is not the
 * digest of anything else.
 */

export interface ProvisionedAccount {
  readonly accountId: string;
  readonly maskedPhone: string;
}

const CODE_HMAC_SCOPE = 'auth.police_bootstrap_code' as const;

export class PoliceAccountService extends PoliceServiceBase {
  constructor(
    deps: PoliceDependencies,
    private readonly accounts: PoliceAccountPort,
  ) {
    super(deps);
  }

  /**
   * doc 13 §5.1: a Police Admin creates the account, and the officer finishes
   * it. What is created is inactive and has no password — the first thing that
   * happens to it is a code to the registered phone.
   */
  async provision(
    input: {
      email: string;
      phone: string;
      role: 'POLICE_OFFICER' | 'POLICE_ADMIN';
      unitRef: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ProvisionedAccount> {
    return this.runPoliceCommand(actor, ACCOUNT_MANAGE, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.account_provision', input.idempotencyKey, {
        email: input.email,
      });
      if (claimed.kind === 'replay') return claimed.body as ProvisionedAccount;
      await authorize();

      const existing = await this.accounts.findByEmail(uow, input.email);
      if (existing !== undefined) {
        throw new ApiError('CONFLICT', 'a Police account already holds that address');
      }
      const account = await this.accounts.create(uow, {
        email: input.email,
        role: input.role,
        unitRef: input.unitRef,
      });
      const masked = await this.storeContact(uow, account.accountId, input.phone, 1, actor);

      await recordPoliceAudit(uow, {
        action: 'police.account.provisioned',
        outcome: 'allowed',
        caseRef: account.accountId,
        // The role and the unit, and a masked number. Never the address and
        // never the number itself (doc 13 §13.1).
        payload: { role: input.role, unit: input.unitRef, phone: masked },
      });
      const body = { accountId: account.accountId, maskedPhone: masked };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, body);
      return body;
    });
  }

  /**
   * Issues a code to the account's registered phone.
   *
   * The answer is the same whether or not the account exists (doc 13 §5.2), so
   * a caller cannot enumerate officers by asking for resets. Everything that
   * decides is inside: the resend interval, the two issuance caps and the
   * invalidation of whatever was outstanding.
   */
  async issueCode(
    input: { email: string; purpose: 'ACCOUNT_ACTIVATION' | 'PASSWORD_RESET' },
    request: RequestContext,
  ): Promise<{ accepted: true }> {
    await this.inPoliceScope(request, async (uow) => {
      const account = await this.accounts.findByEmail(uow, input.email);
      if (account === undefined) return;
      const now = this.now(uow);

      const history = await uow.query<{ issued_at: Date }>(
        `SELECT issued_at FROM police.bootstrap_code
          WHERE account_id = $1::uuid AND purpose = $2
          ORDER BY issued_at DESC LIMIT 20`,
        [account.accountId, input.purpose],
      );
      const refusal = refuseIssue(
        history.rows.map((row) => row.issued_at),
        now,
      );
      if (refusal !== undefined) {
        await recordPoliceAudit(uow, {
          action: 'police.bootstrap_code.refused',
          outcome: 'denied',
          caseRef: account.accountId,
          reason: refusal,
          payload: { purpose: input.purpose },
        });
        return;
      }

      // doc 13 §5.3: a new code invalidates every outstanding one, so two
      // cannot be guessed in parallel.
      await uow.query(
        `UPDATE police.bootstrap_code SET invalidated_at = $3
          WHERE account_id = $1::uuid AND purpose = $2
            AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [account.accountId, input.purpose, now],
      );

      const contact = await uow.query<{ phone_version: number }>(
        `SELECT phone_version FROM police.police_contact
          WHERE account_id = $1::uuid AND is_current`,
        [account.accountId],
      );
      const phoneVersion = contact.rows[0]?.phone_version;
      if (phoneVersion === undefined) return;

      const code = String(randomInt(0, 10_000)).padStart(4, '0');
      const digest = await this.deps.keys.hmac(
        CODE_HMAC_SCOPE,
        Buffer.from(
          `${account.accountId}|${input.purpose}|${String(phoneVersion)}|${code}`,
          'utf8',
        ),
      );
      await uow.query(
        `INSERT INTO police.bootstrap_code
           (account_id, purpose, code_hash, hash_key_version, phone_version, issued_at, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
        [
          account.accountId,
          input.purpose,
          Buffer.from(digest.mac),
          digest.keyVersion,
          phoneVersion,
          now,
          codeExpiry(now),
        ],
      );

      const phone = await this.phoneOf(uow, account.accountId);
      if (phone !== undefined) {
        await this.deps.sms.send(
          {
            jobId: `${account.accountId}:${input.purpose}:${String(now.getTime())}`,
            recipients: [{ recipientRef: account.accountId, phone }],
            body: `PRsystem: ${code}`,
          },
          { correlationId: request.correlationId },
        );
      }
      await recordPoliceAudit(uow, {
        action: 'police.bootstrap_code.issued',
        outcome: 'allowed',
        caseRef: account.accountId,
        // The purpose and the phone version. Never the code (CLAUDE.md §8).
        payload: { purpose: input.purpose, phoneVersion },
      });
    });
    // Deliberately the same answer either way.
    return { accepted: true };
  }

  /**
   * doc 13 §5.1 steps 4–6 and §5.2: the code is verified, then the officer
   * chooses their own password.
   *
   * A wrong code costs an attempt; the third failure invalidates the code and
   * locks the flow for thirty minutes. A successful redemption consumes the
   * code, invalidates the rest, and — for a reset — ends every live session.
   */
  async redeem(
    input: {
      email: string;
      code: string;
      purpose: 'ACCOUNT_ACTIVATION' | 'PASSWORD_RESET';
      password: string;
    },
    request: RequestContext,
  ): Promise<{ activated: boolean }> {
    return this.inPoliceScope(request, async (uow) => {
      const generic = new ApiError('VALIDATION_FAILED', 'that code is not valid');
      const account = await this.accounts.findByEmail(uow, input.email);
      if (account === undefined) throw generic;

      const stored = await uow.query<{
        code_id: string;
        code_hash: Uint8Array;
        phone_version: number;
        expires_at: Date;
        attempts: number;
        consumed_at: Date | null;
        invalidated_at: Date | null;
        locked_until: Date | null;
      }>(
        `SELECT code_id, code_hash, phone_version, expires_at, attempts,
                consumed_at, invalidated_at, locked_until
           FROM police.bootstrap_code
          WHERE account_id = $1::uuid AND purpose = $2
          ORDER BY issued_at DESC LIMIT 1`,
        [account.accountId, input.purpose],
      );
      const row = stored.rows[0];
      if (row === undefined) throw generic;
      const now = this.now(uow);
      const refusal = refuseCode(
        {
          expiresAt: row.expires_at,
          attempts: row.attempts,
          consumedAt: row.consumed_at,
          invalidatedAt: row.invalidated_at,
          lockedUntil: row.locked_until,
        },
        now,
      );
      if (refusal !== undefined) {
        await recordPoliceAudit(uow, {
          action: 'police.bootstrap_code.refused',
          outcome: 'denied',
          caseRef: account.accountId,
          reason: refusal,
          payload: { purpose: input.purpose },
        });
        throw generic;
      }

      const digest = await this.deps.keys.hmac(
        CODE_HMAC_SCOPE,
        Buffer.from(
          `${account.accountId}|${input.purpose}|${String(row.phone_version)}|${input.code}`,
          'utf8',
        ),
      );
      const presented = Buffer.from(digest.mac);
      const expected = Buffer.from(row.code_hash);
      const matches = presented.length === expected.length && timingSafeEqual(presented, expected);
      if (!matches) {
        const attempts = row.attempts + 1;
        await uow.query(
          `UPDATE police.bootstrap_code
              SET attempts = $2,
                  invalidated_at = CASE WHEN $2 >= 3 THEN $3 ELSE invalidated_at END,
                  locked_until = CASE WHEN $2 >= 3 THEN $4 ELSE locked_until END
            WHERE code_id = $1::uuid`,
          [row.code_id, attempts, now, lockUntil(now)],
        );
        await recordPoliceAudit(uow, {
          action: 'police.bootstrap_code.failed',
          outcome: 'denied',
          caseRef: account.accountId,
          reason: attempts >= 3 ? 'LOCKED' : 'WRONG_CODE',
          payload: { purpose: input.purpose, attempts },
        });
        throw generic;
      }

      await uow.query(
        `UPDATE police.bootstrap_code SET consumed_at = $2 WHERE code_id = $1::uuid`,
        [row.code_id, now],
      );
      await uow.query(
        `UPDATE police.bootstrap_code SET invalidated_at = $2
          WHERE account_id = $1::uuid AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [account.accountId, now],
      );
      await this.accounts.setPassword(uow, account.accountId, input.password);
      const activated =
        input.purpose === 'ACCOUNT_ACTIVATION'
          ? await this.accounts.activate(uow, account.accountId, account.revision)
          : false;
      if (input.purpose === 'PASSWORD_RESET') {
        await this.accounts.revokeSessions(uow, account.accountId, 'police_password_reset');
      }
      await uow.query(
        `UPDATE police.police_contact SET verified_at = coalesce(verified_at, $2)
          WHERE account_id = $1::uuid AND is_current`,
        [account.accountId, now],
      );
      await recordPoliceAudit(uow, {
        action:
          input.purpose === 'ACCOUNT_ACTIVATION'
            ? 'police.account.activated'
            : 'police.account.password_reset',
        outcome: 'allowed',
        caseRef: account.accountId,
        payload: { purpose: input.purpose },
      });
      return { activated };
    });
  }

  /** Envelope-encrypts a number and keeps four digits of it for recognition. */
  private async storeContact(
    uow: UnitOfWork,
    accountId: string,
    phone: string,
    version: number,
    actor: CommandActor,
  ): Promise<string> {
    const sealed = await encryptValue(this.deps.keys, 'pii.police', phone, {
      table: 'police.police_contact',
      column: 'phone_ciphertext',
      rowRef: accountId,
    });
    const masked = maskRegistrationNumber(phone);
    await uow.query(
      `UPDATE police.police_contact SET is_current = false
        WHERE account_id = $1::uuid AND is_current`,
      [accountId],
    );
    await uow.query(
      `INSERT INTO police.police_contact
         (account_id, phone_version, is_current, phone_ciphertext, phone_wrapped_dek,
          phone_key_version, phone_masked, approved_by_account_id)
       VALUES ($1::uuid, $2, true, $3, $4, $5, $6, $7::uuid)`,
      [
        accountId,
        version,
        Buffer.from(sealed.ciphertext),
        Buffer.from(sealed.wrappedDek),
        sealed.keyVersion,
        masked,
        actor.principal.accountId,
      ],
    );
    return masked;
  }

  private async phoneOf(uow: UnitOfWork, accountId: string): Promise<string | undefined> {
    const result = await uow.query<{
      contact_id: string;
      phone_ciphertext: Uint8Array;
      phone_wrapped_dek: Uint8Array;
      phone_key_version: string;
    }>(
      `SELECT contact_id, phone_ciphertext, phone_wrapped_dek, phone_key_version
         FROM police.police_contact WHERE account_id = $1::uuid AND is_current`,
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
      { table: 'police.police_contact', column: 'phone_ciphertext', rowRef: row.contact_id },
    );
  }
}
