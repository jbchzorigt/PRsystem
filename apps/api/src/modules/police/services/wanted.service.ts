import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPoliceAudit } from '@prsystem/db';
import { decryptValue, deriveLookupToken, encryptValue } from '@prsystem/ports';
import {
  IDENTITY_NAMESPACE,
  isStructurallyValidRegistrationNumber,
  normalizeRegistrationNumber,
  separateAccounts,
} from '../domain/police';
import { PoliceRepository } from '../repositories/police.repository';
import type { IdentityRevisionRow } from '../repositories/police.repository';
import type { CommandActor, PoliceDependencies, RequestContext } from './police-context';
import {
  DRAFT_CREATE,
  IDENTITY_APPROVE,
  PoliceServiceBase,
  WANTED_VIEW,
  claim,
} from './police-context';

/**
 * The wanted person and the immutable revisions of their identity
 * (doc 13 §6, `POL-DEC-001`, `POL-DEC-017`, `POL-DEC-018`).
 *
 * Three things this service does and nothing else does.
 *
 * **It asks ХУР first.** doc 13 §6.1: the officer types a registration number
 * and the server calls the approved service. What comes back is an identity,
 * not a case — the reason and the category are the officer's to enter, and
 * §6.1 says in as many words not to expect them from ХУР.
 *
 * **It never lets a manual identity approve itself** (`POL-DEC-018`). A
 * `MANUAL` revision is created `PENDING_APPROVAL`, and the account that decides
 * it must be a different one. That is compared on immutable account ids here,
 * in the pipeline above, and by a CHECK on the row itself.
 *
 * **It does not create a person twice.** The identity token is unique per
 * namespace, so the same number reaches the same wanted person and a second
 * case is attached to them rather than a second person being invented.
 */

export interface WantedIdentityInput {
  readonly registrationNumber: string;
  /** Present only when ХУР could not answer, which is what makes it manual. */
  readonly manual?: {
    readonly familyName: string;
    readonly parentName: string;
    readonly givenName: string;
    readonly dateOfBirth: string;
    readonly homeAddress?: string;
    readonly homeDistrict?: string;
    readonly reason: 'XYP_UNAVAILABLE' | 'XYP_NOT_FOUND';
  };
}

export interface WantedPersonView {
  readonly personId: string;
  readonly revisionId: string;
  readonly provenance: 'XYP_VERIFIED' | 'MANUAL';
  readonly approvalState: 'PENDING_APPROVAL' | 'APPROVED';
  readonly familyName: string;
  readonly parentName: string;
  readonly givenName: string;
  readonly dateOfBirth: string;
  readonly homeDistrict: string | null;
  readonly matchable: boolean;
}

export class WantedPersonService extends PoliceServiceBase {
  constructor(deps: PoliceDependencies) {
    super(deps);
  }

