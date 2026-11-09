import type { ClaimedJob } from "./db.js";
import type { Job, SchedulerSettings } from "../shared/types.js";
import type { JobStore } from "./db.js";
import { Limiter } from "./limiter.js";
import type { AttemptOutcome, JobRunner } from "./runner.js";

export interface SchedulerOptions {
  store: JobStore;
  runner: JobRunner;
  limiter: Limiter;
  settings: () => SchedulerSettings;
  now?: () => number;
  log?: (message: string) => void;
}

/** 错过窗口的宽限：超过这个时长仍未执行的任务视为过期，不再补跑。 */
const DEFAULT_MISSED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 熔断阈值：常驻任务连续这么多轮都失败就自动停用。
 * 每轮本身含多次重试尝试，5 轮失败说明任务已经坏透，继续排程只会白烧 token。
 */
const AUTO_DISABLE_AFTER_FAILURES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly inFlight = new Set<string>();
  private readonly missedWindowMs: number;

  constructor(private readonly options: SchedulerOptions) {
    this.missedWindowMs = DEFAULT_MISSED_WINDOW_MS;
  }

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  start(): void {
    if (this.timer) return;
    const settings = this.options.settings();
    this.timer = setInterval(() => {
      void this.tick();
    }, settings.pollIntervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get busyJobIds(): string[] {
    return [...this.inFlight];
  }

  /** 一轮调度：认领到期任务并发起执行。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now;
      const due = this.options.store.claimDue(now);
      for (const claimed of due) {
        void this.execute(claimed);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 立即执行：指定任务，或全部启用中的任务。显式触发不受错过窗口约束。 */
  async runNow(jobId?: string): Promise<string[]> {
    const jobs = jobId
      ? [this.options.store.getJob(jobId)].filter((job): job is Job => job !== null)
      : this.options.store.listJobs().filter((job) => job.enabled);
    const started: string[] = [];
    for (const job of jobs) {
      started.push(job.id);
      void this.execute({ job, dueAt: null });
    }
    return started;
  }

  /**
   * 执行一个任务（含失败重试）。
   *
   * 并发槽只在真正跑尝试的窗口内持有：退避等待期间必须放掉，否则失败高峰时
   * 几个睡觉的任务就能占满全部并发额度，把别的任务堵死。
   */
  private async execute(claimed: { job: Job; dueAt: number | null }): Promise<void> {
    const job = claimed.job;
    if (this.inFlight.has(job.id)) return;
    this.inFlight.add(job.id);

    const settings = this.options.settings();
    this.options.limiter.configure({
      maxConcurrent: settings.maxConcurrent,
      maxStartsPerMinute: settings.maxStartsPerMinute,
      minGapMs: settings.minGapMs,
    });

    try {
      // dueAt 为 null 表示显式触发（runNow），不受错过窗口约束。
      if (claimed.dueAt !== null && this.now - claimed.dueAt > this.missedWindowMs) {
        this.log(`任务 ${job.id} 错过执行窗口（搁置超过 24 小时），跳过`);
        this.options.store.settleJob(
          job.id,
          { status: "failed", error: "错过执行窗口", willRetry: false, retryAt: null },
          this.now,
        );
        return;
      }

      const maxAttempts = Math.max(1, job.maxAttempts);
      let attempt = 1;
      let outcome: AttemptOutcome;
      for (;;) {
        await this.options.limiter.acquire();
        try {
          outcome = await this.options.runner.runOnce(job, attempt);
        } finally {
          this.options.limiter.release();
        }

        if (!(outcome.status === "failed" && outcome.retryable && attempt < maxAttempts)) break;

        const backoff = settings.retryBackoffMs * 2 ** (attempt - 1);
        this.log(
          `任务 ${job.id} 第 ${attempt} 次尝试失败（${outcome.errorCode ?? "unknown"}：${
            outcome.errorMessage ?? "无详情"
          }），${backoff}ms 后在原会话重试`,
        );
        this.options.store.settleJob(
          job.id,
          {
            status: "failed",
            error: outcome.errorMessage,
            willRetry: true,
            retryAt: this.now + backoff,
          },
          this.now,
        );
        await sleep(backoff);
        attempt += 1;
      }

      this.options.store.settleJob(
        job.id,
        {
          status: outcome.status,
          error: outcome.errorMessage,
          willRetry: false,
          retryAt: null,
        },
        this.now,
      );
      this.log(
        `任务 ${job.id} 第 ${attempt} 次尝试结束：${outcome.status}${
          outcome.errorMessage ? `（${outcome.errorMessage}）` : ""
        }`,
      );
      this.maybeAutoDisable(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`任务 ${job.id} 执行异常：${message}`);
      this.options.store.settleJob(
        job.id,
        { status: "failed", error: message, willRetry: false, retryAt: null },
        this.now,
      );
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  /** 常驻任务连续失败到阈值就自动停用，别再每晚空烧。 */
  private maybeAutoDisable(jobId: string): void {
    const job = this.options.store.getJob(jobId);
    if (!job || !job.enabled || job.schedule.kind === "once") return;
    if (job.consecutiveFailures < AUTO_DISABLE_AFTER_FAILURES) return;
    this.options.store.setEnabled(jobId, false, this.now);
    this.log(
      `任务 ${jobId} 已连续失败 ${job.consecutiveFailures} 轮，自动停用；修好后可在面板重新启用`,
    );
  }
}
