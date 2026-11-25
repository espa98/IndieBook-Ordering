import { AppError } from "../errors/AppError";

/** 과대 입력 상한(E4). 본문 크기 상한(기본 1 MiB)은 HTTP 서버가 따로 지킨다 */
export const INPUT_LIMITS = { maxArrayItems: 100, maxStringLength: 1000, maxMoneyDigits: 15 } as const;

const tooLarge = (what: string) => new AppError("VALIDATION_ERROR", `${what} exceeds the allowed limit`);

const isMoneyField = (key: string | undefined) => key !== undefined && /Krw$/.test(key);

/** 요청 본문(JSON)의 모든 값을 훑어 상한을 넘는 입력을 거부한다. 형식 검증은 도메인이 한다 */
export function assertWithinLimits(value: unknown, key?: string): void {
  if (typeof value === "string") {
    if (value.length > INPUT_LIMITS.maxStringLength) throw tooLarge("a string value");
    // 금액 필드(`...Krw`)의 숫자 문자열은 자릿수를 제한한다. 숫자가 아닌 값은 도메인이 형식 오류로 거부한다
    if (isMoneyField(key) && /^-?\d+$/.test(value) && value.replace(/^-/, "").length > INPUT_LIMITS.maxMoneyDigits) throw tooLarge("a money amount");
    return;
  }
  if (typeof value === "number") {
    if (isMoneyField(key) && Number.isFinite(value) && String(Math.trunc(Math.abs(value))).length > INPUT_LIMITS.maxMoneyDigits) throw tooLarge("a money amount");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > INPUT_LIMITS.maxArrayItems) throw tooLarge("an array");
    for (const item of value) assertWithinLimits(item, key);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertWithinLimits(v, k);
  }
}
