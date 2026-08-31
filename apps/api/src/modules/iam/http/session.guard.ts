import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { FastifyRequest } from 'fastify';
import { SessionService } from '../services/session.service';
import type { CommandActor } from '../services/iam-context';
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

async function resolveBearer(
  sessions: SessionService,
  request: AuthenticatedRequest,
): Promise<boolean> {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) return false;

  const session = await sessions.authenticate(token, newRequestContext());
  request.principal = session.principal;
  request.sessionId = session.sessionId;
  return true;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!(await resolveBearer(this.sessions, request))) {
      throw new ApiError('UNAUTHENTICATED', 'a session token is required');
    }
    return true;
  }
}

/**
 * Authentication for a route that serves both a stranger and a member.
 *
 * Invitation acceptance is the one flow with two legitimate callers: someone
 * with no account yet, who has only the one-time link, and someone who already
 * has one and must accept *as themselves* (doc 19 §5). A route that simply read
 * `request.principal` without a guard would never see the second — nothing would
 * ever populate it — so the existing-account path was unreachable in practice.
 *
 * A **present** bearer is always verified: an invalid one is refused rather than
 * quietly downgraded to the anonymous path, which would let a caller with a
 * revoked session accept as a new account.
 */
@Injectable()
export class OptionalSessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await resolveBearer(this.sessions, request);
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

/**
 * The actor a command runs as: the principal *and* the session it came from.
 *
 * Both, always. Authority inside a hotel is the session's scope grant, so a
 * command that received only the principal could not tell a live device from one
 * whose access was revoked a moment ago (doc 19 §10).
 */
export function actorOf(request: AuthenticatedRequest): CommandActor {
  return { principal: principalOf(request), sessionId: sessionIdOf(request) };
}
