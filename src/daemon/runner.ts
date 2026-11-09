import type { Job, SchedulerSettings } from "../shared/types.js";
import { isModelSet } from "../shared/types.js";
import type { SessionGateway } from "../protocol/gateway.js";
import {
  SETTABLE_MODES,
  TurnTimeoutError,
  type SettableMode,
  type TurnOutcome,
  type WorkspaceRef,
} from "../protocol/session.js";
import type { JobStore } from "./db.js";
import type { DesktopTaskIndex } from "./desktop-index.js";
import { continuationPrompt, shouldRetryOutcome } from "./classify.js";

export interface AttemptOutcome {
  status: "succeeded" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
  tokens: number | null;
  sessionId: string | null;
  /** 本次失败是否值得重试。 */
  retryable: boolean;
}

export interface RunnerOptions {
  store: JobStore;
  settings: () => SchedulerSettings;
  /** 按工作区取会话网关（每个工作区一个 CLI 进程）。 */
  gatewayFor: (workspace: WorkspaceRef) => SessionGateway;
  /** 把 daemon 新建的会话登记进桌面端任务列表。 */
  desktopIndex?: DesktopTaskIndex;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * 执行单个任务的一次尝试。
 *
 * 失败重试的关键点：重试必须回到**同一个会话**，模型才能带着上下文接着做完。
 * 所以「新建会话」类型的任务在首次执行后会把自己绑定到那个新建出来的会话，
 * 后续尝试复用它；「已有会话」类型天然固定。
 */
export class JobRunner {
  constructor(private readonly options: RunnerOptions) {}

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** 任务归属的工作区，决定用哪个 CLI 进程执行。 */
  private workspaceFor(job: Job): WorkspaceRef {
    const path = job.workspacePath.trim();
    const identity = job.workspaceIdentity?.trim();
    return {
      workspaceKey: identity || path,
      workspacePath: path,
      ...(identity ? { workspaceIdentity: identity } : {}),
    };
  }

  /** 解析这次执行要用的会话，必要时新建并绑定。 */
  async resolveSession(job: Job): Promise<{ sessionId: string; created: boolean }> {
    if (job.target.kind === "session") {
      return { sessionId: job.target.sessionId, created: false };
    }
    const bound = this.options.store.getBoundSession(job.id);
    if (bound) return { sessionId: bound, created: false };

    const settings = this.options.settings();
    // 模型留空表示「跟随默认」：不指定，让会话用它自己当前选中的模型。
    const model = isModelSet(settings.model) ? settings.model : undefined;
    const sessionId = await this.options.gatewayFor(this.workspaceFor(job)).createSession(
      this.workspaceFor(job),
      {
        title: job.target.title,
        ...(model ? { model } : {}),
      },
    );
    this.options.store.bindSession(job.id, sessionId, this.now);
    this.log(`任务 ${job.id} 新建会话 ${sessionId}`);
    return { sessionId, created: true };
  }

