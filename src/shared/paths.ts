import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 插件源码根目录（宿主注入 ZCODE_PLUGIN_ROOT）。 */
export function pluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_PLUGIN_ROOT?.trim() || process.cwd();
}

/**
 * 旧版插件自己的状态库路径（2026-11-12 前的 daemon 执行面用）。
 * 只用于一次性迁移，迁移完即改名保留。
 */
export function legacyStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const injected = env.ZCODE_PLUGIN_DATA?.trim();
  const base = injected || join(homedir(), ".zcode", "plugin-data", "zcode-task-scheduler");
  return join(base, "state.db");
}
