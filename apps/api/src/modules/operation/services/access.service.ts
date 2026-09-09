import { randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import { operationGrantablePermissions } from '@prsystem/authz';
import { OperationRepository } from '../repositories/operation.repository';
import { ENROLMENT_SUBJECT } from './auth.service';
import type { CommandActor, OperationDependencies, RequestContext } from './operation-context';
import { ACCESS_MANAGE, PERMISSION_MANAGE, OperationServiceBase, claim } from './operation-context';

/**
 * Who may act in the Operation realm at all (doc 14 §2, doc 18 §5).
 *
 * `PLATFORM_OPERATION_ACCESS_MANAGE` is the only permission that reaches this
 * service, and four rules are enforced here rather than assumed:
 *
 *  - **Every account is one named person.** An address is unique in the realm
 *    by the account table's own key, the account is created with no credential,
 *    and only the person who opens the enrolment link sets one. There is no
 *    surface through which a shared account could be created with a known
 *    password.
 *  - **A role name grants nothing.** A grant must appear in
 *    `operationGrantablePermissions` for the account's own realm role, checked
 *    here, again by the account repository, and again by the row's CHECK.
 *  - **Nobody administers themselves.** An operator may not create, suspend,
 *    grant to or revoke from their own account — which is the difference
 *    between an access-management permission and a self-elevation one.
 *  - **A change takes effect at once.** Suspending an account or moving its
 *    permissions bumps its auth epoch and revokes its sessions in the same
 *    transaction, so authority that was withdrawn is withdrawn on every device.
 */

const OPERATION_ROLES = ['OPERATION_ADMIN', 'PLATFORM_SUPER_ADMIN'] as const;
export type OperationRoleName = (typeof OPERATION_ROLES)[number];

export function isOperationRoleName(value: string): value is OperationRoleName {
  return (OPERATION_ROLES as readonly string[]).includes(value);
}

export class OperationAccessService extends OperationServiceBase {
  constructor(deps: OperationDependencies) {
    super(deps);
  }

  /**
   * Creates a named Operation account and sends its one-time enrolment link.
   *
   * The account exists immediately and can do nothing: it is
   * `PENDING_ACTIVATION`, holds no credential and holds no second factor. What
   * the link carries is the token and nothing else — not the role, not the
   * permissions, not who created it.
   */
  async createAccount(
    actor: CommandActor,
    input: {
      email: string;
      role: OperationRoleName;
      permissions: readonly string[];
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ accountId: string; enrolmentId: string; expiresAt: Date }> {
    const grantable = operationGrantablePermissions(input.role);
    for (const permission of input.permissions) {
      if (!grantable.includes(permission)) {
        throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [
          { field: 'permissions', issue: `${permission} is not grantable to ${input.role}` },
        ]);
      }
    }

    const { outcome, delivery } = await this.runOperationCommand(
      actor,
      ACCESS_MANAGE,
      { targetType: 'user_account', targetRef: input.email },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.access.create', input.idempotencyKey, {
          email: input.email,
          role: input.role,
          permissions: [...input.permissions].sort(),
        });
        if (claimed.kind === 'replay') {
          return {
            outcome: claimed.body as { accountId: string; enrolmentId: string; expiresAt: Date },
            delivery: undefined,
          };
        }

        const accounts = this.deps.accounts;
        if ((await accounts.findByEmail(uow, input.email)) !== undefined) {
          throw new ApiError('CONFLICT', 'an Operation account already uses that address');
        }
        const account = await accounts.create(uow, { email: input.email, role: input.role });
        for (const permission of input.permissions) {
          await accounts.grantPermission(
            uow,
            account.accountId,
            permission,
            actor.principal.accountId,
          );
        }

        const issued = await this.tokens.issue('operation_enrolment', ENROLMENT_SUBJECT);
        const repository = new OperationRepository(uow);
        const enrolmentId = await repository.createEnrolment({
          accountId: account.accountId,
          tokenHash: issued.tokenHash,
          tokenKeyVersion: issued.keyVersion,
          ttlSeconds: this.parameters.enrolmentTtlSeconds,
          createdBy: actor.principal.accountId,
        });
        const expiresAt = new Date(
          this.now(uow).getTime() + this.parameters.enrolmentTtlSeconds * 1000,
        );

        await this.audit(uow, {
          action: 'operation.access.account_created',
          outcome: 'allowed',
          targetType: 'user_account',
          targetRef: account.accountId,
          payload: { role: input.role, permissions: [...input.permissions].sort() },
        });

        const result = { accountId: account.accountId, enrolmentId, expiresAt };
        await this.complete(uow, claimed.idempotencyId, result);
        return {
          outcome: result,
          delivery: {
            deliveryId: randomUUID(),
            accountId: account.accountId,
            emailNormalized: input.email.trim().toLowerCase(),
            expiresAt,
            token: issued.token,
          },
        };
      },
    );

    // The link is delivered after the transaction commits, exactly as Phase 04
    // delivers an invitation: a provider failure costs a re-issue, not an
    // account that half exists.
    if (delivery !== undefined) {
      await this.deps.notifications.deliver({ kind: 'operation_enrolment', ...delivery });
    }
    return outcome;
  }

  /** Suspends or reactivates an Operation account (doc 14 §2). */
  async setAccountState(
    actor: CommandActor,
    input: {
      accountId: string;
      state: 'ACTIVE' | 'SUSPENDED';
      reason: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ accountId: string; state: string; sessionsRevoked: number }> {
    this.refuseSelf(actor, input.accountId);
    return this.runOperationCommand(
      actor,
      ACCESS_MANAGE,
      { targetType: 'user_account', targetRef: input.accountId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.access.state', input.idempotencyKey, {
          accountId: input.accountId,
          state: input.state,
        });
        if (claimed.kind === 'replay') {
          return claimed.body as { accountId: string; state: string; sessionsRevoked: number };
        }

        const accounts = this.deps.accounts;
        const account = await accounts.lockById(uow, input.accountId);
        if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');

        let sessionsRevoked = 0;
        if (account.state !== input.state) {
          if (
            !(await accounts.setState(
              uow,
              account.accountId,
              input.state,
              account.revision,
              input.reason,
            ))
          ) {
            throw new ApiError('CONFLICT', 'the account moved while it was being changed');
          }
          if (input.state === 'SUSPENDED') {
            // The epoch and the revocation together: the epoch closes tokens
            // that are checked against it, and the revocation closes the rows.
            await accounts.bumpAuthEpoch(uow, account.accountId, account.revision + 1);
            sessionsRevoked = await accounts.revokeSessions(
              uow,
              account.accountId,
              'operation_account_suspended',
            );
          }
        }

        await this.audit(uow, {
          action: 'operation.access.account_state',
          outcome: 'allowed',
          targetType: 'user_account',
          targetRef: account.accountId,
          reason: input.reason,
          payload: { state: input.state, sessionsRevoked },
        });

        const result = { accountId: account.accountId, state: input.state, sessionsRevoked };
        await this.complete(uow, claimed.idempotencyId, result);
        return result;
      },
    );
  }

  /**
   * Grants or revokes one named permission.
   *
   * Either way the subject's sessions end, because doc 14 §2 requires a
   * permission change to take effect immediately and a live token carries the
   * grants it was authorised against until it is re-resolved.
   */
  async setPermission(
    actor: CommandActor,
    input: {
      accountId: string;
      permission: string;
      granted: boolean;
      reason: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ accountId: string; permissions: readonly string[]; sessionsRevoked: number }> {
    this.refuseSelf(actor, input.accountId);
    return this.runOperationCommand(
      actor,
      PERMISSION_MANAGE,
      { targetType: 'account_permission_grant', targetRef: input.accountId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.access.permission', input.idempotencyKey, {
          accountId: input.accountId,
          permission: input.permission,
          granted: input.granted,
        });
        if (claimed.kind === 'replay') {
          return claimed.body as {
            accountId: string;
            permissions: readonly string[];
            sessionsRevoked: number;
          };
        }

        const accounts = this.deps.accounts;
        const account = await accounts.lockById(uow, input.accountId);
        if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');

        const changed = input.granted
          ? await accounts.grantPermission(
              uow,
              account.accountId,
              input.permission,
              actor.principal.accountId,
            )
          : await accounts.revokePermission(
              uow,
              account.accountId,
              input.permission,
              actor.principal.accountId,
              input.reason,
            );

        let sessionsRevoked = 0;
        if (changed) {
          await accounts.bumpAuthEpoch(uow, account.accountId, account.revision);
          sessionsRevoked = await accounts.revokeSessions(
            uow,
            account.accountId,
            'operation_permission_changed',
          );
        }

        const permissions = await accounts.permissionsFor(uow, account.accountId);
        await this.audit(uow, {
          action: input.granted
            ? 'operation.access.permission_granted'
            : 'operation.access.permission_revoked',
          outcome: 'allowed',
          targetType: 'account_permission_grant',
          targetRef: account.accountId,
          reason: input.reason,
          payload: { permission: input.permission, changed, sessionsRevoked },
        });

        const result = { accountId: account.accountId, permissions, sessionsRevoked };
        await this.complete(uow, claimed.idempotencyId, result);
        return result;
      },
    );
  }

  /**
   * An operator may not administer their own account.
   *
   * Without this, `PLATFORM_OPERATION_ACCESS_MANAGE` would be a
   * self-elevation permission: its holder could grant themselves every other
   * row of doc 18 §5. `A-P19-3` records that doc 14 does not state the rule and
   * that refusing it is the reading this phase took.
   */
  private refuseSelf(actor: CommandActor, accountId: string): void {
    if (actor.principal.accountId === accountId) {
      throw new ApiError('FORBIDDEN', 'an Operation account may not administer itself');
    }
  }
}
