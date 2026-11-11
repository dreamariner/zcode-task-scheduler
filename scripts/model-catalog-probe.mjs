import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 模型目录探针：在 daemon 同款的 app-server 进程里回答两个问题。
 *
 * 1. settings.model.available 里有没有 account: 前缀的供应商（预期：没有）；
 * 2. 显式下发 account:bigmodel-start-plan 模型选择时，执行以什么形态失败
 *    （预期：provider-not-found），并用目录里第一个可用 API 模型做对照组。
 *
 * 用法：node scripts/model-catalog-probe.mjs
 */

const CLI_CANDIDATES = [
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  join(homedir(), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
];

const cliPath = CLI_CANDIDATES.find((candidate) => existsSync(candidate));
if (!cliPath) throw new Error("找不到桌面端内置 CLI");

const workspacePath = mkdtempSync(join(tmpdir(), "zts-catalog-"));
const child = spawn(process.execPath, [cliPath, "app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: workspacePath,
  env: { ...process.env },
});

let buffer = "";
const pending = new Map();
const serverPending = new Map();
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
    if (message.id === undefined) continue;
    // 服务端反向请求（带 method）必须应答，否则对端挂着。
    if (message.method) {
      const id = message.id;
      serverPending.delete(id);
      const answer = serverAnswer(message.method);
      child.stdin.write(`${JSON.stringify({ id, result: answer })}\n`);
      continue;
    }
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const text = chunk.trim();
  if (text) console.log(`[stderr] ${text.slice(0, 400)}`);
});

function serverAnswer(method) {
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
      return { action: "decline", reason: "probe" };
    case "interaction/requestProviderRuntimeHeaders":
      console.log("[probe] 服务端请求了 provider 运行时请求头（account 鉴权走这里）");
      return { headersApplied: false, errorMessage: "probe: 无宿主鉴权" };
    case "interaction/requestOfficialMcpAuthHeaders":
      return { ok: false, reason: "official_auth_unavailable" };
    default:
      console.log(`[probe] 未应答的反向请求：${method}`);
      return {};
  }
}

function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时：${method}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) {
        const error = new Error(`${method} 失败：${message.error.message}`);
        error.code = message.error.code;
        reject(error);
      } else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

const telemetryEvents = [];
const turnWaiters = [];

// turn.terminal 是通知帧（无 id），不在 request/response 通道上；
// 单独挂一个监听器解析通知帧，与上面处理带 id 帧的监听器并存。
child.stdout.on("data", (chunk) => {
  // 与上面同一份流；通知帧（无 id）在这里处理。
  let lines = chunk.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined) continue;
    if (message.method === "v4/telemetry/event") {
      const params = message.params ?? {};
      if (params.kind === "turn.terminal") {
        telemetryEvents.push(params);
        for (const waiter of turnWaiters.splice(0)) waiter(params);
      }
    }
  }
});

function waitForTurn(sessionId, timeoutMs = 180000) {
  const existing = telemetryEvents.find(
    (event) => event.sessionId === sessionId && ["success", "failed", "interrupted"].includes(event.status),
  );
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = turnWaiters.indexOf(handle);
      if (index >= 0) turnWaiters.splice(index, 1);
      reject(new Error(`等 turn.terminal 超时（${sessionId}）`));
    }, timeoutMs);
    const handle = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
    turnWaiters.push(handle);
  });
}

let exitCode = 0;
try {
  const workspace = { workspaceKey: workspacePath, workspacePath };
  const created = await request("session/create", { workspace });
  const sessionId = created?.session?.sessionId;
  if (!sessionId) throw new Error(`session/create 没有返回会话 id：${JSON.stringify(created).slice(0, 300)}`);
  console.log(`[probe] 临时会话 ${sessionId}`);

  const resumed = await request("session/resume", { sessionId, workspace });
  const available = resumed?.settings?.model?.available ?? [];
  const providers = new Map();
  for (const entry of available) {
    const providerId = entry?.ref?.providerId ?? "?";
    const modelId = entry?.ref?.modelId ?? "?";
    if (!providers.has(providerId)) providers.set(providerId, []);
    providers.get(providerId).push(modelId);
  }
  console.log("[probe] 目录供应商：");
  for (const [providerId, models] of providers) {
    console.log(`  ${providerId}: ${models.join(", ")}`);
  }
  const accountProviders = [...providers.keys()].filter((id) => id.startsWith("account:") || id.startsWith("builtin:"));
  console.log(
    accountProviders.length === 0
      ? "[probe] 结论：目录里没有任何 account:/builtin: 供应商（Start Plan 缺席实锤）"
      : `[probe] 结论：目录里有账号供应商：${accountProviders.join(", ")}`,
  );

  // 对照组：目录里第一个带推理档位的模型，证明本进程执行链本身是好的。
  const usable = available.find(
    (entry) => Array.isArray(entry?.reasoning?.levels) && entry.reasoning.levels.length > 0,
  );
  if (usable) {
    const selection = {
      providerId: usable.ref.providerId,
      modelId: usable.ref.modelId,
      options: { reasoningLevel: usable.reasoning.levels[0]?.value ?? usable.reasoning.defaultLevel },
    };
    console.log(`[probe] 对照组：${usable.ref.providerId}/${usable.ref.modelId} level=${selection.options.reasoningLevel}`);
    await request("session/send", {
      sessionId,
      content: "只回复两个字：就绪",
      modelSelection: selection,
    });
    const outcome = await waitForTurn(sessionId);
    console.log(`[probe] 对照组终态：${outcome.status} errorCode=${outcome.errorCode ?? "无"}`);
  }

  // 实验组：显式下发 Start Plan 选择，看失败形态。
  const accountSelection = {
    providerId: "account:bigmodel-start-plan",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "high" },
  };
  console.log(`[probe] 实验组：${accountSelection.providerId}/${accountSelection.modelId}`);
  try {
    await request("session/send", {
      sessionId,
      content: "只回复两个字：就绪",
      modelSelection: accountSelection,
    });
    const outcome = await waitForTurn(sessionId);
    console.log(
      `[probe] 实验组终态：${outcome.status} errorCode=${outcome.errorCode ?? "无"} message=${(outcome.errorMessage ?? "").slice(0, 200)}`,
    );
  } catch (error) {
    console.log(`[probe] 实验组 send 即被拒：${error.message}`);
  }

  await request("session/close", { sessionId }).catch(() => undefined);
} catch (error) {
  exitCode = 1;
  console.error(`[probe] 失败：${error.message}`);
} finally {
  child.kill("SIGTERM");
  setTimeout(() => rmSync(workspacePath, { recursive: true, force: true }), 500);
}
process.exit(exitCode);
