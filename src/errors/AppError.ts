const HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  BUSINESS_INVARIANT: 422,
} as const;

export type ErrorCode = keyof typeof HTTP_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}