  /**
   * `POL-DEC-001`: register an identity, from ХУР or by hand.
   *
   * The number is normalized and structurally checked before anything else
   * happens: doc 13 §8.1 matches on exactly that form, and an identity that
   * could never match would be a wanted record that silently does nothing.
   */
  async register(
    input: WantedIdentityInput & { idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<WantedPersonView> {
    const normalized = normalizeRegistrationNumber(input.registrationNumber);
    if (!isStructurallyValidRegistrationNumber(normalized)) {
      throw new ApiError('VALIDATION_FAILED', 'the registration number is not structurally valid');
    }

    // ХУР is asked outside the transaction: it is a network call, and it must
    // not hold a row lock while it waits.
    const answer =
      input.manual === undefined
        ? await this.deps.xyp.lookupByRegistrationNumber(
            { registrationNumber: normalized, requestRef: input.idempotencyKey },
            { correlationId: request.correlationId },
          )
        : undefined;

    return this.runPoliceCommand(actor, DRAFT_CREATE, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.wanted_register', input.idempotencyKey, {
        token: 'redacted',
      });
      if (claimed.kind === 'replay') return claimed.body as WantedPersonView;
      await authorize();

      const repository = new PoliceRepository(uow);
      const identityToken = await deriveLookupToken(
        this.deps.keys,
        'lookup.police_identity',
        { identityType: 'registration_number', countryCode: 'MN' },
        normalized,
      );
      // The second token is the one a check-in event carries: matching is the
      // comparison of two values of the same number under the platform key,
      // while the token above is this schema's own identity key (`A-P18-1`).
      const matchToken = await deriveLookupToken(
        this.deps.keys,
        'lookup.identity',
        { identityType: 'registration_number', countryCode: 'MN' },
        normalized,
      );

      const existing = await repository.personByIdentityToken(identityToken.token);
      const personRow =
        existing ??
        (await repository.insertPerson({
          identityNamespace: IDENTITY_NAMESPACE,
          identityToken: identityToken.token,
          identityKeyVersion: identityToken.keyVersion,
          matchNamespace: IDENTITY_NAMESPACE,
          matchToken: matchToken.token,
          matchKeyVersion: matchToken.keyVersion,
          createdByAccountId: actor.principal.accountId,
        }));

      if (existing !== undefined) {
        // doc 13 §6.3: the same number never becomes a second person. What a
        // second registration produces is a second case on the person who is
        // already there, and the identity they already have.
        const current = await repository.currentRevision(personRow.personId);
        if (current !== undefined) {
          const view = this.view(personRow.personId, current, true);
          await recordPoliceAudit(uow, {
            action: 'police.wanted_person.reused',
            outcome: 'allowed',
            caseRef: personRow.personId,
            payload: { provenance: current.provenance },
          });
          return view;
        }
      }

      const identity =
        input.manual === undefined &&
        answer?.ok === true &&
        answer.value.found &&
        answer.value.citizen.parentName !== undefined
          ? {
              familyName: answer.value.citizen.familyName,
              parentName: answer.value.citizen.parentName,
              givenName: answer.value.citizen.givenName,
              dateOfBirth: answer.value.citizen.dateOfBirth,
              homeAddress: answer.value.citizen.homeAddress ?? null,
              homeDistrict: answer.value.citizen.homeDistrict ?? null,
              provenance: 'XYP_VERIFIED' as const,
            }
          : input.manual !== undefined
            ? {
                familyName: input.manual.familyName,
                parentName: input.manual.parentName,
                givenName: input.manual.givenName,
                dateOfBirth: input.manual.dateOfBirth,
                homeAddress: input.manual.homeAddress ?? null,
                homeDistrict: input.manual.homeDistrict ?? null,
                provenance: 'MANUAL' as const,
              }
            : undefined;
      if (identity === undefined) {
        // doc 13 §6.2: ХУР did not answer and the officer supplied nothing.
        // The record is refused rather than stored as if it were verified.
        throw new ApiError(
          'PRECONDITION_FAILED',
          'XYP_UNAVAILABLE: enter the identity manually for approval',
        );
      }

      const revisionNo = await repository.nextRevisionNo(personRow.personId);
      const sealed = await encryptValue(this.deps.keys, 'pii.police', normalized, {
        table: 'police.wanted_identity_revision',
        column: 'identifier_ciphertext',
        rowRef: personRow.personId,
      });
      const approved = identity.provenance === 'XYP_VERIFIED';
      const revision = await repository.insertRevision({
        personId: personRow.personId,
        revisionNo,
        isCurrent: approved,
        familyName: identity.familyName,
        parentName: identity.parentName,
        givenName: identity.givenName,
        dateOfBirth: identity.dateOfBirth,
        homeAddress: identity.homeAddress,
        homeDistrict: identity.homeDistrict,
        identifierCiphertext: sealed.ciphertext,
        identifierWrappedDek: sealed.wrappedDek,
        identifierKeyVersion: sealed.keyVersion,
        provenance: identity.provenance,
        approvalState: approved ? 'APPROVED' : 'PENDING_APPROVAL',
        createdByAccountId: actor.principal.accountId,
      });

      await recordPoliceAudit(uow, {
        action: 'police.wanted_identity.created',
        outcome: 'allowed',
        caseRef: personRow.personId,
        // Never the number and never the name: doc 13 §13.1 keeps the audit
        // to who did what, not to what the record said.
        payload: {
          provenance: identity.provenance,
          approvalState: revision.approvalState,
          revisionNo,
          ...(input.manual === undefined ? {} : { manualReason: input.manual.reason }),
        },
      });

      const view = this.view(personRow.personId, revision, approved);
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
      return view;
    });
  }

  /**
   * `POL-DEC-018`: a second officer approves — or refuses — a manual identity.
   *
   * Until this happens the person has no current revision, and a person with no
   * current revision matches nothing. The separation is checked three times:
   * by the pipeline's own `approver_not_creator` rule, here, and by the CHECK
   * on the row.
   */
  async decideIdentity(
    input: {
      personId: string;
      revisionId: string;
      approve: boolean;
      reason: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<WantedPersonView> {
    // The pipeline compares the requester on the cell's separation rule, so the
    // creator has to be known before authorization runs — not after it.
    const creator = await this.inPoliceScope(request, async (uow) => {
      const revision = await new PoliceRepository(uow).lockRevision(input.revisionId);
      return revision?.createdByAccountId;
    });

    return this.runPoliceCommand(actor, IDENTITY_APPROVE, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.identity_decide', input.idempotencyKey, {
        revisionId: input.revisionId,
        approve: input.approve,
      });
      if (claimed.kind === 'replay') return claimed.body as WantedPersonView;
      await authorize({
        ...(creator === undefined ? {} : { separationCounterpartAccountId: creator }),
        targetRef: input.personId,
      });

      const repository = new PoliceRepository(uow);
      const revision = await repository.lockRevision(input.revisionId);
      if (revision === undefined || revision.personId !== input.personId) {
        throw new ApiError('NOT_FOUND', 'no such identity revision');
      }
      if (revision.approvalState !== 'PENDING_APPROVAL') {
        throw new ApiError('CONFLICT', 'that identity revision has already been decided');
      }
      if (!separateAccounts(revision.createdByAccountId, actor.principal.accountId)) {
        throw new ApiError(
          'FORBIDDEN',
          'SEPARATION_OF_DUTIES: the approver may not be the creator',
        );
      }

      const now = this.now(uow);
      await repository.decideRevision({
        revisionId: revision.revisionId,
        approved: input.approve,
        decidedByAccountId: actor.principal.accountId,
        decidedAt: now,
        reason: input.reason,
      });
      if (input.approve) await repository.makeCurrent(revision.personId, revision.revisionId);

      await recordPoliceAudit(uow, {
        action: input.approve
          ? 'police.wanted_identity.approved'
          : 'police.wanted_identity.rejected',
        outcome: 'allowed',
        caseRef: revision.personId,
        reason: input.reason,
        payload: { revisionNo: revision.revisionNo, provenance: revision.provenance },
      });

      const reread = await repository.lockRevision(revision.revisionId);
      const view = this.view(revision.personId, reread ?? revision, input.approve);
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
      return view;
    });
  }

  /** doc 13 §12.1: the wanted list a Police account may read in its own scope. */
  async read(
    personId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<WantedPersonView & { registrationNumber: string }> {
    return this.runPoliceCommand(actor, WANTED_VIEW, request, async (uow, authorize) => {
      await authorize({ targetRef: personId });
      const repository = new PoliceRepository(uow);
      const revision = await repository.currentRevision(personId);
      if (revision === undefined) throw new ApiError('NOT_FOUND', 'no such wanted person');
      const number = await this.registrationNumberOf(revision);
      await recordPoliceAudit(uow, {
        action: 'police.wanted_person.read',
        outcome: 'allowed',
        caseRef: personId,
        payload: {},
      });
      return { ...this.view(personId, revision, true), registrationNumber: number };
    });
  }

  /**
   * The plaintext registration number of a revision.
   *
   * It exists because two approved surfaces need it — the Match SMS carries the
   * full number (`POL-DEC-009`) and an unmasked export may (doc 13 §12.2) — and
   * it is deliberately the only way to get one: the ciphertext never leaves
   * this module in any other form.
   */
  async registrationNumberOf(revision: IdentityRevisionRow): Promise<string> {
    return decryptValue(
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
  }

  private view(
    personId: string,
    revision: IdentityRevisionRow,
    matchable: boolean,
  ): WantedPersonView {
    return {
      personId,
      revisionId: revision.revisionId,
      provenance: revision.provenance,
      approvalState:
        revision.approvalState === 'REJECTED' ? 'PENDING_APPROVAL' : revision.approvalState,
      familyName: revision.familyName,
      parentName: revision.parentName,
      givenName: revision.givenName,
      dateOfBirth: revision.dateOfBirth,
      homeDistrict: revision.homeDistrict,
      matchable: matchable && revision.approvalState === 'APPROVED',
    };
  }
}
