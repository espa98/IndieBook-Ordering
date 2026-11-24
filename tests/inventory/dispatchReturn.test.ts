import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { recordReturnReply } from "../../src/inventory/recordReturnReply";
import { dispatchReturn } from "../../src/inventory/dispatchReturn";
import { dispatchScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("dispatchReturn: 반품 출고 (ST-C04, UC-28, D31)", () => {
  it("수락된 수량을 실제로 출고하면 수량·참조번호를 가진 출고 기록이 남고 반품 요청은 바뀌지 않는다", () => {
    const { deps, dispatchRequest, returnRequestRecord } = dispatchScene(); // 요청 2, 수락 1
    const requestBefore = structuredClone(returnRequestRecord);

    const dispatch = dispatchReturn(deps, dispatchRequest({ quantity: 1 }));

    expect(dispatch).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      returnRequestId: returnRequestRecord.id,
      quantity: 1,
      dispatchedBy: "김직원",
      dispatchedAt: "2026-03-04T06:59:45.000Z",
      referenceNumber: "TRK-001",
      recordedAt: expect.any(String),
    });
    expect(deps.returnDispatches.list("tenant-a", returnRequestRecord.id)).toEqual([dispatch]);
    expect(deps.returnRequests.get("tenant-a", returnRequestRecord.id)).toEqual(requestBefore);
  });

  it("출고는 수락된 미출고 수량까지만 가능하고(미응답·거절·기출고 제외) 추가 수락 후에는 그만큼 더 출고할 수 있다", () => {
    const { deps, dispatchRequest, replyRequest, returnRequestRecord } = dispatchScene(); // 요청 2, 수락 1, 미응답 1
    const dispatch = (quantity: number) => {
      try {
        dispatchReturn(deps, dispatchRequest({ quantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = dispatch(2); // 수락은 1뿐
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(dispatch(1)).toBeUndefined(); // 수락분 소진
    expect(dispatch(1)).toBeInstanceOf(AppError); // 미응답 1은 출고 불가

    recordReturnReply(deps, replyRequest({ acceptedQuantity: 0, rejectedQuantity: 1, idempotencyKey: "rep-2" })); // 거절 1
    expect(dispatch(1)).toBeInstanceOf(AppError); // 거절 수량은 출고 불가
    expect(deps.returnDispatches.list("tenant-a", returnRequestRecord.id)).toHaveLength(1);
  });

  it("수량이 1 이상 정수가 아니거나 출고자·참조번호가 비었거나 dispatchedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, dispatchRequest, returnRequestRecord } = dispatchScene();

    for (const bad of [
      dispatchRequest({ quantity: 0 }),
      dispatchRequest({ quantity: -1 }),
      dispatchRequest({ quantity: 1.5 }),
      dispatchRequest({ quantity: Number.NaN }),
      dispatchRequest({ dispatchedBy: " " }),
      dispatchRequest({ referenceNumber: " " }),
      dispatchRequest({ dispatchedAt: "2026-03-04" }),
      dispatchRequest({ dispatchedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        dispatchReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.returnDispatches.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("없는 반품 요청이거나 다른 테넌트의 요청이면 NOT_FOUND 404이다", () => {
    const { deps, dispatchRequest, returnRequestRecord } = dispatchScene();

    for (const bad of [
      dispatchRequest({ returnRequestId: "no-such-request" }),
      dispatchRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        dispatchReturn(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.returnDispatches.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 출고를 돌려주고 중복 기록하지 않는다", () => {
    const { deps, dispatchRequest, returnRequestRecord } = dispatchScene();

    const first = dispatchReturn(deps, dispatchRequest({ idempotencyKey: "k" }));
    const replay = dispatchReturn(deps, dispatchRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.returnDispatches.list("tenant-a", returnRequestRecord.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, dispatchRequest, returnRequestRecord } = dispatchScene();
    dispatchReturn(deps, dispatchRequest({ referenceNumber: "TRK-001", idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      dispatchReturn(deps, dispatchRequest({ referenceNumber: "TRK-002", idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.returnDispatches.list("tenant-a", returnRequestRecord.id)).toHaveLength(1);
  });
});
