import type { UnitOfWork } from '@prsystem/db';
import type {
  CommissionContract,
  ConfirmedPayment,
  Retention,
  SettlementPort,
  UnmatchedCapture,
} from '../../booking/contracts/settlement';
import { SettlementRepository } from '../repositories/settlement.repository';
import { SettlementService } from '../services/settlement.service';

/**
 * The settlement module's implementation of the booking module's contract.
 *
 * It holds no pool and opens no transaction: every call runs inside the
 * booking's own, on rows the booking command has already locked, which is what
 * makes "the money and the lifecycle move together or not at all" true rather
 * than intended.
 */
export class RepositorySettlement implements SettlementPort {
  private readonly settlement = new SettlementService();

  async contractFor(uow: UnitOfWork, at: Date): Promise<CommissionContract | undefined> {
    const contract = await new SettlementRepository(uow).activeContract(at);
    if (contract === undefined) return undefined;
    return {
      contractId: contract.contractId,
      contractVersion: contract.contractVersion,
      commissionRateBps: contract.commissionRateBps,
      cancellationPolicyVersion: contract.cancellationPolicyVersion,
    };
  }

  async openPayable(uow: UnitOfWork, input: ConfirmedPayment): Promise<void> {
    await this.settlement.openPayable(uow, {
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      grossPaidMnt: input.grossPaidMnt,
      providerFeeMnt: input.providerFeeMnt,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      contract: {
        contractId: input.contract.contractId,
        contractVersion: input.contract.contractVersion,
        commissionRateBps: input.contract.commissionRateBps,
      },
    });
  }

  async recordRetention(uow: UnitOfWork, input: Retention): Promise<void> {
    await this.settlement.recordRetention(uow, {
      hotelId: input.hotelId,
      bookingId: input.bookingId,
      refundMnt: input.refundMnt,
      reason: input.reason,
      sourceRef: input.sourceRef,
      at: input.at,
      localDate: input.localDate,
    });
  }

  async raiseUnmatchedRefund(uow: UnitOfWork, input: UnmatchedCapture): Promise<void> {
    await this.settlement.raiseUnmatchedRefund(uow, input);
  }

  async markEligible(
    uow: UnitOfWork,
    input: { bookingId: string; at: Date; localDate: string },
  ): Promise<void> {
    await this.settlement.markEligible(uow, input);
  }
}
