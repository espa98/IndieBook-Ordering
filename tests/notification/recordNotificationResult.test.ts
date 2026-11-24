import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { notificationState } from "../../src/notification/notificationState";
import { recordNotificationResult } from "../../src/notification/recordNotificationResult";
import { resultScene } from "../helpers/notificationFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("recordNotificationResult: 직원이 확인한 안내 결과 기록 (ST-M04, MSG-005/006/010)", () => {
  it("직원이 안내를 마쳤다고 기록하면 근거와 함께 남고, 고객 수신·읽음은 추정하거나 저장하지 않는다", () => {
    const { deps, resultRequest, attempt, target, notificationResults } = resultScene();

    const result = recordNotificationResult(deps, resultRequest({ outcome: "MANUAL_RECORDED" }));

    expect(result).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      targetId: target.id,
      attemptId: attempt.id,
      outcome: "MANUAL_RECORDED",
      note: "고객 본인과 통화하여 수령 가능 안내를 구두로 전달함",
      recordedBy: "김직원",
      resultAt: "2026-03-04T06:59:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    for (const inferred of ["received", "receivedAt", "read", "readAt", "delivered"]) {
      expect(result).not.toHaveProperty(inferred);
    }
    expect(notificationResults.list("tenant-a", target.id)).toEqual([result]);
    expect(
      notificationState({
        attempts: deps.notificationAttempts.list("tenant-a", target.id),
        results: notificationResults.list("tenant-a", target.id),
      }),
    ).toBe("MANUAL_RECORDED");
  });

  it("이미 결과가 기록된 시도에 다른 결과를 기록할 수 없다(결과를 덮어쓰지 않는다, BUSINESS_INVARIANT 422)", () => {
    const { deps, resultRequest, target, notificationResults } = resultScene();
    recordNotificationResult(deps, resultRequest({ outcome: "FAILED", note: "연락 두절, 전화 받지 않음" }));

    let thrown: unknown;
    try {
      recordNotificationResult(deps, resultRequest({ outcome: "MANUAL_RECORDED" })); // 새 멱등 키
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).httpStatus).toBe(422);
    expect(notificationResults.list("tenant-a", target.id).map((r) => r.outcome)).toEqual(["FAILED"]);
  });

  it("결과 종류가 잘못이거나 근거(note)·기록자가 비었거나 resultAt이 잘못·미래이면 VALIDATION_ERROR 400이다 (근거 없는 완료·실패 금지)", () => {
    const { deps, resultRequest, target, notificationResults } = resultScene();

    for (const bad of [
      resultRequest({ outcome: "READ" as never }),
      resultRequest({ note: " " }),
      resultRequest({ recordedBy: "" }),
      resultRequest({ resultAt: "2026-03-04" }),
      resultRequest({ resultAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        recordNotificationResult(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(notificationResults.list("tenant-a", target.id)).toEqual([]);
  });

  it("시도 기록이 없거나 다른 테넌트의 시도면 NOT_FOUND 404이다 (시도 없이 결과를 기록할 수 없다)", () => {
    const { deps, resultRequest, target, notificationResults } = resultScene();

    for (const bad of [
      resultRequest({ attemptId: "no-such-attempt" }),
      resultRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        recordNotificationResult(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(notificationResults.list("tenant-a", target.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 결과를 돌려주고(이미 결과 있음 오류가 아니다) 중복 기록하지 않는다", () => {
    const { deps, resultRequest, target, notificationResults } = resultScene();

    const first = recordNotificationResult(deps, resultRequest({ idempotencyKey: "k" }));
    const replay = recordNotificationResult(deps, resultRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(notificationResults.list("tenant-a", target.id)).toEqual([first]);
  });
});
