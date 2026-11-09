import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logPath, pluginDataDir, pluginRoot } from "../shared/paths.js";

/**
 * launchd 开机自启（仅 macOS）。
 *
 * 没有它，重启后要等用户打开一个会话（插件加载）才会把调度器拉起来，
 * 错过窗口的任务就白白跳过了。装一个 LaunchAgent：
 * - 登录时拉起（RunAtLoad），队列空且长时间无活动时调度器自己退出；
 * - 只在异常退出时自动重拉（KeepAlive.SuccessfulExit=false），空闲自退
 *   的 process.exit(0) 不会被 launchd 当成故障反复重启。
 *
 * 插件升级会换版本目录，所以 plist 里写的是「装自启那一刻」的插件路径；
 * 每次重新安装都会刷新成当前路径，面板升级插件后再点一次即可。
 */

export const AUTOSTART_LABEL = "top.dreamariner.zcode-task-scheduler";

export interface AutostartOptions {
  /** 覆盖 LaunchAgents 目录（测试用）；默认 ~/Library/LaunchAgents。 */
  launchAgentsDir?: string;
  /** 覆盖 launchctl 可执行文件（测试用）。 */
  launchctl?: string;
  log?: (message: string) => void;
}

export interface AutostartStatus {
  platform: "macos" | "unsupported";
  /** plist 文件是否存在。 */
  plistInstalled: boolean;
  /** launchd 是否已加载该任务。 */
  loaded: boolean;
}

export function plistPath(options: AutostartOptions = {}): string {
  const dir = options.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  return join(dir, `${AUTOSTART_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 生成 LaunchAgent plist 内容。导出是为了单测锁定关键字段。 */
export function buildPlistXml(input: {
  nodePath: string;
  entryPath: string;
  dataDir: string;
  pluginRootPath: string;
  pathEnv: string;
  logFile: string;
}): string {
  // dict 项是 key/value 对；array 项只能是裸 <string>，塞 key/value 对 launchd 会拒载
  // （报 5: Input/output error，plutil -lint 却放行，只能靠结构正确）。
  const entry = (key: string, value: string): string =>
    `  <key>${key}</key>\n  <string>${xmlEscape(value)}</string>\n`;
  const item = (value: string): string => `    <string>${xmlEscape(value)}</string>\n`;
  const body =
    entry("Label", AUTOSTART_LABEL) +
    "  <key>ProgramArguments</key>\n  <array>\n" +
    item(input.nodePath) +
    item(input.entryPath) +
    "  </array>\n" +
    "  <key>EnvironmentVariables</key>\n  <dict>\n" +
    entry("ZCODE_DAEMON_ROLE", "daemon") +
    entry("ZCODE_PLUGIN_DATA", input.dataDir) +
    entry("ZCODE_PLUGIN_ROOT", input.pluginRootPath) +
    entry("PATH", input.pathEnv) +
    "  </dict>\n" +
    "  <key>RunAtLoad</key>\n  <true/>\n" +
    "  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n" +
    "  <key>ProcessType</key>\n  <string>Background</string>\n" +
    entry("StandardOutPath", input.logFile) +
    entry("StandardErrorPath", input.logFile);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}</dict>
</plist>
`;
}

function runLaunchctl(launchctl: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(launchctl, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

function guiTarget(): string {
  // @types/node 把 getuid 声明成可选；macOS 上一定存在，兜底 0 只影响类型。
  return `gui/${process.getuid?.() ?? 0}`;
}

export function autostartStatus(options: AutostartOptions = {}): AutostartStatus {
  if (process.platform !== "darwin") {
    return { platform: "unsupported", plistInstalled: false, loaded: false };
  }
  const file = plistPath(options);
  const plistInstalled = existsSync(file);
  if (!plistInstalled) {
    return { platform: "macos", plistInstalled: false, loaded: false };
  }
  // launchctl print 对已加载任务返回 0；没加载则非 0。
  const { ok } = runLaunchctl(options.launchctl ?? "launchctl", [
    "print",
    `${guiTarget()}/${AUTOSTART_LABEL}`,
  ]);
  return { platform: "macos", plistInstalled, loaded: ok };
}

/** 安装（或按当前路径刷新）LaunchAgent 并加载。 */
export function installAutostart(options: AutostartOptions = {}): AutostartStatus {
  if (process.platform !== "darwin") {
    throw new Error("开机自启目前只支持 macOS");
  }
  const log = options.log ?? (() => undefined);
  const file = plistPath(options);
  const entryPath = join(pluginRoot(), "dist", "daemon.mjs");
  if (!existsSync(entryPath)) {
    throw new Error(`找不到调度器入口：${entryPath}`);
  }
  const xml = buildPlistXml({
    nodePath: process.execPath,
    entryPath,
    dataDir: pluginDataDir(),
    pluginRootPath: pluginRoot(),
    pathEnv: process.env.PATH ?? "/usr/bin:/bin",
    logFile: logPath(),
  });
  mkdirSync(dirname(file), { recursive: true });
  // 先卸载旧任务再写文件：launchd 对 plist 变更的感知以重新加载为准。
  runLaunchctl(options.launchctl ?? "launchctl", ["bootout", `${guiTarget()}/${AUTOSTART_LABEL}`]);
  writeFileSync(file, xml, "utf8");
  log(`已写入 LaunchAgent：${file}`);

  let boot = runLaunchctl(options.launchctl ?? "launchctl", [
    "bootstrap",
    guiTarget(),
    file,
  ]);
  if (!boot.ok) {
    // 旧系统没有 bootstrap，回落 load。
    log(`bootstrap 失败（${boot.output}），回落 launchctl load`);
    boot = runLaunchctl(options.launchctl ?? "launchctl", ["load", file]);
  }
  if (!boot.ok) {
    throw new Error(`launchctl 加载失败：${boot.output || "无输出"}`);
  }
  // load 这条老路可能退码 0 却没加载成功（空 key 之类的坏结构就是这种情况），
  // 以 launchd 的真实状态为准，别给面板报假成功。
  const verified = autostartStatus(options);
  if (!verified.loaded) {
    throw new Error(`launchctl 报成功但服务没有加载：${boot.output || "无输出"}`);
  }
  log("LaunchAgent 已加载，重启后调度器会随登录自动拉起");
  return verified;
}

/** 卸载 LaunchAgent：先 bootout 再删文件。 */
export function removeAutostart(options: AutostartOptions = {}): AutostartStatus {
  if (process.platform !== "darwin") {
    throw new Error("开机自启目前只支持 macOS");
  }
  const log = options.log ?? (() => undefined);
  const launchctl = options.launchctl ?? "launchctl";
  const file = plistPath(options);
  let down = runLaunchctl(launchctl, ["bootout", `${guiTarget()}/${AUTOSTART_LABEL}`]);
  if (!down.ok) {
    down = runLaunchctl(launchctl, ["unload", file]);
  }
  if (down.ok) {
    log("LaunchAgent 已卸载");
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // 文件可能本来就不在
  }
  return { platform: "macos", plistInstalled: false, loaded: false };
}

/** 仅供测试与诊断使用：确认 plist 可解析。 */
export function readAutostartPlist(options: AutostartOptions = {}): string | null {
  const file = plistPath(options);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
