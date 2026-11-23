import { AppError } from "../errors/AppError";

/** 공급처가 취소 요청에 응답한 수량. 한 요청에 여러 번 나눠 응답할 수 있다 (BR-P02). */
export type CancellationResponseEffect = {
  acceptedQuantity: number;
  rejectedQuantity: number;
};

export type CancellationRequestStatus =
  | "REQUESTED"
  | "ACCEPTED"
  | "PARTIALLY_ACCEPTED"
  | "REJECTED";

export type CancellationRequestState = {
  requested: number;
  accepted: number;
  rejected: number;
  /** 미응답 수량: 요청량 − 수락 − 거절 */
  unanswered: number;
  /** 계산값이다. 저장하지 않는다. */
  status: CancellationRequestStatus;
};

/**
 * 취소 요청의 현재 상태를 응답에서 계산한다.
 * 미응답이 남아 있으면 일부가 수락·거절되었어도 REQUESTED다 (TC-77).
 * 응답 합이 요청량을 넘으면 거절한다(중복 응답 차단).
 */
export function cancellationRequestState(
  requested: number,
  responses: readonly CancellationResponseEffect[],
): CancellationRequestState {
  let accepted = 0;
  let rejected = 0;
  for (const response of responses) {
    accepted += response.acceptedQuantity;
    rejected += response.rejectedQuantity;
  }
  const unanswered = requested - accepted - rejected;
  if (unanswered < 0) {
    throw new AppError(
      "BUSINESS_INVARIANT",
      "responses exceed the requested cancellation quantity",
    );
  }

  let status: CancellationRequestStatus;
  if (unanswered > 0) status = "REQUESTED";
  else if (rejected === 0) status = "ACCEPTED";
  else if (accepted === 0) status = "REJECTED";
  else status = "PARTIALLY_ACCEPTED";

  return { requested, accepted, rejected, unanswered, status };
}
