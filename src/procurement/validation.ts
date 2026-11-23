import { AppError } from "../errors/AppError";

/** VALIDATION_ERROR(400)를 던진다. 메시지는 "<field> <rule>" 형식이다. */
export function invalid(field: string, rule: string): never {
  throw new AppError("VALIDATION_ERROR", `${field} ${rule}`);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** RFC3339 UTC(Z). 날짜만, 오프셋 표기, 임의 문자열은 거부한다. */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * 업무 발생 시각을 검증하고 epoch ms로 돌려준다.
 * RFC3339 UTC여야 하고, 유효한 날짜여야 하며, 기록 시각(now)보다 미래일 수 없다
 * (아직 일어나지 않은 일은 기록할 수 없다).
 */
export function parseUtcTimestamp(
  field: string,
  value: unknown,
  now: Date,
): number {
  const ms =
    typeof value === "string" && UTC_TIMESTAMP.test(value)
      ? Date.parse(value)
      : Number.NaN;
  if (Number.isNaN(ms)) invalid(field, "must be an RFC3339 UTC timestamp");
  if (ms > now.getTime()) invalid(field, "must not be in the future");
  return ms;
}

/** YYYY-MM-DD 형식의 실제로 존재하는 날짜인지 확인한다 (예: 2026-13-01은 거부). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}
