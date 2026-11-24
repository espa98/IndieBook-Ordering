import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { bindActor } from "../../src/auth/bindActor";
import { createSystemPrincipal, type UserPrincipal } from "../../src/auth/principal";

type Req = { tenantId: string; actorRole: "OWNER" | "STAFF"; confirmedBy: string; amountKrw: string };
const echo = (_deps: object, request: Req) => request;

const owner: UserPrincipal = { kind: "USER", userId: "owner-1", tenantId: "tenant-a", role: "OWNER" };
const staff: UserPrincipal = { kind: "USER", userId: "staff-1", tenantId: "tenant-a", role: "STAFF" };

describe("bindActor: 요청 본문의 신원 필드를 주체에서 주입 (T7)", () => {
  it("요청에 위조된 tenantId·actorRole·행위자 이름이 있어도 무시하고 주체의 값으로 덮어쓴다", () => {
    const bound = bindActor(echo, { roleField: "actorRole", nameField: "confirmedBy", allow: ["OWNER", "STAFF"] });

    const seen = bound({}, staff, {
      amountKrw: "1000",
      // 위조 시도: 다른 테넌트, 점주 역할, 점주 이름
      tenantId: "tenant-b",
      actorRole: "OWNER",
      confirmedBy: "owner-1",
    } as never);

    expect(seen).toEqual({
      tenantId: "tenant-a",
      actorRole: "STAFF",
      confirmedBy: "staff-1",
      amountKrw: "1000",
    });
  });
});

describe("bindActor: 허용 주체 검사", () => {
  const codeOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return (error as AppError).code;
    }
  };

  it("허용되지 않은 역할(Staff의 Owner 전용 명령)·주체 종류는 명령을 호출하기 전에 FORBIDDEN 403이다", () => {
    let calls = 0;
    const counted = (deps: object, request: Req) => (calls++, echo(deps, request));
    const ownerOnly = bindActor(counted, { roleField: "actorRole", nameField: "confirmedBy", allow: ["OWNER"] });
    const request = { amountKrw: "1" } as never;

    expect(codeOf(() => ownerOnly({}, staff, request))).toBe("FORBIDDEN");
    expect(codeOf(() => ownerOnly({}, createSystemPrincipal("tenant-a"), request))).toBe("FORBIDDEN");
    expect(calls).toBe(0);
    expect(codeOf(() => ownerOnly({}, owner, request))).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("SYSTEM 전용 명령은 SYSTEM 주체만 실행하고 executedBy가 서버에서 주입되며, 사용자는 위조해도 FORBIDDEN이다", () => {
    type SysReq = { tenantId: string; executedBy: "SYSTEM"; closureRequestId: string };
    const run = (_deps: object, request: SysReq) => request;
    const systemOnly = bindActor(run, { systemField: "executedBy", allow: ["SYSTEM"] });
    const request = { closureRequestId: "c-1", executedBy: "SYSTEM" } as never; // 위조 시도 포함

    expect(systemOnly({}, createSystemPrincipal("tenant-a"), { closureRequestId: "c-1" })).toEqual({
      tenantId: "tenant-a",
      executedBy: "SYSTEM",
      closureRequestId: "c-1",
    });
    expect(codeOf(() => systemOnly({}, owner, request))).toBe("FORBIDDEN");
    expect(codeOf(() => systemOnly({}, staff, request))).toBe("FORBIDDEN");
  });
});
