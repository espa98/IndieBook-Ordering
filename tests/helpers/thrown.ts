/** fn이 던진 값을 반환한다. 던지지 않으면 테스트가 실패하도록 예외를 낸다. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw, but it did not");
}
