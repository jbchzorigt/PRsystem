import type { KeyManagementPort } from './key-management.port';
import { KeyManagementError } from './key-management.port';
import { LocalKeyManagement } from './local-key-management';

/**
 * Chooses the key management adapter for an environment, and fails startup
 * rather than degrading (ADR-0020 §8, CLAUDE.md §9).
 *
 * The simulator is unreachable outside local, ci and test — not by convention,
 * but because this is the only place an adapter is selected and it refuses.
 */

export type KmsAdapter = 'local' | 'none' | (string & {});

export interface KeyManagementSelection {
  readonly appEnv: string;
  readonly kmsAdapter: KmsAdapter;
  /** Required by the simulator. Never defaulted — a default would be a key. */
  readonly seed?: string;
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export function selectKeyManagement(selection: KeyManagementSelection): KeyManagementPort {
  const isNonProduction = NON_PRODUCTION.has(selection.appEnv);

  if (selection.kmsAdapter === 'local') {
    if (!isNonProduction) {
      throw new KeyManagementError(
        'the local key management simulator is not permitted outside local, ci or test',
        'not_permitted_in_production',
      );
    }
    if (selection.seed === undefined || selection.seed.length === 0) {
      throw new KeyManagementError(
        'the local key management simulator requires an explicit seed',
        'unavailable',
      );
    }
    return new LocalKeyManagement({ seed: selection.seed, appEnv: selection.appEnv });
  }

  if (selection.kmsAdapter === 'none') {
    throw new KeyManagementError(
      'no approved key management adapter is configured (INT-KMS-01 is not cleared)',
      'unavailable',
    );
  }

  // A named production adapter that does not exist yet. Refusing is the point:
  // the alternative is starting with identifier storage that cannot be encrypted.
  throw new KeyManagementError(
    `key management adapter "${selection.kmsAdapter}" is not implemented; INT-KMS-01 is not cleared`,
    'unavailable',
  );
}
