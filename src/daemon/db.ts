import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS,
  type Job,
  type JobInput,
  type JobPatch,
  type JobStatus,
  type JobTarget,
  type RunRecord,
  type RunStatus,
  type Schedule,
  type SchedulerSettings,
} from "../shared/types.js";
import { nextRunAt } from "../shared/schedule.js";

/**
 * 任务与运行记录的状态层。
 *
 * 存储位置是插件数据目录（不进版本库）。写入纪律照仓库里 pilot-core 的做法：
 * busy_timeout 必须先于 journal_mode，WAL 让读写不互斥，写事务用 BEGIN IMMEDIATE
 * 并在 busy 时整体重试，失败响亮报错而不是静默丢数据。
 */
const BUSY_TIMEOUT_MS = 3000;
const WRITE_MAX_ATTEMPTS = 5;

const DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_session_id TEXT,
  target_label TEXT,
  target_title TEXT,
  prompt TEXT NOT NULL,
  workspace_path TEXT NOT NULL DEFAULT '',
  workspace_identity TEXT,
  schedule_kind TEXT NOT NULL,
  schedule_run_at INTEGER,
  schedule_time_of_day INTEGER,
  schedule_weekdays TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  last_status TEXT,
  last_run_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  bound_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  session_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, id DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|SQLITE_LOCKED|database (table )?is locked/i.test(message);
}

function execWithRetry(db: DatabaseSync, sql: string): void {
  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      db.exec(sql);
      return;
    } catch (error) {
      if (!isBusyError(error) || attempt === WRITE_MAX_ATTEMPTS) throw error;
    }
  }
}

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  execWithRetry(db, "PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  execWithRetry(db, DDL);
  return db;
}

/** 认领结果：dueAt 是被认领那一刻的计划时刻，调度器靠它判断错过窗口。 */
export interface ClaimedJob {
  job: Job;
  dueAt: number;
}

function rowToJob(row: Record<string, unknown>): Job {
  const kind = String(row.target_kind);
  const target: JobTarget =
    kind === "new-session"
      ? {
          kind: "new-session",
          ...(row.target_title ? { title: String(row.target_title) } : {}),
        }
      : {
          kind: "session",
          sessionId: String(row.target_session_id ?? ""),
          ...(row.target_label ? { label: String(row.target_label) } : {}),
        };

  let schedule: Schedule;
  if (row.schedule_kind === "daily") {
    schedule = { kind: "daily", timeOfDay: Number(row.schedule_time_of_day ?? 0) };
  } else if (row.schedule_kind === "weekly") {
    const raw = String(row.schedule_weekdays ?? "[]");
    let weekdays: number[] = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) weekdays = parsed.map(Number).filter((n) => Number.isInteger(n));
    } catch {
      weekdays = [];
    }
    schedule = { kind: "weekly", timeOfDay: Number(row.schedule_time_of_day ?? 0), weekdays };
  } else {
    schedule = { kind: "once", runAt: Number(row.schedule_run_at ?? 0) };
  }

  return {
    id: String(row.id),
    title: String(row.title),
    target,
    prompt: String(row.prompt),
    workspacePath: String(row.workspace_path ?? ""),
    ...(row.workspace_identity ? { workspaceIdentity: String(row.workspace_identity) } : {}),
    schedule,
    enabled: Number(row.enabled) === 1,
    maxAttempts: Number(row.max_attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
    lastStatus: (row.last_status as JobStatus | null) ?? null,
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    consecutiveFailures: Number(row.consecutive_failures),
  };
}

interface ScheduleColumns {
  schedule_kind: string;
  schedule_run_at: number | null;
  schedule_time_of_day: number | null;
  schedule_weekdays: string | null;
}

