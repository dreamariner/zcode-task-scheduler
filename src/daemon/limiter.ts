/**
 * 限流闸：全局并发上限 + 启动速率 + 相邻启动最小间隔。
 *
 * 准入是串行的（FIFO）：先等速率与间隔，再占并发槽。这样同一时刻只有一个人在
 * 做准入判定，速率与间隔不会被并发进入的申请互相穿透。
 */
export interface LimiterOptions {
  maxConcurrent: number;
  maxStartsPerMinute: number;
  minGapMs: number;
}

const WINDOW_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class Limiter {
  private active = 0;
  private readonly startedAt: number[] = [];
  private lastStartAt: number | null = null;
  private admission: Promise<void> = Promise.resolve();
  private readonly waiters: (() => void)[] = [];

  constructor(
    private options: LimiterOptions,
    private readonly now: () => number = Date.now,
  ) {}

  configure(options: Partial<LimiterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  get activeCount(): number {
    return this.active;
  }

  get recentStartCount(): number {
    this.prune(this.now());
    return this.startedAt.length;
  }

  async acquire(): Promise<void> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.admission;
    this.admission = previous.then(() => turn);
    await previous;
    try {
      await this.waitForRate();
      await this.waitForSlot();
    } finally {
      release();
    }
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  private prune(now: number): void {
    while (this.startedAt.length > 0 && now - (this.startedAt[0] as number) >= WINDOW_MS) {
      this.startedAt.shift();
    }
  }

  private async waitForRate(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.prune(now);
      const windowFull = this.startedAt.length >= this.options.maxStartsPerMinute;
      const gapRemaining =
        this.lastStartAt === null ? 0 : this.lastStartAt + this.options.minGapMs - now;
      if (!windowFull && gapRemaining <= 0) {
        this.startedAt.push(now);
        this.lastStartAt = now;
        return;
      }
      const waitMs = windowFull
        ? Math.max(50, (this.startedAt[0] as number) + WINDOW_MS - now)
        : Math.max(50, gapRemaining);
      await sleep(Math.min(waitMs, 500));
    }
  }

  private async waitForSlot(): Promise<void> {
    while (this.active >= this.options.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.active += 1;
  }
}
