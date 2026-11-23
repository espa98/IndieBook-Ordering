import { AppError } from "../errors/AppError";
import { toErrorResponse, type ErrorResponse } from "./toErrorResponse";

export type SuccessResponse<T> = { status: number; body: { data: T } };
export type HttpResponse<T> = SuccessResponse<T> | ErrorResponse;

export type HandleOptions = {
  successStatus?: number;
  /** AppError가 아닌 예상 못한 오류의 원본을 받는다(서버측 로깅 자리). 응답에는 쓰이지 않는다. */
  onUnexpectedError?: (error: unknown) => void;
};

export function handle<T>(
  fn: () => T,
  options: HandleOptions = {},
): HttpResponse<T> {
  try {
    return {
      status: options.successStatus ?? 200,
      body: { data: fn() },
    };
  } catch (error) {
    if (!(error instanceof AppError)) {
      try {
        options.onUnexpectedError?.(error);
      } catch {
        // 로깅 실패가 응답을 깨뜨리면 안 된다
      }
    }
    return toErrorResponse(error);
  }
}
