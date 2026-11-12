import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "../shared/paths.js";
import { gatePidPath } from "./runner.js";

/**
 * 拉起节流闸（常驻进程）。
 *
 * 以 launcher 角色启动：入口脚本会再 fork 一次真正的闸门并立刻退出，让闸门的
 * 父进程变成 init。宿主回收会话级 MCP server 时按 PPID 树清理子树，直接挂载
 * 会让闸门跟着一起死。
 */

export interface GateSpawnOptions {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** 闸门入口脚本，默认 dist/gate.mjs。 */
  entry?: string;
}

/** 闸门是否已在跑。 */
export function gateRunning(env: NodeJS.ProcessEnv = process.env): number | null {
  const pidPath = gatePidPath(env);
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * 确保闸门在跑；不在就拉起一个。返回当前 pid（拉起后是刚起的那个）。
 */
export function ensureGatekeeper(options: GateSpawnOptions = {}): number | null {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const existing = gateRunning(env);
  if (existing) return existing;

  const entry = join(pluginRoot(env), options.entry ?? "dist/gate.mjs");
  if (!existsSync(entry)) {
    log(`找不到闸门入口：${entry}`);
    return null;
  }
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...env, ZCODE_GATE_ROLE: "launcher" },
  });
  child.unref();
  log(`尝试拉起节流闸（launcher pid=${child.pid}，若已有实例在跑这个进程会自行退出）`);
  return child.pid ?? null;
}
