import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AutomationStore, computeNextRunAt, type AutomationRow } from "../automation/store.js";
import { computeGate, holdUntil, type GateTask } from "./gate.js";
import { pruneAnchors, readAnchors } from "./anchors.js";

/**
 * 投递节流闸（常驻进程）。
 *
 * 它不执行任何任务，只控制「任务何时处于到期状态」：
 * 桌面端调度器只认领 next_run_at 已到的任务，闸门批准谁，谁才允许到期。
 *
 * 为什么需要常驻进程：桌面端的认领轮询是 20 秒一轮，只有闸门自己进程在场时，
 * 才能在任务到期前把它停放到未来。插件 MCP server 是会话级短命进程（空闲 30 秒
 * 即被杀），所以闸门要用两次 fork 脱离会话进程树，独立活着。
 */

/** 全局同时在投上限。 */
export const MAX_CONCURRENT = 3;
/**
 * 临近到期提前多久停放（毫秒）。
 * 要明显大于桌面端认领轮询间隔（官方 20 秒），否则停放没来得及生效任务就被认领走。
 */
export const PRE_PARK_MS = 90_000;
/** 被停放的任务推到多久之后（毫秒）。 */
export const HOLD_MS = 90_000;
/** 轮询间隔（毫秒）。 */
export const POLL_INTERVAL_MS = 5_000;
/** 没有任何自己的任务后，空闲多久退出（毫秒）。 */
export const IDLE_EXIT_MS = 30 * 60_000;
/** 放行后多久还没被桌面端认领就算放行失效（毫秒）。 */
export const RELEASE_TTL_MS = 120_000;

export interface GateRunnerOptions {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** 轮询间隔，单测用短值。 */
  pollIntervalMs?: number;
  /** 空闲退出时长，单测用短值。 */
  idleExitMs?: number;
}

function pluginDataDir(env: NodeJS.ProcessEnv): string {
  return env.ZCODE_PLUGIN_DATA?.trim() || join(homedir(), ".zcode", "plugin-data", "zcode-task-scheduler");
}

export function gatePidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "gate.pid");
}

export function gateLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "gate.log");
}

/** 一次性任务的意图执行时刻（锚点）：cron 只有月日时分，算不出年份。 */
export function gateAnchorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "gate-anchors.json");
}

/**
 * 闸门日志写文件。
 *
 * 闸门进程的 stdout 是 ignore（脱离会话后没人接），日志只能落文件；
 * 文件里不含任务正文与凭据，只有节流判定的事实。
 */
function fileLogger(env: NodeJS.ProcessEnv): (message: string) => void {
  const path = gateLogPath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // 目录建不出来就退化成不记日志。
  }
  return (message: string) => {
    try {
      appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // 日志失败不能影响节流本身。
    }
  };
}

/** pidfile 单例锁：已有实例在跑就不重复拉起。 */
export function acquireGateLock(pidPath: string): { acquired: boolean; pid: number | null } {
  try {
    mkdirSync(dirname(pidPath), { recursive: true });
  } catch {
    // 目录建不出来时下面的开锁会失败，返回未获取。
  }
  if (existsSync(pidPath)) {
    const raw = readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return { acquired: false, pid };
      } catch {
        // 进程没了，pidfile 是残留，继续往下抢锁。
      }
    }
  }
  try {
    const fd = openSync(pidPath, "wx");
    writeFileSync(fd, String(process.pid));
    return { acquired: true, pid: process.pid };
  } catch {
    const raw = readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    return { acquired: false, pid: Number.isInteger(pid) ? pid : null };
  }
}

export function releaseGateLock(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // 锁文件没了就算了。
  }
}

/**
 * 算任务的意图执行时刻。
 *
 * 循环任务按 cron 推算（与桌面端同一套 croner 语义）；一次性任务用锚点表里的
 * 确切时刻（cron 的月日推不出年份）。
 */
export function intendedAtOf(job: AutomationRow, now: number, anchors: Record<string, number>): number | null {
  if (!job.recurring) {
    const anchor = anchors[job.automationId];
    if (typeof anchor === "number") return anchor;
  }
  return computeNextRunAt(job.cronExpr, now);
}

/**
 * 跑一轮节流。
 *
 * 返回这一轮的判定，便于日志与单测。
 */
