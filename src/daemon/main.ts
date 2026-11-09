import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
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

/** 队列为空后的空闲自退阈值。 */
const IDLE_EXIT_MS = 30 * 60 * 1000;

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
 * 插件 MCP server 每个会话都会尝试拉起 daemon，多个会话可能同时发起，
 * 所以锁必须是原子创建的（O_EXCL），否则两个进程会同时认为自己拿到了锁。
 */
function acquirePidLock(file: string): { acquired: boolean; pid: number | null } {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // wx：文件已存在时抛 EEXIST，创建本身是原子的。
      const handle = openSync(file, "wx");
      try {
        writeSync(handle, `${process.pid}\n`);
      } finally {
        closeSync(handle);
      }
      return { acquired: true, pid: process.pid };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let existing = Number.NaN;
      try {
        existing = Number(readFileSync(file, "utf8").trim());
      } catch {
        existing = Number.NaN;
      }
      if (Number.isInteger(existing) && existing > 0 && isProcessAlive(existing)) {
        return { acquired: false, pid: existing };
      }
      // 僵尸锁（上次进程崩了没清），清掉后重试。
      try {
        unlinkSync(file);
      } catch {
        // 清理失败就当没锁住
      }
    }
  }
  return { acquired: false, pid: null };
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
  const startedAt = Date.now();

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

  // 空闲自退：没有任何待执行任务、也没有在跑的活时，长期挂着没意义。
  // 一旦有任务登记，重新打开插件会把它再拉起来。
  const idleExit = setInterval(() => {
    if (scheduler.busyJobIds.length > 0) return;
    const jobs = store.listJobs();
    if (jobs.some((job) => job.enabled && job.nextRunAt !== null)) return;
    const lastActivity = jobs.reduce(
      (latest, job) => Math.max(latest, job.updatedAt),
      startedAt,
    );
    if (Date.now() - lastActivity < IDLE_EXIT_MS) return;
    log("队列已空且长时间无活动，daemon 退出");
    void shutdown("idle");
  }, 60_000);
  idleExit.unref?.();

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
