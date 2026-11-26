import { AppError } from "../errors/AppError";

/** 국내 번호만: 0으로 시작하는 9~11자리(휴대전화 010…, 지역번호 유선) */
const DOMESTIC = /^0\d{8,10}$/;

export function normalizePhone(raw: string): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION_ERROR", "phone must be a string");
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  const normalized = trimmed.startsWith("+82") ? `0${digits.slice(2)}` : digits;
  if (!DOMESTIC.test(normalized)) throw new AppError("VALIDATION_ERROR", "phone must be a domestic phone number");
  return normalized;
}
