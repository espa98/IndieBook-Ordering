import { AppError, type ErrorCode } from "../errors/AppError";

export type ErrorResponse = {
  status: number;
  body: { error: { code: string; message: string } };
};

/** 클라이언트에 보이는 고정 문구. 내부 규칙·존재 여부가 새지 않도록 detail과 분리한다. */
const FIXED_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "Invalid request",
  UNAUTHENTICATED: "Authentication required",
  FORBIDDEN: "Access denied",
  NOT_FOUND: "Resource not found",
  IDEMPOTENCY_CONFLICT:
    "Idempotency key was already used with a different request",
  VERSION_CONFLICT: "The resource was modified; reload and retry",
  BUSINESS_INVARIANT: "The request violates a business rule",
};

export function toErrorResponse(error: unknown): ErrorResponse {
  if (!(error instanceof AppError)) {
    // 예상하지 못한 오류: 원본 메시지·스택·내부 정보를 응답에 넣지 않는다
    return {
      status: 500,
      body: {
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      },
    };
  }
  // detail은 400 VALIDATION_ERROR에만 노출한다 (사용자 결정)
  const message =
    error.code === "VALIDATION_ERROR" && error.detail !== undefined
      ? error.detail
      : FIXED_MESSAGES[error.code];
  return {
    status: error.httpStatus,
    body: { error: { code: error.code, message } },
  };
}
