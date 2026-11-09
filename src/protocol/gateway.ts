import type { ModelSelection, SessionSummary } from "../shared/types.js";
import type { CliLaunch } from "../shared/paths.js";
import { ProtocolClient } from "./client.js";
import {
  createSession,
  listSessions,
  readSession,
  resumeSession,
  sendPrompt,
  setSessionMode,
  waitForTurnOutcome,
  type TurnOutcome,
  type WorkspaceRef,
} from "./session.js";

/** 执行器依赖的会话操作集合。抽成接口是为了让单测能注入假实现。 */
export interface SessionGateway {
  listSessions(workspace: WorkspaceRef): Promise<SessionSummary[]>;
  createSession(workspace: WorkspaceRef, options?: { title?: string; model?: ModelSelection }): Promise<string>;
  resumeSession(sessionId: string, workspace: WorkspaceRef): Promise<void>;
  readSession(sessionId: string): Promise<{ title: string; status: string }>;
  setMode(sessionId: string, mode: "plan" | "build" | "edit" | "yolo" | "guarded" | "auto"): Promise<void>;
  sendPrompt(sessionId: string, content: string, model?: ModelSelection): Promise<void>;
  waitForTurnOutcome(sessionId: string, timeoutMs: number): Promise<TurnOutcome>;
  close(): Promise<void>;
}

export interface GatewayOptions {
  launch: CliLaunch;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (message: string) => void;
}

/**
 * 基于 ZCode Protocol 的会话网关。
 *
 * 协议是双向的：服务端会反向发请求，客户端必须应答，否则回合会一直挂着。
 * 这里把无人值守场景下会出现的三类交互都答掉。
 */
export class ProtocolSessionGateway implements SessionGateway {
  private constructor(private readonly client: ProtocolClient) {}

  static start(options: GatewayOptions): ProtocolSessionGateway {
    const client = ProtocolClient.start({
      launch: options.launch,
      cwd: options.cwd,
      env: options.env,
      onLog: options.onLog,
    });

    client.onServerRequest("session/requestRuntimePreferences", () => ({
      nativeSearchEnhancementsEnabled: true,
      toolSearchMode: "off",
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true,
    }));

    client.onServerRequest("interaction/requestPermission", () => ({ decision: "allow" }));

    client.onServerRequest("interaction/requestUserInput", () => ({
      action: "decline",
      reason: "无人值守执行，不接受交互式提问",
    }));

    client.onServerRequest("interaction/requestProviderRuntimeHeaders", () => ({
      headersApplied: false,
      errorMessage: "当前执行未提供 provider 运行时请求头",
    }));

    // 官方 MCP 的鉴权头只有宿主能给（宿主解析 Coding Plan 凭证）。daemon 是脱离
    // 桌面端独立跑的进程，没有宿主可问，明确回「拿不到」而不是回错误，让 CLI
    // 把官方 MCP 标成不可用，而不是反复重试。
    client.onServerRequest("interaction/requestOfficialMcpAuthHeaders", () => ({
      ok: false,
      reason: "official_auth_unavailable",
    }));

    return new ProtocolSessionGateway(client);
  }

  listSessions(workspace: WorkspaceRef): Promise<SessionSummary[]> {
    return listSessions(this.client, workspace);
  }

  createSession(
    workspace: WorkspaceRef,
    options: { title?: string; model?: ModelSelection } = {},
  ): Promise<string> {
    return createSession(this.client, workspace, options);
  }

  resumeSession(sessionId: string, workspace: WorkspaceRef): Promise<void> {
    return resumeSession(this.client, sessionId, workspace);
  }

  readSession(sessionId: string): Promise<{ title: string; status: string }> {
    return readSession(this.client, sessionId);
  }

  setMode(
    sessionId: string,
    mode: "plan" | "build" | "edit" | "yolo" | "guarded" | "auto",
  ): Promise<void> {
    return setSessionMode(this.client, sessionId, mode);
  }

  sendPrompt(sessionId: string, content: string, model?: ModelSelection): Promise<void> {
    return sendPrompt(this.client, sessionId, content, model);
  }

  waitForTurnOutcome(sessionId: string, timeoutMs: number): Promise<TurnOutcome> {
    return waitForTurnOutcome(this.client, sessionId, timeoutMs);
  }

  async close(): Promise<void> {
    await this.client.stop();
  }
}
