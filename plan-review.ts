// 계획 검토는 툴 일회 승인과 달리 수정 피드백 또는 계획 단계 종료를 결정한다.
export type PlanReviewAnswer = { decision: "approve" } | { decision: "revise"; feedback: string } | { decision: "cancel" };
// UI는 제출된 계획 전문을 보여주고 실제 사용자의 선택을 반환한다.
export type RequestPlanReview = (plan: string, signal?: AbortSignal) => Promise<PlanReviewAnswer>;

// 검토 UI가 없으면 실패하며 중단 시 UI가 답하지 않아도 대기를 끝낸다.
export async function reviewPlan(plan: string, review?: RequestPlanReview, signal?: AbortSignal): Promise<PlanReviewAnswer> {
  signal?.throwIfAborted();
  if (!review) throw new Error("계획 검토 UI가 없습니다. 사용자에게 /mode edit 전환을 요청하세요.");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      review(plan, signal),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
