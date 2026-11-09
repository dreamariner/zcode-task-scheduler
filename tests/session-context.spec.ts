import { describe, expect, it } from "vitest";
import { requireSessionId, toolCallContextOf } from "../src/server/session-context.js";

describe("工具调用的会话上下文", () => {
  it("从嵌套的 com.zcode/request-context 取会话与工作区", () => {
    const context = toolCallContextOf({
      "com.zcode/request-context": {
        session_id: "sess_abc",
        workspace_path: "/tmp/ws",
        workspace_key: "ws-1",
      },
    });
    expect(context).toEqual({ sessionId: "sess_abc", workspacePath: "/tmp/ws", workspaceKey: "ws-1" });
  });

  it("缺失嵌套结构时回退顶层键", () => {
    const context = toolCallContextOf({ session_id: "sess_flat", workspace_path: "/tmp/ws" });
    expect(context.sessionId).toBe("sess_flat");
    expect(context.workspacePath).toBe("/tmp/ws");
  });

  it("空值与非法形态安全返回空对象", () => {
    expect(toolCallContextOf(undefined)).toEqual({});
    expect(toolCallContextOf(null)).toEqual({});
    expect(toolCallContextOf("nope")).toEqual({});
    expect(toolCallContextOf({ session_id: "  " })).toEqual({});
    expect(toolCallContextOf({ session_id: 42 })).toEqual({});
  });

  it("requireSessionId 有会话时返回，没有时明确报错", () => {
    expect(requireSessionId({ "com.zcode/request-context": { session_id: "sess_1" } })).toBe("sess_1");
    expect(() => requireSessionId({})).toThrow("_meta.session_id");
    expect(() => requireSessionId(undefined)).toThrow("只能在会话内使用");
  });
});
