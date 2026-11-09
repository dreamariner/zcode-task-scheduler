/**
 * 失败分类：判断一次失败值不值得重试。
 *
 * 运行时本身会在 turn.terminal 事实里给出 `errorRetryable`（见官方
 * packages/shared/src/zcode-protocol-v4/telemetry.ts），那是权威信号，优先采用。
 * 运行时没给的时候退回按错误码匹配，避免把配置类错误反复重试。
 */
const NON_RETRYABLE_KEYWORDS = [
  "configuration_error",
  "invalid_model_request",
  "invalid_request",
  "bad_request",
  "authentication",
  "unauthorized",
  "forbidden",
  "permission_denied",
  "account_scope",
  "model_not_found",
  "unsupported",
];

const RETRYABLE_KEYWORDS = [
  "timeout",
  "timed_out",
  "network",
  "connection",
  "econnreset",
  "econnrefused",
  "etimedout",
  "eai_again",
  "socket hang up",
  "rate_limit",
  "ratelimit",
  "too_many_requests",
  "overloaded",
  "unavailable",
  "temporarily",
  "service_unavailable",
  "internal_error",
  "5xx",
  "bad_gateway",
  "gateway_timeout",
];

export function isRetryableFailure(errorCode?: string | null, errorRetryable?: boolean): boolean {
  if (typeof errorRetryable === "boolean") return errorRetryable;
  const code = (errorCode ?? "").trim().toLowerCase();
  if (!code) return false;
  if (NON_RETRYABLE_KEYWORDS.some((keyword) => code.includes(keyword))) return false;
  if (RETRYABLE_KEYWORDS.some((keyword) => code.includes(keyword))) return true;
  return false;
}

/** 无人值守跑批时被中断，按可重试处理一次。 */
export function shouldRetryOutcome(
  status: "success" | "interrupted" | "failed",
  errorCode?: string | null,
  errorRetryable?: boolean,
): boolean {
  if (status === "success") return false;
  if (status === "interrupted") return true;
  return isRetryableFailure(errorCode, errorRetryable);
}

/** 续跑提示词：让模型在原会话里接着做完，不要重跑已经完成的部分。 */
export function continuationPrompt(originalPrompt: string, errorMessage: string | null): string {
  const reason = errorMessage?.trim() ? errorMessage.trim() : "未知错误";
  return [
    "上一次执行没有完成，失败原因如下：",
    reason,
    "",
    "请从中断处继续，把原任务做完，不要重复已经完成的部分。",
    "原任务内容：",
    originalPrompt,
  ].join("\n");
}
