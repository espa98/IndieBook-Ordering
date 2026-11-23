import { describe, it, expect } from "vitest";
import { poLineState } from "../../src/procurement/poLineState";
import { AppError } from "../../src/errors/AppError";
import { thrown } from "../helpers/thrown";

describe("poLineState: 발주 품목 수량을 미응답/지연/확정/품절 4개 풀로 나눈다 (BR-P01, ST-P07)", () => {
  it("회신이 없으면 전부 미응답이고 Qreduce는 0, Qvalid는 Qsend다 (회신 없는 발주를 확인으로 추정하지 않는다)", () => {
    expect(poLineState(10, [])).toEqual({
      qsend: 10,
      unanswered: 10,
      delayed: 0,
      confirmed: 0,
      outOfStock: 0,
      qreduce: 0,
      qvalid: 10,
    });
  });

  it("확정과 품절은 미응답에서 빠지고, 품절 확정 수량만 Qreduce가 된다", () => {
    const state = poLineState(10, [
      { kind: "CONFIRM", quantity: 3 },
      { kind: "OUT_OF_STOCK", quantity: 2 },
    ]);

    expect(state).toEqual({
      qsend: 10,
      unanswered: 5,
      delayed: 0,
      confirmed: 3,
      outOfStock: 2,
      qreduce: 2,
      qvalid: 8,
    });
  });

  it("지연은 Qreduce에 넣지 않는다: Qvalid는 그대로다 (BR-P01)", () => {
    const state = poLineState(10, [{ kind: "DELAY", quantity: 4 }]);

    expect(state).toMatchObject({ delayed: 4, unanswered: 6, qreduce: 0, qvalid: 10 });
  });

  describe("지연 수량의 전환 (사용자 결정 1: 허용)", () => {
    it("지연 수량을 나중에 확정으로 바꾸면 지연 풀에서 빠지고 Qvalid는 그대로다", () => {
      const state = poLineState(10, [
        { kind: "DELAY", quantity: 4 },
        { kind: "CONFIRM", quantity: 4, source: "DELAYED" },
      ]);

      expect(state).toMatchObject({ delayed: 0, confirmed: 4, unanswered: 6, qreduce: 0, qvalid: 10 });
    });

    it("지연 수량이 결국 품절로 확정되면 그때 Qreduce가 늘어난다", () => {
      const state = poLineState(10, [
        { kind: "DELAY", quantity: 4 },
        { kind: "OUT_OF_STOCK", quantity: 4, source: "DELAYED" },
      ]);

      expect(state).toMatchObject({ delayed: 0, outOfStock: 4, qreduce: 4, qvalid: 6 });
    });

    it("지연 수량 일부만 전환할 수 있다", () => {
      const state = poLineState(10, [
        { kind: "DELAY", quantity: 5 },
        { kind: "CONFIRM", quantity: 2, source: "DELAYED" },
        { kind: "OUT_OF_STOCK", quantity: 1, source: "DELAYED" },
      ]);

      expect(state).toMatchObject({ delayed: 2, confirmed: 2, outOfStock: 1, unanswered: 5, qreduce: 1, qvalid: 9 });
    });

    it("source를 생략하면 미응답에서 가져온다 (지연 풀은 건드리지 않는다)", () => {
      const state = poLineState(10, [
        { kind: "DELAY", quantity: 4 },
        { kind: "CONFIRM", quantity: 3 }, // source 생략: 미응답(6)에서
      ]);

      expect(state).toMatchObject({ delayed: 4, confirmed: 3, unanswered: 3 });
    });
  });

  describe("풀에 있는 수량보다 많이 가져가는 이벤트는 거절한다 (수량 이중 사용 방지)", () => {
    const reject = (qsend: number, events: Parameters<typeof poLineState>[1]) => {
      const error = thrown(() => poLineState(qsend, events));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
    };

    it.each(["CONFIRM", "OUT_OF_STOCK", "DELAY"] as const)(
      "%s가 미응답 수량을 넘으면 거절한다",
      (kind) => {
        reject(10, [{ kind, quantity: 11 }]);
      },
    );

    it("이미 분류한 수량을 또 분류하면 거절한다 (확정 6 + 품절 5 > 10)", () => {
      reject(10, [
        { kind: "CONFIRM", quantity: 6 },
        { kind: "OUT_OF_STOCK", quantity: 5 },
      ]);
    });

    it("지연 풀의 수량을 넘는 전환은 거절한다", () => {
      reject(10, [
        { kind: "DELAY", quantity: 2 },
        { kind: "CONFIRM", quantity: 3, source: "DELAYED" },
      ]);
    });

    it("지연 풀이 비어 있으면 DELAYED에서 가져올 수 없다", () => {
      reject(10, [{ kind: "OUT_OF_STOCK", quantity: 1, source: "DELAYED" }]);
    });

    it("source를 생략하면 미응답에서 가져가므로, 미응답이 모자라면 지연 풀에 수량이 있어도 거절한다", () => {
      reject(10, [
        { kind: "DELAY", quantity: 6 }, // 미응답 4, 지연 6
        { kind: "CONFIRM", quantity: 5 }, // source 생략 → 미응답(4)에서 5는 불가
      ]);
    });

    it("풀을 정확히 다 쓰는 것은 허용한다 (경계값)", () => {
      expect(poLineState(10, [{ kind: "CONFIRM", quantity: 10 }])).toMatchObject({ unanswered: 0, confirmed: 10 });
      expect(
        poLineState(10, [
          { kind: "DELAY", quantity: 4 },
          { kind: "OUT_OF_STOCK", quantity: 4, source: "DELAYED" },
        ]),
      ).toMatchObject({ delayed: 0, outOfStock: 4 });
    });
  });

  describe("수락된 취소는 Qreduce에 합산된다 (사용자 결정: 공급처가 수락한 수량만 차감, BR-P01·TC-77)", () => {
    it("TC-77: 발주 10권에서 공급처가 수락한 취소 2권만 차감하면 유효 발주는 8권이다", () => {
      const state = poLineState(10, [], 2);

      expect(state).toMatchObject({ qsend: 10, qreduce: 2, qvalid: 8 });
    });

    it("품절 확정과 수락된 취소는 합산된다 (3 + 2 → Qreduce 5, Qvalid 5)", () => {
      const state = poLineState(10, [{ kind: "OUT_OF_STOCK", quantity: 3 }], 2);

      expect(state).toMatchObject({ outOfStock: 3, qreduce: 5, qvalid: 5 });
    });

    it("수락된 취소는 풀(미응답·지연·확정·품절)을 바꾸지 않는다 — 별도 차감이다", () => {
      const withCancel = poLineState(10, [{ kind: "CONFIRM", quantity: 4 }], 3);
      const without = poLineState(10, [{ kind: "CONFIRM", quantity: 4 }]);

      expect({ ...withCancel, qreduce: 0, qvalid: 10 }).toEqual(without);
    });

    it("품절 확정과 수락된 취소의 합이 Qsend를 넘으면 BUSINESS_INVARIANT(422)이다 (이중 차감 방지)", () => {
      const error = thrown(() => poLineState(10, [{ kind: "OUT_OF_STOCK", quantity: 7 }], 4)); // 7 + 4 > 10

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BUSINESS_INVARIANT");
      expect((error as AppError).httpStatus).toBe(422);
    });

    it("수락된 취소만으로 Qsend를 넘어도 거절한다", () => {
      expect(() => poLineState(10, [], 11)).toThrow(/BUSINESS_INVARIANT/);
    });

    it("합이 정확히 Qsend이면 허용한다 (유효 발주 0권)", () => {
      expect(poLineState(10, [{ kind: "OUT_OF_STOCK", quantity: 6 }], 4)).toMatchObject({
        qreduce: 10,
        qvalid: 0,
      });
    });
  });

  it("어떤 이벤트 순서에서도 네 풀의 합은 Qsend이고 Qvalid = Qsend − Qreduce이다", () => {
    const events = [
      { kind: "DELAY", quantity: 3 },
      { kind: "CONFIRM", quantity: 2 },
      { kind: "OUT_OF_STOCK", quantity: 1, source: "DELAYED" },
      { kind: "CONFIRM", quantity: 1, source: "DELAYED" },
      { kind: "OUT_OF_STOCK", quantity: 2 },
    ] as const;
    for (let n = 0; n <= events.length; n++) {
      const s = poLineState(10, events.slice(0, n));

      expect(s.unanswered + s.delayed + s.confirmed + s.outOfStock).toBe(10);
      expect(s.qvalid).toBe(s.qsend - s.qreduce);
    }
  });
});
