import { recordPoliceAudit } from '@prsystem/db';
import type { DashboardCounts, MatchOutcome } from '../domain/police';
import { countsFrom } from '../domain/police';
import type { CommandActor, PoliceDependencies, RequestContext } from './police-context';
import { ANALYTICS_AUDIT, DASHBOARD_BASIC, PoliceServiceBase } from './police-context';

/**
 * The Police dashboard (doc 13 §11, `POL-DEC-003`, `POL-DEC-005`).
 *
 * The counters are open to both Police columns; the two charts are the Admin's
 * alone, and they are deliberately two charts. doc 13 §11.2 keeps the wanted
 * people, grouped by the district of their *home address*, apart from the
 * matches, grouped by the district of the *hotel* — the same word for two
 * different questions, and merging them would answer neither.
 */

export interface DistrictSlice {
  readonly district: string;
  readonly count: number;
}

export interface PoliceCharts {
  /** Found people by crime category (doc 13 §11.2). */
  readonly foundByCategory: readonly { readonly category: string; readonly count: number }[];
  /** Matches by the district of the hotel they happened in. */
  readonly matchesByHotelDistrict: readonly DistrictSlice[];
  /** Actively wanted people by the district of their last approved address. */
  readonly wantedByHomeDistrict: readonly DistrictSlice[];
}

export class PoliceDashboardService extends PoliceServiceBase {
  constructor(deps: PoliceDependencies) {
    super(deps);
  }

  /** doc 13 §11.1: seven numbers, and never two of them merged. */
  async counts(
    window: { from: Date; to: Date },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<DashboardCounts> {
    return this.runPoliceCommand(actor, DASHBOARD_BASIC, request, async (uow, authorize) => {
      await authorize();
      const people = await uow.query<{ people: string; cases: string }>(
        `SELECT count(DISTINCT c.person_id)::text AS people, count(*)::text AS cases
           FROM police.wanted_case c WHERE c.state = 'ACTIVE'`,
      );
      const matches = await uow.query<{ person_id: string; outcome: MatchOutcome }>(
        `SELECT wanted_person_id AS person_id, outcome FROM police.police_match
          WHERE detected_at >= $1 AND detected_at < $2`,
        [window.from, window.to],
      );
      const open = await uow.query<{ open: string }>(
        `SELECT count(*)::text AS open FROM police.police_match
          WHERE workflow_state <> 'RESOLVED'`,
      );
      return countsFrom({
        activeWantedPeople: Number(people.rows[0]?.people ?? '0'),
        activeCases: Number(people.rows[0]?.cases ?? '0'),
        openMatches: Number(open.rows[0]?.open ?? '0'),
        matches: matches.rows.map((row) => ({ personId: row.person_id, outcome: row.outcome })),
      });
    });
  }

  /** doc 13 §11.2: the Admin's charts, and the access audit that comes with them. */
  async charts(
    window: { from: Date; to: Date },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<PoliceCharts> {
    return this.runPoliceCommand(actor, ANALYTICS_AUDIT, request, async (uow, authorize) => {
      await authorize();
      const byCategory = await uow.query<{ category: string; count: string }>(
        `SELECT c.crime_category AS category, count(DISTINCT m.match_id)::text AS count
           FROM police.police_match m
           JOIN police.match_case_link l ON l.match_id = m.match_id
           JOIN police.wanted_case c ON c.case_id = l.case_id
          WHERE m.outcome = 'FOUND' AND m.detected_at >= $1 AND m.detected_at < $2
          GROUP BY c.crime_category ORDER BY 2 DESC, 1`,
        [window.from, window.to],
      );
      const byHotelDistrict = await uow.query<{ district: string; count: string }>(
        `SELECT hotel_district AS district, count(*)::text AS count
           FROM police.police_match
          WHERE detected_at >= $1 AND detected_at < $2 AND outcome <> 'FALSE_MATCH'
          GROUP BY 1 ORDER BY 2 DESC, 1`,
        [window.from, window.to],
      );
      // The other axis entirely: where the wanted person lives, not where a
      // match happened. An address with no district is its own bucket rather
      // than being folded into somebody else's.
      const byHomeDistrict = await uow.query<{ district: string; count: string }>(
        `SELECT coalesce(r.home_district, 'Тодорхойгүй') AS district,
                count(DISTINCT r.person_id)::text AS count
           FROM police.wanted_identity_revision r
          WHERE r.is_current
            AND EXISTS (SELECT 1 FROM police.wanted_case c
                         WHERE c.person_id = r.person_id AND c.state = 'ACTIVE')
          GROUP BY 1 ORDER BY 2 DESC, 1`,
      );
      await recordPoliceAudit(uow, {
        action: 'police.dashboard.charts_read',
        outcome: 'allowed',
        payload: { device: request.deviceRef ?? null },
      });
      return {
        foundByCategory: byCategory.rows.map((row) => ({
          category: row.category,
          count: Number(row.count),
        })),
        matchesByHotelDistrict: byHotelDistrict.rows.map((row) => ({
          district: row.district,
          count: Number(row.count),
        })),
        wantedByHomeDistrict: byHomeDistrict.rows.map((row) => ({
          district: row.district,
          count: Number(row.count),
        })),
      };
    });
  }
}
