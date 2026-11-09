import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import type { SessionGateway } from "../protocol/gateway.js";
import type { WorkspaceRef } from "../protocol/session.js";
import type { JobInput, JobPatch, JobStatus, Schedule, SchedulerSettings } from "../shared/types.js";
import type { JobStore } from "./db.js";
import type { Scheduler } from "./scheduler.js";

export interface RpcRequest {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcContext {
  store: JobStore;
  scheduler: Scheduler;
  settings: () => SchedulerSettings;
  gatewayFor: (workspace: WorkspaceRef) => SessionGateway | Promise<SessionGateway>;
  log: (message: string) => void;
}

export type RpcHandler = (
  params: Record<string, unknown>,
  context: RpcContext,
) => Promise<unknown> | unknown;

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`参数 ${key} 缺失或非法`);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function workspaceFrom(params: Record<string, unknown>): WorkspaceRef {
  const workspacePath = requireString(params, "workspacePath");
  const workspaceIdentity = optionalString(params, "workspaceIdentity");
  return {
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
}

function parseSchedule(params: Record<string, unknown>): Schedule {
  const kind = optionalString(params, "scheduleKind") ?? "daily";
  if (kind === "once") {
    const runAt = Number(params.runAt);
    if (!Number.isFinite(runAt) || runAt <= 0) throw new Error("一次性任务需要合法的 runAt");
    return { kind: "once", runAt };
  }
  const timeOfDay = Number(params.timeOfDay);
  if (!Number.isFinite(timeOfDay) || timeOfDay < 0 || timeOfDay >= 24 * 60 * 60 * 1000) {
    throw new Error("timeOfDay 需要是当天零点起的毫秒偏移");
  }
  if (kind === "weekly") {
    const raw = params.weekdays;
    const weekdays = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [];
    return { kind: "weekly", timeOfDay, weekdays };
  }
  return { kind: "daily", timeOfDay };
}

function parseTarget(params: Record<string, unknown>): JobInput["target"] {
  const kind = optionalString(params, "targetKind") ?? "session";
  if (kind === "new-session") {
    return { kind: "new-session", title: optionalString(params, "targetTitle") };
  }
  return {
    kind: "session",
    sessionId: requireString(params, "sessionId"),
    label: optionalString(params, "targetLabel"),
  };
}

export function createRpcHandlers(): Map<string, RpcHandler> {
  const handlers = new Map<string, RpcHandler>();

  handlers.set("ping", () => ({ ok: true, at: Date.now() }));

  handlers.set("list_jobs", (_params, ctx) => ({ jobs: ctx.store.listJobs() }));

  handlers.set("get_job", (params, ctx) => {
    const job = ctx.store.getJob(requireString(params, "jobId"));
    if (!job) throw new Error("任务不存在");
    return { job };
  });

  handlers.set("add_job", (params, ctx) => {
    const workspace = workspaceFrom(params);
    const input: JobInput = {
      title: optionalString(params, "title") ?? "未命名任务",
      target: parseTarget(params),
      prompt: requireString(params, "prompt"),
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      schedule: parseSchedule(params),
      maxAttempts: Number.isFinite(Number(params.maxAttempts)) ? Number(params.maxAttempts) : undefined,
      enabled: params.enabled === undefined ? true : Boolean(params.enabled),
    };
    const settings = ctx.settings();
    const job = ctx.store.addJob(
      {
        ...input,
        maxAttempts: input.maxAttempts ?? settings.maxRetries + 1,
      },
      `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      Date.now(),
    );
    ctx.log(`登记任务 ${job.id}：${job.title}`);
    return { job };
  });

  handlers.set("update_job", (params, ctx) => {
    const jobId = requireString(params, "jobId");
    const patch: JobPatch = {};
    const title = optionalString(params, "title");
    const prompt = optionalString(params, "prompt");
    if (title) patch.title = title;
    if (prompt) patch.prompt = prompt;
    if (params.scheduleKind !== undefined) patch.schedule = parseSchedule(params);
    if (params.targetKind !== undefined) patch.target = parseTarget(params);
    if (params.enabled !== undefined) patch.enabled = Boolean(params.enabled);
    if (Number.isFinite(Number(params.maxAttempts))) patch.maxAttempts = Number(params.maxAttempts);
    const job = ctx.store.updateJob(jobId, patch, Date.now());
    if (!job) throw new Error("任务不存在");
    return { job };
  });

  handlers.set("remove_job", (params, ctx) => {
    const removed = ctx.store.removeJob(requireString(params, "jobId"));
    return { removed };
  });

  handlers.set("run_now", async (params, ctx) => {
    const jobId = optionalString(params, "jobId");
    const started = await ctx.scheduler.runNow(jobId);
    return { started };
  });

  handlers.set("job_status", (params, ctx) => {
    const jobId = optionalString(params, "jobId");
    const jobs = ctx.store.listJobs();
    const runs = ctx.store.listRuns(jobId ?? null, Number(params.limit ?? 50));
    const summary = jobs.map((job) => ({
      jobId: job.id,
      title: job.title,
      lastStatus: job.lastStatus,
      nextRunAt: job.nextRunAt,
      consecutiveFailures: job.consecutiveFailures,
    }));
    return { summary, runs, busy: ctx.scheduler.busyJobIds };
  });

  handlers.set("list_sessions", async (params, ctx) => {
    const workspace = workspaceFrom(params);
    const gateway = await ctx.gatewayFor(workspace);
    const sessions = await gateway.listSessions(workspace);
    return { sessions };
  });

  handlers.set("get_settings", (_params, ctx) => ({ settings: ctx.settings() }));

  handlers.set("update_settings", (params, ctx) => {
    const patch: Partial<SchedulerSettings> = {};
    if (Number.isFinite(Number(params.defaultTimeOfDay))) patch.defaultTimeOfDay = Number(params.defaultTimeOfDay);
    if (Number.isFinite(Number(params.maxConcurrent))) patch.maxConcurrent = Number(params.maxConcurrent);
    if (Number.isFinite(Number(params.maxStartsPerMinute))) patch.maxStartsPerMinute = Number(params.maxStartsPerMinute);
    if (Number.isFinite(Number(params.minGapMs))) patch.minGapMs = Number(params.minGapMs);
    if (Number.isFinite(Number(params.taskTimeoutMs))) patch.taskTimeoutMs = Number(params.taskTimeoutMs);
    if (Number.isFinite(Number(params.maxRetries))) patch.maxRetries = Number(params.maxRetries);
    if (Number.isFinite(Number(params.retryBackoffMs))) patch.retryBackoffMs = Number(params.retryBackoffMs);
    if (params.model && typeof params.model === "object") {
      const model = params.model as Record<string, unknown>;
      const options = model.options as Record<string, unknown> | undefined;
      patch.model = {
        providerId: typeof model.providerId === "string" ? model.providerId : "",
        modelId: typeof model.modelId === "string" ? model.modelId : "",
        ...(options && typeof options.reasoningLevel === "string"
          ? { options: { reasoningLevel: options.reasoningLevel } }
          : {}),
      };
    }
    return { settings: ctx.store.setSettings(patch) };
  });

  return handlers;
}

export interface RpcServer {
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

export function createRpcServer(socketFile: string, context: RpcContext): RpcServer {
  const handlers = createRpcHandlers();
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) void handleLine(line, socket);
        index = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  async function handleLine(line: string, socket: Socket): Promise<void> {
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      socket.write(`${JSON.stringify({ error: { message: "无法解析的请求" } })}\n`);
      return;
    }
    const handler = handlers.get(request.method);
    if (!handler) {
      socket.write(
        `${JSON.stringify({ id: request.id, error: { message: `未知方法：${request.method}` } })}\n`,
      );
      return;
    }
    try {
      const result = await handler(request.params ?? {}, context);
      socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.write(`${JSON.stringify({ id: request.id, error: { message } })}\n`);
    }
  }

  return {
    listen: async () => {
      await unlink(socketFile).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketFile, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketFile).catch(() => undefined);
    },
  };
}

export type { JobStatus };
