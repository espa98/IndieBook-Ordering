import { describe, it, expect } from "vitest";
import { resolveReturnException } from "../../src/inventory/resolveReturnException";
import { completeReturn } from "../../src/inventory/completeReturn";
import { recordReturnReply } from "../../src/inventory/recordReturnReply";
import { transferCancelledToStock } from "../../src/inventory/transferCancelledToStock";
import { cancelAllocation } from "../../src/inventory/cancelAllocation";
import { correctReceipt } from "../../src/inventory/correctReceipt";
import { deliverAllocation } from "../../src/inventory/deliverAllocation";
import { allocateReceipt } from "../../src/inventory/allocateReceipt";
import { receiptBalances } from "../../src/inventory/receiptBalances";
import { releaseAllocation } from "../../src/inventory/releaseAllocation";
import { allocationScene, cancellationScene, completionScene, resolutionScene, intakeScene, correctionScene, deliveryScene, releaseScene } from "../helpers/inventoryFixtures";

describe("receiptBalances: 입고 기록과 배분 기록에서 버킷 잔량 산출 (BR-Q14, BR-Q17)", () => {
  it("배분하지 않으면 정상 입고량 전부가 UNALLOCATED이고, 배분하면 그만큼 ALLOCATED_OPEN으로 옮겨진다", () => {
    const { deps, request, receipt, orders } = allocationScene();
    const balancesOf = () =>
      receiptBalances(receipt, deps.receiptAllocations.list("tenant-a", receipt.id));

    expect(balancesOf()).toMatchObject({ UNALLOCATED: 4, ALLOCATED_OPEN: 0 });

    allocateReceipt(deps, request({ quantity: 2 }));
    allocateReceipt(
      deps,
      request({ orderId: orders[1]!.id, orderLineId: orders[1]!.lines[0]!.lineId, quantity: 1 }),
    );

    expect(balancesOf()).toEqual({
      UNALLOCATED: 1,
      ALLOCATED_OPEN: 3,
      DELIVERED_NET: 0,
      DISPOSITION_PENDING: 0,
      RETURN_HELD: 0,
      RETURN_DISPATCHED: 0,
      RETURNED_FINAL: 0,
      STOCK_TRANSFERRED: 0,
    });
  });

  it("배분을 해제하면 그만큼 ALLOCATED_OPEN에서 UNALLOCATED로 돌아온다", () => {
    const { deps, request, receipt, allocation } = releaseScene();
    const balancesOf = () =>
      receiptBalances(
        receipt,
        deps.receiptAllocations.list("tenant-a", receipt.id),
        deps.allocationReleases.list("tenant-a", allocation.id),
      );

    expect(balancesOf()).toMatchObject({ UNALLOCATED: 1, ALLOCATED_OPEN: 3 }); // 4권 중 3권 배분

    releaseAllocation(deps, request({ quantity: 2 }));

    expect(balancesOf()).toMatchObject({ UNALLOCATED: 3, ALLOCATED_OPEN: 1 });
  });

  it("인도하면 그만큼 ALLOCATED_OPEN에서 DELIVERED_NET으로 옮겨진다", () => {
    const { deps, request, releaseRequest, receipt, allocation } = deliveryScene();
    const balancesOf = () =>
      receiptBalances(
        receipt,
        deps.receiptAllocations.list("tenant-a", receipt.id),
        deps.allocationReleases.list("tenant-a", allocation.id),
        deps.allocationDeliveries.list("tenant-a", allocation.id),
      );

    deliverAllocation(deps, request({ quantity: 2 }));
    expect(balancesOf()).toMatchObject({ UNALLOCATED: 1, ALLOCATED_OPEN: 1, DELIVERED_NET: 2 });

    releaseAllocation(deps, releaseRequest({ quantity: 1 }));
    expect(balancesOf()).toMatchObject({ UNALLOCATED: 2, ALLOCATED_OPEN: 0, DELIVERED_NET: 2 });
  });

  it("입고 정정은 정상 순량과 UNALLOCATED를 그만큼 줄인다(버킷 합계는 정상 순량과 같다)", () => {
    const { deps, correctRequest, receipt } = correctionScene();

    correctReceipt(deps, correctRequest({ quantity: 1 }));

    const balances = receiptBalances(
      receipt,
      deps.receiptAllocations.list("tenant-a", receipt.id),
      [],
      [],
      deps.receiptCorrections.list("tenant-a", receipt.id),
    );
    expect(balances.UNALLOCATED).toBe(3);
    expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("주문 취소 처분은 UNALLOCATED가 아니라 DISPOSITION_PENDING으로 직접 이동한다 (BR-Q21)", () => {
    const { deps, cancelRequest, receipt, allocation } = cancellationScene(); // 4권 중 3권 배분
    cancelAllocation(deps, cancelRequest({ quantity: 2 }));

    const balances = receiptBalances(
      receipt,
      deps.receiptAllocations.list("tenant-a", receipt.id),
      [],
      [],
      [],
      deps.allocationCancellations.list("tenant-a", allocation.id),
    );

    expect(balances).toMatchObject({
      UNALLOCATED: 1,
      ALLOCATED_OPEN: 1,
      DISPOSITION_PENDING: 2,
    });
    expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("재고 편입하면 그만큼 DISPOSITION_PENDING에서 STOCK_TRANSFERRED로 옮겨지고 버킷 합계는 보존된다", () => {
    const { deps, intakeRequest, cancellation, receipt } = intakeScene(); // 처분 대기 2
    transferCancelledToStock(deps, intakeRequest({ quantity: 1 }));

    const balances = receiptBalances(
      receipt,
      deps.receiptAllocations.list("tenant-a", receipt.id),
      [],
      [],
      [],
      deps.allocationCancellations.list("tenant-a", cancellation.allocationId),
      deps.stockIntakes.list("tenant-a", cancellation.id),
    );

    expect(balances).toMatchObject({ DISPOSITION_PENDING: 1, STOCK_TRANSFERRED: 1 });
    expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("반품 요청·출고·완료·거절이 각각 RETURN_HELD·RETURN_DISPATCHED·RETURNED_FINAL·DISPOSITION_PENDING으로 옮기고 합계는 보존된다", () => {
    const { deps, completeRequest, replyRequest, receipt, cancellation, returnRequestRecord } =
      completionScene(); // 처분 대기 2 -> 반품 요청 2, 수락 1, 출고 1
    const balancesOf = () =>
      receiptBalances(
        receipt,
        deps.receiptAllocations.list("tenant-a", receipt.id),
        [],
        [],
        [],
        deps.allocationCancellations.list("tenant-a", cancellation.allocationId),
        deps.stockIntakes.list("tenant-a", cancellation.id),
        {
          requests: deps.returnRequests.list("tenant-a", cancellation.id),
          replies: deps.returnReplies.list("tenant-a", returnRequestRecord.id),
          dispatches: deps.returnDispatches.list("tenant-a", returnRequestRecord.id),
          completions: deps.returnCompletions.list("tenant-a", returnRequestRecord.id),
        },
      );
    const total = (b: Record<string, number>) => Object.values(b).reduce((x, y) => x + y, 0);

    expect(balancesOf()).toMatchObject({
      DISPOSITION_PENDING: 0,
      RETURN_HELD: 1, // 출고 전 1 (수락 대기 포함)
      RETURN_DISPATCHED: 1,
      RETURNED_FINAL: 0,
    });
    expect(total(balancesOf())).toBe(4);

    completeReturn(deps, completeRequest({ quantity: 1 }));
    expect(balancesOf()).toMatchObject({ RETURN_DISPATCHED: 0, RETURNED_FINAL: 1 });

    recordReturnReply(deps, replyRequest({ acceptedQuantity: 0, rejectedQuantity: 1, idempotencyKey: "rep-rej" }));
    expect(balancesOf()).toMatchObject({ RETURN_HELD: 0, DISPOSITION_PENDING: 1 }); // 거절은 처분 대기로 복귀
    expect(total(balancesOf())).toBe(4);
  });

  it("반송 예외는 회수·검수 확인(RECOVERED) 시 처분 대기로, 공급처 최종 확인(RETURNED) 시 반품 완료로 귀속되고 합계는 보존된다", () => {
    const total = (b: Record<string, number>) => Object.values(b).reduce((x, y) => x + y, 0);
    const balancesFor = (scene: ReturnType<typeof resolutionScene>) =>
      receiptBalances(
        scene.receipt,
        scene.deps.receiptAllocations.list("tenant-a", scene.receipt.id),
        [],
        [],
        [],
        scene.deps.allocationCancellations.list("tenant-a", scene.cancellation.allocationId),
        scene.deps.stockIntakes.list("tenant-a", scene.cancellation.id),
        {
          requests: scene.deps.returnRequests.list("tenant-a", scene.cancellation.id),
          replies: scene.deps.returnReplies.list("tenant-a", scene.returnRequestRecord.id),
          dispatches: scene.deps.returnDispatches.list("tenant-a", scene.returnRequestRecord.id),
          completions: scene.deps.returnCompletions.list("tenant-a", scene.returnRequestRecord.id),
          resolutions: scene.deps.returnExceptionResolutions.list(
            "tenant-a",
            scene.returnException.id,
          ),
        },
      );

    const recovered = resolutionScene();
    expect(balancesFor(recovered)).toMatchObject({ RETURN_DISPATCHED: 1, DISPOSITION_PENDING: 0 }); // 신고만으로는 이동 없음
    resolveReturnException(recovered.deps, recovered.resolveRequest({ outcome: "RECOVERED" }));
    expect(balancesFor(recovered)).toMatchObject({ RETURN_DISPATCHED: 0, DISPOSITION_PENDING: 1, RETURNED_FINAL: 0 });
    expect(total(balancesFor(recovered))).toBe(4);

    const returned = resolutionScene();
    resolveReturnException(returned.deps, returned.resolveRequest({ outcome: "RETURNED" }));
    expect(balancesFor(returned)).toMatchObject({ RETURN_DISPATCHED: 0, DISPOSITION_PENDING: 0, RETURNED_FINAL: 1 });
    expect(total(balancesFor(returned))).toBe(4);
  });
});
