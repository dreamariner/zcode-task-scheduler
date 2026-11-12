import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";

/**
 * 桌面端调度器的数据面。
 *
 * 执行不在本插件里发生：本插件只把任务写成桌面端 `automations` 表的一行，
 * 由桌面端自带的调度器进程（electronUtilityProcess 子进程，20 秒轮询）认领，
 * 再由 host 在桌面端自己的会话运行时里投递 prompt（dispatchCronRun）。
 *
 * 这样做的关键收益：执行发生在桌面端运行时里，模型与鉴权都是桌面端自己的，
 * 订阅账号模型（如 Start Plan）可以正常使用，插件完全不需要接触任何凭据。
 *
 * 代价（写在这里，避免以后误判）：桌面端必须开着。桌面端退出或关机期间，
 * 一次性任务有 1 分钟、循环任务有 5 分钟的宽限，超出即记 skipped 不补跑。
 *
 * 表结构与写入形状对齐官方源码：
 * - packages/services/src/session/tasksDatabase/schema-v1.ts（automations 表）
 * - packages/services/src/session/automationRepo.ts（认领、manual run 事务）
 * - packages/services/src/session/automationCron.ts（cron 表达式与 next_run_at）
 */

/** 插件自己的任务在 automations 表里的 id 前缀；只读写带此前缀的行。 */
export const AUTOMATION_ID_PREFIX = "zts_";

/** 官方约定的定时任务条数上限（docs/automation-create-limit.md）。 */
export const AUTOMATION_LIMIT = 20;

