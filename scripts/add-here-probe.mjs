import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 会话内派任务探针：模拟宿主带 `_meta.session_id` 调 `add_job_here`，
 * 验证任务目标就是当前会话（宿主注入 _meta 的行为见官方 mcpRequestMeta）。
 *
 * 用法：node scripts/add-here-probe.mjs <workspacePath>
 */

const workspacePath = process.argv[2] ?? process.cwd();
const SESSION_ID = `sess_probe_here_${Date.now().toString(36)}`;
const dataDir = mkdtempSync(join(tmpdir(), "zts-here-"));

const child = spawn(process.execPath, [join(process.cwd(), "dist/server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ZCODE_PLUGIN_DATA: dataDir,
    ZCODE_PLUGIN_ROOT: process.cwd(),
    ZCODE_WORKSPACE_ROOT: workspacePath,
  },
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
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", () => {});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时：${method}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method} 失败：${message.error.message}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

let failed = false;
try {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "here-probe", version: "0" },
  });

  const tools = await call("tools/list", {});
  const names = (tools.tools ?? []).map((tool) => tool.name);
  if (!names.includes("add_job_here")) throw new Error("add_job_here 未注册");
  console.log("add_job_here 已注册");

  // 宿主形态的 _meta：嵌套 request-context 为主，顶层冗余一份。
  const requestMeta = {
    session_id: SESSION_ID,
    "com.zcode/request-context": {
      session_id: SESSION_ID,
      workspace_path: workspacePath,
      workspace_key: workspacePath,
    },
  };

  const added = await call("tools/call", {
    name: "add_job_here",
    arguments: {
      title: "会话内派任务探针",
      prompt: "探针用，验证后删除",
      scheduleKind: "daily",
      timeOfDay: 1_800_000,
    },
    _meta: requestMeta,
  });
  console.log("登记 =>", added.content?.[0]?.text ?? JSON.stringify(added));

  const jobId = added.structuredContent?.job?.id;
  if (!jobId) throw new Error("登记没有返回 job id");

  const jobs = await call("tools/call", {
    name: "list_jobs",
    arguments: {},
    _meta: requestMeta,
  });
  const job = (jobs.structuredContent?.jobs ?? []).find((item) => item.id === jobId);
  if (!job) throw new Error("任务清单里找不到刚登记的任务");
  const sessionId = job.target?.sessionId;
  console.log("任务目标 =>", job.target?.kind, sessionId);
  if (sessionId !== SESSION_ID) {
    throw new Error(`目标会话不对：期望 ${SESSION_ID}，实际 ${sessionId ?? "无"}`);
  }

  // 反向验证：不带 _meta 调用要明确报错，而不是猜一个目标。
  // 工具内抛错由 SDK 包成 isError 的结果，不走协议错误。
  let rejected = false;
  try {
    const bad = await call("tools/call", {
      name: "add_job_here",
      arguments: { title: "不该成功", prompt: "x", scheduleKind: "daily", timeOfDay: 0 },
    });
    if (bad.isError) {
      rejected = true;
      console.log("缺 _meta 正确拒绝 =>", (bad.content?.[0]?.text ?? "").slice(0, 80));
    }
  } catch (error) {
    rejected = true;
    console.log("缺 _meta 正确拒绝 =>", error.message.slice(0, 80));
  }
  if (!rejected) throw new Error("缺 _meta 的调用居然成功了");

  // 清理探针任务
  await call("tools/call", { name: "remove_job", arguments: { jobId }, _meta: requestMeta });
  console.log("结论：add_job_here 目标会话正确，缺失上下文时明确拒绝。");
} catch (error) {
  failed = true;
  console.error(`探针失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  child.stdin.end();
  child.kill();
  setTimeout(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }, 500);
}
