import { describe, it, expect } from "vitest";
import { AppError } from "../../src/errors/AppError";
import { recordReturnReply } from "../../src/inventory/recordReturnReply";
import { returnReplyScene } from "../helpers/inventoryFixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("recordReturnReply: 공급처 반품 회신 (ST-C03, UC-28, BR-C01)", () => {
  it("공급처가 일부 수량만 수락하면 회신 기록이 남고 미응답 수량은 RETURN_PENDING으로 남는다(부분 회신)", () => {
    const { deps, replyRequest, returnRequestRecord } = returnReplyScene(); // 반품 요청 2
    const requestBefore = structuredClone(returnRequestRecord);

    const reply = recordReturnReply(deps, replyRequest({ acceptedQuantity: 1, rejectedQuantity: 0 }));

    expect(reply).toEqual({
      id: expect.stringMatching(UUID_RE),
      tenantId: "tenant-a",
      returnRequestId: returnRequestRecord.id,
      acceptedQuantity: 1,
      rejectedQuantity: 0,
      evidence: "공급처 이메일 2026-03-05 반품 수락 회신",
      repliedBy: "김직원",
      repliedAt: "2026-03-04T06:59:30.000Z",
      recordedAt: expect.any(String),
    });
    expect(deps.returnReplies.list("tenant-a", returnRequestRecord.id)).toEqual([reply]);
    expect(deps.returnRequests.get("tenant-a", returnRequestRecord.id)).toEqual(requestBefore);
  });

  it("수락+거절 합계가 미응답 잔량(요청 2)을 넘으면 BUSINESS_INVARIANT 422이고 부분 회신을 합산한다", () => {
    const { deps, replyRequest, returnRequestRecord } = returnReplyScene();
    const reply = (acceptedQuantity: number, rejectedQuantity: number) => {
      try {
        recordReturnReply(deps, replyRequest({ acceptedQuantity, rejectedQuantity }));
      } catch (error) {
        return error;
      }
    };

    const tooMany = reply(2, 1);
    expect(tooMany).toBeInstanceOf(AppError);
    expect((tooMany as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((tooMany as AppError).httpStatus).toBe(422);
    expect(reply(1, 0)).toBeUndefined(); // 미응답 1
    expect(reply(1, 1)).toBeInstanceOf(AppError); // 1 초과
    expect(reply(0, 1)).toBeUndefined(); // 미응답 0
    expect(reply(1, 0)).toBeInstanceOf(AppError);
    expect(deps.returnReplies.list("tenant-a", returnRequestRecord.id)).toHaveLength(2);
  });

  it("수량이 0 이상 정수가 아니거나 합이 0이거나 근거·회신자가 비었거나 repliedAt이 잘못·미래이면 VALIDATION_ERROR 400이다", () => {
    const { deps, replyRequest, returnRequestRecord } = returnReplyScene();

    for (const bad of [
      replyRequest({ acceptedQuantity: 0, rejectedQuantity: 0 }),
      replyRequest({ acceptedQuantity: -1 }),
      replyRequest({ rejectedQuantity: 1.5 }),
      replyRequest({ acceptedQuantity: Number.NaN }),
      replyRequest({ evidence: " " }),
      replyRequest({ repliedBy: "" }),
      replyRequest({ repliedAt: "2026-03-04" }),
      replyRequest({ repliedAt: "2999-03-04T08:00:00.000Z" }),
    ]) {
      let thrown: unknown;
      try {
        recordReturnReply(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(deps.returnReplies.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("없는 반품 요청이거나 다른 테넌트의 요청이면 NOT_FOUND 404이다", () => {
    const { deps, replyRequest, returnRequestRecord } = returnReplyScene();

    for (const bad of [
      replyRequest({ returnRequestId: "no-such-request" }),
      replyRequest({ tenantId: "tenant-b" }),
    ]) {
      let thrown: unknown;
      try {
        recordReturnReply(deps, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("NOT_FOUND");
      expect((thrown as AppError).httpStatus).toBe(404);
    }
    expect(deps.returnReplies.list("tenant-a", returnRequestRecord.id)).toEqual([]);
  });

  it("같은 멱등 키로 재호출하면 같은 회신을 돌려주고 중복 기록하지 않는다", () => {
    const { deps, replyRequest, returnRequestRecord } = returnReplyScene();

    const first = recordReturnReply(deps, replyRequest({ idempotencyKey: "k" }));
    const replay = recordReturnReply(deps, replyRequest({ idempotencyKey: "k" }));

    expect(replay).toEqual(first);
    expect(deps.returnReplies.list("tenant-a", returnRequestRecord.id)).toEqual([first]);
  });

  it("같은 멱등 키에 다른 내용이면 IDEMPOTENCY_CONFLICT 409이다", () => {
    const { deps, replyRequest, returnRequestRecord } = returnReplyScene();
    recordReturnReply(deps, replyRequest({ acceptedQuantity: 1, idempotencyKey: "k" }));

    let thrown: unknown;
    try {
      recordReturnReply(deps, replyRequest({ acceptedQuantity: 0, rejectedQuantity: 1, idempotencyKey: "k" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((thrown as AppError).httpStatus).toBe(409);
    expect(deps.returnReplies.list("tenant-a", returnRequestRecord.id)).toHaveLength(1);
  });
});
