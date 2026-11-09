import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, JobStore } from "../src/daemon/db.js";
import { Limiter } from "../src/daemon/limiter.js";
import { Scheduler } from "../src/daemon/scheduler.js";
import type { AttemptOutcome, JobRunner } from "../src/daemon/runner.js";
import type { Job, SchedulerSettings } from "../src/shared/types.js";
import { DEFAULT_SETTINGS } from "../src/shared/types.js";

class FakeRunner {
  readonly calls: { job: Job; attempt: number }[] = [];
  /** 每次调用的返回值，按顺序消费；耗尽后返回成功。 */
  outcomes: AttemptOutcome[] = [];

  runOnce(job: Job, attempt: number): Promise<AttemptOutcome> {
    this.calls.push({ job, attempt });
    const outcome = this.outcomes.shift();
    return Promise.resolve(
      outcome ?? {
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        tokens: null,
        sessionId: null,
        retryable: false,
      },
    );
  }
}

function makeHarness(outcomes: AttemptOutcome[], settings?: Partial<SchedulerSettings>) {
  const dir = mkdtempSync(join(tmpdir(), "zts-sched-"));
  const store = new JobStore(openDatabase(join(dir, "state.db")));
  const runner = new FakeRunner();
  runner.outcomes = outcomes;
  const limiter = new Limiter({ maxConcurrent: 1, maxStartsPerMinute: 1000, minGapMs: 0 });
  // execute 会按 settings 重配限流器；默认把速率闸放开，免得测试在 10 秒最小间隔上干等。
  const merged: SchedulerSettings = {
    ...DEFAULT_SETTINGS,
    maxStartsPerMinute: 1000,
    minGapMs: 0,
    ...settings,
  };
  const scheduler = new Scheduler({
    store,
    runner: runner as unknown as JobRunner,
    limiter,
    settings: () => merged,
  });
  return { store, runner, limiter, scheduler };
}

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (check()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("等待条件超时"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function addOnceJob(store: JobStore, id: string, runAt: number, maxAttempts = 1): Job {
  return store.addJob(
    {
      title: `任务 ${id}`,
      target: { kind: "session", sessionId: "sess_1" },
      prompt: "跑",
      workspacePath: "/tmp/ws",
      schedule: { kind: "once", runAt },
      maxAttempts,
    },
    id,
    Date.now(),
  );
}

function addDailyJob(store: JobStore, id: string, now: number): Job {
  return store.addJob(
    {
      title: `每日任务 ${id}`,
      target: { kind: "session", sessionId: "sess_1" },
      prompt: "跑",
      workspacePath: "/tmp/ws",
      schedule: { kind: "daily", timeOfDay: 1_800_000 },
      maxAttempts: 1,
    },
    id,
    now,
  );
}

const failedOutcome = (message: string, retryable = false): AttemptOutcome => ({
  status: "failed",
  errorCode: retryable ? "network_error" : "invalid_model_request",
  errorMessage: message,
  tokens: null,
  sessionId: "sess_1",
  retryable,
});

describe("调度器", () => {
  it("认领时带回计划时刻，搁置超过 24 小时的任务直接跳过", async () => {
    const { store, runner, scheduler } = makeHarness([]);
    const now = Date.now();
    // 25 小时前就该跑的一次性任务：修复前 claimDue 清空 next_run_at 后重读，
    // 错过窗口检查永远不触发，任务会照跑。
    addOnceJob(store, "job_stale", now - 25 * 60 * 60 * 1000);

    scheduler.start();
    try {
      await waitFor(
        () =>
          scheduler.busyJobIds.length === 0 && store.getJob("job_stale")?.lastStatus === "failed",
      );
      expect(runner.calls).toHaveLength(0);
      const job = store.getJob("job_stale");
      expect(job?.lastError).toBe("错过执行窗口");
    } finally {
      scheduler.stop();
    }
  });

  it("刚到期的任务正常执行，不受错过窗口影响", async () => {
    const { store, runner, scheduler } = makeHarness([]);
    addOnceJob(store, "job_fresh", Date.now() - 1000);

    scheduler.start();
    try {
      await waitFor(
        () =>
          scheduler.busyJobIds.length === 0 &&
          store.getJob("job_fresh")?.lastStatus === "succeeded",
      );
      expect(runner.calls.map((call) => call.job.id)).toEqual(["job_fresh"]);
    } finally {
      scheduler.stop();
    }
  });

  it("常驻任务连续失败到阈值后自动停用", async () => {
    // 每轮都失败（非重试类），到第 5 轮触发熔断。
    const { store, runner, scheduler } = makeHarness(
      Array.from({ length: 5 }, () => failedOutcome("模型不可用")),
    );
    const now = Date.now();
    addDailyJob(store, "job_breaker", now);

    for (let round = 0; round < 5; round += 1) {
      await scheduler.runNow("job_breaker");
      await waitFor(() => scheduler.busyJobIds.length === 0);
    }
    expect(runner.calls).toHaveLength(5);
    const job = store.getJob("job_breaker");
    expect(job?.consecutiveFailures).toBe(5);
    expect(job?.enabled).toBe(false);
    expect(job?.nextRunAt).toBeNull();
  });

  it("重试退避期间放掉并发槽，下一次尝试拿得回来", async () => {
    const { store, runner, limiter, scheduler } = makeHarness(
      [
        failedOutcome("网络断了", true),
        { status: "succeeded", errorCode: null, errorMessage: null, tokens: null, sessionId: "sess_1", retryable: false },
      ],
      { retryBackoffMs: 250, maxRetries: 2 },
    );
    const job = addOnceJob(store, "job_retry", Date.now() - 1000, 2);

    await scheduler.runNow(job.id);
    // 第一次尝试结束后进入退避：此时必须已经放掉槽位（maxConcurrent=1，不放掉下次死锁）。
    await waitFor(() => runner.calls.length === 1);
    await waitFor(() => limiter.activeCount === 0, 200);
    await waitFor(
      () =>
        scheduler.busyJobIds.length === 0 &&
        store.getJob("job_retry")?.lastStatus === "succeeded",
      5000,
    );
    expect(runner.calls.map((call) => call.attempt)).toEqual([1, 2]);
    expect(limiter.activeCount).toBe(0);
  });
});
