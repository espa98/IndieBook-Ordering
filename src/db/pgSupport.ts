import type { Pool, PoolClient } from "pg";
import { currentAudit } from "./auditContext";
import { AppError } from "../errors/AppError";
import { authorizeTenantAccess, type Membership } from "../auth/authorizeTenantAccess";
import type { UserPrincipal } from "../auth/principal";
import type { IdempotencyStore } from "../idempotency/executeIdempotent";
import type { Order, OrderLine } from "../order/createDraftOrder";

/** 풀에서 연결을 빌려 쓰는 최소 인터페이스 (pg.Pool과 호환) */
export type PoolLike = Pick<Pool, "connect">;
export type DbRole = "service_role" | "authenticated";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/**
 * 요청 본문의 참조 ID(`orderLineId`·`paymentId` 등)가 uuid 형식인지 확인한다. 도메인은 메모리 저장소 테스트가 `"order-1"` 같은 비-uuid ID를
 * 쓰기 때문에 형식을 강제하지 못하고, uuid 형식은 어댑터의 책임이다. 값이 없는(`undefined`) 필드는 필수 여부를 도메인이 판단하므로 건너뛴다.
 * 오류 메시지에는 필드 이름만 담고 클라이언트가 보낸 값은 되돌리지 않는다.
 */
export function assertReferenceIds(request: object, fields: readonly string[]): void {
  for (const field of fields) {
    // 이름이 `[]`로 끝나면 배열 필드이고 모든 원소가 uuid여야 한다. 배열이 아니거나 비어 있는지는 도메인이 판단한다
    const isArrayField = field.endsWith("[]");
    const name = isArrayField ? field.slice(0, -2) : field;
    const value = (request as Record<string, unknown>)[name];
    if (value === undefined) continue;
    const bad = isArrayField ? Array.isArray(value) && !value.every(isUuid) : !isUuid(value);
    if (bad) throw new AppError("VALIDATION_ERROR", `${name} must be a valid id`);
  }
}

/**
 * 도메인 호출을 감싸 본문의 참조 ID 형식을 확인한다. 우선순위는 권한(403) → 다른 입력 검증(400) → 이 확인 → 조회 실패(404·422)다.
 * 도메인이 성공하면 형식이 틀린 값이 조회에 쓰이지 않은 것이므로 거부하고, 도메인이 대상을 못 찾아 끝났다면(NOT_FOUND·BUSINESS_INVARIANT)
 * 형식 오류를 "없는 대상"으로 오해시키지 않도록 400으로 바꾼다. 그 밖의 오류는 그대로 던진다.
 */
export function withReferenceIds<T>(request: object, fields: readonly string[], run: () => T): T {
  let result: T;
  try {
    result = run();
  } catch (error) {
    if (error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "BUSINESS_INVARIANT")) assertReferenceIds(request, fields);
    throw error;
  }
  assertReferenceIds(request, fields);
  return result;
}

/**
 * 한 트랜잭션에서 지정한 DB 역할로 실행한다. `authenticated`면 JWT 클레임의 sub를 설정해 RLS가 적용된다.
 * 실패하면 롤백한다.
 */
