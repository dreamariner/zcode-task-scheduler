import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pluginRoot } from "../shared/paths.js";
import { requireSessionId } from "./session-context.js";
import { migrateLegacyJobs } from "../automation/migrate.js";
import { ensureGatekeeper } from "../gate/spawn.js";
import { MAX_CONCURRENT } from "../gate/runner.js";
import {
  AUTOMATION_LIMIT,
  AutomationStore,
  type ScheduleInput,
  type ScheduleKind,
} from "../automation/store.js";

const SERVER_NAME = "zcode-task-scheduler";
const SERVER_VERSION = "0.1.0";
const SURFACE_ID = "scheduler";
const PANEL_URI = `ui://${SERVER_NAME}/panel.html`;
const HTML_MIME = "text/html;profile=mcp-app";

function workspaceParams(): { workspacePath: string; workspaceIdentity?: string } {
  const workspacePath = process.env.ZCODE_WORKSPACE_ROOT?.trim() || process.cwd();
  const workspaceIdentity = process.env.ZCODE_WORKSPACE_IDENTITY?.trim();
  return {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
}

function toolUi(visibility: string[] = ["model", "app"]): Record<string, unknown> {
  return {
    ui: {
      resourceUri: PANEL_URI,
      surface: SURFACE_ID,
      visibility,
    },
  };
}

function textResult(text: string, structuredContent?: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

const scheduleShape = {
  scheduleKind: z.enum(["once", "daily", "weekly"]).optional().describe("once 一次性，daily 每天，weekly 每周"),
  runAt: z.number().optional().describe("scheduleKind 为 once 时的绝对时刻（毫秒时间戳）"),
  timeOfDay: z.number().optional().describe("每天几点（当天零点起的毫秒偏移），如 00:30 传 1800000"),
  weekdays: z.array(z.number()).optional().describe("scheduleKind 为 weekly 时的星期（0 是周日）"),
};

/**
 * 执行模型。
 *
 * 默认用 MiniMax M3.1 Flash：它是全天可用的常规模型。订阅账号套餐（如 Start Plan）
 * 只在套餐覆盖的时段（夜间）可用，白天指定它会被桌面端判为不可用而失败，
 * 所以默认不跟随会话当前模型（会话里选的往往正是夜间套餐）。
 * 需要夜间套餐时显式指定 model；需要完全跟随会话时用 followSessionModel。
 */
const DEFAULT_MODEL = {
  providerId: "minimax",
  modelId: "MiniMax-M3.1-Flash",
  reasoningLevel: "max",
} as const;

const modelShape = {
  model: z
    .object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      reasoningLevel: z.string().min(1),
    })
    .optional()
    .describe(
      "执行模型；不传则用 MiniMax M3.1 Flash（白天可用的常规模型）。夜间套餐（如 account:bigmodel-start-plan）要显式指定，并给思考档位",
    ),
  followSessionModel: z
    .boolean()
    .optional()
    .describe("true 表示跟随桌面端当前首选模型（会话当前选择）；套餐可能只在夜间可用"),
};

function scheduleOf(input: {
  scheduleKind?: ScheduleKind;
  runAt?: number;
  timeOfDay?: number;
  weekdays?: number[];
}): ScheduleInput {
  const kind = input.scheduleKind ?? "daily";
  if (kind === "once") {
    if (typeof input.runAt !== "number" || !Number.isFinite(input.runAt) || input.runAt <= 0) {
      throw new Error("一次性任务需要合法的 runAt（毫秒时间戳）");
    }
    return { kind, runAt: input.runAt };
  }
  const timeOfDay = input.timeOfDay ?? 0;
  if (!Number.isFinite(timeOfDay) || timeOfDay < 0 || timeOfDay >= 24 * 60 * 60 * 1000) {
    throw new Error("timeOfDay 需要是当天零点起的毫秒偏移");
  }
  if (kind === "weekly") {
    const weekdays = (input.weekdays ?? []).filter(
      (day) => Number.isInteger(day) && day >= 0 && day <= 6,
    );
    if (weekdays.length === 0) throw new Error("每周任务至少选择一天");
    return { kind, timeOfDay, weekdays };
  }
  return { kind, timeOfDay };
}

/**
 * 决定任务用哪个模型：
 * - followSessionModel 为 true → 跟随桌面端当前首选（model_selection 写 "null"）；
 * - 给了 model → 用它（桌面端派发前会校验模型与思考档位）；
 * - 都没给 → 默认 MiniMax M3.1 Flash（白天可用的常规模型）。
 */
