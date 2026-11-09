import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 端到端探针：起 MCP server，通过 stdio 派一个真任务到真会话。
 *
 * 用法：node scripts/e2e-probe.mjs <workspacePath> <sessionId> "<任务内容>"
 */
const [workspacePath, sessionId, prompt] = process.argv.slice(2);
if (!workspacePath || !sessionId || !prompt) {
  console.error("用法：node scripts/e2e-probe.mjs <workspacePath> <sessionId> <任务内容>");
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "zts-e2e-"));
const env = {
  ...process.env,
  ZCODE_PLUGIN_DATA: dataDir,
  ZCODE_PLUGIN_ROOT: process.cwd(),
  ZCODE_WORKSPACE_ROOT: workspacePath,
};

const child = spawn(process.execPath, [join(process.cwd(), "dist/server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  env,
});

let buffer = "";
const pending = new Map();
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
    } else if (message.method) {
      console.log(`[event] ${message.method}`);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function textOf(message) {
  const content = message?.result?.content;
  if (Array.isArray(content) && content[0]?.text) return content[0].text;
  return JSON.stringify(message?.result ?? message?.error ?? {});
}

const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e-probe", version: "0.0.1" },
});
console.log("initialize =>", JSON.stringify(init.result?.serverInfo ?? init.error));

notify("notifications/initialized");

const tools = await call("tools/list", {});
console.log(
  "工具：",
  (tools.result?.tools ?? []).map((tool) => tool.name).join(", "),
);

const sessions = await call("tools/call", { name: "list_sessions", arguments: {} });
console.log("会话数：", (sessions.result?.structuredContent?.sessions ?? []).length);

const added = await call("tools/call", {
  name: "add_job",
  arguments: {
    title: "e2e 探针任务",
    prompt,
    ...(sessionId === "new"
      ? { targetKind: "new-session", targetTitle: "e2e 探针新会话" }
      : { targetKind: "session", sessionId }),
    scheduleKind: "once",
    runAt: Date.now() + 1000,
  },
});
console.log("登记 =>", textOf(added));

const jobId = added.result?.structuredContent?.job?.id;
console.log("jobId =", jobId);

const ran = await call("tools/call", { name: "run_now", arguments: { jobId } });
console.log("执行 =>", textOf(ran));

for (let index = 0; index < 60; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const status = await call("tools/call", { name: "job_status", arguments: { jobId } });
  const runs = status.result?.structuredContent?.runs ?? [];
  const latest = runs[0];
  if (latest && latest.status !== "running") {
    console.log("运行结果 =>", JSON.stringify(latest));
    break;
  }
}

child.kill("SIGTERM");
// 同样收掉探针拉起的调度器（detached，不收会空跑半小时）。
try {
  const { readFileSync } = await import("node:fs");
  const pid = Number(readFileSync(join(dataDir, "daemon.pid"), "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
} catch {}
process.exit(0);
