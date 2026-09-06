import { randomBytes, randomInt } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { RestaurantRepository } from '../repositories/restaurant.repository';
import type { GuestSessionRow } from '../repositories/restaurant.repository';
import { MAX_GUEST_SESSIONS, accessAllowance } from '../domain/restaurant';
import type { CommandActor, RequestContext, RestaurantDependencies } from './restaurant-context';
import {
  RestaurantServiceBase,
  claim,
  isAccessLimitRefusal,
  newRestaurantRequest,
} from './restaurant-context';

/**
 * The guest's way in (doc 08 §7, `RC-DEC-026`, `RC-DEC-027`).
 *
 * Three rules shape it.
 *
 * **A QR is a starting point, never an authorization.** The permanent token in
 * the room identifies the room and nothing else; what creates a session is a
 * one-time code Reception issued for *this* stay, and the two must agree.
 *
 * **Nothing is stored in plaintext.** The QR token, the code and the session
 * token are each hashed under their own key, so a leaked database yields no
 * working QR, no usable code and no session — and the code never reaches a log
 * or an audit payload either (CLAUDE.md §8).
 *
 * **Five is counted by the database.** Active sessions plus valid unused codes
 * share one allowance, and the counter row is locked before either half moves.
 * doc 08 §7 asks explicitly that two codes confirmed at the same instant cannot
 * exceed it, and the `CHECK` is what answers that rather than a count this code
 * took and then trusted.
 */

/** doc 08 §7: four to six digits. Six, so a guess is worth a millionth. */
const CODE_DIGITS = 6;
/** Long enough that guessing a session token is not a strategy. */
const SESSION_TOKEN_BYTES = 32;
const CODE_TTL_MINUTES = 60;
const SESSION_TTL_HOURS = 12;
/** doc 08 §7: wrong codes are throttled, and Reception issues a fresh one. */
const MAX_CODE_ATTEMPTS = 5;

const RECEPTION_CODE = 'hotel.stay.check_in';

export interface IssuedCode {
  readonly codeId: string;
  /** The plaintext, returned **once**, to be read to the guest and forgotten. */
  readonly code: string;
  readonly expiresAt: Date;
  readonly remainingAllowance: number;
}

export interface OpenedSession {
  readonly guestSessionId: string;
  /** The bearer token, returned once. Only its hash is stored. */
  readonly token: string;
  readonly hotelId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly expiresAt: Date;
}

export class GuestAccessService extends RestaurantServiceBase {
  constructor(deps: RestaurantDependencies) {
    super(deps);
  }