function resolveModel(input: {
  model?: { providerId: string; modelId: string; reasoningLevel: string };
  followSessionModel?: boolean;
}): { providerId: string; modelId: string; reasoningLevel: string } | null {
  if (input.followSessionModel === true) return null;
  if (input.model) {
    return {
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      reasoningLevel: input.model.reasoningLevel,
    };
  }
  return { ...DEFAULT_MODEL };
}

function statusText(row: {
  enabled: boolean;
  lifecycleStatus: string;
  running: boolean;
  lastRunAt: number | null;
}): string {  if (!row.enabled) return "已停用";
  if (row.lifecycleStatus === "completed") return "已完成";
  if (row.lifecycleStatus === "failed") return "已失败";
  if (row.running) return "在投中";
  return row.lastRunAt ? "已排队" : "待执行";
}

export async function main(): Promise<void> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  const store = new AutomationStore({
    log: (message) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`),
  });

  // 一次性迁移：旧版插件自己的任务库 → 桌面端 automations 表。
  const migrated = migrateLegacyJobs(store, {
    log: (message) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`),
  });
  if (migrated.migrated > 0) {
    process.stderr.write(
      `[${SERVER_NAME}] 已迁移 ${migrated.migrated} 条旧任务到桌面端调度器\n`,
    );
  }

  // 节流闸：桌面端调度器没有并发闸（一次认领所有到期任务），节流必须由插件这一侧
  // 管。闸门是常驻进程，用两次 fork 脱离会话进程树；插件一加载就把它拉起来。
  const gateLog = (message: string): void => {
    process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
  };
  const ensureGate = (): void => {
    ensureGatekeeper({ env: process.env, log: gateLog });
  };
  ensureGate();

  // ── 工具 ──

  // 版本探针：面板 HTML 每次渲染从磁盘现读，server 却在会话创建时进内存。
  // 重装插件后两者可能错版本，旧 server 会把新参数静默剥掉（zod 默认剥离）。
  // 面板启动时 ping 一下对构建号，不一致就显 banner 并禁掉写操作。
  server.registerTool(
    "ping",
    {
      description: "版本探针：返回本 server 的构建号，供面板与自己的构建号比对。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async () => textResult(`build ${process.env.ZTS_BUILD_ID ?? "unknown"}`, { buildId: process.env.ZTS_BUILD_ID ?? "unknown" }),
  );

  server.registerTool(
    "list_sessions",
    {
      description: "列出当前工作区的会话，用来给任务挑一个执行目标。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async () => {
      const workspace = workspaceParams();
      const tasks = store.listWorkspaceTasks(workspace.workspacePath);
      const sessions = tasks.map((task) => ({
        sessionId: task.taskId,
        title: task.title,
        status: "",
        updatedAt: task.updatedAt,
      }));
      const lines = sessions.map(
        (item) => `${item.sessionId}\t${item.title || "(无标题)"}`,
      );
      return textResult(
        lines.length > 0 ? ["会话列表（sessionId / 标题）：", ...lines].join("\n") : "当前工作区没有会话。",
        { sessions },
      );
    },
  );

  server.registerTool(
    "list_jobs",
    {
      description: "列出已登记的定时任务。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async () => {
      ensureGate();
      const jobs = store.list();
      const inFlightIds = new Set(store.inFlightTasks().map((item) => item.automationId));
      // 在投标记按「回合未终结」判定，与节流闸同一判据；面板徽标据此显示。
      const jobViews = jobs.map((job) => ({
        ...job,
        running: inFlightIds.has(job.automationId),
      }));
      const concurrency = {
        max: MAX_CONCURRENT,
        inFlight: inFlightIds.size,
        waiting: store.listPendingManualRuns().length,
        inFlightTitles: jobs
          .filter((job) => inFlightIds.has(job.automationId))
          .map((job) => job.title),
      };
      const lines = jobViews.map((job) => {
        const due = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString("zh-CN") : "无下次计划";
        return `${job.automationId}\t${job.title}\t${statusText(job)}\t下次 ${due}`;
      });
      const head = `在投 ${concurrency.inFlight}/${concurrency.max}${concurrency.waiting > 0 ? `，排队 ${concurrency.waiting}` : ""}`;
      return textResult(
        lines.length > 0 ? [head, "任务列表：", ...lines].join("\n") : [head, "还没有登记任何任务。"].join("\n"),
        { jobs: jobViews, concurrency },
      );
    },
  );

  server.registerTool(
    "add_job",
    {
      description: "登记一个定时任务。目标可以是已有会话，也可以是到点时新建一个会话。",
      inputSchema: {
        title: z.string().optional().describe("任务标题"),
        prompt: z.string().min(1).describe("要执行的任务内容，直接描述要完成的最终工作"),
        targetKind: z.enum(["session", "new-session"]).optional().describe("session 指派到已有会话，new-session 到点时新建会话"),
        sessionId: z.string().optional().describe("targetKind 为 session 时必填"),
        targetTitle: z.string().optional().describe("targetKind 为 new-session 时的新会话标题"),
        ...scheduleShape,
        ...modelShape,
      },
      _meta: toolUi(),
    },
    async (input) => {
      const count = store.count();
      if (count >= AUTOMATION_LIMIT) {
        throw new Error(`定时任务已达上限 ${AUTOMATION_LIMIT} 条（官方约定），请先删掉不用的`);
      }
      const workspace = workspaceParams();
      const job = store.create({
        title: input.title?.trim() || "未命名任务",
        prompt: input.prompt,
        targetSessionId: input.targetKind === "new-session" ? null : (input.sessionId ?? null),
        workspaceKey: workspace.workspacePath,
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        schedule: scheduleOf(input),
        enabled: true,
        model: resolveModel(input),
      });
      const due = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString("zh-CN") : "未排期";
      return textResult(`已登记任务 ${job.automationId}：${job.title}，下次执行 ${due}`, { job });
    },
  );

  server.registerTool(
    "add_job_here",
    {
      description:
        "在当前会话里给这个会话本身登记定时任务：目标自动取当前会话，不用也不能指定别的会话。",
      inputSchema: {
        title: z.string().optional().describe("任务标题"),
        prompt: z.string().min(1).describe("要执行的任务内容，直接描述要完成的最终工作"),
        ...scheduleShape,
        ...modelShape,
      },
      _meta: toolUi(),
    },
    async (input, extra) => {
      // 会话 id 由宿主随工具调用注入（_meta.session_id），模型与指令都拿不到自己的会话 id。
      const sessionId = requireSessionId(extra?._meta);
      const count = store.count();
      if (count >= AUTOMATION_LIMIT) {
        throw new Error(`定时任务已达上限 ${AUTOMATION_LIMIT} 条（官方约定），请先删掉不用的`);
      }
      const workspace = workspaceParams();
      const job = store.create({
        title: input.title?.trim() || "未命名任务",
        prompt: input.prompt,
        targetSessionId: sessionId,
        workspaceKey: workspace.workspacePath,
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        schedule: scheduleOf(input),
        enabled: true,
        model: resolveModel(input),
      });
      const due = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString("zh-CN") : "未排期";
      return textResult(
        `已把任务 ${job.automationId}（${job.title}）派到当前会话，下次执行 ${due}`,
        { job },
      );
    },
  );

  server.registerTool(
    "update_job",
    {
      description:
        "修改任务：改期、改内容、换目标会话、换执行模型、停用或启用。没给的字段保持不变。",
      inputSchema: {
        jobId: z.string().min(1),
        title: z.string().optional().describe("任务标题"),
        prompt: z.string().optional().describe("任务内容"),
        enabled: z.boolean().optional().describe("停用或启用"),
        targetSessionId: z
          .string()
          .nullable()
          .optional()
          .describe("目标会话 id；null 表示到点时新建会话"),
        ...scheduleShape,
        ...modelShape,
      },
      _meta: toolUi(),
    },
    async (input) => {
      const hasSchedule =
        input.scheduleKind !== undefined ||
        input.runAt !== undefined ||
        input.timeOfDay !== undefined ||
        input.weekdays !== undefined;
      // 模型用「没给就不动」语义（与 add_job 的默认兜底不同）：改编辑面板常用部分更新。
      const model = input.followSessionModel
        ? null
        : input.model
          ? {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              reasoningLevel: input.model.reasoningLevel,
            }
          : undefined;
      const job = store.update(input.jobId, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.targetSessionId !== undefined ? { targetSessionId: input.targetSessionId } : {}),
        ...(hasSchedule ? { schedule: scheduleOf(input) } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      if (!job) throw new Error(`任务 ${input.jobId} 不存在`);
      const due = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString("zh-CN") : "未排期";
      return textResult(`任务 ${input.jobId} 已更新，下次执行 ${due}`, { job });
    },
  );

  server.registerTool(
    "remove_job",
    {
      description: "删除一个任务。",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { destructiveHint: true },
      _meta: toolUi(),
    },
    async (input) => {
      const removed = store.remove(input.jobId);
      return textResult(removed ? `任务 ${input.jobId} 已删除` : `任务 ${input.jobId} 不存在`);
    },
  );

  server.registerTool(
    "run_now",
    {
      description: "立即执行一轮，不等到计划时刻。传 jobId 只跑指定任务，不传则跑全部启用中的任务。",
      inputSchema: { jobId: z.string().optional() },
      _meta: toolUi(),
    },
    async (input) => {
      ensureGate();
      const targets = input.jobId
        ? [input.jobId]
        : store.list().filter((job) => job.enabled).map((job) => job.automationId);
      const jobs = store.list();
      const inFlight = store.inFlightTasks();
      const started: string[] = [];
      const queued: string[] = [];
      const busy: string[] = [];
      for (const id of targets) {
        const job = jobs.find((item) => item.automationId === id);
        if (!job) {
          busy.push(id);
          continue;
        }
        // 并发满，或同会话已有在投任务：排队等待，不绕过闸门。
        const sessionBusy = job.targetSessionId
          ? inFlight.some((item) => item.targetSessionId === job.targetSessionId)
          : false;
        const needQueue = inFlight.length + started.length >= MAX_CONCURRENT || sessionBusy;
        const result = store.enqueueManualRun(id, { queued: needQueue });
        if (!result) {
          busy.push(id);
          continue;
        }
        if (result.queued) queued.push(id);
        else started.push(id);
      }
      const parts: string[] = [];
      if (started.length > 0) parts.push(`已开始执行：${started.join("、")}`);
      if (queued.length > 0) {
        parts.push(
          `并发已满或同会话正在执行，已排队等待：${queued.join("、")}（最多同时 ${MAX_CONCURRENT} 条在投）`,
        );
      }
      if (busy.length > 0) parts.push(`已在执行中（未重复投递）：${busy.join("、")}`);
      if (parts.length === 0) parts.push("没有可执行的任务。");
      return textResult(parts.join("\n"), { started, queued, busy });
    },
  );

  server.registerTool(
    "job_status",
    {
      description: "查看任务与最近运行的结果摘要。",
      inputSchema: {
        jobId: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async (input) => {
      ensureGate();
      const jobs = store.list();
      const inFlightIds = new Set(store.inFlightTasks().map((item) => item.automationId));
      const summary = jobs.map((job) => ({
        jobId: job.automationId,
        title: job.title,
        lastStatus: statusText(job),
        nextRunAt: job.nextRunAt,
        consecutiveFailures: 0,
        enabled: job.enabled,
        // 在投 = 回合未终结（与节流闸同一个判据）。
        running: inFlightIds.has(job.automationId),
        targetSessionId: job.targetSessionId,
      }));
      const runs = store.listRuns(input.jobId, input.limit ?? 30);
      const waiting = store.listPendingManualRuns().length;
      const concurrency = {
        max: MAX_CONCURRENT,
        inFlight: inFlightIds.size,
        waiting,
        inFlightTitles: jobs
          .filter((job) => inFlightIds.has(job.automationId))
          .map((job) => job.title),
      };
      const lines = summary.map((item) => {
        const due = item.nextRunAt ? new Date(item.nextRunAt).toLocaleString("zh-CN") : "无";
        return `${item.title}\t${item.lastStatus}\t下次 ${due}`;
      });
      const head = `在投 ${concurrency.inFlight}/${concurrency.max}${concurrency.waiting > 0 ? `，排队 ${concurrency.waiting}` : ""}`;
      return textResult(
        lines.length > 0 ? [head, "任务状态：", ...lines].join("\n") : [head, "还没有任务。"].join("\n"),
        { summary, runs, concurrency },
      );
    },
  );

  // ── 资源 ──

  const root = pluginRoot();
  const panelMeta = { "zcode/csp": { wasmUnsafeEval: true } };

  server.registerResource(
    "panel",
    PANEL_URI,
    { mimeType: HTML_MIME, _meta: panelMeta },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: HTML_MIME,
          text: await readFile(join(root, "dist", "ui", "panel.html"), "utf8"),
          _meta: panelMeta,
        },
      ],
    }),
  );

  server.registerResource(
    "assets",
    new ResourceTemplate(`ui://${SERVER_NAME}/assets/{+name}`, { list: undefined }),
    { mimeType: "text/plain" },
    async (uri, variables) => {
      const name = String(variables.name ?? "");
      const safe = name.replace(/[^A-Za-z0-9._-]/g, "");
      const text = await readFile(join(root, "dist", "ui", safe), "utf8");
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    },
  );

  server.registerResource(
    "sessions",
    `ui://${SERVER_NAME}/sessions.json`,
    { mimeType: "application/json" },
    async (uri) => {
      const workspace = workspaceParams();
      const sessions = store
        .listWorkspaceTasks(workspace.workspacePath)
        .map((task) => ({
          sessionId: task.taskId,
          title: task.title,
          status: "",
          updatedAt: task.updatedAt,
        }));
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify({ sessions }) },
        ],
      };
    },
  );

  server.registerResource(
    "jobs",
    `ui://${SERVER_NAME}/jobs.json`,
    { mimeType: "application/json" },
    async (uri) => {
      const jobs = store.list();
      const runs = store.listRuns(undefined, 30);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ jobs, runs }),
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
}
