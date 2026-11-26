import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { Customer, CustomerChange, RegisterCustomerRequest } from "../customer/registerCustomer";
import { RETENTION_BATCH_SIZE, type ApplyCustomerRetentionRequest } from "../customer/applyCustomerRetention";
import type { LinkOrderCustomerRequest, OrderCustomerLink } from "../customer/linkOrderCustomer";
import type { AnonymizeCustomerRequest } from "../customer/anonymizeCustomer";
import type { UpdateCustomerRequest } from "../customer/updateCustomer";
import { normalizePhone } from "../customer/normalizePhone";
import { AppError } from "../errors/AppError";
import { decodeCursor, encodeCursor, inTransaction, isCommandKeyConflict, isUuid, loadCommands, loadMembership, principalFor, saveNewCommands, type PoolLike } from "./pgSupport";

type Actor = { userId: string };

/** 호출자가 보내는 요청. 행위자(역할·이름)는 인증된 사용자에서 주입된다 */
export type RegisterCustomerBody = Omit<RegisterCustomerRequest, "actorRole" | "registeredBy">;

export type UpdateCustomerBody = Omit<UpdateCustomerRequest, "actorRole" | "changedBy">;
export type LinkOrderCustomerBody = Omit<LinkOrderCustomerRequest, "actorRole" | "linkedBy">;
export type ApplyCustomerRetentionBody = Omit<ApplyCustomerRetentionRequest, "actorRole" | "appliedBy">;
export type AnonymizeCustomerBody = Omit<AnonymizeCustomerRequest, "actorRole" | "anonymizedBy">;

/** 목록 화면용: 번호는 끝 4자리만(고객 결정 #3) */
export type CustomerListItem = { id: string; name: string; phoneLast4?: string; version: number; anonymized: boolean };
export type CustomerChangeView = { id: string; kind: "REGISTERED" | "UPDATED" | "ANONYMIZED"; before?: unknown; after?: unknown; by: string; at: string };
export type ListCustomersRequest = { tenantId: string; search?: string; limit?: number; cursor?: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** LIKE 와일드카드를 글자 그대로 찾도록 막는다 */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export const toCustomer = (row: any): Customer => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  phone: row.phone,
  version: Number(row.version),
  ...(row.anonymized_at === null ? {} : { anonymizedAt: (row.anonymized_at as Date).toISOString() }),
});

