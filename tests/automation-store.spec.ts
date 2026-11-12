import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutomationStore,
  AUTOMATION_ID_PREFIX,
  AUTOMATION_LIMIT,
  buildCronExpr,
  computeNextRunAt,
} from "../src/automation/store.js";

/**
 * fixture 库要照官方 schema 建表（packages/services/src/session/tasksDatabase/schema-v1.ts），
 * 少了列就会让写入形状测试失去意义。
 */
const FIXTURE_SCHEMA = `
CREATE TABLE automations (
  automation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  cron_expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  mode TEXT,
  thought_level TEXT,
  model_selection TEXT,
  workspace_key TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_identity TEXT,
  target_task_id TEXT,
  bot_delivery_target TEXT,
  location_kind TEXT NOT NULL DEFAULT 'local',
  recurring INTEGER NOT NULL DEFAULT 1,
  max_runs INTEGER,
  end_at INTEGER,
  schedule_rule TEXT,
  schedule_edited_by_user INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  scheduled_run_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  next_run_at INTEGER,
  last_run_at INTEGER,
  running INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  dispatch_status TEXT NOT NULL DEFAULT 'idle',
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE automation_runs (
  run_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  scheduled_at INTEGER,
  trigger TEXT NOT NULL DEFAULT 'schedule',
  model_selection TEXT,
  dispatch_status TEXT NOT NULL DEFAULT 'claimed',
  outcome TEXT,
  session_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  workspace_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT,
  updated_at INTEGER,
  cli_updated_at INTEGER,
  cli_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_key, task_id)
);
`;

const fixtures: string[] = [];

function makeFixture(): { path: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "zts-auto-"));
  fixtures.push(dir);
  const path = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(path);
  db.exec(FIXTURE_SCHEMA);
  return { path, db };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cron 表达式", () => {
  it("一次性用绝对时刻的五段式", () => {
    const at = new Date(2026, 10, 12, 3, 45).getTime();
    expect(buildCronExpr({ kind: "once", runAt: at })).toBe("45 3 12 11 *");
  });

  it("每天与每周", () => {
    expect(buildCronExpr({ kind: "daily", timeOfDay: 30 * 60_000 })).toBe("30 0 * * *");
    expect(buildCronExpr({ kind: "weekly", timeOfDay: 9 * 3_600_000, weekdays: [1, 5] })).toBe(
      "0 9 * * 1,5",
    );
  });

  it("下一次执行时刻可算且非法表达式返回 null", () => {
    const next = computeNextRunAt("30 0 * * *", new Date(2026, 10, 12, 10, 0).getTime());
    expect(next).toBe(new Date(2026, 10, 13, 0, 30).getTime());
    expect(computeNextRunAt("不是 cron", Date.now())).toBeNull();
  });
});

