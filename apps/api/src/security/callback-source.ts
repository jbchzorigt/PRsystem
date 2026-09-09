import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { CanActivate, DynamicModule, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '@prsystem/contracts';
import type { CallbackAllowlists } from '@prsystem/config';
import { isAllowedSource, isNonProductionEnv, isPaymentProvider } from '@prsystem/ports';
import type { Cidr, PaymentProvider } from '@prsystem/ports';

/**
 * Provider callback source allowlisting (Phase 20; doc 14 §5.6's "IP
 * allowlist" and build plan Phase 20).
 *
 * A callback is authenticated by its signature, deduplicated, and confirmed by
 * a status query before it is believed — none of that changes here. What this
 * adds is a gate *before* the body is read: a request that does not come from
 * one of the ranges the provider's contract names is answered as if the route
 * did not exist. The ranges are configuration (`CALLBACK_ALLOWLIST_<PROVIDER>`),
 * and no contract has supplied any, so:
 *
 *  - at and above staging, a provider with no configured allowlist has every
 *    callback refused — the same fail-closed stance as the adapter's own
 *    `DISABLED`, one layer earlier;
 *  - below staging, no configured allowlist means "allow", so the simulator
 *    can call in from the loopback; a configured one is enforced there too, so
 *    the guard is tested against the same code path production runs.
 *
 * The source address is Fastify's `request.ip`, which is the socket peer unless
 * a trusted-proxy setting says otherwise; that setting is a deployment matter
 * and is deliberately not defaulted here.
 */

export interface CallbackSourcePolicy {
  /** Whether a callback claiming to be from `provider` may proceed from `sourceIp`. */
  permits(provider: PaymentProvider, sourceIp: string): boolean;
  /** One line per provider, safe to log: whether a list exists and how long it is. */
  describe(): readonly { provider: PaymentProvider; configured: boolean; ranges: number }[];
}

export const CALLBACK_SOURCE_POLICY = Symbol('CALLBACK_SOURCE_POLICY');

const PROVIDERS: readonly PaymentProvider[] = ['QPAY', 'KHAAN'];

export function callbackSourcePolicy(
  appEnv: string,
  allowlists: CallbackAllowlists,
): CallbackSourcePolicy {
  const lists = new Map<PaymentProvider, readonly Cidr[] | undefined>([
    ['QPAY', allowlists.QPAY],
    ['KHAAN', allowlists.KHAAN],
  ]);
  const permissiveWhenAbsent = isNonProductionEnv(appEnv);
  return {
    permits(provider, sourceIp) {
      const list = lists.get(provider);
      if (list === undefined) return permissiveWhenAbsent;
      return isAllowedSource(sourceIp, list);
    },
    describe() {
      return PROVIDERS.map((provider) => {
        const list = lists.get(provider);
        return { provider, configured: list !== undefined, ranges: list?.length ?? 0 };
      });
    },
  };
}

/** The policy a construction site gets when it names none: refuse every source. */
export function refuseAllCallbackSources(): CallbackSourcePolicy {
  return {
    permits: () => false,
    describe: () => PROVIDERS.map((provider) => ({ provider, configured: false, ranges: 0 })),
  };
}

@Injectable()
export class CallbackSourceGuard implements CanActivate {
  constructor(@Inject(CALLBACK_SOURCE_POLICY) private readonly policy: CallbackSourcePolicy) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const params = request.params as Record<string, unknown> | undefined;
    const providerParam = typeof params?.['provider'] === 'string' ? params['provider'] : '';
    const provider = providerParam.toUpperCase();
    // An unknown provider is the controller's refusal to make, with its own
    // message; the guard decides only about sources of providers it knows.
    if (!isPaymentProvider(provider)) return true;
    if (!this.policy.permits(provider, request.ip)) {
      // Opaque, the way every other denial on this API is: a source the
      // contract does not name learns that the route is not there for it.
      throw new ApiError('NOT_FOUND', 'not found');
    }
    return true;
  }
}

/**
 * Makes the policy injectable everywhere the guard is used. A construction site
 * that supplies none gets the refusing policy, so a callback route can never
 * become reachable by omission.
 */
@Global()
@Module({})
export class CallbackSourceModule {
  static forRoot(policy: CallbackSourcePolicy | undefined): DynamicModule {
    return {
      module: CallbackSourceModule,
      providers: [
        { provide: CALLBACK_SOURCE_POLICY, useValue: policy ?? refuseAllCallbackSources() },
      ],
      exports: [CALLBACK_SOURCE_POLICY],
    };
  }
}