export async function inTransaction<T>(
  pool: PoolLike,
  role: DbRole,
  userId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // 빌려 간 연결의 소켓 오류(서버가 연결을 끊음 등)는 풀이 아니라 연결이 내보낸다. 받는 쪽이 없으면 프로세스가 죽는다.
  // 진행 중인 질의는 자체 오류로 실패하므로 여기서는 삼키고, 끊긴 연결은 풀에 돌려주지 않고 폐기한다.
  let broken: Error | undefined;
  const onError = (error: Error) => {
    broken = error;
  };
  client.on("error", onError);
  try {
    await client.query("begin");
    try {
      await client.query(`set local role ${role}`);
      if (role === "authenticated") {
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
      }
      const result = await run(client);
      // 감사 행은 명령과 같은 트랜잭션이다: 저장에 실패하면 명령도 롤백된다
      const audit = currentAudit();
      if (audit) {
        await client.query("insert into public.ordering_audit_log (tenant_id, actor_id, operation, command_key, request_hash, targets) values ($1, $2, $3, $4, $5, $6::jsonb)", [
          audit.tenantId ?? null,
          audit.actorId,
          audit.operation,
          audit.commandKey ?? null,
          audit.requestHash,
          JSON.stringify(audit.targets),
        ]);
      }
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.removeListener("error", onError);
    client.release(broken);
  }
}

/** 같은 멱등 키가 동시에 들어와 유일 제약에 걸린 경우(먼저 저장된 결과를 다시 읽으면 된다) */
export function isCommandKeyConflict(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e.code === "23505" && e.constraint === "ordering_commands_pkey";
}

export async function loadMembership(client: PoolClient, userId: string, tenantId: string): Promise<Membership[]> {
  if (!isUuid(userId) || !isUuid(tenantId)) return [];
  const rows = (
    await client.query("select user_id, tenant_id, role, active from public.ordering_members where user_id = $1 and tenant_id = $2", [
      userId,
      tenantId,
    ])
  ).rows;
  return rows.map((r) => ({
    userId: r.user_id,
    tenantId: r.tenant_id,
    role: r.role,
    status: r.active ? "ACTIVE" : "INACTIVE",
  }));
}

/** 멤버십으로 주체를 만든다. 인증 없음·비멤버·비활성은 도메인과 같은 오류를 낸다 */
export function principalFor(memberships: Membership[], userId: string, tenantId: string): UserPrincipal {
  const { role } = authorizeTenantAccess(
    { memberships: { find: (u, t) => memberships.find((m) => m.userId === u && m.tenantId === t) } },
    { userId, tenantId },
  );
  return { kind: "USER", userId, tenantId, role };
}

const commandKey = (tenantId: string, operation: string, key: string) => JSON.stringify([tenantId, operation, key]);

/**
 * 멱등 기록에 저장하는 결과의 형태 버전. 결과 JSON의 형태를 바꾸는 변경은 이 값을 올린다.
 * 낮은 버전의 기록은 읽을 때 삭제하고 없는 것으로 본다(오래된 기록 호환 정책, 026 마이그레이션).
 */
export const RESULT_SCHEMA_VERSION = 1;

export async function deleteStaleCommands(client: PoolClient, tenantId: string | null, stale: { operation: string; command_key: string }[]): Promise<void> {
  for (const r of stale) {
    await client.query(
      "delete from public.ordering_commands where operation = $1 and command_key = $2 and result_version < $3 and ($4::uuid is null or tenant_id = $4::uuid)",
      [r.operation, r.command_key, RESULT_SCHEMA_VERSION, tenantId],
    );
  }
}

export async function loadCommands(client: PoolClient, tenantId: string, key: unknown): Promise<IdempotencyStore> {
  const store: IdempotencyStore = new Map();
  if (!isUuid(tenantId) || typeof key !== "string" || key.trim() === "") return store;
  const rows = (
    await client.query(
      "select operation, command_key, payload_hash, result, result_version from public.ordering_commands where tenant_id = $1 and command_key = $2",
      [tenantId, key],
    )
  ).rows;
  // 옛 결과 형태의 기록은 삭제하고 없는 것으로 본다(호환 정책: 변환하지 않는다)
  await deleteStaleCommands(client, tenantId, rows.filter((r) => r.result_version < RESULT_SCHEMA_VERSION));
  for (const r of rows) {
    if (r.result_version < RESULT_SCHEMA_VERSION) continue;
    store.set(commandKey(tenantId, r.operation, r.command_key), { payloadHash: r.payload_hash, result: r.result });
  }
  return store;
}

/** 이번 요청에서 새로 생긴 멱등 기록만 저장한다 */
export async function saveNewCommands(client: PoolClient, store: IdempotencyStore, known: Set<string>): Promise<void> {
  for (const [storeKey, entry] of store) {
    if (known.has(storeKey)) continue;
    const [tenantId, operation, key] = JSON.parse(storeKey) as [string, string, string];
    await client.query(
      "insert into public.ordering_commands (tenant_id, operation, command_key, payload_hash, result, result_version) values ($1, $2, $3, $4, $5::jsonb, $6)",
      [tenantId, operation, key, entry.payloadHash, JSON.stringify(entry.result), RESULT_SCHEMA_VERSION],
    );
  }
}

type OrderRow = {
  id: string;
  tenant_id: string;
  status: "DRAFT" | "CONFIRMED";
  version: string;
  display_number: string | null;
  total_krw: string | null;
  created_at: Date;
  closed_at: Date | null;
  cancelled_at: Date | null;
  held_at: Date | null;
  hold_reason: string | null;
  held_by: string | null;
  discarded_at: Date | null;
  discard_reason: string | null;
  discarded_by: string | null;
};
type LineRow = {
  id: string;
  order_id: string;
  book_key: string;
  quantity: number;
  unit_price_krw: string;
  book_title: string | null;
  book_isbn: string | null;
  list_price_krw: string | null;
};

export function toOrder(row: OrderRow, lines: LineRow[]): Order {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    lines: lines.map(
      (l): OrderLine => ({
        lineId: l.id,
        bookId: l.book_key,
        quantity: l.quantity,
        unitPriceKrw: l.unit_price_krw,
        ...(l.book_title === null ? {} : { bookTitle: l.book_title }),
        ...(l.book_isbn === null ? {} : { bookIsbn: l.book_isbn }),
        ...(l.list_price_krw === null ? {} : { listPriceKrw: l.list_price_krw }),
      }),
    ),
    ...(row.total_krw === null ? {} : { totalKrw: row.total_krw }),
    ...(row.display_number === null ? {} : { displayNumber: Number(row.display_number) }),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at.toISOString() }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at.toISOString() }),
    ...(row.held_at === null ? {} : { heldAt: row.held_at.toISOString(), holdReason: row.hold_reason ?? "", heldBy: row.held_by ?? "" }),
    ...(row.discarded_at === null ? {} : { discardedAt: row.discarded_at.toISOString(), discardReason: row.discard_reason ?? "", discardedBy: row.discarded_by ?? "" }),
  };
}

