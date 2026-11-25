import { AsyncLocalStorage } from "node:async_hooks";

/** 감사 로그 한 줄의 근거. HTTP 계층이 쓰기 요청마다 만들어 요청 처리 동안 붙여 둔다 */
export type AuditContext = {
  actorId: string;
  /** 서점 범위 요청의 서점. 서점을 만들기 전의 계정 업무에는 없다 */
  tenantId?: string;
  /** 메서드와 OpenAPI 표기 경로(예: `POST /v1/tenants/{tenantId}/orders`) */
  operation: string;
  commandKey?: string;
  /** 요청 본문의 SHA-256(소문자 16진수). 본문 원문은 저장하지 않는다 */
  requestHash: string;
  /** 경로의 대상 식별자(`orderId` 등) */
  targets: Record<string, string>;
};

const storage = new AsyncLocalStorage<AuditContext>();

/** 이 함수 안에서 열리는 쓰기 트랜잭션은 성공할 때 감사 행을 같은 트랜잭션에 남긴다 */
export const runWithAudit = <T>(context: AuditContext, run: () => Promise<T>): Promise<T> => storage.run(context, run);

export const currentAudit = (): AuditContext | undefined => storage.getStore();