/** 고객 등록·수정·익명화·조회를 Postgres 위에서 실행한다(1차 최소 수집: 이름 + 전화번호) */
export function createPgCustomerApi(deps: { pool: PoolLike }) {
  const withRetry = async <T>(runOnce: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt === 0 && isCommandKeyConflict(error)) continue;
        throw error;
      }
    }
  };

  async function persistChanges(client: PoolClient, customers: Customer[], changes: CustomerChange[], previousList?: Customer | Customer[]) {
    for (const c of customers) {
      const previous = Array.isArray(previousList) ? previousList.find((p) => p.id === c.id) : previousList;
      if (previous) {
        const updated = await client.query("update public.ordering_customers set name = $3, phone = $4, version = $5, anonymized_at = $7 where tenant_id = $1 and id = $2 and version = $6", [c.tenantId, c.id, c.name, c.phone, c.version, previous.version, c.anonymizedAt ?? null]);
        if (updated.rowCount !== 1) throw new AppError("VERSION_CONFLICT");
      } else {
        await client.query("insert into public.ordering_customers (id, tenant_id, name, phone, version) values ($1, $2, $3, $4, $5)", [c.id, c.tenantId, c.name, c.phone, c.version]);
      }
    }
    for (const c of changes) {
      await client.query(
        'insert into public.ordering_customer_changes (id, tenant_id, customer_id, kind, before, after, "by", "at") values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [c.id, c.tenantId, c.customerId, c.kind, c.before === undefined ? null : JSON.stringify(c.before), JSON.stringify(c.after ?? {}), c.by, c.at],
      );
    }
  }

  const registerOnce = (actor: Actor, body: RegisterCustomerBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
      let existing: Customer[] = [];
      if (isUuid(body.tenantId) && typeof body.phone === "string") {
        try {
          const phone = normalizePhone(body.phone);
          existing = (await client.query("select * from public.ordering_customers where tenant_id = $1 and phone = $2 order by created_at, id", [body.tenantId, phone])).rows.map(toCustomer);
        } catch (error) {
          if (!(error instanceof AppError)) throw error; // 형식 오류는 도메인이 400으로 처리한다
        }
      }
      const idempotency = await loadCommands(client, body.tenantId, body.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: Customer[] = [];
      const changes: CustomerChange[] = [];
      const { tenantId: _t, ...rest } = body;
      void _t;
      const result = authorizedActions.registerCustomer(
        { customers: { listByPhone: (_x, phone) => existing.filter((c) => c.phone === phone), save: (c) => void saved.push(c) }, customerChanges: { save: (c) => void changes.push(c) }, idempotency },
        principal,
        rest,
      );
      await persistChanges(client, saved, changes);
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  type MutateDeps = { customers: { get(tenantId: string, id: string): Customer | undefined; save(customer: Customer): void }; customerChanges: { save(change: CustomerChange): void }; idempotency: any };
  /** 고객 한 명을 잠그고 읽은 뒤 도메인 명령을 실행해 결과를 저장한다(수정·익명화 공통) */
  const mutate = <B extends { tenantId: string; customerId: string; idempotencyKey: string }, R>(actor: Actor, body: B, run: (d: MutateDeps, principal: ReturnType<typeof principalFor>, rest: Omit<B, "tenantId">) => R): Promise<R> =>
    withRetry(() =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
        const current = isUuid(body.tenantId) && isUuid(body.customerId) ? (await client.query("select * from public.ordering_customers where tenant_id = $1 and id = $2 for update", [body.tenantId, body.customerId])).rows.map(toCustomer)[0] : undefined;
        const idempotency = await loadCommands(client, body.tenantId, body.idempotencyKey);
        const known = new Set(idempotency.keys());
        const saved: Customer[] = [];
        const changes: CustomerChange[] = [];
        const { tenantId: _t, ...rest } = body;
        void _t;
        const result = run(
          { customers: { get: (_x, id) => (current && current.id === id ? current : undefined), save: (c) => void saved.push(c) }, customerChanges: { save: (c) => void changes.push(c) }, idempotency },
          principal,
          rest,
        );
        await persistChanges(client, saved, changes, current);
        await saveNewCommands(client, idempotency, known);
        return result;
      }),
    );

  const asMember = <T>(actor: Actor, tenantId: string, run: (client: PoolClient) => Promise<T>): Promise<T> =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      principalFor(await loadMembership(client, actor.userId, tenantId), actor.userId, tenantId);
      return run(client);
    });

  const requireCustomer = async (client: PoolClient, tenantId: string, customerId: string): Promise<Customer> => {
    const row = isUuid(tenantId) && isUuid(customerId) ? (await client.query("select * from public.ordering_customers where tenant_id = $1 and id = $2", [tenantId, customerId])).rows[0] : undefined;
    if (!row) throw new AppError("NOT_FOUND");
    return toCustomer(row);
  };

  const linkOnce = (actor: Actor, body: LinkOrderCustomerBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
      const okIds = isUuid(body.tenantId) && isUuid(body.orderId) && isUuid(body.customerId);
      // 같은 주문의 동시 연결을 직렬화한다
      if (okIds) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ocl:${body.tenantId}:${body.orderId}`]);
      const orderRow = okIds ? (await client.query("select id, closed_at, cancelled_at, discarded_at from public.ordering_orders where tenant_id = $1 and id = $2", [body.tenantId, body.orderId])).rows[0] : undefined;
      const customer = okIds ? (await client.query("select * from public.ordering_customers where tenant_id = $1 and id = $2", [body.tenantId, body.customerId])).rows.map(toCustomer)[0] : undefined;
      const currentRow = orderRow ? (await client.query("select * from public.ordering_order_customer_links where tenant_id = $1 and order_id = $2 order by recorded_at desc, id desc limit 1", [body.tenantId, body.orderId])).rows[0] : undefined;
      const idempotency = await loadCommands(client, body.tenantId, body.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: OrderCustomerLink[] = [];
      const iso = (v: Date | null) => (v === null ? {} : { v: v.toISOString() }).v;
      const { tenantId: _t, ...rest } = body;
      void _t;
      const result = authorizedActions.linkOrderCustomer(
        {
          customers: { get: (_x, id) => (customer && customer.id === id ? customer : undefined) },
          orders: { get: (_x, id) => (orderRow && orderRow.id === id ? { id, ...(iso(orderRow.closed_at) ? { closedAt: iso(orderRow.closed_at)! } : {}), ...(iso(orderRow.cancelled_at) ? { cancelledAt: iso(orderRow.cancelled_at)! } : {}), ...(iso(orderRow.discarded_at) ? { discardedAt: iso(orderRow.discarded_at)! } : {}) } : undefined) },
          orderCustomerLinks: {
            current: () => (currentRow ? { id: currentRow.id, tenantId: currentRow.tenant_id, orderId: currentRow.order_id, customerId: currentRow.customer_id, linkedBy: currentRow.linked_by, linkedAt: (currentRow.linked_at as Date).toISOString() } : undefined),
            save: (l) => void saved.push(l),
          },
          idempotency,
        },
        principal,
        rest,
      );
      for (const l of saved) {
        await client.query("insert into public.ordering_order_customer_links (id, tenant_id, order_id, customer_id, linked_by, linked_at) values ($1, $2, $3, $4, $5, $6)", [l.id, l.tenantId, l.orderId, l.customerId, l.linkedBy, l.linkedAt]);
      }
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  const retentionOnce = (actor: Actor, body: ApplyCustomerRetentionBody) =>
    inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
      const principal = principalFor(await loadMembership(client, actor.userId, body.tenantId), actor.userId, body.tenantId);
      const okTenant = isUuid(body.tenantId);
      if (okTenant) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ret:${body.tenantId}`]);
      const days = okTenant ? (await client.query("select customer_retention_days from public.ordering_tenants where id = $1", [body.tenantId])).rows[0]?.customer_retention_days : null;
      // 후보: 마지막 활동(등록·변경·주문 연결 중 서버가 기록한 가장 늦은 시각)이 기한 이전인 고객. 도메인이 기준을 다시 확인한다
      const candidates = new Map<string, { customer: Customer; last: string }>();
      const appliedMs = typeof body.appliedAt === "string" ? Date.parse(body.appliedAt) : Number.NaN;
      if (okTenant && days !== null && days !== undefined && !Number.isNaN(appliedMs)) {
        const rows = (
          await client.query(
            `select c.*, greatest(c.created_at,
                      coalesce((select max(h.recorded_at) from public.ordering_customer_changes h where h.tenant_id = c.tenant_id and h.customer_id = c.id), c.created_at),
                      coalesce((select max(l.recorded_at) from public.ordering_order_customer_links l where l.tenant_id = c.tenant_id and l.customer_id = c.id), c.created_at)) as last_activity
               from public.ordering_customers c
              where c.tenant_id = $1 and c.anonymized_at is null
                and greatest(c.created_at,
                      coalesce((select max(h.recorded_at) from public.ordering_customer_changes h where h.tenant_id = c.tenant_id and h.customer_id = c.id), c.created_at),
                      coalesce((select max(l.recorded_at) from public.ordering_order_customer_links l where l.tenant_id = c.tenant_id and l.customer_id = c.id), c.created_at)) < $2::timestamptz
              order by last_activity, c.id
              limit $3
                for update of c`,
            [body.tenantId, new Date(appliedMs - days * 86_400_000).toISOString(), RETENTION_BATCH_SIZE + 1],
          )
        ).rows;
        for (const r of rows) candidates.set(r.id, { customer: toCustomer(r), last: (r.last_activity as Date).toISOString() });
      }
      const idempotency = await loadCommands(client, body.tenantId, body.idempotencyKey);
      const known = new Set(idempotency.keys());
      const saved: Customer[] = [];
      const changes: CustomerChange[] = [];
      const { tenantId: _t, ...rest } = body;
      void _t;
      const result = authorizedActions.applyCustomerRetention(
        {
          customers: { list: () => [...candidates.values()].map((x) => x.customer), get: (_x, id) => candidates.get(id)?.customer, save: (c) => void saved.push(c) },
          customerChanges: { save: (c) => void changes.push(c) },
          stores: { getRetentionDays: () => (days === null || days === undefined ? undefined : days) },
          activity: { lastActivityAt: (_x, id) => candidates.get(id)?.last },
          idempotency,
        },
        principal,
        rest,
      );
      await persistChanges(client, saved, changes, [...candidates.values()].map((x) => x.customer));
      await saveNewCommands(client, idempotency, known);
      return result;
    });

  return {
    /** Owner가 정한 보존기간이 지난 고객을 익명화한다(한 번에 최대 100명, 남으면 `hasMore`) */
    applyCustomerRetention: (actor: Actor, body: ApplyCustomerRetentionBody) => withRetry(() => retentionOnce(actor, body)),

    /** 주문에 고객을 연결한다(선택). 같은 고객이면 기록을 늘리지 않고, 다른 고객이면 새 연결이 추가된다 */
    linkOrderCustomer: (actor: Actor, body: LinkOrderCustomerBody) => withRetry(() => linkOnce(actor, body)),

    /** 주문의 현재 고객(가장 최근 연결). 안내 업무를 위해 번호 전체를 보여 준다. 연결이 없으면 `{ customer: null }` */
    getOrderCustomer: (actor: Actor, request: { tenantId: string; orderId: string }): Promise<{ customer: { id: string; name: string; phone: string | null } | null; linkedBy?: string; linkedAt?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const order = isUuid(request.tenantId) && isUuid(request.orderId) ? (await client.query("select 1 from public.ordering_orders where tenant_id = $1 and id = $2", [request.tenantId, request.orderId])).rowCount : 0;
        if (!order) throw new AppError("NOT_FOUND");
        const row = (await client.query("select c.id, c.name, c.phone, l.linked_by, l.linked_at from public.ordering_order_customer_links l join public.ordering_customers c on c.tenant_id = l.tenant_id and c.id = l.customer_id where l.tenant_id = $1 and l.order_id = $2 order by l.recorded_at desc, l.id desc limit 1", [request.tenantId, request.orderId])).rows[0];
        return row ? { customer: { id: row.id, name: row.name, phone: row.phone }, linkedBy: row.linked_by, linkedAt: (row.linked_at as Date).toISOString() } : { customer: null };
      }),

    /** 상세: 번호 전체(안내 업무에 필요, 고객 결정 #3) */
    getCustomer: (actor: Actor, request: { tenantId: string; customerId: string }): Promise<Customer> => asMember(actor, request.tenantId, (client) => requireCustomer(client, request.tenantId, request.customerId)),

    /** 변경 이력(오래된 순). Owner는 전·후 값까지, 직원은 변경 종류·행위자·시각만(고객 결정 #8) */
    listCustomerChanges: (actor: Actor, request: { tenantId: string; customerId: string }): Promise<{ items: CustomerChangeView[] }> =>
      inTransaction(deps.pool, "service_role", actor.userId, async (client) => {
        const principal = principalFor(await loadMembership(client, actor.userId, request.tenantId), actor.userId, request.tenantId);
        await requireCustomer(client, request.tenantId, request.customerId);
        const rows = (await client.query('select id, kind, before, after, "by", "at" from public.ordering_customer_changes where tenant_id = $1 and customer_id = $2 order by recorded_at, id', [request.tenantId, request.customerId])).rows;
        return {
          items: rows.map((r): CustomerChangeView => ({
            id: r.id,
            kind: r.kind,
            ...(principal.role === "OWNER" ? { ...(r.before === null ? {} : { before: r.before }), after: r.after } : {}),
            by: r.by,
            at: (r.at as Date).toISOString(),
          })),
        };
      }),

    /** 최신 등록순. 이름 부분 일치 + 번호 숫자열 부분 일치(숫자 3자리 이상)(고객 결정 #9) */
    listCustomers: (actor: Actor, request: ListCustomersRequest): Promise<{ items: CustomerListItem[]; nextCursor?: string }> =>
      asMember(actor, request.tenantId, async (client) => {
        const limit = request.limit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new AppError("VALIDATION_ERROR", "limit must be an integer 1..100");
        const search = request.search?.trim();
        if (request.search !== undefined && !search) throw new AppError("VALIDATION_ERROR", "search must not be empty");
        const digits = search?.replace(/\D/g, "") ?? "";
        const params: unknown[] = [request.tenantId];
        let where = "";
        if (search) {
          params.push(`%${escapeLike(search)}%`);
          where = " and (name ilike $2";
          if (digits.length >= 3) {
            params.push(`%${escapeLike(digits)}%`);
            where += " or phone like $3";
          }
          where += ")";
        }
        if (request.cursor !== undefined) {
          const [at, id] = decodeCursor(request.cursor, 2) as [string, string];
          if (Number.isNaN(Date.parse(at)) || !isUuid(id)) throw new AppError("VALIDATION_ERROR", "invalid cursor");
          params.push(at, id);
          where += ` and (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
        }
        params.push(limit + 1);
        const found = (await client.query(`select *, created_at::text as created_at_text from public.ordering_customers where tenant_id = $1${where} order by created_at desc, id desc limit $${params.length}`, params)).rows;
        const rows = found.slice(0, limit);
        const last = rows[rows.length - 1];
        return {
          ...(found.length > limit && last ? { nextCursor: encodeCursor([last.created_at_text, last.id]) } : {}),
          items: rows.map((r): CustomerListItem => ({ id: r.id, name: r.name, ...(r.phone === null ? {} : { phoneLast4: (r.phone as string).slice(-4) }), version: Number(r.version), anonymized: r.anonymized_at !== null })),
        };
      }),

    updateCustomer: (actor: Actor, body: UpdateCustomerBody) => mutate(actor, body, (d, p, rest) => authorizedActions.updateCustomer(d, p, rest)),
    anonymizeCustomer: (actor: Actor, body: AnonymizeCustomerBody) => mutate(actor, body, (d, p, rest) => authorizedActions.anonymizeCustomer(d, p, rest)),
    registerCustomer: (actor: Actor, body: RegisterCustomerBody) => withRetry(() => registerOnce(actor, body)),
  };
}
