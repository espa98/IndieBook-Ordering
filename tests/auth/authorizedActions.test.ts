import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { AppError } from "../../src/errors/AppError";
import { authorizedActions } from "../../src/auth/authorizedActions";
import { createSystemPrincipal, type UserPrincipal } from "../../src/auth/principal";
import { executionScene } from "../helpers/closureFixtures";
import { paymentCorrectionScene } from "../helpers/paymentFixtures";

const owner: UserPrincipal = { kind: "USER", userId: "owner-1", tenantId: "tenant-a", role: "OWNER" };
const staff: UserPrincipal = { kind: "USER", userId: "staff-1", tenantId: "tenant-a", role: "STAFF" };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("authorizedActions: 신원 필드를 주체에서 주입한 명령 모음 (T7)", () => {
  it("Staff 주체가 요청에 actorRole OWNER를 위조해도 Owner 전용 명령은 FORBIDDEN이고 아무것도 기록되지 않는다", () => {
    const { deps, correctPaymentRequest, paymentCorrections, first: payment } = paymentCorrectionScene();
    const { actorRole: _role, correctedBy: _by, tenantId: _t, ...spoofed } = {
      ...correctPaymentRequest(),
      actorRole: "OWNER",
      correctedBy: "점주",
    };

    let thrown: unknown;
    try {
      authorizedActions.correctPayment(deps, staff, spoofed);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect(paymentCorrections.list("tenant-a", payment.id)).toEqual([]);
  });

  it("Owner 주체로 실행하면 기록되는 행위자는 요청이 주장한 이름이 아니라 주체의 사용자 ID이다", () => {
    const { deps, correctPaymentRequest, paymentCorrections, first: payment } = paymentCorrectionScene();
    const { actorRole: _r, correctedBy: _b, tenantId: _t, ...rest } = correctPaymentRequest();

    const correction = authorizedActions.correctPayment(deps, owner, { ...rest, correctedBy: "다른사람" } as never);

    expect(correction.correctedBy).toBe("owner-1");
    expect(paymentCorrections.list("tenant-a", payment.id)).toEqual([correction]);
  });

  it("종결 실행은 SYSTEM 주체만 할 수 있고 사용자 주체는 위조해도 FORBIDDEN이다", () => {
    const { deps, executeRequest, orderD } = executionScene();
    const { executedBy: _e, tenantId: _t, ...rest } = executeRequest();

    expect(() => authorizedActions.executeOrderClosure(deps, owner, { ...rest, executedBy: "SYSTEM" } as never)).toThrow(AppError);
    const closure = authorizedActions.executeOrderClosure(deps, createSystemPrincipal("tenant-a"), rest);
    expect(closure).toMatchObject({ orderId: orderD.id, executedBy: "SYSTEM" });
  });

  it("역할 또는 SYSTEM 실행자를 요청으로 받는 모든 명령 파일이 이 모음에 바인딩되어 있다 (누락 방지)", () => {
    const needsBinding = sourceFiles("src")
      .filter((path) => !path.split(sep).join("/").startsWith("src/auth/"))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return /actorRole: "OWNER" \| "STAFF"/.test(text) || /executedBy: "SYSTEM";/.test(text);
      })
      .map((path) => (path.split(sep).join("/").split("/").pop() ?? "").replace(".ts", ""));

    expect(needsBinding.length).toBeGreaterThan(15);
    for (const name of needsBinding) {
      expect(Object.keys(authorizedActions), `${name} must be bound`).toContain(name);
    }
  });
});
