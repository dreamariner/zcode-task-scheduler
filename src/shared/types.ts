/**
 * 插件内共享的数据模型。
 *
 * 命名与字段只描述业务语义，不泄漏任何宿主内部结构；协议层的字段名在
 * `src/protocol/client.ts` 里做一次转换。
 */

/** 任务目标：已有会话，或到点时新建一个会话。 */
export type JobTarget =
  | { kind: "session"; sessionId: string; label?: string }
  | { kind: "new-session"; title?: string };

export type Schedule =
  /** 一次性：在 runAt 这个绝对时刻执行一次。 */
  | { kind: "once"; runAt: number }
  /** 每天：timeOfDay 为当天零点起的毫秒偏移。 */
  | { kind: "daily"; timeOfDay: number }
  /** 每周：weekdays 用 0..6（周日为 0）。 */
  | { kind: "weekly"; timeOfDay: number; weekdays: number[] };

export type JobStatus =
  | "scheduled"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "disabled";

export interface Job {
  id: string;
  title: string;
  target: JobTarget;
  prompt: string;
  /** 任务归属的工作区，决定执行时用哪个 CLI 进程。 */
  workspacePath: string;
  workspaceIdentity?: string;
  schedule: Schedule;
  enabled: boolean;
  /** 含首次执行在内的总尝试次数上限。 */
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastStatus: JobStatus | null;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export type RunStatus = "running" | "succeeded" | "failed";

export interface RunRecord {
  id: number;
  jobId: string;
  attempt: number;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  errorCode: string | null;
  errorMessage: string | null;
  tokens: number | null;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  status: string;
  updatedAt: number | null;
  createdAt: number | null;
}

export interface Settings {
  /** 每晚默认执行时刻（当天零点起的毫秒偏移），默认 00:30。 */
  defaultTimeOfDay: number;
  /** 全局并发上限。 */
  maxConcurrent: number;
  /** 每分钟最多启动多少个任务。 */
  maxStartsPerMinute: number;
  /** 相邻两次启动之间的最小间隔（毫秒）。 */
  minGapMs: number;
  /** 单个任务尝试的超时时间（毫秒）。 */
  taskTimeoutMs: number;
  /** 失败后的最大重试次数（不含首次执行）。 */
  maxRetries: number;
  /** 首次重试前的等待时间（毫秒），之后按倍数递增。 */
  retryBackoffMs: number;
  /**
   * 执行用模型。providerId 与 modelId 都为空表示「跟随默认」：
   * 不下发 modelSelection，会话用它自己当前选中的模型。
   */
  model: ModelSelection;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  /**
   * 部分模型（如 minimax 系列）必须显式给出思考等级，否则请求会被判为配置错误。
   * 字段位置与协议一致：思考等级放在 options 里。
   */
  options?: { reasoningLevel?: string };
}

/** 模型是否被显式指定；空字符串对表示「跟随默认」。 */
export function isModelSet(model: ModelSelection): boolean {
  return model.providerId.trim().length > 0 && model.modelId.trim().length > 0;
}

export interface SchedulerSettings extends Settings {
  /** 调度轮询间隔（毫秒）。 */
  pollIntervalMs: number;
}

export const DEFAULT_SETTINGS: SchedulerSettings = {
  defaultTimeOfDay: 30 * 60 * 1000,
  maxConcurrent: 3,
  maxStartsPerMinute: 6,
  minGapMs: 10_000,
  taskTimeoutMs: 30 * 60 * 1000,
  maxRetries: 2,
  retryBackoffMs: 60_000,
  pollIntervalMs: 20_000,
  // 默认跟随会话自己的模型；要固定某个模型在面板里挑。
  model: { providerId: "", modelId: "" },
};

export interface JobInput {
  title: string;
  target: JobTarget;
  prompt: string;
  workspacePath: string;
  workspaceIdentity?: string;
  schedule: Schedule;
  maxAttempts?: number;
  enabled?: boolean;
}

export interface JobPatch {
  title?: string;
  prompt?: string;
  schedule?: Schedule;
  maxAttempts?: number;
  enabled?: boolean;
  target?: JobTarget;
}
