import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { locationBalanceMnt } from '../domain/cash';
import type { LocationRow } from '../repositories/finance.repository';
import type { FinanceRepository } from '../repositories/finance.repository';
import type { FinanceDependencies } from './finance-context';

/**
 * The four checks every cash write shares (doc 24 §§2, 5, 7).
 *
 * They are here rather than repeated in each service so that "a drawer
 * movement belongs to the drawer's active shift" and "a drawer never goes
 * negative" are each written once and cannot drift between commands.
 */

export async function requireLocation(
  repository: FinanceRepository,
  locationId: string,
  kind?: 'DRAWER' | 'SAFE',
): Promise<LocationRow> {
  const location = await repository.lockLocation(locationId);
  if (location === undefined) throw new ApiError('NOT_FOUND', 'not found');
  if (kind !== undefined && location.kind !== kind) {
    throw new ApiError(
      'VALIDATION_FAILED',
      kind === 'DRAWER' ? 'this cash location is not a drawer' : 'this cash location is not a safe',
    );
  }
  if (location.state !== 'ACTIVE') {
    throw new ApiError('PRECONDITION_FAILED', 'INACTIVE_LOCATION: the cash location is inactive');
  }
  return location;
}

/**
 * doc 24 §2.2: a drawer movement names the shift accountable for the drawer.
 * With no shift open on it, there is nobody to be accountable and the movement
 * is refused rather than posted loose.
 */
export async function requireDrawerShift(
  deps: FinanceDependencies,
  uow: UnitOfWork,
  locationId: string,
): Promise<string> {
  const shift = await deps.shifts.activeShiftOnDrawer(uow, locationId);
  if (shift === undefined) {
    throw new ApiError(
      'PRECONDITION_FAILED',
      'NO_ACTIVE_SHIFT: no Reception shift is accountable for this drawer',
    );
  }
  return shift.shiftId;
}

/** The shift of a drawer, or nothing at all for a safe (`CASH-DEC-002`). */
export async function shiftOf(
  deps: FinanceDependencies,
  uow: UnitOfWork,
  location: LocationRow,
): Promise<string | undefined> {
  return location.kind === 'DRAWER'
    ? requireDrawerShift(deps, uow, location.locationId)
    : undefined;
}

/** doc 24 §7: cash that is not there cannot leave. */
export async function requireSufficientCash(
  repository: FinanceRepository,
  locationId: string,
  amountMnt: bigint,
): Promise<bigint> {
  const balance = locationBalanceMnt(await repository.movementsOfLocation(locationId));
  if (balance < amountMnt) {
    throw new ApiError(
      'PRECONDITION_FAILED',
      `INSUFFICIENT_CASH: the location holds ${balance.toString()}₮`,
    );
  }
  return balance;
}

export function requireAmount(value: bigint, what: string): bigint {
  if (value <= 0n) throw new ApiError('VALIDATION_FAILED', `${what} is a positive amount`);
  return value;
}

export function requireReason(reason: string | undefined, what: string): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) throw new ApiError('VALIDATION_FAILED', `${what} requires a reason`);
  if (trimmed.length > 300) throw new ApiError('VALIDATION_FAILED', 'the reason is too long');
  return trimmed;
}
