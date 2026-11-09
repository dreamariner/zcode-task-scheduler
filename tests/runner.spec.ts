import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, JobStore } from "../src/daemon/db.js";
import { JobRunner } from "../src/daemon/runner.js";
import type { SessionGateway } from "../src/protocol/gateway.js";
import type { TurnOutcome, WorkspaceRef } from "../src/protocol/session.js";
import { DEFAULT_SETTINGS } from "../src/shared/types.js";

interface SendRecord {
  sessionId: string;
  content: string;
}

class FakeGateway implements SessionGateway {
  readonly sends: SendRecord[] = [];
  readonly resumed: string[] = [];
  readonly modes: { sessionId: string; mode: string }[] = [];
  readonly createdSessions: string[] = [];
  outcomes: TurnOutcome[] = [];

  async listSessions(): Promise<[]> {
    return [];
  }

  async createSession(_workspace: WorkspaceRef, options: { title?: string } = {}): Promise<string> {
    const sessionId = `sess_new_${this.createdSessions.length + 1}`;
    this.createdSessions.push(sessionId);
    return sessionId;
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.resumed.push(sessionId);
  }

  async readSession(sessionId: string): Promise<{ title: string; status: string }> {
    return { title: `标题-`, status: "completed" };
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    this.modes.push({ sessionId, mode });
  }

  async sendPrompt(sessionId: string, content: string): Promise<void> {
    this.sends.push({ sessionId, content });
  }

  async waitForTurnOutcome(): Promise<TurnOutcome> {
    const outcome = this.outcomes.shift();
    return outcome ?? { status: "success" };
  }

  async close(): Promise<void> {}
}

function makeStore(): { store: JobStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zts-runner-"));
  const store = new JobStore(openDatabase(join(dir, "state.db")));
  return { store, dir };
}

const WORKSPACE = { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" };

describe("任务执行器", () => {
  it("失败后重试回到同一个会话，并带上续跑提示", async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway();
    gateway.outcomes = [
      { status: "failed", errorCode: "network_error", errorMessage: "连接被重置", errorRetryable: true },
      { status: "success", tokens: 120 },
    ];
    const job = store.addJob(
      {
        title: "巡检",
        target: { kind: "session", sessionId: "sess_existing" },
        prompt: "跑一次巡检",
        workspacePath: WORKSPACE.workspacePath,
        schedule: { kind: "once", runAt: Date.now() + 60_000 },
        maxAttempts: 3,
      },
      "job_1",
      Date.now(),
    );

    const runner = new JobRunner({
      store,
      settings: () => DEFAULT_SETTINGS,
      gatewayFor: () => gateway,
    });

    const first = await runner.runOnce(job, 1);
    expect(first.status).toBe("failed");
    expect(first.retryable).toBe(true);

    const second = await runner.runOnce(job, 2);
    expect(second.status).toBe("succeeded");

    expect(gateway.sends).toHaveLength(2);
    expect(gateway.sends[0]?.sessionId).toBe("sess_existing");
    expect(gateway.sends[1]?.sessionId).toBe("sess_existing");
    expect(gateway.sends[1]?.content).toContain("连接被重置");
    expect(gateway.sends[1]?.content).toContain("跑一次巡检");
    expect(gateway.sends[1]?.content).toContain("请从中断处继续");
    expect(gateway.modes.every((item) => item.mode === "yolo")).toBe(true);
  });

  it("新建会话类型的任务只建一次会话，重试复用同一个", async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway();
    gateway.outcomes = [
      { status: "failed", errorCode: "rate_limit", errorMessage: "429", errorRetryable: true },
      { status: "success" },
    ];
    const job = store.addJob(
      {
        title: "新建会话任务",
        target: { kind: "new-session", title: "夜间报告" },
        prompt: "写报告",
        workspacePath: WORKSPACE.workspacePath,
        schedule: { kind: "once", runAt: Date.now() + 60_000 },
        maxAttempts: 3,
      },
      "job_2",
      Date.now(),
    );

    const runner = new JobRunner({
      store,
      settings: () => DEFAULT_SETTINGS,
      gatewayFor: () => gateway,
    });

    await runner.runOnce(job, 1);
    await runner.runOnce(job, 2);

    expect(gateway.createdSessions).toHaveLength(1);
    expect(gateway.sends[0]?.sessionId).toBe("sess_new_1");
    expect(gateway.sends[1]?.sessionId).toBe("sess_new_1");
    expect(store.getBoundSession("job_2")).toBe("sess_new_1");
  });

  it("不可重试的失败不做续跑", async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway();
    gateway.outcomes = [
      { status: "failed", errorCode: "invalid_model_request", errorMessage: "模型不可用" },
    ];
    const job = store.addJob(
      {
        title: "配置错误任务",
        target: { kind: "session", sessionId: "sess_existing" },
        prompt: "跑一次",
        workspacePath: WORKSPACE.workspacePath,
        schedule: { kind: "once", runAt: Date.now() + 60_000 },
        maxAttempts: 3,
      },
      "job_3",
      Date.now(),
    );

    const runner = new JobRunner({
      store,
      settings: () => DEFAULT_SETTINGS,
      gatewayFor: () => gateway,
    });

    const outcome = await runner.runOnce(job, 1);
    expect(outcome.retryable).toBe(false);
  });
});
