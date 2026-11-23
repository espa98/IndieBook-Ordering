import { describe, it, expect } from "vitest";
import { cancellationRequestState } from "../../src/procurement/cancellationRequestState";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";

const r = (acceptedQuantity: number, rejectedQuantity: number) => ({
  acceptedQuantity,
  rejectedQuantity,
});

describe("cancellationRequestState: 요청량 = 수락 + 거절 + 미응답 (BR-P02)", () => {
  it("응답이 없으면 전부 미응답이고 REQUESTED다", () => {
    expect(cancellationRequestState(4, [])).toEqual({
      requested: 4,
      accepted: 0,
      rejected: 0,
      unanswered: 4,
      status: "REQUESTED",
    });
  });

  it("TC-77: 요청 4권에 수락 2·거절 1이면 미응답 1이 남고 REQUESTED를 유지한다", () => {
    const state = cancellationRequestState(4, [r(2, 0), r(0, 1)]); // 부분 응답 2번

    expect(state).toEqual({
      requested: 4,
      accepted: 2,
      rejected: 1,
      unanswered: 1,
      status: "REQUESTED",
    });
  });

  it("일부가 수락되었어도 미응답이 남아 있으면 REQUESTED이다 (ACCEPTED가 아니다)", () => {
    expect(cancellationRequestState(4, [r(3, 0)]).status).toBe("REQUESTED");
  });

  it.each([
    ["전부 수락", [r(4, 0)], "ACCEPTED"],
    ["나눠서 전부 수락", [r(1, 0), r(3, 0)], "ACCEPTED"],
    ["전부 거절", [r(0, 4)], "REJECTED"],
    ["수락과 거절이 섞여 모두 응답", [r(2, 2)], "PARTIALLY_ACCEPTED"],
    ["여러 번에 나눠 섞여 모두 응답", [r(1, 0), r(0, 1), r(1, 1)], "PARTIALLY_ACCEPTED"],
  ] as const)("모두 응답하면: %s", (_name, responses, status) => {
    const state = cancellationRequestState(4, responses);

    expect(state.unanswered).toBe(0);
    expect(state.status).toBe(status);
  });

  it("응답 합이 요청량을 넘으면 BUSINESS_INVARIANT(422)이다 (중복 응답 차단)", () => {
    const error = thrown(() => cancellationRequestState(4, [r(3, 0), r(2, 0)])); // 5 > 4

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
    expect((error as AppError).httpStatus).toBe(422);
  });

  it("합이 정확히 요청량이면 허용한다 (경계값)", () => {
    expect(() => cancellationRequestState(4, [r(2, 2)])).not.toThrow();
  });

  it("어떤 응답 순서에서도 수락 + 거절 + 미응답 = 요청량이다", () => {
    const responses = [r(1, 0), r(0, 2), r(1, 0)];
    for (let n = 0; n <= responses.length; n++) {
      const s = cancellationRequestState(5, responses.slice(0, n));

      expect(s.accepted + s.rejected + s.unanswered).toBe(5);
    }
  });
});
