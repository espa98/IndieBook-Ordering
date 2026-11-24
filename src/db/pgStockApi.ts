import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import { AppError } from "../errors/AppError";
import type { StockReservationDelivery } from "../inventory/deliverStockReservation";
import type { StockMovement } from "../inventory/registerInitialStock";
import type { StockReservationRelease } from "../inventory/releaseStockReservation";
import type { ReserveStockRequest, StockReservationRecord } from "../inventory/reserveStock";
import type { SourcingAllocation } from "../procurement/allocateSourcing";
import {
  inTransaction,
  isCommandKeyConflict,
  loadCommands,
  loadMembership,
  loadOrders,
  principalFor,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";

type Actor = { userId: string };

/** 호출자가 보내는 예약 요청. 예약자(`reservedBy`)는 인증된 사용자에서 주입되므로 보낼 필요가 없다 */
export type ReserveStockBody = Omit<ReserveStockRequest, "reservedBy">;

const iso = (value: Date) => value.toISOString();

export async function loadBookLedger(client: PoolClient, tenantId: string, bookKey: string) {
  const movements = (
    await client.query(
      "select * from public.ordering_stock_movements where tenant_id = $1 and book_key = $2 order by recorded_at, id",
      [tenantId, bookKey],
    )
  ).rows.map(
    (m): StockMovement => ({
      id: m.id,
      tenantId: m.tenant_id,
      bookId: m.book_key,
      kind: m.kind,
      direction: m.direction,
      quantity: m.quantity,
      reason: m.reason,
      ...(m.reservation_id === null ? {} : { reservationId: m.reservation_id }),
      ...(m.cancellation_id === null ? {} : { cancellationId: m.cancellation_id }),
      actedBy: m.acted_by,
      actedAt: iso(m.acted_at),
      recordedAt: iso(m.recorded_at),
    }),
  );
  const reservations = (
    await client.query("select * from public.ordering_stock_reservations where tenant_id = $1 and book_key = $2 order by recorded_at, id", [tenantId, bookKey])
  ).rows.map(
    (r): StockReservationRecord => ({
      id: r.id,
      tenantId: r.tenant_id,
      bookId: r.book_key,
      orderId: r.order_id,
      orderLineId: r.order_line_id,
      quantity: r.quantity,
      reservedBy: r.reserved_by,
      reservedAt: iso(r.reserved_at),
      recordedAt: iso(r.recorded_at),
    }),
  );
  const ids = reservations.map((r) => r.id);
  const releases = (
    await client.query("select * from public.ordering_stock_reservation_releases where tenant_id = $1 and reservation_id = any($2::uuid[])", [tenantId, ids])
  ).rows.map(
    (r): StockReservationRelease => ({
      id: r.id,
      tenantId: r.tenant_id,
      bookId: bookKey,
      reservationId: r.reservation_id,
      quantity: r.quantity,
      reason: r.reason,
      releasedBy: r.released_by,
      releasedAt: iso(r.released_at),
      recordedAt: iso(r.recorded_at),
    }),
  );
  const deliveries = (
    await client.query("select * from public.ordering_stock_reservation_deliveries where tenant_id = $1 and reservation_id = any($2::uuid[])", [tenantId, ids])
  ).rows.map(
    (d): StockReservationDelivery => ({
      id: d.id,
      tenantId: d.tenant_id,
      bookId: bookKey,
      reservationId: d.reservation_id,
      quantity: d.quantity,
      deliveredBy: d.delivered_by,
      deliveredAt: iso(d.delivered_at),
      recordedAt: iso(d.recorded_at),
    }),
  );
  return { movements, reservations, releases, deliveries };
}

async function loadAllocations(client: PoolClient, tenantId: string, orderId: string): Promise<SourcingAllocation[]> {
  return (
    await client.query("select * from public.ordering_sourcing_allocations where tenant_id = $1 and order_id = $2", [tenantId, orderId])
  ).rows.map(
    (a): SourcingAllocation => ({
      id: a.id,
      tenantId: a.tenant_id,
      orderId: a.order_id,
      lineId: a.order_line_id,
      supplierCode: a.supplier_code,
      quantity: a.quantity,
      status: a.status,
    }),
  );
}

/**
 * 재고 예약을 Postgres 영속화 위에서 실행한다 (E7 권고안 a). 책 단위 경합(마지막 1권)은 (서점, 책)
 * 트랜잭션 어드바이저리 락으로 직렬화하고, 같은 락을 DB 트리거도 잡아 어댑터를 거치지 않는 쓰기도 막는다.
 * 쓰기는 `service_role`, 권한은 `authorizedActions`(인증된 사용자에서 예약자를 주입)가 책임진다.
 */
export function createPgStockApi(deps: { pool: PoolLike }) {
  async function reserveOnce(actor: Actor, request: ReserveStockBody): Promise<StockReservationRecord> {
    return inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      // 권한을 먼저 판단한다. 인증 없음·비멤버·비활성은 어떤 조회·저장도 하기 전에 거부된다
      const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);

      const [order] = await loadOrders(client, request.tenantId, { orderId: request.orderId, lock: "share" });
      const line = order?.lines.find((l) => l.lineId === request.orderLineId);

      let ledger = { movements: [] as StockMovement[], reservations: [] as StockReservationRecord[], releases: [] as StockReservationRelease[], deliveries: [] as StockReservationDelivery[] };
      let allocations: SourcingAllocation[] = [];
      if (order && line) {
        // 같은 책의 예약을 직렬화한다. 락을 잡은 뒤에 원장을 읽어야 먼저 커밋된 예약이 보인다
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${order.tenantId}:${line.bookId}`]);
        ledger = await loadBookLedger(client, order.tenantId, line.bookId);
        allocations = await loadAllocations(client, order.tenantId, order.id);
      }

      // 멱등 기록은 락을 잡은 뒤에 읽는다. 같은 키로 먼저 커밋된 요청의 결과를 봐야 재생으로 처리된다
      const idempotency = await loadCommands(client, request.tenantId, request.idempotencyKey);
      const knownCommands = new Set(idempotency.keys());

      const saved: StockReservationRecord[] = [];
      const forbidden = () => {
        throw new Error("this command must not write this ledger");
      };
      const { tenantId: _tenantId, ...rest } = request;
      void _tenantId;
      const reservation = authorizedActions.reserveStock(
        {
          orders: {
            get: (tenantId, orderId) => (order && order.tenantId === tenantId && order.id === orderId ? order : undefined),
            list: () => (order ? [order] : []),
            save: forbidden,
          },
          sourcingAllocations: { list: () => allocations },
          stockMovements: { list: (_t, bookId) => ledger.movements.filter((m) => m.bookId === bookId), save: forbidden },
          stockReservations: {
            get: (_t, id) => ledger.reservations.find((r) => r.id === id),
            list: (_t, bookId) => ledger.reservations.filter((r) => r.bookId === bookId),
            save: (r) => void saved.push(r as StockReservationRecord),
          },
          stockReservationReleases: { list: (_t, reservationId) => ledger.releases.filter((r) => r.reservationId === reservationId), save: forbidden },
          stockReservationDeliveries: { list: (_t, reservationId) => ledger.deliveries.filter((d) => d.reservationId === reservationId) },
          idempotency,
        },
        principal,
        rest,
      );

      for (const r of saved) {
        await client.query(
          `insert into public.ordering_stock_reservations (id, tenant_id, book_key, order_id, order_line_id, quantity, reserved_by, reserved_at, recorded_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.id, r.tenantId, r.bookId, r.orderId, r.orderLineId, r.quantity, r.reservedBy, r.reservedAt, r.recordedAt],
        );
      }
      await saveNewCommands(client, idempotency, knownCommands);
      return reservation;
    });
  }

  return {
    async reserveStock(actor: Actor, request: ReserveStockBody): Promise<StockReservationRecord> {
      // 같은 멱등 키가 동시에 들어오면 한쪽의 저장이 유일 제약에 걸린다. 한 번 다시 시도하면 먼저 저장된 결과를 본다
      for (let attempt = 0; ; attempt++) {
        try {
          return await reserveOnce(actor, request);
        } catch (error) {
          if (attempt === 0 && isCommandKeyConflict(error)) continue;
          // DB 가드가 거부했다면 도메인 검사와 DB 상태가 어긋난 것이다. 업무 규칙 위반으로 돌려준다
          if ((error as { code?: string }).code === "P0001") {
            throw new AppError("BUSINESS_INVARIANT", (error as Error).message);
          }
          throw error;
        }
      }
    },
  };
}
