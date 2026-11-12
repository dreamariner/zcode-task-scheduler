import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync } from "node:fs";
import { legacyStateDbPath } from "../shared/paths.js";
import { AutomationStore, type ScheduleInput } from "./store.js";

/**
 * 一次性迁移：旧版插件自己的 state.db 里的任务 → 桌面端 automations 表。
 *
 * 旧库的结构（2026-11-12 之前）：
 *   jobs(id, title, target_kind, target_session_id, prompt, workspace_path,
 *        workspace_identity, schedule_kind, schedule_run_at, schedule_time_of_day,
 *        schedule_weekdays, enabled, ...)
 *
 * 迁移是 best-effort：能转的转，转不了的（旧排期已过、库损坏）只记日志。
 * 迁完把旧库改名保留，不删：用户想回退时还有据可依。
 */

interface LegacyJobRow {
  id: string;
  title: string;
  target_kind: string;
  target_session_id: string | null;
  prompt: string;
  workspace_path: string;
  workspace_identity: string | null;
  schedule_kind: string;
  schedule_run_at: number | null;
  schedule_time_of_day: number | null;
  schedule_weekdays: string | null;
  enabled: number;
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
  renamed: boolean;
}

export function migrateLegacyJobs(
  store: AutomationStore,
  options: { env?: NodeJS.ProcessEnv; log?: (message: string) => void } = {},
): MigrationResult {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const result: MigrationResult = { migrated: 0, skipped: 0, renamed: false };

  const legacyPath = legacyStateDbPath(env);
  if (!existsSync(legacyPath)) return result;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(legacyPath);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get();
    if (!table) return result;
    const rows = db.prepare("SELECT * FROM jobs").all() as unknown as LegacyJobRow[];
    for (const row of rows) {
      if (row.enabled !== 1) {
        result.skipped += 1;
        continue;
      }
      try {
        const schedule: ScheduleInput = scheduleOf(row);
        store.create({
          title: row.title || "未命名任务",
          prompt: row.prompt,
          targetSessionId: row.target_kind === "session" ? row.target_session_id : null,
          workspaceKey: row.workspace_path,
          workspacePath: row.workspace_path,
          ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
          schedule,
          enabled: true,
        });
        result.migrated += 1;
      } catch (error) {
        result.skipped += 1;
        log(
          `旧任务 ${row.id} 迁移失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    log(`读旧任务库失败，跳过迁移：${error instanceof Error ? error.message : String(error)}`);
    return result;
  } finally {
    db?.close();
  }

  try {
    renameSync(legacyPath, `${legacyPath}.migrated`);
    result.renamed = true;
  } catch (error) {
    log(
      `旧任务库改名失败（可忽略）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}

function scheduleOf(row: LegacyJobRow): ScheduleInput {
  const kind = row.schedule_kind === "once" || row.schedule_kind === "weekly" ? row.schedule_kind : "daily";
  if (kind === "once") {
    return { kind, runAt: row.schedule_run_at ?? Date.now() + 60_000 };
  }
  const timeOfDay = row.schedule_time_of_day ?? 0;
  if (kind === "weekly") {
    const weekdays = (row.schedule_weekdays ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
    return { kind, timeOfDay, weekdays: weekdays.length > 0 ? weekdays : [0] };
  }
  return { kind, timeOfDay };
}