  /** 把新建的会话登记进桌面端任务列表，让用户在 ZCode 里能打开它。 */
  private async registerInDesktopIndex(
    job: Job,
    sessionId: string,
    succeeded: boolean,
  ): Promise<void> {
    const index = this.options.desktopIndex;
    if (!index) return;
    try {
      const workspace = this.workspaceFor(job);
      let title = job.target.kind === "new-session" ? (job.target.title ?? "") : job.title;
      try {
        const snapshot = await this.options.gatewayFor(workspace).readSession(sessionId);
        if (snapshot.title.trim()) title = snapshot.title;
      } catch {
        // 读不到标题就用任务标题顶上
      }
      const now = this.now;
      index.upsertSession({
        taskId: sessionId,
        workspaceKey: workspace.workspaceKey,
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        title,
        status: succeeded ? "completed" : "error",
        createdAt: now,
        updatedAt: now,
      });
      this.log(`会话 ${sessionId} 已登记到桌面端任务列表`);
    } catch (error) {
      this.log(
        `会话 ${sessionId} 登记到桌面端任务列表失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 读会话当前的权限模式；读不到或不是可设置值就返回 null，恢复时跳过。 */
  private async currentMode(
    gateway: SessionGateway,
    sessionId: string,
  ): Promise<SettableMode | null> {
    try {
      const snapshot = await gateway.readSession(sessionId);
      const mode = snapshot.mode?.trim();
      return SETTABLE_MODES.includes(mode as SettableMode) ? (mode as SettableMode) : null;
    } catch {
      return null;
    }
  }

  /** 执行一次尝试并落库。 */
  async runOnce(job: Job, attempt: number): Promise<AttemptOutcome> {
    const settings = this.options.settings();
    const store = this.options.store;

    let sessionId: string | null = null;
    let runId: number | null = null;
    let priorMode: SettableMode | null = null;

    try {
      const resolved = await this.resolveSession(job);
      sessionId = resolved.sessionId;

      const gateway = this.options.gatewayFor(this.workspaceFor(job));
      if (!resolved.created) {
        await gateway.resumeSession(sessionId, this.workspaceFor(job));
      }

      // 记下会话原来的权限模式，跑完恢复：无人值守执行不该永久改掉用户的会话设置。
      // 用户恰好在夜里手动改了模式的话会被恢复动作覆盖，这是可接受的取舍。
      priorMode = await this.currentMode(gateway, sessionId);
      await gateway.setMode(sessionId, "yolo");

      const previous = store.listRuns(job.id, 1)[0];
      const content =
        attempt > 1
          ? continuationPrompt(job.prompt, previous?.errorMessage ?? null)
          : job.prompt;

      runId = store.startRun(job.id, attempt, sessionId, this.now);
      store.markRunning(job.id, this.now);

      await gateway.sendPrompt(
        sessionId,
        content,
        isModelSet(settings.model) ? settings.model : undefined,
      );
      let outcome: TurnOutcome;
      try {
        outcome = await gateway.waitForTurnOutcome(sessionId, settings.taskTimeoutMs);
      } catch (error) {
        if (error instanceof TurnTimeoutError) {
          // 超时必须先停回合：旧回合还在跑的话，重试的 prompt 会被
          // 「已有回合在跑」挡住，重试次数全烧在同一个错误上。
          try {
            await gateway.stopSession(sessionId);
            this.log(`会话 ${sessionId} 的超时回合已停止`);
          } catch (stopError) {
            this.log(
              `停止超时回合失败：${stopError instanceof Error ? stopError.message : String(stopError)}`,
            );
          }
          outcome = {
            status: "failed",
            errorCode: "turn_timeout",
            errorMessage: error.message,
            errorRetryable: true,
          };
        } else {
          throw error;
        }
      }

      const failed = outcome.status !== "success";
      store.finishRun(
        runId,
        {
          status: failed ? "failed" : "succeeded",
          errorCode: outcome.errorCode ?? null,
          errorMessage: outcome.errorMessage ?? null,
          tokens: outcome.tokens ?? null,
        },
        this.now,
      );

      // daemon 自己新建的会话，桌面端侧栏默认看不见（它只认本进程内存里的会话）。
      // 这里补一条索引行，让用户在 ZCode 界面里能打开这个会话看结果。
      if (resolved.created) {
        await this.registerInDesktopIndex(job, sessionId, outcome.status === "success");
      }

      return {
        status: failed ? "failed" : "succeeded",
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        tokens: outcome.tokens ?? null,
        sessionId,
        retryable: failed
          ? shouldRetryOutcome(outcome.status, outcome.errorCode, outcome.errorRetryable)
          : false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId !== null) {
        store.finishRun(runId, { status: "failed", errorCode: "dispatch_failed", errorMessage: message }, this.now);
      }
      // 投递层面的失败（进程没起来、会话被占用等）多数是瞬时的，值得重试一次。
      return {
        status: "failed",
        errorCode: "dispatch_failed",
        errorMessage: message,
        tokens: null,
        sessionId,
        retryable: true,
      };
    } finally {
      // 无论成败都恢复模式；失败路径尤其重要，会话第二天还要给用户正常用。
      if (sessionId !== null && priorMode !== null && priorMode !== "yolo") {
        try {
          await this.options.gatewayFor(this.workspaceFor(job)).setMode(sessionId, priorMode);
        } catch {
          // 恢复失败不影响结果；会话留在 yolo 比把任务标记失败更无害。
        }
      }
    }
  }
}
