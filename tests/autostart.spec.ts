import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AUTOSTART_LABEL,
  autostartStatus,
  buildPlistXml,
  installAutostart,
  plistPath,
  readAutostartPlist,
  removeAutostart,
} from "../src/daemon/autostart.js";

const cleanups: (() => void)[] = [];

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function makeFakeLaunchctl(exitCode = 0): { dir: string; logFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "zts-autostart-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "launchctl-fake");
  const logFile = join(dir, "launchctl.log");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(logFile)}\nexit ${exitCode}\n`,
  );
  chmodSync(script, 0o755);
  return { dir, logFile };
}

function withEnv(): void {
  const dir = mkdtempSync(join(tmpdir(), "zts-autostart-env-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "plugin", "dist"), { recursive: true });
  writeFileSync(join(dir, "plugin", "dist", "daemon.mjs"), "// entry\n");
  process.env.ZCODE_PLUGIN_ROOT = join(dir, "plugin");
  process.env.ZCODE_PLUGIN_DATA = join(dir, "data");
  mkdirSync(join(dir, "data"), { recursive: true });
}

describe("开机自启", () => {
  it("plist 模板包含 launchd 需要的关键字段，并做 XML 转义", () => {
    const xml = buildPlistXml({
      nodePath: "/usr/local/bin/node",
      entryPath: "/opt/plugin/dist/daemon.mjs",
      dataDir: "/opt/data&a<b",
      pluginRootPath: "/opt/plugin",
      pathEnv: "/usr/bin:/bin",
      logFile: "/opt/data/daemon.log",
    });
    expect(xml).toContain(`<key>Label</key>`);
    expect(xml).toContain(AUTOSTART_LABEL);
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>SuccessfulExit</key>");
    expect(xml).toContain("/usr/local/bin/node");
    expect(xml).toContain("/opt/plugin/dist/daemon.mjs");
    // 转义：数据目录里的 & 和 < 不能破坏 XML
    expect(xml).toContain("/opt/data&amp;a&lt;b");
    expect(xml).toContain("<key>ZCODE_DAEMON_ROLE</key>");
    expect(xml).toContain("<string>daemon</string>");
    // 数组项必须是裸 <string>：塞 key/value 对 plutil 放行但 launchd 拒载。
    expect(xml).not.toContain("<key></key>");
    expect(xml).toMatch(/<array>\s*<string>\/usr\/local\/bin\/node<\/string>/);
  });

  it("安装会先卸旧任务再 bootstrap，文件落在 LaunchAgents 目录", () => {
    withEnv();
    const fake = makeFakeLaunchctl(0);
    const agentsDir = mkdtempSync(join(tmpdir(), "zts-agents-"));
    cleanups.push(() => rmSync(agentsDir, { recursive: true, force: true }));

    const status = installAutostart({ launchAgentsDir: agentsDir, launchctl: fake.dir + "/launchctl-fake" });
    expect(status.plistInstalled).toBe(true);
    expect(status.loaded).toBe(true);

    const xml = readAutostartPlist({ launchAgentsDir: agentsDir });
    expect(xml).toContain(AUTOSTART_LABEL);
    expect(xml).toContain(process.env.ZCODE_PLUGIN_DATA ?? "");

    // 调用顺序：先 bootout（清旧），后 bootstrap gui/<uid> <plist>
    const log = existsSync(fake.logFile) ? readFileSync(fake.logFile, "utf8") : "";
    const lines = log.trim().split("\n");
    expect(lines[0]).toBe(`bootout gui/${process.getuid?.() ?? 0}/${AUTOSTART_LABEL}`);
    expect(lines[1]).toBe(`bootstrap gui/${process.getuid?.() ?? 0} ${plistPath({ launchAgentsDir: agentsDir })}`);
  });

  it("bootstrap 失败时回落 launchctl load", () => {
    withEnv();
    // 自制脚本：bootstrap 返回 1，其余返回 0
    const dir = mkdtempSync(join(tmpdir(), "zts-autostart-fb-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, "launchctl-fb");
    writeFileSync(
      script,
      `#!/bin/sh\n[ "$1" = "bootstrap" ] && exit 1\nexit 0\n`,
    );
    chmodSync(script, 0o755);
    const agentsDir = mkdtempSync(join(tmpdir(), "zts-agents-fb-"));
    cleanups.push(() => rmSync(agentsDir, { recursive: true, force: true }));

    const status = installAutostart({ launchAgentsDir: agentsDir, launchctl: script });
    expect(status.loaded).toBe(true);
    expect(existsSync(plistPath({ launchAgentsDir: agentsDir }))).toBe(true);
  });

  it("卸载会 bootout 并删除 plist 文件", () => {
    withEnv();
    const fake = makeFakeLaunchctl(0);
    const agentsDir = mkdtempSync(join(tmpdir(), "zts-agents-rm-"));
    cleanups.push(() => rmSync(agentsDir, { recursive: true, force: true }));
    installAutostart({ launchAgentsDir: agentsDir, launchctl: fake.dir + "/launchctl-fake" });
    expect(existsSync(plistPath({ launchAgentsDir: agentsDir }))).toBe(true);

    const status = removeAutostart({ launchAgentsDir: agentsDir, launchctl: fake.dir + "/launchctl-fake" });
    expect(status.plistInstalled).toBe(false);
    expect(existsSync(plistPath({ launchAgentsDir: agentsDir }))).toBe(false);
  });

  it("状态：没有 plist 就是未安装；有 plist 且 launchctl 认账就是已加载", () => {
    const agentsDir = mkdtempSync(join(tmpdir(), "zts-agents-st-"));
    cleanups.push(() => rmSync(agentsDir, { recursive: true, force: true }));
    expect(autostartStatus({ launchAgentsDir: agentsDir, launchctl: "/bin/true" }).plistInstalled).toBe(false);

    const fake = makeFakeLaunchctl(0);
    installAutostart({ launchAgentsDir: agentsDir, launchctl: fake.dir + "/launchctl-fake" });
    const status = autostartStatus({ launchAgentsDir: agentsDir, launchctl: fake.dir + "/launchctl-fake" });
    expect(status).toEqual({ platform: "macos", plistInstalled: true, loaded: true });
  });
});
