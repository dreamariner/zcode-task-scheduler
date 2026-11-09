import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, JobStore } from "../src/daemon/db.js";
import { JobRunner } from "../src/daemon/runner.js";
import type { SessionGateway } from "../src/protocol/gateway.js";
import { TurnTimeoutError, type TurnOutcome, type WorkspaceRef } from "../src/protocol/session.js";
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
  readonly stopped: string[] = [];
  /** waitForTurnOutcome 第 N 次调用抛出的错误，按调用顺序消费。 */
  turnErrors: Error[] = [];
  closed = false;

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

  async readSession(sessionId: string): Promise<{ title: string; status: string; mode?: string }> {
    return { title: `标题-`, status: "completed", mode: "build" };
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    this.modes.push({ sessionId, mode });
  }

  async sendPrompt(sessionId: string, content: string): Promise<void> {
    this.sends.push({ sessionId, content });
  }

  async waitForTurnOutcome(): Promise<TurnOutcome> {
    const error = this.turnErrors.shift();
    if (error) throw error;
    const outcome = this.outcomes.shift();
    return outcome ?? { status: "success" };
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  onClose(_listener: () => void): void {
    // 假实现不需要通知
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
    // 每次尝试前切 yolo，结束后把会话恢复回原来的 build 模式。
    expect(gateway.modes.filter((item) => item.mode === "yolo")).toHaveLength(2);
    expect(gateway.modes[gateway.modes.length - 1]?.mode).toBe("build");
  });

  it("等待终态超时会先停掉回合，再按可重试失败结算", async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway();
    gateway.turnErrors = [new TurnTimeoutError("sess_existing", 30_000)];
    const job = store.addJob(
      {
        title: "超时任务",
        target: { kind: "session", sessionId: "sess_existing" },
        prompt: "跑一次",
        workspacePath: WORKSPACE.workspacePath,
        schedule: { kind: "once", runAt: Date.now() + 60_000 },
        maxAttempts: 3,
      },
      "job_t1",
      Date.now(),
    );

    const runner = new JobRunner({
      store,
      settings: () => ({ ...DEFAULT_SETTINGS, taskTimeoutMs: 30_000 }),
      gatewayFor: () => gateway,
    });

    const outcome = await runner.runOnce(job, 1);
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("turn_timeout");
    expect(outcome.retryable).toBe(true);
    // 不停掉旧回合，重试的 prompt 会被「已有回合在跑」挡住。
    expect(gateway.stopped).toEqual(["sess_existing"]);

    const run = store.listRuns(job.id, 1)[0];
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("turn_timeout");
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
