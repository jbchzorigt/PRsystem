import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { FastifyRequest } from 'fastify';
import { SessionService } from '../services/session.service';
import { newRequestContext } from '../services/iam-context';

/**
 * Pipeline stage 1 at the edge (doc 05 §2).
 *
 * The guard resolves the bearer token into a **server-derived** principal:
 * account state, memberships, active role grants and explicit permission grants
 * all come from the database on every request. Nothing the caller sent
 * contributes to it — a `role`, a `permissions` array or a `hotel_id` in the
 * body is a request target at most (doc 05 §6).
 */

export interface AuthenticatedRequest extends FastifyRequest {
  principal?: Principal;
  sessionId?: string;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new ApiError('UNAUTHENTICATED', 'a session token is required');
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'a session token is required');
    }

    const session = await this.sessions.authenticate(token, newRequestContext());
    request.principal = session.principal;
    request.sessionId = session.sessionId;
    return true;
  }
}

/** The principal a guarded handler is guaranteed to have. */
export function principalOf(request: AuthenticatedRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    // Only reachable if a route were mounted without the guard, which is a
    // wiring defect rather than a request problem.
    throw new ApiError('INTERNAL_ERROR', 'the route is not guarded');
  }
  return principal;
}

export function sessionIdOf(request: AuthenticatedRequest): string {
  const sessionId = request.sessionId;
  if (sessionId === undefined) throw new ApiError('INTERNAL_ERROR', 'the route is not guarded');
  return sessionId;
}
