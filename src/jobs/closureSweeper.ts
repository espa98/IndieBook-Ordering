import { AppError } from "../errors/AppError";
import type { ExecuteOrderClosureBody } from "../db/pgCancellationApi";
import type { ExecutePurchaseOrderClosureBody } from "../db/pgProcurementApi";
import { inTransaction, type PoolLike } from "../db/pgSupport";

/** 스위퍼 실행을 한 곳으로 모으는 세션 어드바이저리 락 키. 여러 서버 인스턴스가 같은 DB를 보더라도 한 번에 하나만 돈다 */
export const CLOSURE_SWEEP_LOCK_KEY = 7_203_841_001;

export type SweepCounts = {
  attempted: number;
  closed: number;
  /** 종결 조건을 채우지 못해 BUSINESS_INVARIANT로 거절된 건 */
  blocked: number;
  /** 조회한 뒤 주문·발주 version이 바뀌어 거절된 건(다음 실행에서 다시 본다) */
  stale: number;
  /** 예기치 않은 오류. 한 건의 실패가 나머지 처리를 막지 않는다 */
  failed: number;
};
export type SweepResult = {
  /** 다른 실행이 락을 쥐고 있어 건너뛰었다 */
  skipped: boolean;
  orders: SweepCounts & { blockedDetails: { orderId: string; detail: string }[] };
  purchaseOrders: SweepCounts & { blockedDetails: { purchaseOrderId: string; detail: string }[] };
};

export type ClosureSweeperDeps = {
  /** 락을 쥐는 연결과 후보 조회에 쓴다. 후보 조회는 백엔드와 같이 `service_role`로 읽는다 */
  pool: PoolLike;
  cancellations: { executeOrderClosure(request: ExecuteOrderClosureBody): Promise<unknown> };
  procurement: { executePurchaseOrderClosure(request: ExecutePurchaseOrderClosureBody): Promise<unknown> };
  /** 한 번에 처리할 최대 건수(종류별). 기본 100 */
  batchSize?: number;
  now?: () => Date;
  logError?: (error: unknown) => void;
};

const counts = (): SweepCounts => ({ attempted: 0, closed: 0, blocked: 0, stale: 0, failed: 0 });
const emptyResult = (skipped: boolean): SweepResult => ({
  skipped,
  orders: { ...counts(), blockedDetails: [] },
  purchaseOrders: { ...counts(), blockedDetails: [] },
});

/**
 * 종결 요청이 있는 주문과 진행 중인 발주를 모아 서버 전용 종결 실행(`executeOrderClosure`, `executePurchaseOrderClosure`)을
 * 호출한다 (ST-O09, ST-P11). 종결 조건은 실행 함수가 그 순간 다시 계산하므로 여기서는 후보만 고르고 결과를 분류한다.
 * - 주문: 종결 요청이 있고 아직 종결되지 않았으며 요청 뒤 version이 바뀌지 않은 것. version이 바뀐 요청은 영영 맞지 않으므로
 *   후보에서 뺀다(다시 요청해야 한다).
 * - 발주: SENT·ACKNOWLEDGED 전부. 조건을 못 채우면 차단 사유와 함께 남기고 다음 실행에서 다시 본다.
 */
export function createClosureSweeper(deps: ClosureSweeperDeps) {
  const batchSize = deps.batchSize ?? 100;
  const nowIso = () => (deps.now ?? (() => new Date()))().toISOString();

  async function runOnce(): Promise<SweepResult> {
    const lock = await deps.pool.connect();
    try {
      const acquired = (await lock.query("select pg_try_advisory_lock($1) as ok", [CLOSURE_SWEEP_LOCK_KEY])).rows[0].ok === true;
      if (!acquired) return emptyResult(true);
      try {
        return await sweep();
      } finally {
        await lock.query("select pg_advisory_unlock($1)", [CLOSURE_SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  async function sweep(): Promise<SweepResult> {
    const result = emptyResult(false);
    const { orders, purchaseOrders } = await inTransaction(deps.pool, "service_role", "", async (client) => ({
      orders: (
        await client.query(
          `select r.tenant_id, r.id as closure_request_id, r.order_id from public.ordering_order_closure_requests r
             join public.ordering_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
            where o.closed_at is null and o.version = r.expected_version
              and not exists (select 1 from public.ordering_order_closures c where c.tenant_id = r.tenant_id and c.closure_request_id = r.id)
            order by r.recorded_at, r.id limit $1`,
          [batchSize],
        )
      ).rows,
      purchaseOrders: (
        await client.query(
          "select tenant_id, id, version from public.ordering_purchase_orders where status in ('SENT', 'ACKNOWLEDGED') order by created_at, id limit $1",
          [batchSize],
        )
      ).rows,
    }));

    for (const row of orders) {
      await attempt(
        result.orders,
        () => deps.cancellations.executeOrderClosure({ tenantId: row.tenant_id, closureRequestId: row.closure_request_id, executedAt: nowIso(), idempotencyKey: `sweep:order-closure:${row.closure_request_id}` }),
        (detail) => result.orders.blockedDetails.push({ orderId: row.order_id, detail }),
      );
    }
    for (const row of purchaseOrders) {
      await attempt(
        result.purchaseOrders,
        () => deps.procurement.executePurchaseOrderClosure({ tenantId: row.tenant_id, purchaseOrderId: row.id, expectedVersion: Number(row.version), executedAt: nowIso(), idempotencyKey: `sweep:po-closure:${row.id}:${row.version}` }),
        (detail) => result.purchaseOrders.blockedDetails.push({ purchaseOrderId: row.id, detail }),
      );
    }
    return result;
  }

  /** 한 건을 실행하고 결과를 분류한다. 어떤 오류도 밖으로 던지지 않는다 */
  async function attempt(target: SweepCounts, run: () => Promise<unknown>, onBlocked: (detail: string) => void): Promise<void> {
    target.attempted++;
    try {
      await run();
      target.closed++;
    } catch (error) {
      if (error instanceof AppError && error.code === "BUSINESS_INVARIANT") {
        target.blocked++;
        onBlocked(error.detail ?? "");
      } else if (error instanceof AppError && error.code === "VERSION_CONFLICT") {
        target.stale++;
      } else {
        target.failed++;
        deps.logError?.(error);
      }
    }
  }

  return { runOnce };
}