/** 桌面端 tasks-index 库路径。 */
export function defaultTasksIndexPath(): string {
  return join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

export type ScheduleKind = "once" | "daily" | "weekly";

export interface ScheduleInput {
  kind: ScheduleKind;
  /** once 用的绝对时刻（毫秒）。 */
  runAt?: number;
  /** daily/weekly 用的当天零点起毫秒偏移。 */
  timeOfDay?: number;
  /** weekly 用的星期（0 是周日）。 */
  weekdays?: number[];
}

export interface AutomationJob {
  automationId: string;
  title: string;
  prompt: string;
  /** 目标会话（桌面端 task_id 就是 CLI 会话 id）。 */
  targetSessionId: string | null;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  schedule: ScheduleInput;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * 显式指定的执行模型。
 *
 * 桌面端读 automations.model_selection：字面量 "null" 表示跟随工作区首选模型；
 * 填具体选择则强制用该模型（桌面端会校验它在自己的注册表里可执行）。
 * 账号套餐模型（account: 前缀）在这里同样可用，因为鉴权由桌面端运行时负责。
 */
export interface ModelOverride {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}

/** model_selection 列的取值：显式选择序列化，或字面量 "null"（跟随工作区首选）。 */
export function serializeModelSelection(override: ModelOverride | null): string {
  if (!override) return "null";
  return JSON.stringify({
    providerId: override.providerId,
    modelId: override.modelId,
    ...(override.reasoningLevel ? { options: { reasoningLevel: override.reasoningLevel } } : {}),
  });
}

export interface AutomationRun {
  runId: string;
  automationId: string;
  trigger: string;
  outcome: string | null;
  error: string | null;
  sessionId: string | null;
  attempts: number;
  scheduledAt: number | null;
  createdAt: number;
}

export interface AutomationRow extends AutomationJob {
  cronExpr: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lifecycleStatus: string;
  running: boolean;
  dispatchStatus: string;
  runCount: number;
  maxRuns: number | null;
  recurring: boolean;
  lastError: string | null;
  /** 桌面端 model_selection 列原值；"null" 表示跟随工作区首选。 */
  modelSelection: string | null;
}

export interface StoreOptions {
  tasksIndexPath?: string;
  log?: (message: string) => void;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 当天零点起毫秒偏移 → 时分。 */
function clockOf(timeOfDay: number): { hour: number; minute: number } {
  const clamped = Math.max(0, Math.min(24 * 60 * 60 * 1000 - 1, timeOfDay));
  return { hour: Math.floor(clamped / 3_600_000), minute: Math.floor((clamped % 3_600_000) / 60_000) };
}

/**
 * 生成五段式 cron 表达式（分 时 日 月 周）。
 * once 用绝对时刻（年内的日 + 月），到期后由桌面端按一次性任务规则收尾。
 */
export function buildCronExpr(schedule: ScheduleInput): string {
  if (schedule.kind === "once") {
    const at = new Date(schedule.runAt ?? Date.now());
    return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
  }
  const { hour, minute } = clockOf(schedule.timeOfDay ?? 0);
  if (schedule.kind === "weekly") {
    const weekdays = [...new Set(schedule.weekdays ?? [0])].sort((a, b) => a - b);
    // croner 与 cron 语义一致：0 是周日，6 是周六。
    return `${minute} ${hour} * * ${weekdays.join(",")}`;
  }
  return `${minute} ${hour} * * *`;
}

/** 按 cron 算下一次执行时刻；表达式非法或无下一次时返回 null。 */
export function computeNextRunAt(cronExpr: string, from: number): number | null {
  try {
    const cron = new Cron(cronExpr, { paused: true });
    const next = cron.nextRun(new Date(from));
    cron.stop();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

interface AutomationDbRow {
  automation_id: string;
  title: string;
  cron_expr: string;
  prompt: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  target_task_id: string | null;
  mode: string | null;
  model: string | null;
  provider: string | null;
  thought_level: string | null;
  model_selection: string | null;
  enabled: number;
  lifecycle_status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
  dispatch_status: string;
  dispatch_attempts: number;
  retry_at: number | null;
  last_error: string | null;
  run_count: number;
  scheduled_run_count: number;
  recurring: number;
  max_runs: number | null;
  end_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunDbRow {
  run_id: string;
  automation_id: string;
  trigger: string;
  outcome: string | null;
  error: string | null;
  session_id: string | null;
  attempts: number;
  scheduled_at: number | null;
  created_at: number;
}

function scheduleOf(row: AutomationDbRow): ScheduleInput {
  const parts = row.cron_expr.trim().split(/\s+/);
  // 一次性：分 时 日 月 *；日不是 * 即为固定月日的一次性任务。
  if (parts.length === 5 && parts[4] === "*" && parts[2] !== "*" && parts[3] !== "*") {
    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    const date = Number(parts[2]);
    const month = Number(parts[3]);
    const now = new Date();
    let year = now.getFullYear();
    const candidate = new Date(year, month - 1, date, hour, minute, 0, 0);
    if (candidate.getTime() < now.getTime() - 60_000) {
      // 已过去的年度目标：按次年计算，桌面端会在认领后收尾。
      year += 1;
    }
    return {
      kind: "once",
      runAt: new Date(year, month - 1, date, hour, minute, 0, 0).getTime(),
    };
  }
  const timeOfDay = (Number(parts[1] ?? 0) * 3_600_000) + (Number(parts[0] ?? 0) * 60_000);
  const weekdayPart = parts[4] ?? "*";
  if (weekdayPart !== "*") {
    const weekdays = weekdayPart
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
    return { kind: "weekly", timeOfDay, weekdays };
  }
  return { kind: "daily", timeOfDay };
}

function toRow(row: AutomationDbRow): AutomationRow {
  return {
    automationId: row.automation_id,
    title: row.title,
    prompt: row.prompt,
    targetSessionId: row.target_task_id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
    schedule: scheduleOf(row),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cronExpr: row.cron_expr,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lifecycleStatus: row.lifecycle_status,
    running: row.running === 1,
    dispatchStatus: row.dispatch_status,
    runCount: row.run_count,
    maxRuns: row.max_runs,
    recurring: row.recurring === 1,
    lastError: row.last_error,
    modelSelection: row.model_selection,
  };
}

/**
 * 桌面端 tasks-index 的读写面。
 *
 * 只碰两类行：automations 里 id 带 zts_ 前缀的、automation_runs 里属于这些任务的。
 * 其他行（用户自己在桌面端建的定时任务）一律不读不写。
 */
export class AutomationStore {
  private readonly path: string;
  private readonly log: (message: string) => void;

  constructor(options: StoreOptions = {}) {
    this.path = options.tasksIndexPath ?? defaultTasksIndexPath();
    this.log = options.log ?? (() => undefined);
  }

  /** 打开库并确认表结构可用；表不存在时返回 null（桌面端还没初始化过索引）。 */
  private open(): DatabaseSync | null {
    let db: DatabaseSync | null = null;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      db = new DatabaseSync(this.path);
      db.exec("PRAGMA busy_timeout=3000");
      db.exec("PRAGMA journal_mode=WAL");
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      if (!tables.has("automations") || !tables.has("automation_runs")) {
        db.close();
        this.log("tasks-index 里还没有 automations 表，等桌面端初始化索引");
        return null;
      }
      return db;
    } catch (error) {
      db?.close();
      this.log(`打开 tasks-index 失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 自己的任务条数（用于 20 条上限）。 */
  count(): number {
    const db = this.open();
    if (!db) return 0;
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total FROM automations WHERE automation_id LIKE ?`,
        )
        .get(`${AUTOMATION_ID_PREFIX}%`) as { total: number };
      return row.total;
    } catch {
      return 0;
    } finally {
      db.close();
    }
  }

  list(): AutomationRow[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT * FROM automations WHERE automation_id LIKE ?
           ORDER BY COALESCE(next_run_at, created_at) ASC, created_at ASC`,
        )
        .all(`${AUTOMATION_ID_PREFIX}%`) as unknown as AutomationDbRow[];
      return rows.map(toRow);
    } catch (error) {
      this.log(`读取任务失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      db.close();
    }
  }

  get(automationId: string): AutomationRow | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db
        .prepare("SELECT * FROM automations WHERE automation_id = ?")
        .get(automationId) as AutomationDbRow | undefined;
      return row ? toRow(row) : null;
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  /**
   * 登记任务。
   *
   * 关键取舍：不写 model_selection、model、provider、thought_level，
   * 桌面端派发时就会沿用目标会话自己的模型（订阅账号模型由此可用）。
   */
  create(
    job: Omit<AutomationJob, "automationId" | "createdAt" | "updatedAt"> & {
      automationId?: string;
      /**
       * 显式执行模型；null 或不传表示跟随工作区首选（桌面端会话当前选择）。
       * 调用方（server 层）会显式给出值：默认 MiniMax，或用户指定的模型。
       */
      model?: ModelOverride | null;
    },
  ): AutomationRow {
    const db = this.open();
    if (!db) throw new Error("桌面端任务索引不可用（tasks-index 里还没有 automations 表）");
    try {
      const now = Date.now();
      const automationId = job.automationId ?? `${AUTOMATION_ID_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const cronExpr = buildCronExpr(job.schedule);
      const nextRunAt = computeNextRunAt(cronExpr, now);
      if (nextRunAt === null) {
        throw new Error(`排期表达式无法解析：${cronExpr}`);
      }
      const recurring = job.schedule.kind !== "once";
      db.prepare(
        `INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, provider, mode, thought_level,
          model_selection, workspace_key, workspace_path, workspace_identity,
          target_task_id, bot_delivery_target, location_kind, recurring, max_runs,
          end_at, schedule_rule, schedule_edited_by_user, run_count, scheduled_run_count,
          enabled, lifecycle_status, next_run_at, last_run_at, running, claimed_at,
          dispatch_status, dispatch_attempts, retry_at, last_error, created_at, updated_at
        ) VALUES (
          @automation_id, @title, @cron_expr, @prompt, NULL, NULL, @mode, NULL,
          @model_selection, @workspace_key, @workspace_path, @workspace_identity,
          @target_task_id, NULL, 'local', @recurring, @max_runs,
          NULL, NULL, 0, 0, 0, @enabled, 'active', @next_run_at, NULL, 0, NULL,
          'idle', 0, NULL, NULL, @now, @now
        )`,
      ).run({
        automation_id: automationId,
        title: job.title,
        cron_expr: cronExpr,
        prompt: job.prompt,
        mode: "yolo",
        // 桌面端用字面量 "null" 表示「跟随工作区首选模型」（SQL NULL 是缺配置，会直接报错）。
        model_selection: serializeModelSelection(job.model ?? null),
        workspace_key: job.workspaceKey,
        workspace_path: job.workspacePath,
        workspace_identity: job.workspaceIdentity ?? null,
        target_task_id: job.targetSessionId,
        recurring: recurring ? 1 : 0,
        max_runs: recurring ? null : 1,
        enabled: job.enabled ? 1 : 0,
        next_run_at: nextRunAt,
        now,
      });
      const created = this.get(automationId);
      if (!created) throw new Error("任务写入后读不回来");
      return created;
    } finally {
      db.close();
    }
  }

  /** 改期（重算 cron 与 next_run_at）、改内容、停用或启用。 */
  update(
    automationId: string,
    patch: {
      title?: string;
      prompt?: string;
      enabled?: boolean;
      schedule?: ScheduleInput;
    },
  ): AutomationRow | null {
    const db = this.open();
    if (!db) return null;
    try {
      const current = db
        .prepare("SELECT * FROM automations WHERE automation_id = ?")
        .get(automationId) as AutomationDbRow | undefined;
      if (!current) return null;
      const now = Date.now();
      const schedule = patch.schedule ?? scheduleOf(current);
      const cronExpr = patch.schedule ? buildCronExpr(schedule) : current.cron_expr;
      let nextRunAt = current.next_run_at;
      if (patch.schedule) {
        const computed = computeNextRunAt(cronExpr, now);
        if (computed === null) throw new Error(`排期表达式无法解析：${cronExpr}`);
        nextRunAt = computed;
      }
      db.prepare(
        `UPDATE automations SET title = @title, prompt = @prompt, enabled = @enabled,
           cron_expr = @cron_expr, next_run_at = @next_run_at, recurring = @recurring,
           max_runs = @max_runs, updated_at = @now
         WHERE automation_id = @automation_id`,
      ).run({
        title: patch.title ?? current.title,
        prompt: patch.prompt ?? current.prompt,
        enabled: (patch.enabled ?? current.enabled === 1) ? 1 : 0,
        cron_expr: cronExpr,
        next_run_at: nextRunAt,
        recurring: (patch.schedule ? schedule.kind !== "once" : current.recurring === 1) ? 1 : 0,
        max_runs:
          patch.schedule
            ? schedule.kind === "once"
              ? 1
              : null
            : current.max_runs,
        now,
        automation_id: automationId,
      });
      const updated = this.get(automationId);
      return updated;
    } finally {
      db.close();
    }
  }

  /** 删除任务及其运行记录。 */
  remove(automationId: string): boolean {
    const db = this.open();
    if (!db) return false;
    try {
      db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(automationId);
      const result = db.prepare("DELETE FROM automations WHERE automation_id = ?").run(automationId);
      return result.changes === 1;
    } finally {
      db.close();
    }
  }

  /**
   * 「立即执行」：插一行 manual run 交给桌面端调度器认领并派发。
   *
   * 形状必须与调度器的认领条件对齐（packages/desktop/src/scheduler/index.ts →
   * AutomationRepo.claimManualRuns）：
   * - run 行 dispatch_status='claimed' 且 attempts=0（attempts=1 表示已交给宿主直派方，
   *   调度器只在认领超时后才做崩溃恢复，插件插的行必须留 0）；
   * - **不占** automations.running 锁：调度器的认领条件要求 a.running=0，由它自己占锁。
   *
   * manual run 不推进 next_run_at，也不改生命周期：跑这一次不影响原排期。
   */
  enqueueManualRun(automationId: string): { runId: string } | null {
    const db = this.open();
    if (!db) return null;
    try {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db
          .prepare("SELECT running, workspace_key FROM automations WHERE automation_id = ?")
          .get(automationId) as { running: number; workspace_key: string } | undefined;
        if (!current) {
          db.exec("ROLLBACK");
          return null;
        }
        // 已有在途执行时不重复排队：同一目标的并发投递会让模型配置互相踩踏。
        if (current.running === 1) {
          db.exec("ROLLBACK");
          return null;
        }
        const runId = `${automationId}:manual:${randomUUID()}`;
        db.prepare(
          `INSERT INTO automation_runs (
            run_id, automation_id, workspace_key, scheduled_at, trigger,
            model_selection, dispatch_status, attempts, created_at, updated_at
          ) VALUES (
            @run_id, @automation_id, @workspace_key, @scheduled_at, 'manual',
            NULL, 'claimed', 0, @now, @now
          )`,
        ).run({
          run_id: runId,
          automation_id: automationId,
          workspace_key: current.workspace_key,
          scheduled_at: now,
          now,
        });
        db.exec("COMMIT");
        return { runId };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  /** 最近运行记录（面板运行日志与状态摘要用）。 */
  listRuns(automationId?: string, limit = 30): AutomationRun[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = (
        automationId
          ? db
              .prepare(
                `SELECT r.* FROM automation_runs r
                 JOIN automations a ON a.automation_id = r.automation_id
                 WHERE r.automation_id = ? AND a.automation_id LIKE ?
                 ORDER BY r.created_at DESC LIMIT ?`,
              )
              .all(automationId, `${AUTOMATION_ID_PREFIX}%`, limit)
          : db
              .prepare(
                `SELECT r.* FROM automation_runs r
                 JOIN automations a ON a.automation_id = r.automation_id
                 WHERE a.automation_id LIKE ?
                 ORDER BY r.created_at DESC LIMIT ?`,
              )
              .all(`${AUTOMATION_ID_PREFIX}%`, limit)
      ) as unknown as RunDbRow[];
      return rows.map((row) => ({
        runId: row.run_id,
        automationId: row.automation_id,
        trigger: row.trigger,
        outcome: row.outcome,
        error: row.error,
        sessionId: row.session_id,
        attempts: row.attempts,
        scheduledAt: row.scheduled_at,
        createdAt: row.created_at,
      }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  /**
   * 桌面端 tasks 表里的会话（task_id 就是 CLI 会话 id），用来给任务挑目标会话。
   */
  listWorkspaceTasks(workspaceKey: string, limit = 100): {
    taskId: string;
    title: string;
    updatedAt: number | null;
  }[] {
    const db = this.open();
    if (!db) return [];
    try {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      if (!tables.has("tasks")) return [];
      const rows = db
        .prepare(
          `SELECT task_id, title, updated_at FROM tasks
           WHERE workspace_key = ? AND cli_deleted = 0
           ORDER BY COALESCE(cli_updated_at, updated_at) DESC LIMIT ?`,
        )
        .all(workspaceKey, limit) as { task_id: string; title: string | null; updated_at: number | null }[];
      return rows.map((row) => ({
        taskId: row.task_id,
        title: row.title?.trim() ?? "",
        updatedAt: row.updated_at,
      }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }
}
