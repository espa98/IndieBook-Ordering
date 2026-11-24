import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { RegisterSupplierRequest, SupplierChange } from "../catalog/registerSupplier";
import type { SetSupplierActiveRequest } from "../catalog/setSupplierActive";
import type { UpdateSupplierRequest } from "../catalog/updateSupplier";
import { AppError } from "../errors/AppError";
import type { Supplier } from "../procurement/allocateSourcing";
import type { PurchaseOrder } from "../procurement/createPurchaseOrder";
import {
  inTransaction,
  isCommandKeyConflict,
  isUuid,
  loadCommands,
  loadMembership,
  principalFor,
  saveNewCommands,
  type PoolLike,
} from "./pgSupport";

type Actor = { userId: string };
const forbidden = () => {
  throw new Error("this command must not write this ledger");
};

/** 호출자가 보내는 요청. 행위자(역할·이름)는 인증된 사용자에서 주입되므로 보낼 필요가 없다 */
export type RegisterSupplierBody = Omit<RegisterSupplierRequest, "actorRole" | "registeredBy">;
export type UpdateSupplierBody = Omit<UpdateSupplierRequest, "actorRole" | "changedBy">;
export type SetSupplierActiveBody = Omit<SetSupplierActiveRequest, "actorRole" | "changedBy">;

const toSupplier = (row: any): Supplier | undefined =>
  row
    ? {
        tenantId: row.tenant_id,
        code: row.code,
        active: row.active,
        ...(row.name === null ? {} : { name: row.name }),
        ...(row.order_channel === null ? {} : { orderChannel: row.order_channel }),
        version: Number(row.version),
      }
    : undefined;

/** 공급처 등록·수정·활성 전환을 Postgres 영속화 위에서 실행한다 (E7 권고안 a).
 * 공급처 단위 락('sup:')을 잡고 읽으므로 같은 공급처의 동시 변경은 직렬화된다. 관리 권한은 점주 또는 점주가 위임한 직원이다. */
export function createPgSupplierApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        if ((error as { code?: string }).code === "P0001") throw new AppError("BUSINESS_INVARIANT", (error as Error).message);
        throw error;
      }
    }
  };

  async function persist(client: PoolClient, suppliers: Supplier[], changes: SupplierChange[], previous: Supplier | undefined) {
    for (const s of suppliers) {
      if (previous) {
        const updated = await client.query("update public.ordering_suppliers set active = $3, name = $4, order_channel = $5, version = $6 where tenant_id = $1 and code = $2 and version = $7", [s.tenantId, s.code, s.active, s.name ?? null, s.orderChannel ?? null, s.version, previous.version]);
        if (updated.rowCount !== 1) throw new AppError("VERSION_CONFLICT");
      } else {
        await client.query("insert into public.ordering_suppliers (tenant_id, code, active, name, order_channel, version) values ($1, $2, $3, $4, $5, $6)", [s.tenantId, s.code, s.active, s.name ?? null, s.orderChannel ?? null, s.version]);
      }
    }
    for (const c of changes) {
      await client.query(
        'insert into public.ordering_supplier_changes (id, tenant_id, code, kind, before, after, reason, open_purchase_order_ids, "by", "at") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [c.id, c.tenantId, c.code, c.kind, c.before === undefined ? null : JSON.stringify(c.before), JSON.stringify(c.after), c.reason ?? null, c.openPurchaseOrderIds === undefined ? null : JSON.stringify(c.openPurchaseOrderIds), c.by, c.at],
      );
    }
  }

  const execute = <B extends { tenantId: string; code: string; idempotencyKey: string }, R>(
    actor: Actor,
    body: B,
    run: (ctx: { suppliers: any; supplierChanges: any; managementDelegations: any; purchaseOrders: any; idempotency: any }, principal: ReturnType<typeof principalFor>, rest: Omit<B, "tenantId">) => R,
  ): Promise<R> =>
    withRetry(() =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
        const tenantOk = isUuid(body.tenantId);
        if (tenantOk && typeof body.code === "string") await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`sup:${body.tenantId}:${body.code}`]);
        const current = tenantOk && typeof body.code === "string" ? toSupplier((await client.query("select * from public.ordering_suppliers where tenant_id = $1 and code = $2", [body.tenantId, body.code])).rows[0]) : undefined;
        const delegated = tenantOk ? (await client.query("select 1 from public.ordering_management_delegations where tenant_id = $1 and user_id = $2", [body.tenantId, actor.userId])).rowCount === 1 : false;
        const open: PurchaseOrder[] = tenantOk && current
          ? (await client.query("select id, supplier_code, status, version from public.ordering_purchase_orders where tenant_id = $1 and supplier_code = $2", [body.tenantId, current.code])).rows.map(
              (p): PurchaseOrder => ({ id: p.id, tenantId: body.tenantId, supplierCode: p.supplier_code, status: p.status, version: Number(p.version), lines: [] }),
            )
          : [];
        const idempotency = await loadCommands(client, body.tenantId, body.idempotencyKey);
        const known = new Set(idempotency.keys());
        const savedSuppliers: Supplier[] = [];
        const savedChanges: SupplierChange[] = [];
        const { tenantId: _t, ...rest } = body;
        void _t;
        const result = run(
          {
            suppliers: { get: (_t2: string, code: string) => (current && current.code === code ? current : undefined), list: () => (current ? [current] : []), save: (s: Supplier) => void savedSuppliers.push(s) },
            supplierChanges: { save: (c: SupplierChange) => void savedChanges.push(c) },
            managementDelegations: { isDelegated: (_t2: string, userId: string) => delegated && userId === actor.userId },
            purchaseOrders: { list: () => open, get: forbidden, save: forbidden },
            idempotency,
          },
          principal,
          rest,
        );
        await persist(client, savedSuppliers, savedChanges, current);
        await saveNewCommands(client, idempotency, known);
        return result;
      }),
    );

  return {
    registerSupplier: (actor: Actor, body: RegisterSupplierBody) => execute(actor, body, (d, p, rest) => authorizedActions.registerSupplier(d, p, rest)),
    updateSupplier: (actor: Actor, body: UpdateSupplierBody) => execute(actor, body, (d, p, rest) => authorizedActions.updateSupplier(d, p, rest)),
    setSupplierActive: (actor: Actor, body: SetSupplierActiveBody) => execute(actor, body, (d, p, rest) => authorizedActions.setSupplierActive(d, p, rest)),
  };
}
