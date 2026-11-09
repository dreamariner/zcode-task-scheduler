import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** 插件数据目录：宿主注入 ZCODE_PLUGIN_DATA；脱离宿主时退回本机约定目录。 */
export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const injected = env.ZCODE_PLUGIN_DATA?.trim();
  if (injected) return injected;
  return join(homedir(), ".zcode", "plugin-data", "zcode-task-scheduler");
}

export function stateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "state.db");
}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "daemon.sock");
}

export function pidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "daemon.pid");
}

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "daemon.log");
}

/** 插件源码根目录（宿主注入 ZCODE_PLUGIN_ROOT）。 */
export function pluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_PLUGIN_ROOT?.trim() || process.cwd();
}

export interface CliLaunch {
  command: string;
  /** CLI 入口自身的参数（不含子命令）。 */
  args: string[];
  /** 展示用的来源说明，便于面板把探测结果显示给用户。 */
  source: string;
}

/** CLI 的协议服务子命令。 */
export const APP_SERVER_SUBCOMMAND = "app-server";

const DESKTOP_CLI_CANDIDATES = [
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  join(homedir(), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
];

/**
 * 解析 ZCode CLI 的启动方式。
 *
 * 插件进程的环境里没有 CLI 路径（宿主只注入工作区与插件目录，见
 * apps/zcode-cli/packages/adapters/src/plugins/mcp.ts），所以按三档探测：
 * 用户显式配置、桌面端内置、PATH 上的 zcode。
 * 配置值写成 auto（或留空）表示交给自动探测。
 */
export function resolveCliLaunch(
  configured?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CliLaunch | null {
  const explicit = configured?.trim();
  if (explicit && explicit !== "auto") {
    if (explicit.endsWith(".cjs") || explicit.endsWith(".js")) {
      return { command: "node", args: [explicit], source: "用户配置" };
    }
    return { command: explicit, args: [], source: "用户配置" };
  }

  for (const candidate of DESKTOP_CLI_CANDIDATES) {
    if (existsSync(candidate)) {
      return { command: "node", args: [candidate], source: "桌面端内置" };
    }
  }

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "zcode");
    if (existsSync(candidate)) {
      return { command: candidate, args: [], source: "PATH" };
    }
  }

  return null;
}
