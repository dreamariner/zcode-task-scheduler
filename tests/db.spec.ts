import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, JobStore } from "../src/daemon/db.js";
import { DEFAULT_SETTINGS } from "../src/shared/types.js";

function makeStore(): JobStore {
  const dir = mkdtempSync(join(tmpdir(), "zts-db-"));
  return new JobStore(openDatabase(join(dir, "state.db")));
}

describe("任务存储", () => {
  it("写入后能读回，并保留目标与计划", () => {
    const store = makeStore();
    const now = Date.now();
    const job = store.addJob(
      {
        title: "夜间巡检",
        target: { kind: "session", sessionId: "sess_1", label: "巡检会话" },
        prompt: "跑一次巡检",
        workspacePath: "/tmp/ws",
        workspaceIdentity: "ws-1",
        schedule: { kind: "daily", timeOfDay: 1_800_000 },
        maxAttempts: 3,
      },
      "job_1",
      now,
    );

    expect(job.title).toBe("夜间巡检");
    expect(job.target).toEqual({ kind: "session", sessionId: "sess_1", label: "巡检会话" });
    expect(job.workspacePath).toBe("/tmp/ws");
    expect(job.workspaceIdentity).toBe("ws-1");
    expect(job.schedule).toEqual({ kind: "daily", timeOfDay: 1_800_000 });
    expect(job.nextRunAt).not.toBeNull();

    const loaded = store.getJob("job_1");
    expect(loaded?.schedule).toEqual({ kind: "daily", timeOfDay: 1_800_000 });
  });

  it("认领到期任务后不会被重复认领", () => {
    const store = makeStore();
    const now = Date.now();
    store.addJob(
      {
        title: "到点任务",
        target: { kind: "session", sessionId: "sess_1" },
        prompt: "跑",
        workspacePath: "/tmp/ws",
        schedule: { kind: "once", runAt: now - 1000 },
        maxAttempts: 2,
      },
      "job_2",
      now,
    );

    const first = store.claimDue(now);
    expect(first.map((job) => job.id)).toEqual(["job_2"]);
    const second = store.claimDue(now);
    expect(second).toHaveLength(0);
  });

  it("结算后按重复规则排下一次", () => {
    const store = makeStore();
    const now = Date.now();
    store.addJob(
      {
        title: "每天任务",
        target: { kind: "session", sessionId: "sess_1" },
        prompt: "跑",
        workspacePath: "/tmp/ws",
        schedule: { kind: "daily", timeOfDay: 1_800_000 },
        maxAttempts: 2,
      },
      "job_3",
      now,
    );
    store.claimDue(now);
    store.settleJob("job_3", { status: "succeeded", error: null, willRetry: false, retryAt: null }, now);

    const job = store.getJob("job_3");
    expect(job?.lastStatus).toBe("succeeded");
    expect(job?.nextRunAt).toBeGreaterThan(now);
  });

  it("设置可以读写并与默认值合并", () => {
    const store = makeStore();
    expect(store.getSettings().maxConcurrent).toBe(DEFAULT_SETTINGS.maxConcurrent);
    const updated = store.setSettings({ maxConcurrent: 5, maxRetries: 1 });
    expect(updated.maxConcurrent).toBe(5);
    expect(updated.maxRetries).toBe(1);
    expect(updated.model.providerId).toBe(DEFAULT_SETTINGS.model.providerId);
    expect(store.getSettings().maxConcurrent).toBe(5);
  });

  it("运行记录按任务留存", () => {
    const store = makeStore();
    const now = Date.now();
    store.addJob(
      {
        title: "记录任务",
        target: { kind: "session", sessionId: "sess_1" },
        prompt: "跑",
        workspacePath: "/tmp/ws",
        schedule: { kind: "once", runAt: now + 1000 },
        maxAttempts: 2,
      },
      "job_4",
      now,
    );
    const runId = store.startRun("job_4", 1, "sess_1", now);
    store.finishRun(runId, { status: "failed", errorCode: "network_error", errorMessage: "断了" }, now + 10);

    const runs = store.listRuns("job_4");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorCode).toBe("network_error");
    expect(runs[0]?.sessionId).toBe("sess_1");
  });
});
