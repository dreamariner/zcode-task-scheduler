import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pluginRoot } from "../shared/paths.js";
import { DaemonClient } from "./daemon-client.js";
import { requireSessionId } from "./session-context.js";

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

export async function main(): Promise<void> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  let daemon: DaemonClient | null = null;
  // 连接过程要合并：插件加载时会主动拉一次调度器，紧接着的第一个工具调用也会拉一次，
  // 不合并就会起两个 daemon，多出来的那个抢不到 pidfile 锁，白跑一轮。
  let daemonPending: Promise<DaemonClient> | null = null;

  const getDaemon = async (): Promise<DaemonClient> => {
    // 调度器是独立进程：它崩了或空闲自退之后，这边缓存的连接就是死的。
    // 不丢掉重连，面板会一直报「daemon 连接未建立」，直到整个会话重建。
    if (daemon && !daemon.connected) {
      daemon = null;
      daemonPending = null;
    }
    if (daemon) return daemon;
    if (daemonPending) return daemonPending;
    daemonPending = DaemonClient.connect({
      env: process.env,
      log: (message) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`),
    })
      .then((client) => {
        daemon = client;
        return client;
      })
      .catch((error: unknown) => {
        daemonPending = null;
        throw error;
      });
    return daemonPending;
  };

  const call = async <T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    try {
      const client = await getDaemon();
      return await client.call<T>(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`调度器不可用：${message}`);
    }
  };

  // ── 工具 ──

  server.registerTool(
    "list_sessions",
    {
      description: "列出当前工作区的会话，用来给任务挑一个执行目标。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async () => {
      const result = await call<{ sessions: unknown[] }>("list_sessions", workspaceParams());
      const sessions = result.sessions ?? [];
      const lines = sessions.map((entry) => {
        const item = entry as { sessionId: string; title: string; status: string; updatedAt: number | null };
        const title = item.title?.trim() || "(无标题)";
        return `${item.sessionId}\t${title}\t${item.status}`;
      });
      return textResult(
        lines.length > 0
          ? ["会话列表（sessionId / 标题 / 状态）：", ...lines].join("\n")
          : "当前工作区没有会话。",
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
      const result = await call<{ jobs: unknown[] }>("list_jobs");
      const jobs = result.jobs ?? [];
      const lines = jobs.map((entry) => {
        const job = entry as { id: string; title: string; nextRunAt: number | null; lastStatus: string | null };
        const due = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString("zh-CN") : "无下次计划";
        return `${job.id}\t${job.title}\t${job.lastStatus ?? "未运行"}\t下次 ${due}`;
      });
      return textResult(
        lines.length > 0 ? ["任务列表：", ...lines].join("\n") : "还没有登记任何任务。",
        { jobs },
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
        scheduleKind: z.enum(["once", "daily", "weekly"]).optional().describe("once 一次性，daily 每天，weekly 每周"),
        runAt: z.number().optional().describe("scheduleKind 为 once 时的绝对时刻（毫秒时间戳）"),
        timeOfDay: z.number().optional().describe("每天几点（当天零点起的毫秒偏移），如 00:30 传 1800000"),
        weekdays: z.array(z.number()).optional().describe("scheduleKind 为 weekly 时的星期（0 是周日）"),
        maxAttempts: z.number().int().positive().optional().describe("含首次执行在内的最大尝试次数"),
      },
      _meta: toolUi(),
    },
    async (input) => {
      const result = await call<{ job: { id: string; title: string; nextRunAt: number | null } }>(
        "add_job",
        { ...workspaceParams(), ...input },
      );
      const due = result.job.nextRunAt
        ? new Date(result.job.nextRunAt).toLocaleString("zh-CN")
        : "未排期";
      return textResult(`已登记任务 ${result.job.id}：${result.job.title}，下次执行 ${due}`, {
        job: result.job,
      });
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
        scheduleKind: z.enum(["once", "daily", "weekly"]).optional().describe("once 一次性，daily 每天，weekly 每周"),
        runAt: z.number().optional().describe("scheduleKind 为 once 时的绝对时刻（毫秒时间戳）"),
        timeOfDay: z.number().optional().describe("每天几点（当天零点起的毫秒偏移），如 00:30 传 1800000"),
        weekdays: z.array(z.number()).optional().describe("scheduleKind 为 weekly 时的星期（0 是周日）"),
        maxAttempts: z.number().int().positive().optional().describe("含首次执行在内的最大尝试次数"),
      },
      _meta: toolUi(),
    },
    async (input, extra) => {
      // 会话 id 由宿主随工具调用注入（_meta.session_id），模型与指令都拿不到自己的会话 id。
      const sessionId = requireSessionId(extra?._meta);
      const result = await call<{ job: { id: string; title: string; nextRunAt: number | null } }>(
        "add_job",
        {
          ...workspaceParams(),
          ...input,
          targetKind: "session",
          sessionId,
          targetLabel: "当前会话",
        },
      );
      const due = result.job.nextRunAt
        ? new Date(result.job.nextRunAt).toLocaleString("zh-CN")
        : "未排期";
      return textResult(
        `已把任务 ${result.job.id}（${result.job.title}）派到当前会话，下次执行 ${due}`,
        { job: result.job },
      );
    },
  );

  server.registerTool(
    "update_job",
    {
      description: "修改任务：改期、改内容、停用或删除。",
      inputSchema: {
        jobId: z.string().min(1),
        title: z.string().optional(),
        prompt: z.string().optional(),
        enabled: z.boolean().optional(),
        scheduleKind: z.enum(["once", "daily", "weekly"]).optional(),
        runAt: z.number().optional(),
        timeOfDay: z.number().optional(),
        weekdays: z.array(z.number()).optional(),
      },
      _meta: toolUi(),
    },
    async (input) => {
      const result = await call<{ job: unknown }>("update_job", input);
      return textResult(`任务 ${input.jobId} 已更新`, { job: result.job });
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
      const result = await call<{ removed: boolean }>("remove_job", input);
      return textResult(result.removed ? `任务 ${input.jobId} 已删除` : `任务 ${input.jobId} 不存在`);
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
      const result = await call<{ started: string[] }>("run_now", input);
      return textResult(
        result.started.length > 0
          ? `已开始执行：${result.started.join("、")}`
          : "没有可执行的任务。",
        { started: result.started },
      );
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
      const result = await call<{ summary: unknown[]; runs: unknown[] }>("job_status", input);
      const summary = result.summary ?? [];
      const lines = summary.map((entry) => {
        const item = entry as {
          jobId: string;
          title: string;
          lastStatus: string | null;
          nextRunAt: number | null;
          consecutiveFailures: number;
        };
        const due = item.nextRunAt ? new Date(item.nextRunAt).toLocaleString("zh-CN") : "无";
        return `${item.title}\t${item.lastStatus ?? "未运行"}\t连续失败 ${item.consecutiveFailures}\t下次 ${due}`;
      });
      return textResult(
        lines.length > 0 ? ["任务状态：", ...lines].join("\n") : "还没有任务。",
        { summary, runs: result.runs },
      );
    },
  );

  server.registerTool(
    "get_settings",
    {
      description: "读取调度器的全局设置（执行时刻、并发上限、速率、超时、重试）。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async () => {
      const result = await call<{ settings: unknown }>("get_settings");
      return textResult(JSON.stringify(result.settings, null, 2), {
        settings: result.settings,
      });
    },
  );

  server.registerTool(
    "update_settings",
    {
      description: "修改调度器的全局设置。只有面板可以调：改并发与速率会改变定时执行的闸门，模型不应碰。",
      inputSchema: {
        defaultTimeOfDay: z.number().optional().describe("每天几点（当天零点起的毫秒偏移）"),
        maxConcurrent: z.number().int().positive().optional().describe("全局并发上限"),
        maxStartsPerMinute: z.number().int().positive().optional().describe("每分钟最多启动多少个任务"),
        minGapMs: z.number().int().nonnegative().optional().describe("相邻两次启动的最小间隔（毫秒）"),
        taskTimeoutMs: z.number().int().positive().optional().describe("单次执行超时（毫秒）"),
        maxRetries: z.number().int().nonnegative().optional().describe("失败后的最大重试次数"),
        retryBackoffMs: z.number().int().nonnegative().optional().describe("首次重试前的等待时间（毫秒）"),
        model: z
          .object({
            providerId: z.string(),
            modelId: z.string(),
            options: z.object({ reasoningLevel: z.string() }).optional(),
          })
          .optional()
          .describe(
            "执行模型；providerId 与 modelId 都留空表示跟随会话默认，候选列表用 list_models 取",
          ),
      },
      // 只对面板开放：模型侧被注入时不能靠改全局设置放大无人值守执行的破坏面。
      _meta: toolUi(["app"]),
    },
    async (input) => {
      const result = await call<{ settings: unknown }>("update_settings", input);
      return textResult("设置已更新", { settings: result.settings });
    },
  );

  server.registerTool(
    "list_models",
    {
      description: "列出当前可用的模型（取自会话运行时的模型目录），用来给执行模型挑一个。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async () => {
      const result = await call<{ models: unknown[] }>("list_models", workspaceParams());
      const models = result.models ?? [];
      const lines = models.map((entry) => {
        const item = entry as {
          providerId: string;
          modelId: string;
          label: string;
          providerLabel?: string;
          reasoningLevels: string[];
          disabledReason?: string;
        };
        const provider = item.providerLabel ?? item.providerId;
        const levels = item.reasoningLevels?.length > 0 ? `\t思考等级 ${item.reasoningLevels.join("/")}` : "";
        const disabled = item.disabledReason ? "\t不可用：" + item.disabledReason : "";
        return `${item.providerId}/${item.modelId}\t${provider} · ${item.label}${levels}${disabled}`;
      });
      return textResult(
        lines.length > 0
          ? ["可用模型（providerId/modelId / 名称）：", ...lines].join("\n")
          : "没有取到模型目录；工作区里先有会话再试。",
        { models },
      );
    },
  );

  server.registerTool(
    "move_job",
    {
      description: "调整任务在面板里的执行顺序。同一会话的多个任务按这个顺序排队执行，不并发。",
      inputSchema: {
        jobId: z.string().min(1),
        direction: z.enum(["up", "down"]).describe("up 上移一位，down 下移一位"),
      },
      // 调顺序是面板偏好，模型侧不需要。
      _meta: toolUi(["app"]),
    },
    async (input) => {
      const result = await call<{ jobs: unknown[] }>("move_job", input);
      return textResult("任务顺序已更新", { jobs: result.jobs });
    },
  );

  server.registerTool(
    "daemon_status",
    {
      description: "查看调度器进程的运行状态（是否活着、CLI 来源、正在执行的任务）。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: toolUi(),
    },
    async () => {
      const result = await call<{ status: Record<string, unknown> }>("status");
      return textResult(JSON.stringify(result.status, null, 2), { status: result.status });
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
      try {
        const result = await call<{ sessions: unknown[] }>("list_sessions", workspaceParams());
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text: JSON.stringify(result) },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: message }) },
          ],
        };
      }
    },
  );

  server.registerResource(
    "jobs",
    `ui://${SERVER_NAME}/jobs.json`,
    { mimeType: "application/json" },
    async (uri) => {
      try {
        const result = await call<{ jobs: unknown[] }>("list_jobs");
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text: JSON.stringify(result) },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: message }) },
          ],
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());

  // 插件一加载就把调度器拉起来：到点就要能跑，不能等到用户点了工具才开工。
  // pidfile 单例锁保证只有第一个会话会真的拉起它。
  void getDaemon().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${SERVER_NAME}] 调度器启动失败：${message}\n`);
  });
}
