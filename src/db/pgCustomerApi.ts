import type { PoolClient } from "pg";
import { authorizedActions } from "../auth/authorizedActions";
import type { Customer, CustomerChange, RegisterCustomerRequest } from "../customer/registerCustomer";
import type { AnonymizeCustomerRequest } from "../customer/anonymizeCustomer";
import type { UpdateCustomerRequest } from "../customer/updateCustomer";
import { normalizePhone } from "../customer/normalizePhone";
import { AppError } from "../errors/AppError";
import { inTransaction, isCommandKeyConflict, isUuid, loadCommands, loadMembership, principalFor, saveNewCommands, type PoolLike } from "./pgSupport";

type Actor = { userId: string };

/** 호출자가 보내는 요청. 행위자(역할·이름)는 인증된 사용자에서 주입된다 */
export type RegisterCustomerBody = Omit<RegisterCustomerRequest, "actorRole" | "registeredBy">;

export type UpdateCustomerBody = Omit<UpdateCustomerRequest, "actorRole" | "changedBy">;
export type AnonymizeCustomerBody = Omit<AnonymizeCustomerRequest, "actorRole" | "anonymizedBy">;

/** 목록 화면용: 번호는 끝 4자리만(고객 결정 #3) */
export type CustomerListItem = { id: string; name: string; phoneLast4?: string; version: number; anonymized: boolean };
export type CustomerChangeView = { id: string; kind: "REGISTERED" | "UPDATED" | "ANONYMIZED"; before?: unknown; after?: unknown; by: string; at: string };
export type ListCustomersRequest = { tenantId: string; search?: string; limit?: number };

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

  async function persistChanges(client: PoolClient, customers: Customer[], changes: CustomerChange[], previous?: Customer) {
    for (const c of customers) {
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

  return {
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
    listCustomers: (actor: Actor, request: ListCustomersRequest): Promise<{ items: CustomerListItem[] }> =>
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
        params.push(limit);
        const rows = (await client.query(`select * from public.ordering_customers where tenant_id = $1${where} order by created_at desc, id desc limit $${params.length}`, params)).rows;
        return {
          items: rows.map((r): CustomerListItem => ({ id: r.id, name: r.name, ...(r.phone === null ? {} : { phoneLast4: (r.phone as string).slice(-4) }), version: Number(r.version), anonymized: r.anonymized_at !== null })),
        };
      }),

    updateCustomer: (actor: Actor, body: UpdateCustomerBody) => mutate(actor, body, (d, p, rest) => authorizedActions.updateCustomer(d, p, rest)),
    anonymizeCustomer: (actor: Actor, body: AnonymizeCustomerBody) => mutate(actor, body, (d, p, rest) => authorizedActions.anonymizeCustomer(d, p, rest)),
    registerCustomer: (actor: Actor, body: RegisterCustomerBody) => withRetry(() => registerOnce(actor, body)),
  };
}
