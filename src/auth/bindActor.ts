import { AppError } from "../errors/AppError";
import type { Role } from "./authorizeTenantAccess";
import type { Principal } from "./principal";

export type ActorBinding<
  RF extends PropertyKey = never,
  NF extends PropertyKey = never,
  SF extends PropertyKey = never,
> = {
  /** 이 명령을 실행할 수 있는 주체 종류. "SYSTEM"은 서버 내부 주체만이다 */
  allow: readonly (Role | "SYSTEM")[];
  /** 요청의 역할 필드(actorRole). 사용자 주체의 멤버십 역할로 채운다 */
  roleField?: RF;
  /** 요청의 행위자 이름 필드(confirmedBy 등). 사용자 ID로 채운다 */
  nameField?: NF;
  /** 서버 내부 실행자 필드(executedBy). "SYSTEM"으로 채운다 */
  systemField?: SF;
};

/**
 * 명령의 신원 필드(tenantId·역할·행위자)를 요청 본문이 아니라 서버가 도출한 주체에서 주입한다.
 * 요청에 같은 이름의 값이 있어도 무시하고 덮어쓰므로 위조할 수 없다.
 */
export function bindActor<
  Deps,
  Req extends { tenantId: string },
  Res,
  RF extends keyof Req = never,
  NF extends keyof Req = never,
  SF extends keyof Req = never,
>(
  command: (deps: Deps, request: Req) => Res,
  binding: ActorBinding<RF, NF, SF>,
): (deps: Deps, principal: Principal, request: Omit<Req, "tenantId" | RF | NF | SF>) => Res {
  return (deps, principal, request) => {
    // 허용된 주체만 명령을 호출할 수 있다. 거부하면 명령은 실행되지 않는다
    const kind = principal.kind === "SYSTEM" ? "SYSTEM" : principal.role;
    if (!binding.allow.includes(kind)) {
      throw new AppError("FORBIDDEN");
    }
    const injected: Record<string, unknown> = { ...request, tenantId: principal.tenantId };
    if (principal.kind === "USER") {
      if (binding.roleField !== undefined) injected[binding.roleField as string] = principal.role;
      if (binding.nameField !== undefined) injected[binding.nameField as string] = principal.userId;
    } else if (binding.systemField !== undefined) {
      injected[binding.systemField as string] = "SYSTEM";
    }
    return command(deps, injected as Req);
  };
}
