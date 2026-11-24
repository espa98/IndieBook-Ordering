import { describe, it, expect } from "vitest";
import { recordNotificationResult } from "../../src/notification/recordNotificationResult";
import { AppError } from "../../src/errors/AppError";
import { renotify } from "../../src/notification/renotify";
import { notificationState } from "../../src/notification/notificationState";
import { attemptScene, failedNotificationScene, resultScene } from "../helpers/notificationFixtures";

describe("renotify: 실패한 안내의 재안내 (ST-M05, MSG-006, DEC-05)", () => {
  it("실패한 안내를 재안내하면 원 대상·시도·결과는 보존되고, 최신 확보량 스냅샷과 원 대상 참조를 가진 새 대기 대상이 생긴다", () => {
    const { deps, renotifyRequest, target, notificationAttempts, notificationResults } =
      failedNotificationScene();
    const targetBefore = structuredClone(target);

    const next = renotify(deps, renotifyRequest());

    expect(next).toMatchObject({
      tenantId: "tenant-a",
      orderId: target.orderId,
      mode: target.mode,
      renoticeOfTargetId: target.id,
      securedTotal: 2,
      createdBy: "김직원",
    });
    expect(next.id).not.toBe(target.id);
    expect(deps.notificationTargets.get("tenant-a", target.id)).toEqual(targetBefore);
    expect(notificationAttempts.list("tenant-a", target.id)).toHaveLength(1);
    expect(notificationResults.list("tenant-a", target.id).map((r) => r.outcome)).toEqual(["FAILED"]);
    expect(
      notificationState({
        attempts: notificationAttempts.list("tenant-a", next.id),
        results: notificationResults.list("tenant-a", next.id),
      }),
    ).toBe("PENDING");
  });

  it("안내가 실패하지 않은 대상(대기·시도 중·성공)은 재안내할 수 없고, 이미 재안내한 실패 대상을 다시 재안내할 수 없다", () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as AppError).code;
      }
    };

    const pending = attemptScene(); // 시도 전(대기)
    expect(code(() => renotify(pending.deps, { tenantId: "tenant-a", targetId: pending.target.id, createdBy: "김직원", createdAt: "2026-03-04T06:59:30.000Z", idempotencyKey: "r1" }))).toBe("BUSINESS_INVARIANT");

    const attempted = resultScene(); // 시도만 있고 결과 없음
    expect(code(() => renotify(attempted.deps, { tenantId: "tenant-a", targetId: attempted.target.id, createdBy: "김직원", createdAt: "2026-03-04T06:59:30.000Z", idempotencyKey: "r2" }))).toBe("BUSINESS_INVARIANT");

    const succeeded = resultScene();
    recordNotificationResult(succeeded.deps, succeeded.resultRequest({ outcome: "MANUAL_RECORDED" }));
    expect(code(() => renotify(succeeded.deps, { tenantId: "tenant-a", targetId: succeeded.target.id, createdBy: "김직원", createdAt: "2026-03-04T06:59:30.000Z", idempotencyKey: "r3" }))).toBe("BUSINESS_INVARIANT");

    const failed = failedNotificationScene();
    renotify(failed.deps, failed.renotifyRequest());
    expect(code(() => renotify(failed.deps, failed.renotifyRequest()))).toBe("BUSINESS_INVARIANT"); // 이미 재안내됨
    expect(failed.deps.notificationTargets.list("tenant-a", failed.target.orderId)).toHaveLength(2);
  });

  it("담당자가 비었거나 createdAt이 잘못·미래이면 VALIDATION_ERROR 400, 없는 대상·다른 테넌트는 NOT_FOUND 404이다", () => {
    const { deps, renotifyRequest, target } = failedNotificationScene();
    const code = (request: ReturnType<typeof renotifyRequest>) => {
      try {
        renotify(deps, request);
      } catch (error) {
        return (error as AppError).code;
      }
    };

    expect(code(renotifyRequest({ createdBy: " " }))).toBe("VALIDATION_ERROR");
    expect(code(renotifyRequest({ createdAt: "2026-03-04" }))).toBe("VALIDATION_ERROR");
    expect(code(renotifyRequest({ createdAt: "2999-03-04T08:00:00.000Z" }))).toBe("VALIDATION_ERROR");
    expect(code(renotifyRequest({ targetId: "no-such-target" }))).toBe("NOT_FOUND");
    expect(code(renotifyRequest({ tenantId: "tenant-b" }))).toBe("NOT_FOUND");
    expect(deps.notificationTargets.list("tenant-a", target.orderId)).toHaveLength(1);
  });

  it("같은 멱등 키로 재호출하면 같은 재안내 대상을 돌려주고(이미 재안내됨 오류가 아니다) 중복 생성하지 않는다", () => {
    const { deps, renotifyRequest, target } = failedNotificationScene();

    const first = renotify(deps, renotifyRequest({ idempotencyKey: "k" }));
    const replay = renotify(deps, renotifyRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.notificationTargets.list("tenant-a", target.orderId)).toHaveLength(2);
  });
});
