import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '@prsystem/contracts';
import type { FastifyRequest } from 'fastify';
import type { GuestSessionRow } from '../repositories/restaurant.repository';
import { GuestAccessService } from '../services/guest-access.service';

/**
 * The room guest's authentication (doc 08 §7).
 *
 * A restaurant guest is **not an account**. They are whoever holds the room's
 * QR and a one-time code Reception read to them, and what they carry afterwards
 * is a session token that names a stay. So this is deliberately not the IAM
 * `SessionGuard`, and it deliberately does not read `Authorization`: a room
 * session must never be mistakable for a Guest-realm account session, and a
 * Guest-realm account token must never open a room session (CLAUDE.md §4).
 *
 * Everything a command needs about the caller — hotel, stay, room — comes from
 * the resolved session and from nothing the request said.
 */

export const RESTAURANT_SESSION_HEADER = 'x-restaurant-session';

export interface GuestSessionRequest extends FastifyRequest {
  guestSession?: GuestSessionRow;
}

@Injectable()
export class RestaurantGuestGuard implements CanActivate {
  constructor(@Inject(GuestAccessService) private readonly access: GuestAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuestSessionRequest>();
    const header = request.headers[RESTAURANT_SESSION_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'a room session is required');
    }
    // Expired, revoked, unknown and closed all answer the same thing.
    const session = await this.access.resolveSession(token.trim());
    if (session === undefined) {
      throw new ApiError('UNAUTHENTICATED', 'a room session is required');
    }
    request.guestSession = session;
    return true;
  }
}

/** The session a guarded handler is guaranteed to have. */
export function guestSessionOf(request: GuestSessionRequest): GuestSessionRow {
  const session = request.guestSession;
  if (session === undefined) {
    throw new ApiError('INTERNAL_ERROR', 'the route is not guarded');
  }
  return session;
}
