import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 调度器存活探针。
 *
 * 宿主回收会话级 MCP server 时，会按 PPID 树把整棵子树干掉（SIGINT → SIGTERM → SIGKILL，
 * 见 zcode 源码 apps/zcode-cli/packages/adapters/src/mcp/process-tree.ts）。调度器必须
 * 逃出这棵树，否则会话一关，当夜就没人干活。
 *
 * 这个探针走真链路：起 app-server → 建会话（插件 MCP server 随会话起来，调度器随之启动）
 * → 关会话 → 等宿主回收 → 看调度器还活着没有。
 *
 * 用法：node scripts/daemon-lifecycle-probe.mjs <workspacePath>
 */

const workspacePath = process.argv[2] ?? process.cwd();
const CLI =
  process.env.ZCODE_CLI ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const PLUGIN_DATA = join(
  process.env.HOME ?? "",
  ".zcode/cli/plugins/data/zcode-task-scheduler@zcode-task-scheduler-local",
);
const PID_FILE = join(PLUGIN_DATA, "daemon.pid");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function daemonPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ppidOf(pid) {
  try {
    const out = spawn("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    let text = "";
    out.stdout.on("data", (chunk) => (text += chunk));
    return new Promise((resolve) =>
      out.on("close", () => resolve(Number(text.trim()) || null)),
    );
  } catch {
    return Promise.resolve(null);
  }
}

const child = spawn(process.execPath, [CLI, "app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: workspacePath,
  env: process.env,
});

let buffer = "";
const pending = new Map();
let nextId = 1;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.id !== undefined && typeof message.method === "string") {
      // 服务端反向请求：必须应答，否则调用方会一直挂着。
      child.stdin.write(`${JSON.stringify({ id: message.id, result: reverseAnswer(message.method) })}\n`);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const text = chunk.trimEnd();
  if (text) console.error(`[cli] ${text}`);
});

// 服务端反向请求的应答（与 src/protocol/gateway.ts 一致）。
function reverseAnswer(method) {
  switch (method) {
    case "session/requestRuntimePreferences":
      return {
        nativeSearchEnhancementsEnabled: true,
        toolSearchMode: "off",
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
      };
    case "interaction/requestPermission":
      return { decision: "allow" };
    case "interaction/requestUserInput":
      return { action: "decline", reason: "探针不接交互" };
    case "interaction/requestProviderRuntimeHeaders":
      return { headersApplied: false, errorMessage: "探针不提供运行时请求头" };
    case "interaction/requestOfficialMcpAuthHeaders":
      return { ok: false, reason: "official_auth_unavailable" };
    default:
      return {};
  }
}

function call(method, params) {  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时：${method}`));
    }, 120000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method} 失败：${message.error.message}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

let failed = false;
try {
  const workspace = { workspaceKey: workspacePath, workspacePath };
  const created = await call("session/create", { workspace });
  const sessionId = created?.session?.sessionId;
  console.log(`会话已建：${sessionId}`);

  let pid = null;
  for (let i = 0; i < 40 && !pid; i += 1) {
    await sleep(500);
    pid = daemonPid();
  }
  if (!pid) throw new Error("调度器没有启动");
  const ppid = await ppidOf(pid);
  console.log(`调度器已启动：pid=${pid} ppid=${ppid}（ppid=1 表示已脱离 MCP server 的进程树）`);

  await call("session/close", { sessionId });
  console.log("会话已关闭，等宿主回收 MCP server（约 45 秒）…");

  await sleep(45_000);

  const stillAlive = alive(pid);
  const ppidAfter = await ppidOf(pid);
  console.log(`回收后调度器：alive=${stillAlive} pid=${pid} ppid=${ppidAfter}`);
  if (!stillAlive) {
    failed = true;
    console.error("结论：调度器被宿主按进程树一起收掉了。");
  } else {
    console.log("结论：调度器在会话关闭后依然存活。");
  }
} catch (error) {
  failed = true;
  console.error(`探针失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}

process.exit(failed ? 1 : 0);
