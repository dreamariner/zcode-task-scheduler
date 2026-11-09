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

  it("认领到期任务后不会被重复认领，并带回计划时刻", () => {
    const store = makeStore();
    const now = Date.now();
    const dueAt = now - 1000;
    store.addJob(
      {
        title: "到点任务",
        target: { kind: "session", sessionId: "sess_1" },
        prompt: "跑",
        workspacePath: "/tmp/ws",
        schedule: { kind: "once", runAt: dueAt },
        maxAttempts: 2,
      },
      "job_2",
      now,
    );

    const first = store.claimDue(now);
    expect(first.map((claimed) => claimed.job.id)).toEqual(["job_2"]);
    // 计划时刻必须在认领时带回：UPDATE 之后 job 快照里已经读不到了。
    expect(first[0]?.dueAt).toBe(dueAt);
    expect(first[0]?.job.nextRunAt).toBeNull();
    const second = store.claimDue(now);
    expect(second).toHaveLength(0);
  });

  it("updateJob 不改目标时保留原 target，改目标时作废旧绑定", () => {
    const store = makeStore();
    const now = Date.now();
    store.addJob(
      {
        title: "巡检",
        target: { kind: "session", sessionId: "sess_1", label: "巡检会话" },
        prompt: "跑",
        workspacePath: "/tmp/ws",
        schedule: { kind: "daily", timeOfDay: 1_800_000 },
        maxAttempts: 3,
      },
      "job_u1",
      now,
    );
    store.bindSession("job_u1", "sess_bound", now);

    // 只停用：之前这个操作会把 target_session_id 抹成 null，任务从此废掉。
    store.updateJob("job_u1", { enabled: false }, now);
    const afterToggle = store.getJob("job_u1");
    expect(afterToggle?.target).toEqual({
      kind: "session",
      sessionId: "sess_1",
      label: "巡检会话",
    });
    expect(store.getBoundSession("job_u1")).toBe("sess_bound");

    // 改目标：旧绑定要作废，否则 new-session 任务会复用旧会话。
    store.updateJob("job_u1", { target: { kind: "new-session", title: "换个目标" } }, now);
    const afterRetarget = store.getJob("job_u1");
    expect(afterRetarget?.target).toEqual({ kind: "new-session", title: "换个目标" });
    expect(store.getBoundSession("job_u1")).toBeNull();
  });

  it("启用一个没有下次执行时刻的任务会立刻可被认领", () => {
    const store = makeStore();
    const now = Date.now();
    store.addJob(
      {
        title: "一次性任务",
        target: { kind: "session", sessionId: "sess_1" },
        prompt: "跑",
        workspacePath: "/tmp/ws",
        schedule: { kind: "once", runAt: now + 60_000 },
        maxAttempts: 2,
      },
      "job_u2",
      now,
    );
    store.claimDue(now);
    store.settleJob("job_u2", { status: "succeeded", error: null, willRetry: false, retryAt: null }, now);
    expect(store.getJob("job_u2")?.nextRunAt).toBeNull();

    store.updateJob("job_u2", { enabled: true }, now + 5000);
    const job = store.getJob("job_u2");
    expect(job?.enabled).toBe(true);
    expect(job?.nextRunAt).toBe(now + 5000);
    const claimed = store.claimDue(now + 6000);
    expect(claimed.map((item) => item.job.id)).toEqual(["job_u2"]);
  });

  it("启动恢复把中断残留的 running 任务复位成待执行", () => {
    const store = makeStore();
    const now = Date.now();
    store.addJob(
      {
        title: "被强杀的任务",
        target: { kind: "session", sessionId: "sess_1" },
        prompt: "跑",
        workspacePath: "/tmp/ws",
        schedule: { kind: "once", runAt: now - 1000 },
        maxAttempts: 2,
      },
      "job_r1",
      now,
    );
    // 模拟 daemon 在执行中途被 SIGKILL：认领后既不结算也不重试。
    store.claimDue(now);
    expect(store.getJob("job_r1")?.lastStatus).toBe("running");
    expect(store.getJob("job_r1")?.nextRunAt).toBeNull();

    const recovered = store.resetStaleRuns(now + 60_000);
    expect(recovered).toBe(1);
    const job = store.getJob("job_r1");
    expect(job?.lastStatus).toBe("scheduled");
    expect(job?.nextRunAt).toBe(now + 60_000);
    const claimed = store.claimDue(now + 61_000);
    expect(claimed.map((item) => item.job.id)).toEqual(["job_r1"]);
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
