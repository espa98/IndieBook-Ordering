import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { notificationState } from "../../src/notification/notificationState";
import { recordNotificationCopy } from "../../src/notification/recordNotificationCopy";
import { copyScene } from "../helpers/notificationFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("recordNotificationCopy: 안내 문구 미리보기·복사·공유 (ST-M02, MSG-004, DEC-05)", () => {
  it("복사·공유를 기록해도 발송 완료로 간주하지 않고 안내 상태는 계속 대기(PENDING)다", () => {
    const { deps, copyRequest, target, notificationCopies } = copyScene();

    const copy = recordNotificationCopy(deps, copyRequest({ action: "COPY" }));
    recordNotificationCopy(deps, copyRequest({ action: "SHARE" }));

    expect(copy).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      targetId: target.id,
      action: "COPY",
      actedBy: "김직원",
      actedAt: "2026-03-04T06:56:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(notificationCopies.list("tenant-a", target.id)).toHaveLength(2);
    expect(notificationState({ attempts: [], results: [] })).toBe("PENDING");
  });

  it("동작이 PREVIEW·COPY·SHARE가 아니거나 담당자가 비었거나 actedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, copyRequest, target, notificationCopies } = copyScene();

    for (const bad of [
      copyRequest({ action: "SEND" as never }),
      copyRequest({ actedBy: " " }),
      copyRequest({ actedAt: "2026-03-04" }),
      copyRequest({ actedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        recordNotificationCopy(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(notificationCopies.list("tenant-a", target.id)).toEqual([]);
  });

  it("없는 안내 대상이거나 다른 테넌트의 대상이면 NOT_FOUND 404이다", () => {
    const { deps, copyRequest, target, notificationCopies } = copyScene();

    for (const bad of [
      copyRequest({ targetId: "no-such-target" }),
      copyRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        recordNotificationCopy(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(notificationCopies.list("tenant-a", target.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 기록을 돌려주고 중복 기록하지 않는다(다른 키의 복사는 각각 기록된다)", () => {
    const { deps, copyRequest, target, notificationCopies } = copyScene();

    const first = recordNotificationCopy(deps, copyRequest({ idempotencyKey: "k" }));
    const replay = recordNotificationCopy(deps, copyRequest({ idempotencyKey: "k" }));
    recordNotificationCopy(deps, copyRequest()); // 다른 키

    expect(replay).toEqual(first);
    expect(notificationCopies.list("tenant-a", target.id)).toHaveLength(2);
  });
});