describe("任务登记", () => {
  it("写入的行不指定模型与鉴权（跟随会话），并算出下次执行", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "审查史料",
      prompt: "核对史料准确性",
      targetSessionId: "sess_abc",
      workspaceKey: "/tmp/ws",
      workspacePath: "/tmp/ws",
      schedule: { kind: "daily", timeOfDay: 30 * 60_000 },
      enabled: true,
    });
    expect(job.automationId.startsWith(AUTOMATION_ID_PREFIX)).toBe(true);
    expect(job.nextRunAt).toBeGreaterThan(Date.now());

    const row = db
      .prepare("SELECT * FROM automations WHERE automation_id = ?")
      .get(job.automationId) as Record<string, unknown>;
    // 桌面端用字面量 "null" 表示跟随工作区首选（SQL NULL 是缺配置，会被直接拒绝）。
    expect(row.model_selection).toBe("null");
    expect(row.model).toBeNull();
    expect(row.provider).toBeNull();
    expect(row.thought_level).toBeNull();
    expect(row.target_task_id).toBe("sess_abc");
    expect(row.mode).toBe("yolo");
    expect(row.enabled).toBe(1);
    expect(row.lifecycle_status).toBe("active");
    expect(row.recurring).toBe(1);
    expect(row.max_runs).toBeNull();
    expect(row.location_kind).toBe("local");
    db.close();
  });

  it("一次性任务标为不可重复", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "一次性",
      prompt: "跑一次",
      targetSessionId: null,
      workspaceKey: "/tmp/ws",
      workspacePath: "/tmp/ws",
      schedule: { kind: "once", runAt: Date.now() + 60_000 },
      enabled: true,
    });
    const row = db
      .prepare("SELECT recurring, max_runs FROM automations WHERE automation_id = ?")
      .get(job.automationId) as { recurring: number; max_runs: number | null };
    expect(row.recurring).toBe(0);
    expect(row.max_runs).toBe(1);
    db.close();
  });

  it("显式指定模型时写入完整选择（含思考档位）", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "指定模型",
      prompt: "p",
      targetSessionId: "sess_1",
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
      model: {
        providerId: "account:bigmodel-start-plan",
        modelId: "GLM-5.3-Flash",
        reasoningLevel: "max",
      },
    });
    const row = db
      .prepare("SELECT model_selection FROM automations WHERE automation_id = ?")
      .get(job.automationId) as { model_selection: string };
    // 桌面端派发前会校验这个 JSON，且要求带 options.reasoningLevel。
    expect(JSON.parse(row.model_selection)).toEqual({
      providerId: "account:bigmodel-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "max" },
    });
    db.close();
  });

  it("model 为 null 时跟随工作区首选", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "跟随会话",
      prompt: "p",
      targetSessionId: null,
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
      model: null,
    });
    const row = db
      .prepare("SELECT model_selection FROM automations WHERE automation_id = ?")
      .get(job.automationId) as { model_selection: string };
    expect(row.model_selection).toBe("null");
    db.close();
  });

  it("只列自己的行（zts_ 前缀），别的任务不碰", () => {    const { path, db } = makeFixture();
    db.prepare(
      `INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, workspace_path,
         recurring, max_runs, enabled, lifecycle_status, created_at, updated_at)
       VALUES ('other_1', '别人的', '0 0 * * *', 'p', '/w', '/w', 1, NULL, 1, 'active', 1, 1)`,
    ).run();
    const store = new AutomationStore({ tasksIndexPath: path });
    store.create({
      title: "我的",
      prompt: "p",
      targetSessionId: null,
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
    });
    const jobs = store.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("我的");
    expect(store.count()).toBe(1);
    db.close();
  });
});

describe("改期与停用", () => {
  it("改期重算 cron 与下次执行时刻", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "任务",
      prompt: "p",
      targetSessionId: null,
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
    });
    const updated = store.update(job.automationId, {
      schedule: { kind: "weekly", timeOfDay: 9 * 3_600_000, weekdays: [3] },
    });
    expect(updated?.cronExpr).toBe("0 9 * * 3");
    expect(updated?.nextRunAt).toBeGreaterThan(Date.now());
    const row = db
      .prepare("SELECT cron_expr, recurring, max_runs FROM automations WHERE automation_id = ?")
      .get(job.automationId) as { cron_expr: string; recurring: number; max_runs: number | null };
    expect(row.cron_expr).toBe("0 9 * * 3");
    expect(row.recurring).toBe(1);
    expect(row.max_runs).toBeNull();
    db.close();
  });

  it("停用与启用只翻 enabled，不动排期", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "任务",
      prompt: "p",
      targetSessionId: null,
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
    });
    const before = db
      .prepare("SELECT next_run_at FROM automations WHERE automation_id = ?")
      .get(job.automationId) as { next_run_at: number };
    const disabled = store.update(job.automationId, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.nextRunAt).toBe(before.next_run_at);
    db.close();
  });
});

