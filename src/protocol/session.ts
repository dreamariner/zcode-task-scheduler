import type { ModelSelection, SessionSummary } from "../shared/types.js";
import { ProtocolClient, ProtocolRequestError } from "./client.js";

export interface WorkspaceRef {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TurnOutcome {
  status: "success" | "interrupted" | "failed";
  errorCode?: string;
  errorMessage?: string;
  errorRetryable?: boolean;
  durationMs?: number;
  tokens?: number;
}

export function workspaceRefOf(workspacePath: string, workspaceIdentity?: string): WorkspaceRef {
  const path = workspacePath.trim();
  return {
    workspaceKey: workspaceIdentity?.trim() || path,
    workspacePath: path,
    ...(workspaceIdentity?.trim() ? { workspaceIdentity: workspaceIdentity.trim() } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 列出工作区内的会话。 */
export async function listSessions(
  client: ProtocolClient,
  workspace: WorkspaceRef,
): Promise<SessionSummary[]> {
  const result = await client.request<{ sessions?: unknown[] }>("session/list", { workspace });
  const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  return sessions.map((entry) => {
    const item = asRecord(entry);
    return {
      sessionId: asString(item.sessionId) ?? "",
      title: asString(item.title) ?? "",
      status: asString(item.status) ?? "",
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : null,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : null,
    };
  }).filter((session) => session.sessionId.length > 0);
}

/** 新建会话，返回真实会话 id。 */
export async function createSession(
  client: ProtocolClient,
  workspace: WorkspaceRef,
  options: { title?: string; model?: ModelSelection } = {},
): Promise<string> {
  const result = await client.request<Record<string, unknown>>("session/create", {
    workspace,
    ...(options.title ? { titleGenerationEnabled: true } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  // 协议层返回的是会话快照本身，会话 id 在 session 字段里；
  // projection.sessionId 在事件流为空时会退化成 "unknown"，不能当 id 用。
  const session = asRecord(result.session);
  const sessionId = asString(session.sessionId);
  if (!sessionId || sessionId === "unknown") {
    throw new ProtocolRequestError("新建会话没有返回会话 id", -32602, "session/create");
  }
  return sessionId;
}

/** 恢复（加载）一个已存在的会话。 */
export async function resumeSession(
  client: ProtocolClient,
  sessionId: string,
  workspace: WorkspaceRef,
): Promise<void> {
  await client.request("session/resume", { sessionId, workspace });
}

/** 读会话快照，取标题与状态。 */
export async function readSession(
  client: ProtocolClient,
  sessionId: string,
): Promise<{ title: string; status: string }> {
  const result = await client.request<Record<string, unknown>>("session/read", { sessionId });
  const session = asRecord(result.session);
  return {
    title: asString(session.title) ?? "",
    status: asString(session.status) ?? "",
  };
}

/** 把会话切到无人值守可跑的权限模式。 */
export async function setSessionMode(
  client: ProtocolClient,
  sessionId: string,
  mode: "plan" | "build" | "edit" | "yolo" | "guarded" | "auto",
): Promise<void> {
  await client.request("session/setMode", { sessionId, mode });
}

/** 向会话下发一条指令，返回受理结果。 */
export async function sendPrompt(
  client: ProtocolClient,
  sessionId: string,
  content: string,
  model?: ModelSelection,
): Promise<void> {
  const result = await client.request<Record<string, unknown>>("session/send", {
    sessionId,
    content,
    ...(model ? { modelSelection: model } : {}),
  });
  if (result?.accepted === false) {
    throw new ProtocolRequestError("会话拒绝了本次指令", -32000, "session/send");
  }
}

/**
 * 等待本轮执行结束。
 *
 * 终态来自 `v4/telemetry/event` 的 turn.terminal 事实，字段与官方
 * packages/shared/src/zcode-protocol-v4/telemetry.ts 的 schema 一致。
 */
export function waitForTurnOutcome(
  client: ProtocolClient,
  sessionId: string,
  timeoutMs: number,
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`等待会话 ${sessionId} 的回合终态超时（${timeoutMs}ms）`)));
    }, timeoutMs);
    timer.unref?.();

    const onEvent = (event: { method: string; params: unknown }): void => {
      if (event.method !== "v4/telemetry/event") return;
      const params = asRecord(event.params);
      if (params.kind !== "turn.terminal") return;
      if (asString(params.sessionId) !== sessionId) return;

      const status = asString(params.status);
      if (status !== "success" && status !== "interrupted" && status !== "failed") return;

      finish(() =>
        resolve({
          status,
          ...(asString(params.errorCode) ? { errorCode: asString(params.errorCode) } : {}),
          ...(asString(params.errorMessage) ? { errorMessage: asString(params.errorMessage) } : {}),
          ...(typeof params.errorRetryable === "boolean"
            ? { errorRetryable: params.errorRetryable }
            : {}),
          ...(typeof params.durationMs === "number" ? { durationMs: params.durationMs } : {}),
          ...(typeof params.tokenCount === "number" ? { tokens: params.tokenCount } : {}),
        }),
      );
    };

    const onClose = (): void => {
      finish(() => reject(new Error("ZCode CLI 进程在回合结束前退出")));
    };

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("event", onEvent);
      client.off("close", onClose);
      action();
    }

    client.on("event", onEvent);
    client.on("close", onClose);
  });
}