  /**
   * The room's permanent QR, and its replacement.
   *
   * doc 08 §7: a QR believed lost is *replaced*, and the old one is void the
   * instant the new one exists — which is why the resolver only ever answers
   * for a live token.
   */
  async issueRoomToken(
    input: { hotelId: string; roomId: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ token: string; version: number }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      'hotel.catalog.room_manage',
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.room_qr', input.idempotencyKey, {
          roomId: input.roomId,
        });
        if (claimed.kind === 'replay') return claimed.body as { token: string; version: number };
        await authorize();
        const repository = new RestaurantRepository(uow);
        const now = this.now(uow);
        const previous = await repository.rotateRoomToken(input.roomId, now);
        const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
        await repository.issueRoomToken({
          hotelId: input.hotelId,
          roomId: input.roomId,
          tokenHash: await this.digest('auth.room_qr_token', token),
          version: previous + 1,
        });
        // A rotation voids every code and session that reached the room through
        // the old QR (doc 08 §7).
        if (previous > 0) {
          const stay = await this.deps.stays.activeStayInRoom(uow, input.roomId);
          if (stay !== undefined) {
            await this.closeAll(uow, stay.stayId, now, 'the room QR was replaced');
          }
        }
        await recordPlatformAudit(uow, {
          action: 'restaurant.room_qr_issued',
          outcome: 'allowed',
          targetType: 'room',
          targetRef: input.roomId,
          // The token itself is never recorded — only that one was issued.
          payload: { version: previous + 1, rotated: previous > 0 },
        });
        const issued = { token, version: previous + 1 };
        await this.completeClaim(uow, claimed, 201, issued);
        void gate;
        return issued;
      },
    );
  }

  /**
   * `RC-DEC-027`: Reception issues one device's code, inside the allowance.
   *
   * The counter is locked first, and the `CHECK` refuses the sixth — so two
   * Receptionists issuing at the same instant produce one code and one refusal,
   * not two codes.
   */
  async issueGuestCode(
    input: { hotelId: string; stayId: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<IssuedCode> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RECEPTION_CODE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.guest_code', input.idempotencyKey, {
          stayId: input.stayId,
        });
        if (claimed.kind === 'replay') return claimed.body as IssuedCode;
        await authorize();
        const repository = new RestaurantRepository(uow);
        const stay = await this.deps.stays.byId(uow, input.stayId);
        if (stay === undefined) throw new ApiError('NOT_FOUND', 'no such stay');
        if (stay.state === 'COMPLETED') {
          throw new ApiError('CONFLICT', 'that stay has ended');
        }
        const counter = await repository.lockAccessCounter({
          hotelId: input.hotelId,
          stayId: stay.stayId,
          roomId: stay.roomId,
        });
        if (accessAllowance(counter.activeSessions, counter.pendingCodes) <= 0) {
          throw new ApiError(
            'CONFLICT',
            `GUEST_ACCESS_LIMIT: a stay holds at most ${String(MAX_GUEST_SESSIONS)} devices; ` +
              'revoke one before issuing another',
          );
        }
        const now = this.now(uow);
        const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
        const created = await repository.createCode({
          hotelId: input.hotelId,
          stayId: stay.stayId,
          roomId: stay.roomId,
          codeHash: await this.codeDigest(stay.stayId, code),
          keyVersion: await this.deps.keys.currentVersion('pii.hotel_guest'),
          expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000),
          issuedByAccountId: gate.principal.accountId,
        });
        const counted = await this.applyCounts(uow, counter.stayId, counter.revision, {
          activeSessions: counter.activeSessions,
          pendingCodes: counter.pendingCodes + 1,
        });
        if (!counted) throw new ApiError('CONFLICT', 'the guest access changed under this command');
        await recordPlatformAudit(uow, {
          action: 'restaurant.guest_code_issued',
          outcome: 'allowed',
          targetType: 'stay',
          targetRef: stay.stayId,
          // doc 08 §7: the act is audited and the code is not.
          payload: { codeId: created.codeId, expiresAt: created.expiresAt.toISOString() },
        });
        const issued: IssuedCode = {
          codeId: created.codeId,
          code,
          expiresAt: created.expiresAt,
          remainingAllowance: accessAllowance(counter.activeSessions, counter.pendingCodes + 1),
        };
        await this.completeClaim(uow, claimed, 201, {
          ...issued,
          // The replayed body carries no code: an idempotency replay is not a
          // second chance to read a one-time secret.
          code: '',
        });
        return issued;
      },
    );
  }

  /**
   * doc 08 §7: the QR, then the code, then a session — and never the QR alone.
   *
   * The hotel and room come from the token through a `SECURITY DEFINER`
   * resolver, because a guest presents no tenant. The stay comes from the room.
   * The request names none of the three.
   */
  async openSession(
    input: { roomToken: string; code: string },
    request: RequestContext = newRestaurantRequest(),
  ): Promise<OpenedSession> {
    const located = await this.roomOfToken(input.roomToken);
    // A wrong QR, a rotated one and one that never existed are the same answer.
    if (located === undefined) throw new ApiError('UNAUTHENTICATED', 'that code did not work');

    return this.inRedemptionScope(located.hotelId, request, async (uow) => {
      const repository = new RestaurantRepository(uow);
      const stay = await this.deps.stays.activeStayInRoom(uow, located.roomId);
      // Nothing about the room is disclosed before the code is right: whether
      // it is occupied, by whom, or for how long (doc 08 §7).
      if (stay === undefined) throw new ApiError('UNAUTHENTICATED', 'that code did not work');

      const digest = await this.codeDigest(stay.stayId, input.code);
      const found = await repository.lockCodeByHash(located.roomId, digest);
      if (found === undefined) {
        await this.throttle(uow, located.roomId, stay.stayId);
        throw new ApiError('UNAUTHENTICATED', 'that code did not work');
      }
      const now = this.now(uow);
      if (found.expiresAt.getTime() <= now.getTime()) {
        await repository.settleCode({
          codeId: found.codeId,
          expectedRevision: found.revision,
          state: 'EXPIRED',
          at: now,
        });
        await this.releasePending(uow, stay.stayId);
        throw new ApiError('UNAUTHENTICATED', 'that code did not work');
      }
      if (found.attempts >= MAX_CODE_ATTEMPTS) {
        throw new ApiError('CONFLICT', 'TOO_MANY_ATTEMPTS: ask Reception for a new code');
      }

      // The allowance again, at the moment the session is created: doc 08 §7
      // requires it checked at *both* ends, so two codes confirmed together
      // cannot overshoot.
      const counter = await repository.lockAccessCounter({
        hotelId: located.hotelId,
        stayId: stay.stayId,
        roomId: stay.roomId,
      });
      const spent = await repository.settleCode({
        codeId: found.codeId,
        expectedRevision: found.revision,
        state: 'USED',
        at: now,
      });
      if (!spent) throw new ApiError('CONFLICT', 'that code was already used');

      const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
      let session: GuestSessionRow;
      try {
        session = await repository.createSession({
          hotelId: located.hotelId,
          stayId: stay.stayId,
          roomId: stay.roomId,
          tokenHash: await this.digest('auth.restaurant_guest_session', token),
          codeId: found.codeId,
          expiresAt: new Date(now.getTime() + SESSION_TTL_HOURS * 3_600_000),
        });
      } catch (error) {
        if (isAccessLimitRefusal(error)) {
          throw new ApiError('CONFLICT', 'GUEST_ACCESS_LIMIT: this stay already has five devices');
        }
        throw error;
      }
      // The code stops counting against the allowance and the session starts:
      // the pair moves together, under the counter's own lock, and the CHECK is
      // what refuses a sixth.
      const moved = await this.applyCounts(uow, counter.stayId, counter.revision, {
        activeSessions: counter.activeSessions + 1,
        pendingCodes: Math.max(0, counter.pendingCodes - 1),
      });
      if (!moved) throw new ApiError('CONFLICT', 'the guest access changed under this command');

      await recordPlatformAudit(uow, {
        action: 'restaurant.guest_session_opened',
        outcome: 'allowed',
        targetType: 'stay',
        targetRef: stay.stayId,
        payload: { guestSessionId: session.guestSessionId },
      });
      return {
        guestSessionId: session.guestSessionId,
        token,
        hotelId: located.hotelId,
        stayId: stay.stayId,
        roomId: stay.roomId,
        expiresAt: session.expiresAt,
      };
    });
  }

  /** The session a bearer token names, or nothing. Never a hint of which. */
  async resolveSession(token: string): Promise<GuestSessionRow | undefined> {
    const digest = await this.digest('auth.restaurant_guest_session', token);
    // A guest names no tenant, so the hotel is resolved through the narrow
    // `SECURITY DEFINER` function rather than by reading the table unscoped —
    // which RLS would refuse anyway, and rightly.
    const rows = await this.deps.pool.query<{ hotel_id: string }>(
      `SELECT hotel_id FROM platform.hotel_of_guest_session($1)`,
      [digest],
    );
    const hotelId = rows.rows[0]?.hotel_id;
    if (hotelId === undefined) return undefined;
    // Re-read inside the tenant scope so every policy that governs the row is
    // in force, rather than trusting the unscoped lookup above.
    const found = await this.inRedemptionScope(hotelId, newRestaurantRequest(), async (uow) =>
      new RestaurantRepository(uow).sessionByToken(digest),
    );
    if (found === undefined || found.state !== 'ACTIVE') return undefined;
    if (found.expiresAt.getTime() <= this.wallClock().getTime()) return undefined;
    return found;
  }

  /** doc 08 §7: Reception closes one device, or every device of a stay. */
  async revoke(
    input: { hotelId: string; stayId: string; guestSessionId?: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ closed: number }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RECEPTION_CODE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.guest_revoke', input.idempotencyKey, {
          stayId: input.stayId,
          guestSessionId: input.guestSessionId ?? 'all',
        });
        if (claimed.kind === 'replay') return claimed.body as { closed: number };
        await authorize();
        const closed = await this.closeSessions(
          uow,
          input.stayId,
          this.now(uow),
          'revoked by Reception',
          input.guestSessionId,
        );
        await recordPlatformAudit(uow, {
          action: 'restaurant.guest_session_revoked',
          outcome: 'allowed',
          targetType: 'stay',
          targetRef: input.stayId,
          payload: { closed, scope: input.guestSessionId === undefined ? 'stay' : 'device' },
        });
        const result = { closed };
        await this.completeClaim(uow, claimed, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 08 §7: the checkout closes everything.
   *
   * Called from the checkout's own transaction, so a stay that has ended cannot
   * still be ordering from the room somebody else is about to occupy.
   */
  async closeAll(uow: UnitOfWork, stayId: string, at: Date, reason: string): Promise<number> {
    return this.closeSessions(uow, stayId, at, reason);
  }

  private async closeSessions(
    uow: UnitOfWork,
    stayId: string,
    at: Date,
    reason: string,
    guestSessionId?: string,
  ): Promise<number> {
    const repository = new RestaurantRepository(uow);
    const closed = await repository.revokeSessions({
      stayId,
      at,
      reason,
      ...(guestSessionId === undefined ? {} : { guestSessionId }),
    });
    const codes =
      guestSessionId === undefined ? await repository.revokePendingCodes(stayId, at) : 0;
    const stay = await this.deps.stays.byId(uow, stayId);
    if (stay !== undefined) {
      const counter = await repository.lockAccessCounter({
        hotelId: stay.hotelId,
        stayId,
        roomId: stay.roomId,
      });
      await this.applyCounts(uow, counter.stayId, counter.revision, {
        activeSessions: Math.max(0, counter.activeSessions - closed),
        pendingCodes: Math.max(0, counter.pendingCodes - codes),
      });
    }
    return closed;
  }

  private async releasePending(uow: UnitOfWork, stayId: string): Promise<void> {
    const repository = new RestaurantRepository(uow);
    const stay = await this.deps.stays.byId(uow, stayId);
    if (stay === undefined) return;
    const counter = await repository.lockAccessCounter({
      hotelId: stay.hotelId,
      stayId,
      roomId: stay.roomId,
    });
    await this.applyCounts(uow, counter.stayId, counter.revision, {
      activeSessions: counter.activeSessions,
      pendingCodes: Math.max(0, counter.pendingCodes - 1),
    });
  }

  private async applyCounts(
    uow: UnitOfWork,
    stayId: string,
    expectedRevision: number,
    counts: { activeSessions: number; pendingCodes: number },
  ): Promise<boolean> {
    try {
      return await new RestaurantRepository(uow).setAccessCounts({
        stayId,
        expectedRevision,
        ...counts,
      });
    } catch (error) {
      if (isAccessLimitRefusal(error)) {
        throw new ApiError('CONFLICT', 'GUEST_ACCESS_LIMIT: this stay already has five devices');
      }
      throw error;
    }
  }

  /**
   * A wrong guess costs an attempt on whichever code is still open.
   *
   * doc 08 §7 asks for throttling without disclosure, so this records the cost
   * and the caller answers the same way it answers every other failure.
   */
  private async throttle(uow: UnitOfWork, roomId: string, stayId: string): Promise<void> {
    const result = await uow.query<{ code_id: string; revision: number }>(
      `SELECT code_id, revision FROM platform.guest_access_code
        WHERE room_id = $1 AND stay_id = $2 AND state = 'PENDING'
        ORDER BY issued_at DESC LIMIT 1 FOR UPDATE`,
      [roomId, stayId],
    );
    const row = result.rows[0];
    if (row === undefined) return;
    await new RestaurantRepository(uow).countWrongGuess(row.code_id, Number(row.revision));
  }

  private async roomOfToken(
    token: string,
  ): Promise<{ hotelId: string; roomId: string } | undefined> {
    const digest = await this.digest('auth.room_qr_token', token);
    const rows = await this.deps.pool.query<{ hotel_id: string; room_id: string }>(
      `SELECT hotel_id, room_id FROM platform.room_of_access_token($1)`,
      [digest],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : { hotelId: row.hotel_id, roomId: row.room_id };
  }

  /** The code is salted with the stay, so the same digits differ per stay. */
  private codeDigest(stayId: string, code: string): Promise<string> {
    return this.digest('auth.guest_access_code', `${stayId}:${code}`);
  }

  private async digest(
    scope: 'auth.room_qr_token' | 'auth.guest_access_code' | 'auth.restaurant_guest_session',
    value: string,
  ): Promise<string> {
    const mac = await this.deps.keys.hmac(scope, Buffer.from(value, 'utf8'));
    return Buffer.from(mac.mac).toString('hex').slice(0, 64);
  }

  private async completeClaim(
    uow: UnitOfWork,
    claimed: { kind: 'claimed'; idempotencyId: string } | { kind: 'replay'; body: unknown },
    status: number,
    body: unknown,
  ): Promise<void> {
    if (claimed.kind !== 'claimed') return;
    await completeIdempotencyKey(uow, claimed.idempotencyId, status, body);
  }
}
