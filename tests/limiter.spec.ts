import { describe, expect, it } from "vitest";
import { Limiter } from "../src/daemon/limiter.js";

describe("限流闸", () => {
  it("并发不超过上限", async () => {
    const limiter = new Limiter(
      { maxConcurrent: 3, maxStartsPerMinute: 1000, minGapMs: 0 },
      () => Date.now(),
    );
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 9 }, () =>
      (async () => {
        await limiter.acquire();
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        limiter.release();
      })(),
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3);
  });

  it("相邻启动之间保持最小间隔", async () => {
    const limiter = new Limiter(
      { maxConcurrent: 3, maxStartsPerMinute: 1000, minGapMs: 60 },
      () => Date.now(),
    );
    const startTimes: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await limiter.acquire();
        startTimes.push(Date.now());
        limiter.release();
      }),
    );
    startTimes.sort((a, b) => a - b);
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(55);
    expect(startTimes[2]! - startTimes[1]!).toBeGreaterThanOrEqual(55);
  });

  it("每分钟启动数不超过上限", async () => {
    let clock = 5_000_000;
    const limiter = new Limiter(
      { maxConcurrent: 10, maxStartsPerMinute: 2, minGapMs: 0 },
      () => clock,
    );
    for (let index = 0; index < 2; index += 1) {
      await limiter.acquire();
      limiter.release();
    }
    const third = limiter.acquire();
    // 第三个必须等窗口腾出，测试里推进时钟即可放行。
    setTimeout(() => {
      clock += 60_001;
    }, 20);
    await third;
    limiter.release();
    expect(limiter.recentStartCount).toBeLessThanOrEqual(2);
  });

  it("并发闸在拿到槽位之前不会占用并发名额", async () => {
    const limiter = new Limiter(
      { maxConcurrent: 1, maxStartsPerMinute: 1000, minGapMs: 0 },
      () => Date.now(),
    );
    await limiter.acquire();
    let secondAcquired = false;
    const second = limiter.acquire().then(() => {
      secondAcquired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondAcquired).toBe(false);
    limiter.release();
    await second;
    expect(secondAcquired).toBe(true);
    limiter.release();
  });
});
