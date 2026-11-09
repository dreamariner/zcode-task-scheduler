import { describe, expect, it } from "vitest";
import { formatTimeOfDay, nextRunAt, timeOfDayFromClock } from "../src/shared/schedule.js";

describe("调度计算", () => {
  it("一次性任务返回固定时刻，过期时刻交给错过窗口规则处置", () => {
    expect(nextRunAt({ kind: "once", runAt: 1_000 }, 500)).toBe(1_000);
    expect(nextRunAt({ kind: "once", runAt: 500 }, 1_000)).toBe(500);
  });

  it("每天任务在当天时刻已过时顺延到明天", () => {
    const base = new Date("2026-11-09T10:00:00").getTime();
    const midnight = new Date("2026-11-09T00:00:00").getTime();
    const timeOfDay = timeOfDayFromClock(0, 30);
    expect(nextRunAt({ kind: "daily", timeOfDay }, base)).toBe(midnight + 24 * 3600_000 + timeOfDay);
    expect(nextRunAt({ kind: "daily", timeOfDay }, midnight)).toBe(midnight + timeOfDay);
  });

  it("每周任务落在指定的星期", () => {
    // 2026-11-09 是周一
    const monday = new Date("2026-11-09T12:00:00").getTime();
    const timeOfDay = timeOfDayFromClock(9, 0);
    const next = nextRunAt({ kind: "weekly", timeOfDay, weekdays: [3] }, monday);
    expect(next).not.toBeNull();
    expect(new Date(next as number).getDay()).toBe(3);
    expect(new Date(next as number).getHours()).toBe(9);
  });

  it("时刻与毫秒偏移互转", () => {
    expect(timeOfDayFromClock(0, 30)).toBe(1_800_000);
    expect(formatTimeOfDay(1_800_000)).toBe("00:30");
    expect(formatTimeOfDay(timeOfDayFromClock(23, 59))).toBe("23:59");
  });
});
