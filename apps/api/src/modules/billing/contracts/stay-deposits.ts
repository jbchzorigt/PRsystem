import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import type { DepositsPort, StayDepositFacts } from '../../stay/contracts/deposits';
import { depositRequirement } from '../domain/money';
import { BillingRepository } from '../repositories/billing.repository';

/**
 * Phase 10's implementation of the contract Phase 08's check-in calls: the
 * folio and the deposit aggregate of a confirmed stay, opened in the
 * confirmation's own transaction with the requirement and the configuration
 * version it was confirmed under (`DEP-DEC-008`).
 *
 * A walk-in in a hotel that has configured no deposit is refused here, which is
 * where doc 02 §3.4's "a walk-in checks in against a configured deposit" is
 * actually enforced. It needs nothing but the transaction it is handed: the
 * facts come from the check-in, so the billing module never has to reach back
 * into the stay module to serve it.
 */
export class BillingDeposits implements DepositsPort {
  async openForStay(uow: UnitOfWork, facts: StayDepositFacts): Promise<void> {
    const billing = new BillingRepository(uow);
    const category = await billing.config(facts.categoryId);
    const hotel = await billing.config(null);
    let requirement;
    try {
      requirement = depositRequirement({
        source: facts.source,
        categoryAmountMnt: category?.amountMnt ?? null,
        hotelAmountMnt: hotel?.amountMnt ?? null,
      });
    } catch {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'DEPOSIT_NOT_CONFIGURED: this hotel has no configured deposit for a walk-in',
      );
    }
    await billing.openFolio({ stayId: facts.stayId, roomId: facts.roomId, at: uow.serverNow });
    await billing.openDeposit({
      stayId: facts.stayId,
      source: facts.source,
      required: requirement.required,
      requiredAmountMnt: requirement.required ? requirement.amountMnt : null,
      configScope: requirement.required ? requirement.scope : 'NONE',
      configVersion: requirement.required
        ? ((requirement.scope === 'CATEGORY' ? category?.configVersion : hotel?.configVersion) ??
          null)
        : null,
      categoryId:
        requirement.required && requirement.scope === 'CATEGORY' ? facts.categoryId : null,
    });
  }
}
