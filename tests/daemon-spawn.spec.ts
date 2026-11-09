import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 调度器必须脱离宿主会话的进程树。
 *
 * 宿主回收会话级 MCP server 时按 PPID 树杀整棵子树（官方源码
 * apps/zcode-cli/packages/adapters/src/mcp/process-tree.ts）。调度器直接挂在 MCP server
 * 下面会被一起收掉，所以入口脚本要先当一次中转进程：拉起真正的调度器后立刻退出，
 * 让它被 init 收养（PPID 变成 1）。
 *
 * 这个用例跑构建产物，跑之前先 pnpm build；没构建就跳过，不让单测挂在构建顺序上。
 */
const distEntry = join(process.cwd(), "dist/daemon.mjs");
const hasBuild = existsSync(distEntry);

function ppidOf(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("close", () => {
      const value = Number(text.trim());
      resolve(Number.isInteger(value) && value > 0 ? value : null);
    });
    child.on("error", () => resolve(null));
  });
}

const cleanups: (() => void)[] = [];

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

describe.skipIf(!hasBuild)("调度器启动", () => {
  it("经中转进程启动后不再挂在调用方的进程树下", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zts-daemon-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const launcher = spawn(process.execPath, [distEntry], {
      stdio: "ignore",
      env: {
        ...process.env,
        ZCODE_DAEMON_ROLE: "launcher",
        ZCODE_PLUGIN_DATA: dataDir,
        ZCODE_CLI_PATH: "auto",
      },
    });
    const launcherExit = new Promise<number | null>((resolve) =>
      launcher.on("close", (code) => resolve(code)),
    );

    // 中转进程要立刻退出，退出后真正的调度器才会被 init 收养。
    expect(await launcherExit).toBe(0);

    const pidFile = join(dataDir, "daemon.pid");
    let pid: number | null = null;
    for (let attempt = 0; attempt < 40 && pid === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!existsSync(pidFile)) continue;
      const value = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(value) && value > 0) pid = value;
    }
    expect(pid).not.toBeNull();

    const ppid = await ppidOf(pid as number);
    // 1 = init / launchd。被 init 收养才意味着宿主的进程树清理碰不到它。
    expect(ppid).toBe(1);

    cleanups.push(() => {
      try {
        process.kill(pid as number, "SIGTERM");
      } catch {
        // 已经退出就算了
      }
    });
  }, 20_000);
});