function scheduleColumns(schedule: Schedule): ScheduleColumns {
  if (schedule.kind === "daily") {
    return {
      schedule_kind: "daily",
      schedule_run_at: null,
      schedule_time_of_day: schedule.timeOfDay,
      schedule_weekdays: null,
    };
  }
  if (schedule.kind === "weekly") {
    return {
      schedule_kind: "weekly",
      schedule_run_at: null,
      schedule_time_of_day: schedule.timeOfDay,
      schedule_weekdays: JSON.stringify(schedule.weekdays),
    };
  }
  return {
    schedule_kind: "once",
    schedule_run_at: schedule.runAt,
    schedule_time_of_day: null,
    schedule_weekdays: null,
  };
}

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}

  listJobs(): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs ORDER BY created_at ASC").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToJob);
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToJob(row) : null;
  }

  addJob(input: JobInput, id: string, now: number): Job {
    const schedule = scheduleColumns(input.schedule);
    const firstRun = nextRunAt(input.schedule, now);
    this.db
      .prepare(
        `INSERT INTO jobs (
           id, title, target_kind, target_session_id, target_label, target_title,
           prompt, workspace_path, workspace_identity,
           schedule_kind, schedule_run_at, schedule_time_of_day, schedule_weekdays,
           enabled, max_attempts, next_run_at, last_status, last_run_at, last_error,
           consecutive_failures, bound_session_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.target.kind,
        input.target.kind === "session" ? input.target.sessionId : null,
        input.target.kind === "session" ? (input.target.label ?? null) : null,
        input.target.kind === "new-session" ? (input.target.title ?? null) : null,
        input.prompt,
        input.workspacePath,
        input.workspaceIdentity ?? null,
        schedule.schedule_kind,
        schedule.schedule_run_at,
        schedule.schedule_time_of_day,
        schedule.schedule_weekdays,
        input.enabled === false ? 0 : 1,
        input.maxAttempts ?? 3,
        firstRun,
        null,
        null,
        null,
        0,
        null,
        now,
        now,
      );
    const created = this.getJob(id);
    if (!created) throw new Error(`写入任务 ${id} 后读不出来`);
    return created;
  }

  updateJob(id: string, patch: JobPatch, now: number): Job | null {
    const job = this.getJob(id);
    if (!job) return null;
    // patch 里没带 target 时必须沿用库里的原值：面板的停用/启用、改期都只传部分字段，
    // 之前这里把 target 三列无条件写成 null，kind 却保留，session 类任务从此废掉。
    const target = patch.target ?? job.target;
    const boundBefore = this.getBoundSession(id);
    const schedule = patch.schedule ? scheduleColumns(patch.schedule) : null;
    // 启用一个没有下次执行时刻的任务（典型是已完成的 once）要让它立刻可被认领，
    // 否则「启用」按钮看起来毫无作用。
    const nextRun = schedule
      ? nextRunAt(patch.schedule as Schedule, now)
      : patch.enabled === true && job.nextRunAt === null
        ? now
        : job.nextRunAt;
    this.db
      .prepare(
        `UPDATE jobs SET
           title = ?, prompt = ?, target_kind = ?, target_session_id = ?, target_label = ?,
           target_title = ?, schedule_kind = ?, schedule_run_at = ?, schedule_time_of_day = ?,
           schedule_weekdays = ?, enabled = ?, max_attempts = ?, next_run_at = ?,
           bound_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? job.title,
        patch.prompt ?? job.prompt,
        target.kind,
        target.kind === "session" ? target.sessionId : null,
        target.kind === "session" ? (target.label ?? null) : null,
        target.kind === "new-session" ? (target.title ?? null) : null,
        schedule ? schedule.schedule_kind : scheduleKindOf(job.schedule),
        schedule ? schedule.schedule_run_at : runAtOf(job.schedule),
        schedule ? schedule.schedule_time_of_day : timeOfDayOf(job.schedule),
        schedule ? schedule.schedule_weekdays : weekdaysOf(job.schedule),
        patch.enabled === undefined ? (job.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
        patch.maxAttempts ?? job.maxAttempts,
        nextRun,
        // 目标变了就作废旧绑定：new-session 任务换目标后不该复用上一次新建的会话。
        patch.target !== undefined ? null : boundBefore,
        now,
        id,
      );
    return this.getJob(id);
  }

  removeJob(id: string): boolean {
    this.db.prepare("DELETE FROM runs WHERE job_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  /** 认领结果：job 是清空 next_run_at 之后的最新快照，dueAt 是被认领时的计划时刻。 */
  claimDue(now: number): ClaimedJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           AND last_status IS NOT 'running'`,
      )
      .all(now) as Record<string, unknown>[];
    const claimed: ClaimedJob[] = [];
    for (const row of rows) {
      const id = String(row.id);
      // 计划时刻必须在清空之前取走：UPDATE 会把它抹掉，而调度器的
      // 「错过窗口」判断靠它区分「到点了」和「搁置了几天才轮到」。
      const dueAt = Number(row.next_run_at);
      const result = this.db
        .prepare(
          "UPDATE jobs SET last_status = 'running', next_run_at = NULL, updated_at = ? WHERE id = ? AND next_run_at IS NOT NULL",
        )
        .run(now, id);
      if (Number(result.changes) === 1) {
        const job = this.getJob(id);
        if (job) claimed.push({ job, dueAt });
      }
    }
    return claimed;
  }

  /**
   * 启动恢复：daemon 在执行中途被强杀时，任务会留在 running 且没有 next_run_at，
   * claimDue 的条件永远挑不到它。启动时把这类残留复位成待执行。
   */
  resetStaleRuns(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE jobs SET last_status = 'scheduled',
           next_run_at = COALESCE(next_run_at, ?), updated_at = ?
         WHERE last_status = 'running'`,
      )
      .run(now, now);
    return Number(result.changes);
  }

  /** 熔断用：直接改启用位。停用时把 next_run_at 一并清掉，空闲自退判断才能生效。 */
  setEnabled(id: string, enabled: boolean, now: number): void {
    const job = this.getJob(id);
    if (!job) return;
    const nextRun = enabled ? (job.nextRunAt ?? nextRunAt(job.schedule, now)) : null;
    this.db
      .prepare("UPDATE jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nextRun, now, id);
  }

  markRunning(jobId: string, now: number): void {
    this.db
      .prepare("UPDATE jobs SET last_status = 'running', next_run_at = NULL, last_run_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, jobId);
  }

  /** 记录一次尝试的开始。 */
  startRun(jobId: string, attempt: number, sessionId: string | null, now: number): number {
    const result = this.db
      .prepare(
        "INSERT INTO runs (job_id, attempt, session_id, started_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run(jobId, attempt, sessionId, now);
    return Number(result.lastInsertRowid);
  }

  finishRun(
    runId: number,
    outcome: {
      status: RunStatus;
      errorCode?: string | null;
      errorMessage?: string | null;
      tokens?: number | null;
    },
    now: number,
  ): void {
    this.db
      .prepare(
        "UPDATE runs SET ended_at = ?, status = ?, error_code = ?, error_message = ?, tokens = ? WHERE id = ?",
      )
      .run(
        now,
        outcome.status,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        outcome.tokens ?? null,
        runId,
      );
  }

  /** 新建会话类型的任务在首次执行后会固定到一个具体会话，后续重试沿用它。 */
  bindSession(jobId: string, sessionId: string, now: number): void {
    this.db
      .prepare("UPDATE jobs SET bound_session_id = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, now, jobId);
  }

  getBoundSession(jobId: string): string | null {
    const row = this.db.prepare("SELECT bound_session_id FROM jobs WHERE id = ?").get(jobId) as
      | Record<string, unknown>
      | undefined;
    const value = row?.bound_session_id;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /** 结算一次尝试：更新任务状态，并计算下一次执行时刻。 */
  settleJob(
    jobId: string,
    outcome: {
      status: "succeeded" | "failed";
      error: string | null;
      willRetry: boolean;
      retryAt: number | null;
    },
    now: number,
  ): void {
    const job = this.getJob(jobId);
    if (!job) return;
    const recurring = job.schedule.kind !== "once";
    const nextRun = outcome.willRetry
      ? outcome.retryAt
      : recurring
        ? nextRunAt(job.schedule, now)
        : null;
    const status: JobStatus = outcome.willRetry
      ? "retrying"
      : outcome.status === "succeeded"
        ? "succeeded"
        : "failed";
    const failures = outcome.status === "succeeded" ? 0 : job.consecutiveFailures + 1;

    this.db
      .prepare(
        `UPDATE jobs SET last_status = ?, last_error = ?, consecutive_failures = ?,
           next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, outcome.error, failures, nextRun, now, now, jobId);
  }

  listRuns(jobId: string | null, limit = 50): RunRecord[] {
    const rows = (
      jobId
        ? this.db
            .prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT ?")
            .all(jobId, limit)
        : this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      jobId: String(row.job_id),
      attempt: Number(row.attempt),
      sessionId: row.session_id === null ? null : String(row.session_id),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      status: String(row.status) as RunStatus,
      errorCode: row.error_code === null ? null : String(row.error_code),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      tokens: row.tokens === null ? null : Number(row.tokens),
    }));
  }

  getSettings(): SchedulerSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'scheduler'").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(String(row.value)) as Partial<SchedulerSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        model: { ...DEFAULT_SETTINGS.model, ...(parsed.model ?? {}) },
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  setSettings(patch: Partial<SchedulerSettings>): SchedulerSettings {
    const merged: SchedulerSettings = {
      ...this.getSettings(),
      ...patch,
      model: { ...this.getSettings().model, ...(patch.model ?? {}) },
    };
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('scheduler', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(merged));
    return merged;
  }

  close(): void {
    this.db.close();
  }
}

function scheduleKindOf(schedule: Schedule): string {
  return schedule.kind;
}

function runAtOf(schedule: Schedule): number | null {
  return schedule.kind === "once" ? schedule.runAt : null;
}

function timeOfDayOf(schedule: Schedule): number | null {
  return schedule.kind === "once" ? null : schedule.timeOfDay;
}

function weekdaysOf(schedule: Schedule): string | null {
  return schedule.kind === "weekly" ? JSON.stringify(schedule.weekdays) : null;
}
