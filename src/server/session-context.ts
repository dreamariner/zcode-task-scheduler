/**
 * 从工具调用的请求 `_meta` 里提取当前会话与工作区上下文。
 *
 * 宿主每次调 MCP 工具都会带 `_meta`（见官方源码 adapters/src/mcp/index.ts 的
 * mcpRequestMeta）：顶层与 `com.zcode/request-context` 下都有 `session_id`、
 * `workspace_path` 等键。会话内派任务（add_job_here）靠它拿到「这个会话」的 id，
 * 模型与指令本身都无从得知自己的会话 id。
 */

export interface ToolCallContext {
  sessionId?: string;
  workspacePath?: string;
  workspaceKey?: string;
}

interface RequestMetaShape {
  session_id?: unknown;
  workspace_path?: unknown;
  workspace_key?: unknown;
  "com.zcode/request-context"?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readContext(meta: RequestMetaShape | undefined): ToolCallContext {
  if (!meta || typeof meta !== "object") return {};
  // 两处等价：优先嵌套的 request-context（字段更全），缺失时回退顶层键。
  const nested = meta["com.zcode/request-context"];
  const source: RequestMetaShape =
    nested && typeof nested === "object" ? (nested as RequestMetaShape) : meta;
  const sessionId = asString(source.session_id) ?? asString(meta.session_id);
  const workspacePath = asString(source.workspace_path) ?? asString(meta.workspace_path);
  const workspaceKey = asString(source.workspace_key) ?? asString(meta.workspace_key);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceKey ? { workspaceKey } : {}),
  };
}

/** 兼容两处形态的 _meta（直接对象或包在 params 里），提取会话上下文。 */
export function toolCallContextOf(meta: unknown): ToolCallContext {
  if (!meta || typeof meta !== "object") return {};
  return readContext(meta as RequestMetaShape);
}

/** 会话内派任务的硬前提：没有会话上下文就明确报错，不猜。 */
export function requireSessionId(meta: unknown): string {
  const context = toolCallContextOf(meta);
  if (!context.sessionId) {
    throw new Error(
      "取不到当前会话 id（工具调用没有带 _meta.session_id）：这个工具只能在会话内使用",
    );
  }
  return context.sessionId;
}