describe("立即执行", () => {
  it("插入 manual run，不占 running 锁（由调度器自己认领）", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "任务",
      prompt: "p",
      targetSessionId: "sess_x",
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
    });
    const result = store.enqueueManualRun(job.automationId);
    expect(result?.runId).toContain(":manual:");
    const run = db
      .prepare("SELECT * FROM automation_runs WHERE run_id = ?")
      .get(result!.runId) as { trigger: string; dispatch_status: string; attempts: number };
    expect(run.trigger).toBe("manual");
    expect(run.dispatch_status).toBe("claimed");
    // attempts=0 是调度器的认领条件（attempts=1 表示已交给宿主直派方）。
    expect(run.attempts).toBe(0);
    const automation = db
      .prepare("SELECT running, claimed_at FROM automations WHERE automation_id = ?")
      .get(job.automationId) as { running: number; claimed_at: number | null };
    // 不占锁：调度器的认领要求 a.running=0，由它自己占。
    expect(automation.running).toBe(0);
    expect(automation.claimed_at).toBeNull();
    db.close();
  });

  it("已有在途执行时不重复排队", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "任务",
      prompt: "p",
      targetSessionId: null,
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
    });
    db.prepare("UPDATE automations SET running = 1 WHERE automation_id = ?").run(job.automationId);
    expect(store.enqueueManualRun(job.automationId)).toBeNull();
    db.close();
  });

  it("不存在的任务返回 null", () => {
    const { path } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    expect(store.enqueueManualRun("zts_missing")).toBeNull();
  });
});

describe("删除与运行记录", () => {
  it("删除任务时一并清掉它的运行记录", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "任务",
      prompt: "p",
      targetSessionId: null,
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
    });
    store.enqueueManualRun(job.automationId);
    expect(store.listRuns(job.automationId)).toHaveLength(1);
    expect(store.remove(job.automationId)).toBe(true);
    expect(store.listRuns(job.automationId)).toHaveLength(0);
    const count = db
      .prepare("SELECT COUNT(*) AS total FROM automation_runs WHERE automation_id = ?")
      .get(job.automationId) as { total: number };
    expect(count.total).toBe(0);
    db.close();
  });

  it("运行记录按时间倒序返回", () => {
    const { path, db } = makeFixture();
    const store = new AutomationStore({ tasksIndexPath: path });
    const job = store.create({
      title: "任务",
      prompt: "p",
      targetSessionId: null,
      workspaceKey: "/w",
      workspacePath: "/w",
      schedule: { kind: "daily", timeOfDay: 0 },
      enabled: true,
    });
    db.prepare(
      `INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status,
         outcome, attempts, created_at, updated_at)
       VALUES ('r1', ?, '/w', 'schedule', 'dispatched', 'success', 1, 100, 100)`,
    ).run(job.automationId);
    db.prepare(
      `INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status,
         outcome, attempts, created_at, updated_at)
       VALUES ('r2', ?, '/w', 'schedule', 'dispatched', 'failed', 1, 200, 200)`,
    ).run(job.automationId);
    const runs = store.listRuns(job.automationId);
    expect(runs.map((run) => run.runId)).toEqual(["r2", "r1"]);
    expect(runs[0]?.outcome).toBe("failed");
    db.close();
  });
});

describe("会话列表", () => {
  it("只列同工作区的会话，桌面端 task_id 即会话 id", () => {
    const { path, db } = makeFixture();
    db.prepare(
      `INSERT INTO tasks (workspace_key, task_id, title, updated_at, cli_deleted)
       VALUES ('/w', 'sess_1', '会话一', 10, 0),
              ('/w', 'sess_2', '会话二', 20, 0),
              ('/other', 'sess_3', '别处', 30, 0),
              ('/w', 'sess_4', '已删除', 40, 1)`,
    ).run();
    const store = new AutomationStore({ tasksIndexPath: path });
    const tasks = store.listWorkspaceTasks("/w");
    expect(tasks.map((task) => task.taskId)).toEqual(["sess_2", "sess_1"]);
    db.close();
  });
});

describe("上限", () => {
  it("官方约定 20 条", () => {
    expect(AUTOMATION_LIMIT).toBe(20);
  });
});
