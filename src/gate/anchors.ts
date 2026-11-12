import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 一次性任务的执行时刻锚点。
 *
 * 一次性任务的 cron 是「分 时 日 月 *」——没有年份，算不出「明年某月某日」。
 * 插件在登记时就知道确切时刻（runAt），记在这里供节流闸判定到期用。
 *
 * 单独成文件是为了不让 automation/store 依赖 gate/runner（那会形成循环引用）：
 * store 只管写锚点，闸门只管读。
 */

export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ZCODE_PLUGIN_DATA?.trim() ||
    join(homedir(), ".zcode", "plugin-data", "zcode-task-scheduler")
  );
}

export function gateAnchorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "gate-anchors.json");
}

/** 读锚点表：automationId → 意图执行时刻。 */
export function readAnchors(env: NodeJS.ProcessEnv = process.env): Record<string, number> {
  try {
    const raw = readFileSync(gateAnchorPath(env), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** 记一个锚点。 */
export function recordAnchor(
  env: NodeJS.ProcessEnv,
  automationId: string,
  runAt: number,
): void {
  const anchors = readAnchors(env);
  anchors[automationId] = runAt;
  try {
    mkdirSync(dirname(gateAnchorPath(env)), { recursive: true });
    writeFileSync(gateAnchorPath(env), JSON.stringify(anchors));
  } catch {
    // 锚点记不住也不致命：闸门会退回到用 cron 推算。
  }
}

/** 删掉已不存在的任务的锚点。 */
export function pruneAnchors(env: NodeJS.ProcessEnv, aliveIds: Set<string>): void {
  const anchors = readAnchors(env);
  const next: Record<string, number> = {};
  let changed = false;
  for (const [key, value] of Object.entries(anchors)) {
    if (aliveIds.has(key)) next[key] = value;
    else changed = true;
  }
  if (!changed) return;
  try {
    writeFileSync(gateAnchorPath(env), JSON.stringify(next));
  } catch {
    // 忽略。
  }
}