export function runGatePass(
  store: AutomationStore,
  options: {
    now?: number;
    maxConcurrent?: number;
    preParkMs?: number;
    holdMs?: number;
    anchors?: Record<string, number>;
    /** 闸门已放行但桌面端还没认领的任务（放行空窗期）。 */
    released?: Map<string, number>;
  } = {},
): ReturnType<typeof computeGate> {
  const now = options.now ?? Date.now();
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT;
  const preParkMs = options.preParkMs ?? PRE_PARK_MS;
  const holdMs = options.holdMs ?? HOLD_MS;
  const anchors = options.anchors ?? {};
  const released = options.released ?? new Map<string, number>();

  const jobs = store.list();
  const inFlightIds = new Set(store.inFlightTasks().map((item) => item.automationId));

  // 放行空窗：闸门放行后、桌面端认领前，这段时间也占槽位。
  for (const [id, at] of released) {
    if (now - at > RELEASE_TTL_MS) released.delete(id);
    else if (!inFlightIds.has(id)) {
      // 还没出现 in-flight 记录，说明桌面端还没认领，仍算占位。
    }
  }

  const tasks: GateTask[] = jobs.map((job) => {
    const releasedAt = released.get(job.automationId);
    const isReleased = releasedAt !== undefined && now - releasedAt <= RELEASE_TTL_MS;
    return {
      automationId: job.automationId,
      targetSessionId: job.targetSessionId,
      createdAt: job.createdAt,
      intendedAt: intendedAtOf(job, now, anchors),
      // 在投判据：回合未终结（outcome 还是 running）。桌面端在投递瞬间就把
      // automations.running 置 0 了，那个字段只覆盖派发动作本身。
      running: inFlightIds.has(job.automationId),
      released: isReleased,
      enabled: job.enabled,
      finished: job.lifecycleStatus === "completed" || job.lifecycleStatus === "failed",
    };
  });

  const decision = computeGate(tasks, { now, maxConcurrent, preParkMs, holdMs });

  // 放行：让任务处于到期状态，桌面端下一轮认领。
  for (const automationId of decision.release) {
    store.setNextRunAt(automationId, now);
    released.set(automationId, now);
  }
  // 停放：推到未来，桌面端认领不到。
  const holdAt = holdUntil(now, holdMs);
  for (const automationId of decision.park) {
    store.setNextRunAt(automationId, holdAt);
    released.delete(automationId);
  }
  // 还原：离到期还远，还原成真实排期。
  for (const automationId of decision.restore) {
    const job = jobs.find((item) => item.automationId === automationId);
    if (!job) continue;
    const intended = intendedAtOf(job, now, anchors);
    if (intended !== null) store.setNextRunAt(automationId, intended);
  }
  return decision;
}

/**
 * 放行排队的「立即执行」。
 *
 * 槽位有富余时把 pending 的 manual run 翻成 claimed，桌面端下一轮就认领。
 */
export function releaseQueuedManualRuns(
  store: AutomationStore,
  options: { maxConcurrent?: number } = {},
): number {
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT;
  const jobs = store.list();
  const inFlight = store.inFlightTasks();
  const inFlightIds = new Set(inFlight.map((item) => item.automationId));
  const inFlightSessions = new Set(
    inFlight.map((item) => item.targetSessionId).filter((value): value is string => Boolean(value)),
  );
  let slots = Math.max(0, maxConcurrent - inFlight.length);
  if (slots === 0) return 0;

  const pending = store.listPendingManualRuns();
  let released = 0;
  for (const run of pending) {
    if (slots <= 0) break;
    const job = jobs.find((item) => item.automationId === run.automationId);
    // 同会话已有在投任务时，这条要等（顺序保证）。
    if (job?.targetSessionId && inFlightSessions.has(job.targetSessionId)) continue;
    if (inFlightIds.has(run.automationId)) continue;
    if (store.releasePendingManualRun(run.runId)) {
      released += 1;
      slots -= 1;
    }
  }
  return released;
}

/** 常驻循环。 */
export async function runGatekeeper(options: GateRunnerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const log = options.log ?? fileLogger(env);
  const store = new AutomationStore({ log });
  const pidPath = gatePidPath(env);
  const lock = acquireGateLock(pidPath);
  if (!lock.acquired) {
    log(`已有闸门实例在跑（pid=${lock.pid}），本次退出`);
    return;
  }
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const idleExitMs = options.idleExitMs ?? IDLE_EXIT_MS;
  const released = new Map<string, number>();
  let lastActivityAt = Date.now();
  log(`闸门启动：pid=${process.pid}，并发上限 ${MAX_CONCURRENT}`);

  const cleanup = (): void => {
    releaseGateLock(pidPath);
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  while (true) {
    try {
      const jobs = store.list();
      pruneAnchors(env, new Set(jobs.map((job) => job.automationId)));
      // 一次性任务的意图时刻靠锚点表（cron 的月日推不出年份），每轮重读，
      // 桌面端重登或插件改期后都能拿到最新值。
      const decision = runGatePass(store, { released, anchors: readAnchors(env) });
      const releasedRuns = releaseQueuedManualRuns(store);
      if (jobs.length === 0) {
        if (Date.now() - lastActivityAt > idleExitMs) {
          log("没有自己的任务且长时间无活动，闸门退出");
          return;
        }
      } else {
        lastActivityAt = Date.now();
      }
      if (
        decision.release.length > 0 ||
        decision.park.length > 0 ||
        releasedRuns > 0
      ) {
        log(
          `在投 ${decision.inFlight}/${MAX_CONCURRENT}，放行 ${decision.release.length} 条，停放 ${decision.park.length} 条，立即执行放行 ${releasedRuns} 条`,
        );
      }
    } catch (error) {
      log(`节流轮询出错：${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * 启动角色：launcher 还是闸门本体。
 *
 * 宿主回收会话级 MCP server 时会按 PPID 树把整棵子树干掉。插件 MCP server 是
 * 会话级短命进程，闸门若直接挂在它下面，宿主一回收就连带把闸门杀掉，节流就失效了。
 * 破解办法是两次 fork：中转进程拉起真正的闸门后立刻退出，闸门于是被 init 收养
 * （PPID 变成 1），不再出现在 MCP server 的子树里。
 */
export async function main(): Promise<void> {
  const role = process.env.ZCODE_GATE_ROLE ?? "gate";
  if (role === "launcher") {
    const entry = process.argv[1];
    if (!entry) {
      process.stderr.write("[zcode-task-scheduler] 找不到闸门入口脚本\n");
      process.exit(1);
    }
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ZCODE_GATE_ROLE: "gate" },
    });
    child.unref();
    process.exit(0);
  }
  await runGatekeeper();
}
