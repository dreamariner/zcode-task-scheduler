import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 让桌面端的任务列表看见 daemon 新建的会话。
 *
 * 背景（对齐官方源码）：
 * - 桌面端侧栏列表读的是 tasks-index 的 tasks 表，条件是 `cli_created_at IS NOT NULL`；
 * - 但这张表只有桌面端主进程会写，本地工作区的会话清单取自「桌面端自己的
 *   app-server 内存里的会话」（apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts
 *   的 listWorkspaceSessionIds），磁盘上的会话基线只服务远程工作区。
 * - 于是：daemon 用独立 CLI 进程新建的会话，内容落在共享会话库，却不会出现在侧栏。
 *
 * 这里补一条索引行。只写自己那一行（主键 workspace_key + task_id），不碰别人的行；
 * 写失败只记日志，不影响任务执行本身。
 */
export interface DesktopIndexSession {
  taskId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  title: string;
  status: "completed" | "error" | "interrupted";
  createdAt: number;
  updatedAt: number;
}

export interface DesktopIndexOptions {
  /** tasks-index 库路径，默认取本机约定位置。 */
  tasksIndexPath?: string;
  log?: (message: string) => void;
}

export function defaultTasksIndexPath(): string {
  return join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

/** 执行后端标识：桌面端自己的会话行用的就是它（不是模型供应商）。 */
const EXECUTION_BACKEND = "glm";

export class DesktopTaskIndex {
  private readonly path: string;
  private readonly log: (message: string) => void;

  constructor(options: DesktopIndexOptions = {}) {
    this.path = options.tasksIndexPath ?? defaultTasksIndexPath();
    this.log = options.log ?? (() => undefined);
  }

  /** 写入（或更新）一条会话索引行。失败只记日志。 */
  upsertSession(session: DesktopIndexSession): boolean {
    let db: DatabaseSync | null = null;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      db = new DatabaseSync(this.path);
      db.exec("PRAGMA busy_timeout=3000");
      db.exec("PRAGMA journal_mode=WAL");

      const columns = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      if (columns.size === 0) {
        this.log("桌面端任务索引里没有 tasks 表，跳过登记");
        return false;
      }

      const values: Record<string, unknown> = {
        workspace_key: session.workspaceKey,
        workspace_path: session.workspacePath,
        workspace_identity: session.workspaceIdentity ?? null,
        task_id: session.taskId,
        title: session.title,
        task_status: session.status,
        provider: EXECUTION_BACKEND,
        mode: "build",
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        host_id: "local",
        root_path: session.workspacePath,
        deleted: 0,
        cli_deleted: 0,
        pinned: 0,
        archived: 0,
        title_overridden: 0,
        meta_json: "{}",
        cli_title: session.title,
        cli_title_source: "generated",
        cli_created_at: session.createdAt,
        cli_updated_at: session.updatedAt,
        cli_last_outcome: session.status === "error" ? "error" : session.status,
        searchable_text: session.title,
      };

      // 只写库里真实存在的列，避免宿主升级换列时插入失败。
      const names = Object.keys(values).filter((name) => columns.has(name));
      if (!names.includes("cli_created_at")) {
        this.log("桌面端任务索引没有 cli_created_at 列，跳过登记");
        return false;
      }
      const placeholders = names.map(() => "?").join(", ");
      const updates = names
        .filter((name) => name !== "workspace_key" && name !== "task_id")
        .map((name) => `${name} = excluded.${name}`)
        .join(", ");

      db.prepare(
        `INSERT INTO tasks (${names.join(", ")}) VALUES (${placeholders})
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET ${updates}`,
      ).run(...names.map((name) => values[name] as never));

      return true;
    } catch (error) {
      this.log(
        `登记桌面端任务索引失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      try {
        db?.close();
      } catch {
        // 关闭失败不影响结果
      }
    }
  }
}
