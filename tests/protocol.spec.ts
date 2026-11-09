import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProtocolClient, ProtocolRequestError } from "../src/protocol/client.js";
import { listModels } from "../src/protocol/session.js";

function fakeLaunch(script: unknown[]): { command: string; args: string[]; source: string } {
  const dir = mkdtempSync(join(tmpdir(), "zts-proto-"));
  const scriptFile = join(dir, "script.jsonl");
  writeFileSync(scriptFile, script.map((item) => JSON.stringify(item)).join("\n"));
  const fake = join(dir, "fake-app-server.mjs");
  writeFileSync(
    fake,
    `import { createInterface } from "node:readline";
const { readFileSync } = await import("node:fs");
const script = readFileSync(${JSON.stringify(scriptFile)}, "utf8").split("\\n").map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const index = script.findIndex(item => item.method === message.method);
  if (index < 0) { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "no fake" } }) + "\\n"); continue; }
  const entry = script.splice(index, 1)[0];
  if (entry.error) { process.stdout.write(JSON.stringify({ id: message.id, error: entry.error }) + "\\n"); }
  else { process.stdout.write(JSON.stringify({ id: message.id, result: entry.result ?? {} }) + "\\n"); }
  if (entry.push) process.stdout.write(JSON.stringify(entry.push) + "\\n");
}
`,
  );
  return { command: process.execPath, args: [fake], source: "测试" };
}

describe("ZCode Protocol 客户端", () => {
  it("按 NDJSON 发送请求并取回 result", async () => {
    const launch = fakeLaunch([{ method: "session/list", result: { sessions: [{ sessionId: "s1" }] } }]);
    const client = ProtocolClient.start({ launch });
    try {
      const result = await client.request<{ sessions: { sessionId: string }[] }>("session/list", {
        workspace: { workspaceKey: "/tmp", workspacePath: "/tmp" },
      });
      expect(result.sessions[0]?.sessionId).toBe("s1");
    } finally {
      await client.stop();
    }
  });

  it("服务端返回 error 时拒绝该请求", async () => {
    const launch = fakeLaunch([
      { method: "session/send", error: { code: -32010, message: "A prompt is already running for this session" } },
    ]);
    const client = ProtocolClient.start({ launch });
    try {
      await expect(client.request("session/send", {})).rejects.toBeInstanceOf(ProtocolRequestError);
    } finally {
      await client.stop();
    }
  });

  it("应答服务端反向请求", async () => {
    const launch = fakeLaunch([
      { method: "session/send", result: { accepted: true } },
      {
        method: "session/send",
        result: { accepted: true },
        push: { id: "server-1", method: "interaction/requestPermission", params: { toolName: "Bash" } },
      },
    ]);
    const client = ProtocolClient.start({ launch });
    const answered: unknown[] = [];
    client.onServerRequest("interaction/requestPermission", (params) => {
      answered.push(params);
      return { decision: "allow" };
    });
    try {
      await client.request("session/send", {});
      await client.request("session/send", {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(answered).toHaveLength(1);
      expect((answered[0] as { toolName: string }).toolName).toBe("Bash");
    } finally {
      await client.stop();
    }
  });

  it("把服务端推送的事件转发出去", async () => {
    const launch = fakeLaunch([
      {
        method: "session/send",
        result: { accepted: true },
        push: {
          method: "v4/telemetry/event",
          params: { kind: "turn.terminal", sessionId: "s1", status: "success" },
        },
      },
    ]);
    const client = ProtocolClient.start({ launch });
    const events: { method: string; params: unknown }[] = [];
    client.on("event", (event: { method: string; params: unknown }) => events.push(event));
    try {
      await client.request("session/send", {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events[0]?.method).toBe("v4/telemetry/event");
      expect((events[0]?.params as { status: string }).status).toBe("success");
    } finally {
      await client.stop();
    }
  });

  it("listModels 从最近会话的 resume 快照取模型目录", async () => {
    const launch = fakeLaunch([
      {
        method: "session/list",
        result: {
          sessions: [
            { sessionId: "s1", title: "最近", status: "completed", updatedAt: 200, createdAt: 1 },
            { sessionId: "s2", title: "更旧", status: "completed", updatedAt: 100, createdAt: 1 },
          ],
        },
      },
      {
        method: "session/resume",
        result: {
          settings: {
            model: {
              current: { providerId: "p1", modelId: "m1" },
              available: [
                {
                  ref: { providerId: "p1", modelId: "m1" },
                  label: "模型一",
                  providerLabel: "供应商一",
                  reasoning: { levels: [{ label: "高", value: "high" }, { label: "低", value: "low" }], defaultLevel: "high" },
                },
                {
                  ref: { providerId: "p2", modelId: "m2" },
                  label: "模型二",
                  disabledReason: "额度不足",
                },
                { ref: {}, label: "坏条目" },
              ],
            },
          },
        },
      },
    ]);
    const client = ProtocolClient.start({ launch });
    try {
      const models = await listModels(client, {
        workspaceKey: "/tmp",
        workspacePath: "/tmp",
      });
      // 坏条目被丢弃，不解析成半残对象。
      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        providerId: "p1",
        modelId: "m1",
        label: "模型一",
        providerLabel: "供应商一",
        reasoningLevels: ["high", "low"],
        reasoningDefault: "high",
      });
      expect(models[1]?.disabledReason).toBe("额度不足");
      expect(models[1]?.reasoningLevels).toEqual([]);
    } finally {
      await client.stop();
    }
  });

  it("listModels 在工作区没有会话时建临时会话取目录再关掉", async () => {
    const launch = fakeLaunch([
      { method: "session/list", result: { sessions: [] } },
      { method: "session/create", result: { session: { sessionId: "s_temp" } } },
      {
        method: "session/resume",
        result: {
          settings: {
            model: {
              available: [{ ref: { providerId: "p1", modelId: "m1" }, label: "模型一" }],
            },
          },
        },
      },
      { method: "session/close", result: {} },
    ]);
    const client = ProtocolClient.start({ launch });
    try {
      const models = await listModels(client, {
        workspaceKey: "/tmp",
        workspacePath: "/tmp",
      });
      expect(models).toHaveLength(1);
      expect(models[0]?.modelId).toBe("m1");
    } finally {
      await client.stop();
    }
  });
});
