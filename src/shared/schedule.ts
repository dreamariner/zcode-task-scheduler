import type { Schedule } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 取某天零点起的毫秒偏移对应的绝对时刻。 */
function atTimeOfDay(dayStart: number, timeOfDay: number): number {
  return dayStart + timeOfDay;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 计算下一次执行时刻。
 *
 * 一次性任务返回固定时刻（即便已经过去，交给调度器按「错过窗口」规则处置，
 * 不在这里悄悄丢掉用户登记的任务）；每天与每周的任务从「从 from 起的当天」
 * 开始找，找不到就顺延到下一天。
 */
export function nextRunAt(schedule: Schedule, from: number): number | null {
  if (schedule.kind === "once") {
    return schedule.runAt;
  }

  const today = startOfDay(from);

  if (schedule.kind === "daily") {
    const candidate = atTimeOfDay(today, schedule.timeOfDay);
    return candidate > from ? candidate : atTimeOfDay(today + DAY_MS, schedule.timeOfDay);
  }

  const weekdays = schedule.weekdays.length > 0 ? schedule.weekdays : [0];
  for (let offset = 0; offset <= 7; offset += 1) {
    const dayStart = today + offset * DAY_MS;
    const weekday = new Date(dayStart).getDay();
    if (!weekdays.includes(weekday)) continue;
    const candidate = atTimeOfDay(dayStart, schedule.timeOfDay);
    if (candidate > from) return candidate;
  }
  return null;
}

/** 把「每天 HH:MM」这种输入解析成当天零点起的毫秒偏移。 */
export function timeOfDayFromClock(hour: number, minute: number): number {
  const h = Math.min(23, Math.max(0, Math.trunc(hour)));
  const m = Math.min(59, Math.max(0, Math.trunc(minute)));
  return h * 60 * 60 * 1000 + m * 60 * 1000;
}

/** 把毫秒偏移格式化成 HH:MM。 */
export function formatTimeOfDay(timeOfDay: number): string {
  const total = Math.max(0, Math.trunc(timeOfDay));
  const hour = Math.floor(total / (60 * 60 * 1000));
  const minute = Math.floor((total % (60 * 60 * 1000)) / (60 * 1000));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
