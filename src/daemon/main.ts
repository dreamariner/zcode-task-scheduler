import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase, JobStore } from "./db.js";
import { DesktopTaskIndex } from "./desktop-index.js";
import { GatewayPool } from "./gateway-pool.js";
import { Limiter } from "./limiter.js";
import { JobRunner } from "./runner.js";
import { createRpcServer } from "./rpc.js";
import { Scheduler } from "./scheduler.js";
import { pluginDataDir, resolveCliLaunch, socketPath, stateDbPath, pidPath } from "../shared/paths.js";

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** 强制指定 CLI 路径（用户配置优先）。 */
  cliPath?: string;
  logFile?: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 单例锁：pidfile 里存 pid，进程还活着就说明已有 daemon 在跑。
 * 插件 MCP server 每次会话启动都会尝试拉起 daemon，靠这个避免起一堆。
 */
function acquirePidLock(file: string): { acquired: boolean; pid: number | null } {
  mkdirSync(dirname(file), { recursive: true });
  try {
    const existing = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(existing) && existing > 0 && isProcessAlive(existing)) {
      return { acquired: false, pid: existing };
    }
  } catch {
    // 没有 pidfile 或内容损坏，继续按新实例处理
  }
  writeFileSync(file, `${process.pid}\n`);
  return { acquired: true, pid: process.pid };
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const logFile = options.logFile ?? `${pluginDataDir(env)}/daemon.log`;
  mkdirSync(dirname(logFile), { recursive: true });

  const log = (message: string): void => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      appendFileSync(logFile, line);
    } catch {
      // 日志写不进去不应该影响执行
    }
  };

  const lock = acquirePidLock(pidPath(env));
  if (!lock.acquired) {
    log(`已有 daemon 在运行（pid=${lock.pid}），本次退出`);
    return;
  }

  const store = new JobStore(openDatabase(stateDbPath(env)));
  const launch = resolveCliLaunch(options.cliPath ?? env.ZCODE_CLI_PATH, env);
  const pool = new GatewayPool(launch, { env, log });

  const settings = () => store.getSettings();
  const runner = new JobRunner({
    store,
    settings,
    gatewayFor: (workspace) => pool.for(workspace),
    desktopIndex: new DesktopTaskIndex({ log }),
    log,
  });
  const limiter = new Limiter({
    maxConcurrent: settings().maxConcurrent,
    maxStartsPerMinute: settings().maxStartsPerMinute,
    minGapMs: settings().minGapMs,
  });
  const scheduler = new Scheduler({ store, runner, limiter, settings, log });

  const rpc = createRpcServer(socketPath(env), {
    store,
    scheduler,
    settings,
    gatewayFor: (workspace) => pool.for(workspace),
    log,
  });
  await rpc.listen();

  scheduler.start();
  log(`daemon 启动：pid=${process.pid} CLI 来源=${pool.launchSource}`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`收到 ${signal}，准备退出`);
    scheduler.stop();
    await rpc.close().catch(() => undefined);
    await pool.closeAll().catch(() => undefined);
    store.close();
    try {
      unlinkSync(pidPath(env));
    } catch {
      // 退出路径尽力而为
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    log(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`);
  });

  // 常驻进程：保持事件循环活着。
  await new Promise<void>(() => undefined);
}
