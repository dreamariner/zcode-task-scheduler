/**
 * 投递节流闸的判定逻辑（纯函数，便于单测）。
 *
 * 桌面端调度器没有并发闸：它一次认领所有到期任务并全部派发。所以闸门必须控制
 * 「任务何时处于到期状态」——桌面端只认领 next_run_at 已到的任务，闸门批准谁，
 * 谁才允许处于到期状态。
 *
 * 三条规则：
 * 1. 全局同时在投不超过 maxConcurrent 个；其余任务排队等待。
 * 2. 同一会话的任务严格按登记顺序投递：前一条没结束，后一条不得到期。
 * 3. 预置停放：临近到期的任务在到期前就被推到未来，桌面端认领不到；
 *    闸门批准后才把它放回到期状态。这样桌面端一轮认领最多只能拿到闸门放行的那些。
 */

/** 闸门看到的一条任务（最小字段集）。 */
export interface GateTask {
  automationId: string;
  /** 目标会话；新建会话型任务没有会话 id，每条自成一组。 */
  targetSessionId: string | null;
  /** 登记时间，同会话内的顺序依据。 */
  createdAt: number;
  /** 意图执行时刻（闸门按 cron 或一次性锚点算出的真实排期）；null 表示没有排期。 */
  intendedAt: number | null;
  /** 回合未终结＝在投中。 */
  running: boolean;
  /** 闸门已放行、桌面端尚未认领（放行后到认领之间的空窗）。 */
  released: boolean;
  enabled: boolean;
  /** 终态任务（已完成/已失败）不再投递。 */
  finished: boolean;
}

export interface GateOptions {
  now: number;
  /** 全局同时在投上限。 */
  maxConcurrent: number;
  /**
   * 临近到期的任务提前多久停放（毫秒）。
   * 要明显大于桌面端的认领轮询间隔（官方 20 秒），否则停放动作没来得及生效，
   * 任务就被桌面端认领走了。
   */
  preParkMs: number;
  /**
   * 被停放的任务推到多久之后（毫秒）。闸门每轮重新判定，所以这个值只要大于
   * 一轮轮询间隔即可；到期前闸门会再次放行或继续停放。
   */
  holdMs: number;
}

export interface GateDecision {
  /** 本轮批准投递的任务（放回到期状态）。 */
  release: string[];
  /** 被停放的任务（推到未来，等槽位）。 */
  park: string[];
  /** 恢复真实排期的任务（离到期还远，把 next_run_at 还原回意图时刻）。 */
  restore: string[];
  /** 当前在投数量。 */
  inFlight: number;
  /** 排队等待的任务数。 */
  waiting: number;
}

/** 分组键：同会话的任务是一组；新建会话型任务各自独立（它们会各建各的会话）。 */
function groupKeyOf(task: GateTask): string {
  return task.targetSessionId ? `session:${task.targetSessionId}` : `new:${task.automationId}`;
}

/**
 * 算一轮节流决策。
 *
 * 判定顺序：
 * 1. 在投 = 回合未终结的任务，加上闸门刚放行还没被桌面端认领的（空窗期也算占用槽位）；
 * 2. 临近到期（intendedAt <= now + preParkMs）的任务进入判定；
 * 3. 同会话一组，组内按登记顺序只有队首可投；组内有在投任务时整组不可投；
 * 4. 剩余槽位按登记顺序分配给各组队首；
 * 5. 其余临近到期的任务停放到未来，离到期还远的还原回真实排期。
 */
export function computeGate(tasks: GateTask[], options: GateOptions): GateDecision {
  const { now, maxConcurrent, preParkMs, holdMs } = options;

  const active = tasks.filter((task) => task.enabled && !task.finished);
  const inFlightTasks = active.filter((task) => task.running || task.released);
  const inFlight = inFlightTasks.length;

  // 同会话分组：组内按登记顺序排队。
  const groups = new Map<string, GateTask[]>();
  for (const task of active) {
    if (task.running || task.released) continue;
    if (task.intendedAt === null) continue;
    if (task.intendedAt > now + preParkMs) continue;
    const key = groupKeyOf(task);
    const list = groups.get(key);
    if (list) list.push(task);
    else groups.set(key, [task]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || a.automationId.localeCompare(b.automationId));
  }

  // 组内有在投任务时，整组排队（等前一条结束）。
  const busyGroups = new Set<string>();
  for (const task of inFlightTasks) {
    busyGroups.add(groupKeyOf(task));
  }

  const eligible: GateTask[] = [];
  for (const [key, list] of groups) {
    if (busyGroups.has(key)) continue;
    eligible.push(list[0]!);
  }
  // 跨会话按登记顺序分配槽位，先登先得。
  eligible.sort((a, b) => a.createdAt - b.createdAt || a.automationId.localeCompare(b.automationId));

  const slots = Math.max(0, maxConcurrent - inFlight);
  const release = eligible.slice(0, slots).map((task) => task.automationId);
  const releaseSet = new Set(release);

  const park: string[] = [];
  const restore: string[] = [];
  for (const task of active) {
    if (task.running || task.released) continue;
    if (task.intendedAt === null) continue;
    if (releaseSet.has(task.automationId)) continue;
    if (task.intendedAt <= now + preParkMs) {
      // 临近到期但没排上：停放到未来，等槽位空出来。
      park.push(task.automationId);
    } else {
      // 离到期还远：还原成真实排期，桌面端到点自然认领（不影响节流）。
      restore.push(task.automationId);
    }
  }

  return {
    release,
    park,
    restore,
    inFlight,
    waiting: park.length,
  };
}

/** 被停放的任务应推到的时刻。 */
export function holdUntil(now: number, holdMs: number): number {
  return now + holdMs;
}
