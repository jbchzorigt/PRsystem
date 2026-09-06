import type { UnitOfWork } from '@prsystem/db';
import type {
  FinancialWindow,
  MinibarFactsPort,
  MinibarSaleRow,
} from '../../reporting/contracts/financial-facts';

/**
 * What the minibar sold, and what it cost (doc 23 §3.1, `FIN-DEC-003`).
 *
 * Two snapshots, from two different moments, and neither is ever re-resolved.
 *
 * **The selling price** comes from the report line, which took it from the
 * stay's check-in price book (doc 25). A later product-price edit does not
 * reprice a sale that already happened.
 *
 * **The cost** comes from the `GUEST_CONSUMPTION` inventory movement, which
 * snapshotted the hotel's weighted average when the stock actually moved
 * (doc 22 §4). A line whose movement carries no cost — a sale from before that
 * snapshot existed — reports a `null` unit cost and a COGS of zero rather than
 * being valued at today's average, because valuing it at today's average is
 * precisely the retrospective repricing doc 23 §12 forbids.
 */

function bigintOf(value: unknown): bigint {
  return BigInt(String(value ?? '0'));
}

export class RepositoryMinibarReads implements MinibarFactsPort {
  async sales(
    uow: UnitOfWork,
    window: FinancialWindow,
    cap: number,
  ): Promise<readonly MinibarSaleRow[]> {
    const rows = await uow.query<Record<string, unknown>>(
      `SELECT l.stay_id, r.room_number, l.product_id, l.product_name,
              l.billable_quantity, l.unit_price_mnt, l.line_total_mnt,
              v.created_at AS recognized_at,
              COALESCE(f.state, 'NONE') AS payment_status,
              -- FIN-DEC-003: the weighted average snapshotted on the movement
              -- that took the stock out of the room for this stay and product.
              (SELECT m.unit_cost_mnt
                 FROM platform.inventory_movement m
                WHERE m.hotel_id = l.hotel_id
                  AND m.stay_id = l.stay_id
                  AND m.product_id = l.product_id
                  AND m.movement_type = 'GUEST_CONSUMPTION'
                ORDER BY m.occurred_at DESC LIMIT 1) AS unit_cost_mnt
         FROM platform.minibar_usage_report_line l
         JOIN platform.minibar_usage_report_version v
           ON v.hotel_id = l.hotel_id AND v.version_id = l.version_id
         JOIN platform.stay s ON s.hotel_id = l.hotel_id AND s.stay_id = l.stay_id
         JOIN platform.room r ON r.hotel_id = s.hotel_id AND r.room_id = s.room_id
         LEFT JOIN platform.stay_folio f ON f.hotel_id = l.hotel_id AND f.stay_id = l.stay_id
        WHERE l.hotel_id = $1::uuid
          AND l.billable_quantity > 0
          AND v.created_at >= $2::timestamptz AND v.created_at < $3::timestamptz
        ORDER BY v.created_at, l.line_id
        LIMIT $4`,
      [window.hotelId, window.from, window.to, cap + 1],
    );
    return rows.rows.map((row) => {
      const quantity = Number(row['billable_quantity']);
      const gross = bigintOf(row['line_total_mnt']);
      const rawCost = row['unit_cost_mnt'];
      const unitCostMnt = rawCost === null || rawCost === undefined ? null : bigintOf(rawCost);
      return {
        stayId: String(row['stay_id']),
        roomNumber: String(row['room_number']),
        productId: String(row['product_id']),
        productName: String(row['product_name']),
        quantity,
        sellingUnitPriceMnt: bigintOf(row['unit_price_mnt']),
        grossSalesMnt: gross,
        discountMnt: 0n,
        netSalesMnt: gross,
        unitCostMnt,
        cogsMnt: unitCostMnt === null ? 0n : unitCostMnt * BigInt(quantity),
        recognizedAt: row['recognized_at'] as Date,
        paymentStatus: String(row['payment_status']),
      };
    });
  }
}
