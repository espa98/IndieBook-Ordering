export type NotificationStatus = "PENDING" | "ATTEMPTED" | "MANUAL_RECORDED" | "FAILED";

/**
 * 안내 대상의 상태는 기록에서 파생한다 (BR-M01). 문구 복사·공유·미리보기는 상태를 바꾸지 않으며,
 * 직원이 외부 발송 시도를 기록해야 ATTEMPTED, 결과를 기록해야 MANUAL_RECORDED/FAILED가 된다.
 */
export function notificationState(records: {
  attempts: readonly unknown[];
  results: readonly { outcome: "MANUAL_RECORDED" | "FAILED" }[];
}): NotificationStatus {
  if (records.attempts.length === 0) return "PENDING";
  const last = records.results[records.results.length - 1];
  return last ? last.outcome : "ATTEMPTED";
}
