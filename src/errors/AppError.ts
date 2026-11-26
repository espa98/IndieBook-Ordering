const HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  BUSINESS_INVARIANT: 422,
  /** 외부 서비스(도서 검색 등)를 지금 쓸 수 없다. 사용자는 수기 등록 같은 대체 경로를 쓴다 */
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof HTTP_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.httpStatus = HTTP_STATUS[code];
  }
}
