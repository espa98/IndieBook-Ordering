import { describe, it, expect } from "vitest";
import { releaseStockReservation } from "../../src/inventory/releaseStockReservation";
import { AppError } from "../../src/errors/AppError";
import { notificationState } from "../../src/notification/notificationState";
import { recordNotificationAttempt } from "../../src/notification/recordNotificationAttempt";
import { attemptScene } from "../helpers/notificationFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("recordNotificationAttempt: 외부 발송 시도 기록 (ST-M03, MSG-005, MSG-010)", () => {
  it("직원이 외부 채널로 실제 안내를 시도했다는 사실을 채널·담당자·시각·문구 스냅샷과 함께 기록하며, 시도만으로는 안내 완료가 아니다(ATTEMPTED)", () => {
    const { deps, attemptRequest, target, notificationAttempts } = attemptScene();
    const targetBefore = structuredClone(target);

    const attempt = recordNotificationAttempt(deps, attemptRequest());

    expect(attempt).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      targetId: target.id,
      channel: "PHONE",
      messageSnapshot: "[책방] 주문하신 도서 2권이 모두 입고되었습니다. 수령 가능합니다.",
      attemptedBy: "김직원",
      attemptedAt: "2026-03-04T06:58:00.000Z",
      recordedAt: "2026-03-04T07:00:00.000Z",
    });
    expect(notificationAttempts.list("tenant-a", target.id)).toEqual([attempt]);
    expect(deps.notificationTargets.get("tenant-a", target.id)).toEqual(targetBefore);
    expect(notificationState({ attempts: [attempt], results: [] })).toBe("ATTEMPTED");
  });

  it("같은 안내 대상에 두 번째 발송 시도는 기록할 수 없다(중복 안내 방지, 다른 멱등 키여도 BUSINESS_INVARIANT 422)", () => {
    const { deps, attemptRequest, target, notificationAttempts } = attemptScene();
    recordNotificationAttempt(deps, attemptRequest());

    let thrown: unknown;
    try {
      recordNotificationAttempt(deps, attemptRequest({ channel: "SMS" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((thrown as AppError).httpStatus).toBe(422);
    expect(notificationAttempts.list("tenant-a", target.id)).toHaveLength(1);
  });

  it("채널이 허용 목록이 아니거나 문구 스냅샷·담당자가 비었거나 attemptedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, attemptRequest, target, notificationAttempts } = attemptScene();

    for (const bad of [
      attemptRequest({ channel: "CARRIER_PIGEON" as never }),
      attemptRequest({ messageSnapshot: " " }),
      attemptRequest({ attemptedBy: "" }),
      attemptRequest({ attemptedAt: "2026-03-04" }),
      attemptRequest({ attemptedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        recordNotificationAttempt(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(notificationAttempts.list("tenant-a", target.id)).toEqual([]);
  });

  it("없는 안내 대상이거나 다른 테넌트의 대상이면 NOT_FOUND 404이다", () => {
    const { deps, attemptRequest, target, notificationAttempts } = attemptScene();

    for (const bad of [
      attemptRequest({ targetId: "no-such-target" }),
      attemptRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        recordNotificationAttempt(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(notificationAttempts.list("tenant-a", target.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 시도를 돌려주고(이미 시도됨 오류가 아니다) 중복 기록하지 않는다", () => {
    const { deps, attemptRequest, target, notificationAttempts } = attemptScene();

    const first = recordNotificationAttempt(deps, attemptRequest({ idempotencyKey: "k" }));
    const replay = recordNotificationAttempt(deps, attemptRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(notificationAttempts.list("tenant-a", target.id)).toEqual([first]);
  });

  it("안내 대상을 만든 뒤 확보량이 바뀌었으면(대상이 obsolete) 그 문구로는 발송 시도를 기록할 수 없고, 기존 대상은 보존된다 (ST-M06)", () => {
    const { deps, attemptRequest, target, reservation, notificationAttempts } = attemptScene(); // 주문 D 확보 2
    releaseStockReservation(deps, {
      tenantId: "tenant-a",
      reservationId: reservation.id,
      quantity: 1,
      reason: "고객이 1권 취소",
      releasedBy: "김직원",
      releasedAt: "2026-03-04T06:57:00.000Z",
      idempotencyKey: "rel-D",
    }); // 확보 2 -> 1

    let thrown: unknown;
    try {
      recordNotificationAttempt(deps, attemptRequest());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BUSINESS_INVARIANT");
    expect(notificationAttempts.list("tenant-a", target.id)).toEqual([]);
    expect(deps.notificationTargets.get("tenant-a", target.id)).toEqual(target);
  });
});