export type OrderPage = {
  /** 한 페이지 크기. 다음 페이지 유무를 알려고 하나 더 읽는다 */
  limit: number;
  status?: Order["status"];
  /** 폐기된 초안도 읽는다. 기본은 제외(폐기분이 페이지를 채우지 않게 SQL에서 거른다) */
  includeDiscarded?: boolean;
  /** 표시번호(정확히 일치)·품목의 도서명(부분 일치, 대소문자 무시)·ISBN(정확히 일치)으로 거른다. 와일드카드는 문자 그대로 찾는다 */
  search?: { text: string; displayNumber?: number; isbn?: string };
  /** 이 키보다 뒤(더 오래된)의 주문만. (createdAt, id) 내림차순 */
  after?: { createdAt: string; id: string };
};

/**
 * 주문과 품목을 적재한다. `lock`이 있으면 행을 잠근다(update: 변경 예정, share: 변경만 막음).
 * `page`가 있으면 최신순(created_at, id 내림차순) 한 페이지(+1건)만 읽는다.
 */
export async function loadOrders(
  client: PoolClient,
  tenantId: string,
  options: { orderId?: string; lock?: "update" | "share"; page?: OrderPage },
): Promise<Order[]> {
  if (!isUuid(tenantId) || (options.orderId !== undefined && !isUuid(options.orderId))) return [];
  const params: unknown[] = [tenantId];
  const where: string[] = ["tenant_id = $1"];
  let tail = "";
  if (options.orderId !== undefined) {
    params.push(options.orderId);
    where.push(`id = $${params.length}`);
  }
  if (options.page) {
    const { page } = options;
    if (page.status !== undefined) {
      params.push(page.status);
      where.push(`status = $${params.length}`);
    }
    if (page.includeDiscarded !== true) where.push("discarded_at is null");
    if (page.search) {
      // LIKE 와일드카드(%, _)와 역슬래시를 이스케이프해 검색어를 문자 그대로 찾는다
      params.push(`%${page.search.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const pattern = `$${params.length}`;
      params.push(page.search.displayNumber ?? null, page.search.isbn ?? null);
      const number = `$${params.length - 1}::bigint`;
      const isbn = `$${params.length}::text`;
      where.push(
        `(display_number = ${number} or exists (select 1 from public.ordering_order_lines sl where sl.tenant_id = ordering_orders.tenant_id and sl.order_id = ordering_orders.id and (sl.book_title ilike ${pattern} escape '\\' or (${isbn} is not null and sl.book_isbn = ${isbn}))))`,
      );
    }
    if (page.after) {
      params.push(page.after.createdAt, page.after.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(page.limit + 1);
    tail = `order by created_at desc, id desc limit $${params.length}`;
  }
  const orders = (
    await client.query<OrderRow>(
      `select * from public.ordering_orders where ${where.join(" and ")} ${tail} ${
        options.lock === "update" ? "for update" : options.lock === "share" ? "for share" : ""
      }`,
      params,
    )
  ).rows;
  if (orders.length === 0) return [];
  const lines = (
    await client.query<LineRow>(
      "select * from public.ordering_order_lines where tenant_id = $1 and order_id = any($2::uuid[]) order by order_id, position",
      [tenantId, orders.map((o) => o.id)],
    )
  ).rows;
  return orders.map((o) =>
    toOrder(
      o,
      lines.filter((l) => l.order_id === o.id),
    ),
  );
}

/** 불투명 커서: 정렬 키 배열을 base64 JSON으로 감싼다. 형식이 맞지 않으면 400 */
export const encodeCursor = (key: string[]) => btoa(unescape(encodeURIComponent(JSON.stringify(key))));
export function decodeCursor(cursor: string, size: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(escape(atob(cursor))));
  } catch {
    throw new AppError("VALIDATION_ERROR", "invalid cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== size || !parsed.every((p) => typeof p === "string")) throw new AppError("VALIDATION_ERROR", "invalid cursor");
  return parsed as string[];
}
