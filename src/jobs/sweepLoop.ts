export type SweepLoopOptions = {
  /** 실행 간격(ms). 0 이하이면 시작하지 않는다 */
  intervalMs: number;
  run: () => Promise<unknown>;
  logError?: (error: unknown) => void;
};

/**
 * `run`을 일정한 간격으로 부른다. 앞 실행이 끝나지 않았으면 겹쳐 시작하지 않고(다음 주기로 넘긴다),
 * 실패는 기록만 하고 루프를 계속한다. `stop()`은 새 실행을 막고 진행 중인 실행이 끝나기를 기다린다.
 */
export function startSweepLoop(options: SweepLoopOptions): { stop(): Promise<void> } {
  if (options.intervalMs <= 0) return { stop: async () => undefined };
  let running: Promise<void> | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await options.run();
      } catch (error) {
        options.logError?.(error);
      } finally {
        running = undefined;
      }
    })();
  }, options.intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
