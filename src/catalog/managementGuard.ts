import { AppError } from "../errors/AppError";

/** 점주가 위임한 직원만 공급처·문구 템플릿을 관리할 수 있다 (STBR "O/위임 S"). */
export type ManagementDelegations = { isDelegated(tenantId: string, userId: string): boolean };

export function assertCanManage(
  delegations: ManagementDelegations,
  request: { tenantId: string; actorRole: "OWNER" | "STAFF" },
  actorName: string,
): void {
  if (request.actorRole !== "OWNER" && !delegations.isDelegated(request.tenantId, actorName)) {
    throw new AppError("FORBIDDEN");
  }
}
