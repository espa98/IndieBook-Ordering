import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { AppError } from "../../src/errors/AppError";
import { authorizedActions } from "../../src/auth/authorizedActions";
import { createSystemPrincipal, type UserPrincipal } from "../../src/auth/principal";
import { executionScene } from "../helpers/closureFixtures";
import { world } from "../helpers/procurementWorld";
import { paymentCorrectionScene, paymentScene } from "../helpers/paymentFixtures";

const owner: UserPrincipal = { kind: "USER", userId: "owner-1", tenantId: "tenant-a", role: "OWNER" };
const staff: UserPrincipal = { kind: "USER", userId: "staff-1", tenantId: "tenant-a", role: "STAFF" };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

// 바인딩 인프라 자체(모음·바인더)만 제외한다. 직원 관리처럼 src/auth 안의 명령은 검사 대상이다
// managementGuard는 위임 검사 헬퍼일 뿐 명령이 아니다
const INFRASTRUCTURE = ["src/auth/authorizedActions.ts", "src/auth/bindActor.ts", "src/catalog/managementGuard.ts"];
const isCommandSource = (path: string) => !INFRASTRUCTURE.includes(path.split(sep).join("/"));

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
      .filter(isCommandSource)
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

  it("명령 입력에 행위자 이름 필드(...By)가 있는 모든 명령 파일도 이 모음에 바인딩되어 있다 (감사 귀속 위조 방지)", () => {
    const needsBinding = sourceFiles("src")
      .filter(isCommandSource)
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        // 멱등 키가 있는 요청 타입 = 외부에서 호출되는 명령 입력
        return [...text.matchAll(/export type \w+ = \{([\s\S]*?)\n\};/g)].some(
          (m) => /idempotencyKey/.test(m[1]!) && /^\s+\w+By: string/m.test(m[1]!),
        );
      })
      .map((path) => (path.split(sep).join("/").split("/").pop() ?? "").replace(".ts", ""));

    expect(needsBinding.length).toBeGreaterThan(40);
    const missing = needsBinding.filter((name) => !Object.keys(authorizedActions).includes(name));
    expect(missing).toEqual([]);
  });

  it("Staff 주체가 결제를 입력할 때 요청이 다른 사람 이름을 주장해도 기록되는 입력자는 주체의 사용자 ID이다", () => {
    const { deps, paymentRequest, payments } = paymentScene();
    const { tenantId: _t, recordedBy: _b, ...rest } = paymentRequest();

    const payment = authorizedActions.recordPayment(deps, staff, { ...rest, recordedBy: "점주" } as never);

    expect(payment.recordedBy).toBe("staff-1");
    expect(payments.list("tenant-a", payment.orderId)).toEqual([payment]);
  });

  it("테넌트와 멱등 키를 요청으로 받는 모든 명령 파일이 이 모음에 바인딩되어 있다 (행위자 필드가 없어도 tenantId 위조 방지)", () => {
    const needsBinding = sourceFiles("src")
      .filter(isCommandSource)
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return [...text.matchAll(/export type \w+ = \{([\s\S]*?)\n\};/g)].some(
          (m) => /^\s+tenantId: string/m.test(m[1]!) && /idempotencyKey: string/.test(m[1]!),
        );
      })
      .map((path) => (path.split(sep).join("/").split("/").pop() ?? "").replace(".ts", ""));

    expect(needsBinding.length).toBeGreaterThan(50);
    const missing = needsBinding.filter((name) => !Object.keys(authorizedActions).includes(name));
    expect(missing).toEqual([]);
  });

  it("Staff 주체가 조달 배정을 만들 때 요청이 다른 테넌트를 주장해도 주체의 테넌트로 처리된다", () => {
    const w = world();
    const order = w.addOrder([{ bookId: "book-1", quantity: 2, unitPriceKrw: "15000" }]);

    const allocation = authorizedActions.allocateSourcing(w.deps, staff, {
      orderId: order.id,
      lineId: order.lines[0]!.lineId,
      supplierCode: "sup-a",
      quantity: 2,
      idempotencyKey: "alloc-bound",
      tenantId: "tenant-b", // 위조 시도
    } as never);

    expect(allocation.tenantId).toBe("tenant-a");
    expect(w.deps.allocations.list("tenant-b")).toEqual([]);
  });
});
