import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSweepLoop } from "../../src/jobs/sweepLoop";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startSweepLoop: 주기 실행", () => {
  it("간격마다 실행하고, 앞 실행이 끝나지 않았으면 겹쳐 시작하지 않으며, 실패해도 다음 주기에 계속한다", async () => {
    let runs = 0;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const errors: unknown[] = [];
    const loop = startSweepLoop({
      intervalMs: 1_000,
      run: async () => {
        runs++;
        if (runs === 1) await slow; // 첫 실행이 길어진다
        if (runs === 3) throw new Error("boom");
      },
      logError: (error) => void errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000); // 첫 실행이 끝나기 전에는 새로 시작하지 않는다
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(3);
    expect(errors).toHaveLength(1); // 실패는 기록하고 루프는 계속된다
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(4);

    await loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(4); // 정지한 뒤에는 실행하지 않는다
  });

  it("간격이 0 이하이면 시작하지 않고, 정지는 진행 중인 실행이 끝나기를 기다린다", async () => {
    let started = 0;
    const off = startSweepLoop({ intervalMs: 0, run: async () => void started++ });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toBe(0);
    await off.stop();

    let finished = false;
    let release!: () => void;
    const loop = startSweepLoop({
      intervalMs: 1_000,
      run: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        finished = true;
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const stopped = loop.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    release();
    await stopped;
    expect(finished).toBe(true);
  });
});
