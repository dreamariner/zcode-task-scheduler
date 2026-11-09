import type { Job, SchedulerSettings } from "../shared/types.js";
import type { JobStore } from "./db.js";
import { Limiter } from "./limiter.js";
import type { JobRunner } from "./runner.js";

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
      for (const job of due) {
        if (this.options.store.getJob(job.id)?.lastStatus === "running" && this.inFlight.has(job.id)) {
          continue;
        }
        void this.execute(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 立即执行：指定任务，或全部启用中的任务。 */
  async runNow(jobId?: string): Promise<string[]> {
    const jobs = jobId
      ? [this.options.store.getJob(jobId)].filter((job): job is Job => job !== null)
      : this.options.store.listJobs().filter((job) => job.enabled);
    const started: string[] = [];
    for (const job of jobs) {
      started.push(job.id);
      void this.execute(job);
    }
    return started;
  }

  /** 执行一个任务（含失败重试）。 */
  private async execute(job: Job): Promise<void> {
    if (this.inFlight.has(job.id)) return;
    this.inFlight.add(job.id);

    const settings = this.options.settings();
    this.options.limiter.configure({
      maxConcurrent: settings.maxConcurrent,
      maxStartsPerMinute: settings.maxStartsPerMinute,
      minGapMs: settings.minGapMs,
    });

    try {
      const now = this.now;
      const overdueBy = (job.nextRunAt ?? now) - now;
      if (job.nextRunAt !== null && overdueBy < -this.missedWindowMs) {
        this.log(`任务 ${job.id} 错过执行窗口，跳过`);
        this.options.store.settleJob(
          job.id,
          { status: "failed", error: "错过执行窗口", willRetry: false, retryAt: null },
          now,
        );
        return;
      }

      await this.options.limiter.acquire();
      let attempt = 1;
      let outcome = await this.options.runner.runOnce(job, attempt);
      const maxAttempts = Math.max(1, job.maxAttempts);

      while (outcome.status === "failed" && outcome.retryable && attempt < maxAttempts) {
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
        outcome = await this.options.runner.runOnce(job, attempt);
      }

      const willRetry = false;
      this.options.store.settleJob(
        job.id,
        {
          status: outcome.status,
          error: outcome.errorMessage,
          willRetry,
          retryAt: null,
        },
        this.now,
      );
      this.log(
        `任务 ${job.id} 第 ${attempt} 次尝试结束：${outcome.status}${
          outcome.errorMessage ? `（${outcome.errorMessage}）` : ""
        }`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`任务 ${job.id} 执行异常：${message}`);
      this.options.store.settleJob(
        job.id,
        { status: "failed", error: message, willRetry: false, retryAt: null },
        this.now,
      );
    } finally {
      this.options.limiter.release();
      this.inFlight.delete(job.id);
    }
  }
}
