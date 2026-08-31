import type { HandoffSubjectKind } from '../repositories/handoff.repository';

/**
 * Unfinished work a suspended or terminated membership still holds
 * (doc 19 §8.1–§8.4, `STAFF-DEC-007`).
 *
 * **Why this is a port and not a request field.** What work a person has open is
 * an authoritative fact owned by the module that runs that work — the Reception
 * shift (Phase 11), the Cleaner task (Phase 09), the Restaurant order
 * (Phase 15). A caller who could name it could also *omit* it, and an omitted
 * item is a suspension that silently drops a blocker rather than handing it
 * over. So IAM asks, and never accepts an answer from the request.
 *
 * None of the three owning modules exists yet. That is a determinate answer, not
 * an unknown one: with no module registered for a subject kind there is no work
 * of that kind in the system at all, and the registry says so explicitly. When a
 * phase lands it registers a provider, and from that moment a provider that
 * *cannot* answer refuses the suspension's handoff enumeration rather than
 * reporting an empty list — an unknown is never rendered as "nothing".
 */

export interface OpenWorkItem {
  readonly kind: HandoffSubjectKind;
  /** Opaque to IAM. The owning module's identifier for the work. */
  readonly ref: string;
  /** True where an immutable movement or partial completion is already posted. */
  readonly movementStarted?: boolean;
  readonly restaurantId?: string;
}

export interface OpenWorkPort {
  /** Every open item the membership holds, as the owning modules report it. */
  openWorkFor(hotelId: string, membershipId: string): Promise<readonly OpenWorkItem[]>;
}

export class OpenWorkUnavailableError extends Error {
  override readonly name = 'OpenWorkUnavailableError';

  constructor(kind: string) {
    super(`the module that owns ${kind} work cannot report it`);
  }
}

/**
 * The Phase 04 answer: no module owns operational work yet, so there is none.
 *
 * Deterministic and complete — not a stub that shrugs. The list of subject kinds
 * with no registered owner is written out so the day a phase lands, the missing
 * registration is a visible omission here rather than a silently empty queue.
 */
export class UnregisteredOpenWork implements OpenWorkPort {
  /** Subject kind → the phase that will register a provider for it. */
  static readonly OWNING_PHASE: Readonly<Record<HandoffSubjectKind, string>> = {
    reception_shift: 'Phase 11',
    cleaner_task: 'Phase 09',
    restaurant_order: 'Phase 15',
  };

  openWorkFor(): Promise<readonly OpenWorkItem[]> {
    return Promise.resolve([]);
  }
}

/**
 * A deterministic simulator for local, CI and test use.
 *
 * A test seeds what the owning module *would* report, so the handoff behaviour
 * can be exercised before Phases 09, 11 and 15 exist — without the request ever
 * being the source.
 */
export class SimulatedOpenWork implements OpenWorkPort {
  private readonly byMembership = new Map<string, readonly OpenWorkItem[]>();
  private readonly failing = new Set<string>();

  private static keyOf(hotelId: string, membershipId: string): string {
    return `${hotelId}:${membershipId}`;
  }

  set(hotelId: string, membershipId: string, items: readonly OpenWorkItem[]): void {
    this.byMembership.set(SimulatedOpenWork.keyOf(hotelId, membershipId), items);
  }

  /** Makes the owning module unreachable, so the fail-closed path is exercised. */
  failFor(hotelId: string, membershipId: string): void {
    this.failing.add(SimulatedOpenWork.keyOf(hotelId, membershipId));
  }

  clear(): void {
    this.byMembership.clear();
    this.failing.clear();
  }

  openWorkFor(hotelId: string, membershipId: string): Promise<readonly OpenWorkItem[]> {
    const key = SimulatedOpenWork.keyOf(hotelId, membershipId);
    if (this.failing.has(key)) return Promise.reject(new OpenWorkUnavailableError('registered'));
    return Promise.resolve(this.byMembership.get(key) ?? []);
  }
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export function selectOpenWork(appEnv: string): OpenWorkPort {
  if (NON_PRODUCTION.has(appEnv)) return new SimulatedOpenWork();
  return new UnregisteredOpenWork();
}
