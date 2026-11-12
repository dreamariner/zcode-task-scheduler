import { describe, expect, it } from "vitest";
import { computeGate, holdUntil, type GateTask } from "../src/gate/gate.js";
import { MAX_CONCURRENT, PRE_PARK_MS } from "../src/gate/runner.js";

const NOW = 1_700_000_000_000;
const OPTIONS = { now: NOW, maxConcurrent: 3, preParkMs: PRE_PARK_MS, holdMs: 60_000 };

function task(overrides: Partial<GateTask> & { automationId: string }): GateTask {
  return {
    targetSessionId: null,
    createdAt: NOW,
    intendedAt: NOW,
    running: false,
    released: false,
    enabled: true,
    finished: false,
    ...overrides,
  };
}

describe("节流闸判定", () => {
  it("全局最多放行 3 条，其余停放", () => {
    const tasks = ["a", "b", "c", "d", "e"].map((id, index) =>
      task({ automationId: id, createdAt: NOW + index }),
    );
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.release).toEqual(["a", "b", "c"]);
    expect(decision.park).toEqual(["d", "e"]);
    expect(decision.waiting).toBe(2);
    expect(decision.inFlight).toBe(0);
  });

  it("在投的任务占槽位", () => {
    const tasks = [
      task({ automationId: "running", running: true }),
      task({ automationId: "b", createdAt: NOW + 1 }),
      task({ automationId: "c", createdAt: NOW + 2 }),
      task({ automationId: "d", createdAt: NOW + 3 }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.inFlight).toBe(1);
    expect(decision.release).toEqual(["b", "c"]);
    expect(decision.park).toEqual(["d"]);
  });

  it("刚放行还没被桌面端认领的也算占位", () => {
    const tasks = [
      task({ automationId: "released", released: true }),
      task({ automationId: "b", createdAt: NOW + 1 }),
      task({ automationId: "c", createdAt: NOW + 2 }),
      task({ automationId: "d", createdAt: NOW + 3 }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.inFlight).toBe(1);
    expect(decision.release).toEqual(["b", "c"]);
  });

  it("同会话只放行队首，后面的等前一条结束", () => {
    const tasks = [
      task({ automationId: "s1", targetSessionId: "sess_a", createdAt: NOW }),
      task({ automationId: "s2", targetSessionId: "sess_a", createdAt: NOW + 1 }),
      task({ automationId: "s3", targetSessionId: "sess_a", createdAt: NOW + 2 }),
      task({ automationId: "other", targetSessionId: "sess_b", createdAt: NOW + 3 }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.release).toEqual(["s1", "other"]);
    expect(decision.park).toEqual(["s2", "s3"]);
  });

  it("同会话前一条在投时，整组等待", () => {
    const tasks = [
      task({ automationId: "s1", targetSessionId: "sess_a", running: true }),
      task({ automationId: "s2", targetSessionId: "sess_a", createdAt: NOW + 1 }),
      task({ automationId: "other", targetSessionId: "sess_b", createdAt: NOW + 2 }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.release).toEqual(["other"]);
    expect(decision.park).toEqual(["s2"]);
  });

  it("同会话按登记顺序排队，不按到期时间", () => {
    const tasks = [
      task({ automationId: "late", targetSessionId: "sess_a", createdAt: NOW + 10 }),
      task({ automationId: "early", targetSessionId: "sess_a", createdAt: NOW }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.release).toEqual(["early"]);
    expect(decision.park).toEqual(["late"]);
  });

  it("离到期还远的任务还原成真实排期，不参与闸门", () => {
    const tasks = [
      task({ automationId: "far", intendedAt: NOW + 6 * 3_600_000 }),
      task({ automationId: "near", intendedAt: NOW + 30_000, createdAt: NOW + 1 }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.release).toEqual(["near"]);
    expect(decision.park).toEqual([]);
    expect(decision.restore).toEqual(["far"]);
  });

  it("已停用与终态任务不参与判定", () => {
    const tasks = [
      task({ automationId: "off", enabled: false }),
      task({ automationId: "done", finished: true }),
      task({ automationId: "due", createdAt: NOW + 1 }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.release).toEqual(["due"]);
    expect(decision.park).toEqual([]);
  });

  it("新建会话型任务各自独立（不是同一组）", () => {
    const tasks = [
      task({ automationId: "n1", targetSessionId: null, createdAt: NOW }),
      task({ automationId: "n2", targetSessionId: null, createdAt: NOW + 1 }),
    ];
    const decision = computeGate(tasks, OPTIONS);
    expect(decision.release).toEqual(["n1", "n2"]);
  });

  it("并发上限是 3", () => {
    expect(MAX_CONCURRENT).toBe(3);
  });

  it("被停放的任务推到未来的时刻", () => {
    expect(holdUntil(NOW, 90_000)).toBe(NOW + 90_000);
  });
});
