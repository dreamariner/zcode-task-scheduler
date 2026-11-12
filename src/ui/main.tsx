import { StrictMode, useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: number | null;
}

interface Job {
  automationId: string;
  title: string;
  prompt: string;
  targetSessionId: string | null;
  workspaceKey: string;
  workspacePath: string;
  schedule: { kind: "once" | "daily" | "weekly"; runAt?: number; timeOfDay?: number; weekdays?: number[] };
  enabled: boolean;
  cronExpr: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  lifecycleStatus: string;
  running: boolean;
  dispatchStatus: string;
  runCount: number;
  modelSelection: string | null;
}

interface RunRecord {
  runId: string;
  automationId: string;
  trigger: string;
  outcome: string | null;
  error: string | null;
  sessionId: string | null;
  attempts: number;
  scheduledAt: number | null;
  createdAt: number;
}

interface ConcurrencyInfo {
  max: number;
  inFlight: number;
  waiting: number;
  inFlightTitles: string[];
}

const app = new App(
  { name: "zcode-task-scheduler", version: "0.1.0" },
  { tools: { listChanged: true }, availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: true },
);

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await app.callServerTool({ name, arguments: args });
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured && typeof structured === "object") return structured;
  const text = (result as { content?: { type: string; text?: string }[] }).content?.[0]?.text;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { text };
  }
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "无";
  return new Date(ts).toLocaleString("zh-CN");
}

function formatClock(timeOfDay: number | undefined): string {
  if (timeOfDay === undefined) return "00:30";
  const hour = Math.floor(timeOfDay / 3_600_000);
  const minute = Math.floor((timeOfDay % 3_600_000) / 60_000);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "HH:MM" 转当天毫秒偏移；格式不对返回 null。 */
function parseClock(text: string): number | null {
  const parts = text.split(":").map((part) => Number(part));
  if (parts.length !== 2 || !Number.isInteger(parts[0]) || !Number.isInteger(parts[1])) return null;
  const hour = parts[0] as number;
  const minute = parts[1] as number;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return (hour * 60 + minute) * 60_000;
}

/** 毫秒时间戳转 datetime-local 输入框要的本地时间串。 */
function toLocalInput(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeSchedule(job: Job): string {
  const schedule = job.schedule;
  if (schedule.kind === "once") {
    return schedule.runAt ? `一次性 · ${formatTime(schedule.runAt)}` : "一次性";
  }
  if (schedule.kind === "weekly") {
    const days = (schedule.weekdays ?? []).map((d) => WEEKDAY_NAMES[d] ?? String(d)).join("、");
    return `每周${days || "日"} ${formatClock(schedule.timeOfDay)}`;
  }
  return `每天 ${formatClock(schedule.timeOfDay)}`;
}

function describeTarget(job: Job, sessions: SessionSummary[]): string {
  if (!job.targetSessionId) return "到点时新建会话";
  const session = sessions.find((item) => item.sessionId === job.targetSessionId);
  return `已有会话${session?.title ? `：${session.title}` : `：${job.targetSessionId}`}`;
}

/** 执行模型：桌面端 model_selection 为字面量 "null" 表示跟随工作区首选。 */
function describeModel(job: Job): string {
  if (!job.modelSelection || job.modelSelection === "null") return "跟随会话当前模型";
  try {
    const parsed = JSON.parse(job.modelSelection) as {
      providerId?: string;
      modelId?: string;
      options?: { reasoningLevel?: string };
    };
    const base = `${parsed.providerId ?? ""}/${parsed.modelId ?? ""}`;
    return parsed.options?.reasoningLevel
      ? `${base}（思考 ${parsed.options.reasoningLevel}）`
      : base;
  } catch {
    return "跟随会话当前模型";
  }
}

/** 任务状态徽标：优先用桌面端回写的生命周期与在途状态。 */
function jobStatus(job: Job): { tone: string; text: string } {
  if (!job.enabled) return { tone: "idle", text: "已停用" };
  if (job.lifecycleStatus === "completed") return { tone: "ok", text: "已完成" };
  if (job.lifecycleStatus === "failed") return { tone: "bad", text: "已失败" };
  if (job.running) return { tone: "busy", text: "在投中" };
  if (job.lastRunAt) return { tone: "ok", text: "已执行" };
  return { tone: "idle", text: "待执行" };
}

const RUN_TONE: Record<string, string> = {
  success: "ok",
  succeeded: "ok",
  completed: "ok",
  failed: "bad",
  error: "bad",
  skipped: "warn",
  running: "busy",
  pending: "idle",
};

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 与服务端 add_job 默认一致的模型；编辑框选默认项时显式写回这三个值。 */
const DEFAULT_MODEL_FORM = {
  providerId: "minimax",
  modelId: "MiniMax-M3.1-Flash",
  reasoningLevel: "max",
} as const;

/** 从任务的 model_selection 反推编辑框模型表单的初值。 */
function modelFormInit(job: Job): {
  mode: "minimax" | "follow" | "custom";
  provider: string;
  modelId: string;
  reasoning: string;
} {
  const fallback = { mode: "minimax" as const, provider: "", modelId: "", reasoning: "max" };
  if (!job.modelSelection || job.modelSelection === "null") {
    return { mode: "follow", provider: "", modelId: "", reasoning: "max" };
  }
  try {
    const parsed = JSON.parse(job.modelSelection) as {
      providerId?: string;
      modelId?: string;
      options?: { reasoningLevel?: string };
    };
    const reasoning = parsed.options?.reasoningLevel ?? "max";
    // 与新建表单默认项完全一致才归入默认；否则按指定模型回填，避免保存时静默改值。
    if (
      parsed.providerId === DEFAULT_MODEL_FORM.providerId &&
      parsed.modelId === DEFAULT_MODEL_FORM.modelId &&
      reasoning === DEFAULT_MODEL_FORM.reasoningLevel
    ) {
      return fallback;
    }
    return {
      mode: "custom",
      provider: parsed.providerId ?? "",
      modelId: parsed.modelId ?? "",
      reasoning,
    };
  } catch {
    return fallback;
  }
}

function WeekdayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const toggle = (day: number): void => {
    onChange(value.includes(day) ? value.filter((item) => item !== day) : [...value, day].sort());
  };
  return (
    <div className="chips">
      {WEEKDAY_NAMES.map((name, day) => (
        <button
          key={day}
          type="button"
          className={`chip ${value.includes(day) ? "on" : ""}`}
          onClick={() => toggle(day)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function App_(): JSX.Element {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [concurrency, setConcurrency] = useState<ConcurrencyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [targetKind, setTargetKind] = useState<"session" | "new-session">("session");
  const [sessionId, setSessionId] = useState("");
  const [targetTitle, setTargetTitle] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"once" | "daily" | "weekly">("daily");
  const [runAt, setRunAt] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("00:30");
  const [weekdays, setWeekdays] = useState<number[]>([0]);
  const [modelMode, setModelMode] = useState<"minimax" | "follow" | "custom">("minimax");
  const [modelProvider, setModelProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState("max");

  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editTargetKind, setEditTargetKind] = useState<"session" | "new-session">("session");
  const [editSessionId, setEditSessionId] = useState("");
  const [editKind, setEditKind] = useState<"once" | "daily" | "weekly">("daily");
  const [editRunAt, setEditRunAt] = useState("");
  const [editTime, setEditTime] = useState("00:30");
  const [editWeekdays, setEditWeekdays] = useState<number[]>([0]);
  const [editModelMode, setEditModelMode] = useState<"minimax" | "follow" | "custom">("minimax");
  const [editModelProvider, setEditModelProvider] = useState("");
  const [editModelId, setEditModelId] = useState("");
  const [editReasoningLevel, setEditReasoningLevel] = useState("max");

  const refresh = useCallback(async () => {
    try {
      const [jobResult, sessionResult, statusResult] = await Promise.all([
        callTool("list_jobs") as Promise<{ jobs: Job[]; concurrency?: ConcurrencyInfo }>,
        callTool("list_sessions") as Promise<{ sessions: SessionSummary[] }>,
        callTool("job_status") as Promise<{ runs: RunRecord[]; concurrency?: ConcurrencyInfo }>,
      ]);
      setJobs(jobResult.jobs ?? []);
      setSessions(sessionResult.sessions ?? []);
      setRuns(statusResult.runs ?? []);
      setConcurrency(jobResult.concurrency ?? statusResult.concurrency ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const withBusy = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const submit = useCallback(async () => {
    if (scheduleKind === "once" && !runAt) {
      setError("一次性任务请先选择执行时刻");
      return;
    }
    if (scheduleKind === "weekly" && weekdays.length === 0) {
      setError("每周任务至少选择一天");
      return;
    }
    await withBusy(async () => {
      await callTool("add_job", {
        title: title.trim() || "未命名任务",
        prompt,
        targetKind,
        ...(targetKind === "session" ? { sessionId } : { targetTitle }),
        scheduleKind,
        ...(scheduleKind === "once"
          ? { runAt: new Date(runAt).getTime() }
          : { timeOfDay: parseClock(timeOfDay) ?? 0 }),
        ...(scheduleKind === "weekly" ? { weekdays } : {}),
        ...(modelMode === "follow"
          ? { followSessionModel: true }
          : modelMode === "custom" && modelProvider.trim() && modelId.trim()
            ? {
                model: {
                  providerId: modelProvider.trim(),
                  modelId: modelId.trim(),
                  reasoningLevel: reasoningLevel.trim() || "max",
                },
              }
            : {}),
      });
      setTitle("");
      setPrompt("");
      setRunAt("");
    });
  }, [
    withBusy,
    title,
    prompt,
    targetKind,
    sessionId,
    targetTitle,
    scheduleKind,
    runAt,
    timeOfDay,
    weekdays,
    modelMode,
    modelProvider,
    modelId,
    reasoningLevel,
  ]);

  const startEdit = useCallback((job: Job) => {
    const modelForm = modelFormInit(job);
    setEditingJobId(job.automationId);
    setEditTitle(job.title);
    setEditPrompt(job.prompt);
    setEditTargetKind(job.targetSessionId ? "session" : "new-session");
    setEditSessionId(job.targetSessionId ?? "");
    setEditKind(job.schedule.kind);
    setEditRunAt(
      job.schedule.kind === "once" && job.schedule.runAt ? toLocalInput(job.schedule.runAt) : "",
    );
    setEditTime(formatClock(job.schedule.timeOfDay));
    setEditWeekdays(job.schedule.weekdays ?? [0]);
    setEditModelMode(modelForm.mode);
    setEditModelProvider(modelForm.provider);
    setEditModelId(modelForm.modelId);
    setEditReasoningLevel(modelForm.reasoning);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingJobId) return;
    if (editTargetKind === "session" && !editSessionId) {
      setError("编辑目标请先选择会话");
      return;
    }
    if (!editPrompt.trim()) {
      setError("任务内容不能为空");
      return;
    }
    if (editKind === "once" && !editRunAt) {
      setError("一次性任务请先选择执行时刻");
      return;
    }
    if (editKind === "weekly" && editWeekdays.length === 0) {
      setError("每周任务至少选择一天");
      return;
    }
    if (editModelMode === "custom" && (!editModelProvider.trim() || !editModelId.trim())) {
      setError("指定模型请填写供应商与模型名");
      return;
    }
    await withBusy(async () => {
      await callTool("update_job", {
        jobId: editingJobId,
        title: editTitle.trim() || "未命名任务",
        prompt: editPrompt.trim(),
        targetSessionId: editTargetKind === "session" ? editSessionId : null,
        scheduleKind: editKind,
        ...(editKind === "once" ? { runAt: new Date(editRunAt).getTime() } : {}),
        ...(editKind === "daily" || editKind === "weekly"
          ? { timeOfDay: parseClock(editTime) ?? 0 }
          : {}),
        ...(editKind === "weekly" ? { weekdays: editWeekdays } : {}),
        ...(editModelMode === "follow"
          ? { followSessionModel: true }
          : editModelMode === "custom"
            ? {
                model: {
                  providerId: editModelProvider.trim(),
                  modelId: editModelId.trim(),
                  reasoningLevel: editReasoningLevel.trim() || "max",
                },
              }
            : { model: DEFAULT_MODEL_FORM }),
      });
      setEditingJobId(null);
    });
  }, [
    withBusy,
    editingJobId,
    editTitle,
    editPrompt,
    editTargetKind,
    editSessionId,
    editKind,
    editRunAt,
    editTime,
    editWeekdays,
    editModelMode,
    editModelProvider,
    editModelId,
    editReasoningLevel,
  ]);

  const sessionOptions = useMemo(
    () =>
      sessions.map((session) => ({
        value: session.sessionId,
        label: session.title?.trim() || session.sessionId,
      })),
    [sessions],
  );

  return (
    <div className="panel">
      <header className="panel-head">
        <h1>任务调度</h1>
        <button className="ghost" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </header>

      <div className="daemon-hint">
        {concurrency
          ? `在投 ${concurrency.inFlight}/${concurrency.max}${
              concurrency.waiting > 0 ? `，排队 ${concurrency.waiting}` : ""
            }：任务由桌面端调度器到点投递，最多同时 ${concurrency.max} 条在投，同一会话的任务按登记顺序串行投递。`
          : "任务由桌面端调度器到点投递：最多同时 3 条在投，同一会话的任务按登记顺序串行投递。"}
      </div>

      {error ? <div className="banner error">{error}</div> : null}

      <section className="block">
        <h2>任务清单</h2>
        {jobs.length === 0 ? (
          <p className="empty">还没有登记任务。</p>
        ) : (
          <ul className="jobs">
            {jobs.map((job) => {
              const status = jobStatus(job);
              const editing = editingJobId === job.automationId;
              // 目标会话可能已被删掉（会话清单里没有它）：编辑时把原目标兜底成选项，避免静默换目标。
              const editSessionOptions =
                editing && editSessionId && !sessionOptions.some((option) => option.value === editSessionId)
                  ? [{ value: editSessionId, label: `原目标 ${editSessionId}` }, ...sessionOptions]
                  : sessionOptions;
              return (
                <li key={job.automationId} className="job">
                  <div className="job-row">
                    <span className={`badge ${status.tone}`}>{status.text}</span>
                    <span className="job-title">{job.title}</span>
                  </div>
                  <div className="job-meta">
                    <span>{describeTarget(job, sessions)}</span>
                    <span>{describeSchedule(job)}</span>
                    <span>{describeModel(job)}</span>
                    <span>下次 {formatTime(job.nextRunAt)}</span>
                    <span>已执行 {job.runCount} 次</span>
                  </div>                  {job.lastError ? <div className="job-error">{job.lastError}</div> : null}
                  {editing ? (
                    <div className="edit-box">
                      <label>
                        <span>标题</span>
                        <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                      </label>
                      <label>
                        <span>执行目标</span>
                        <select
                          value={editTargetKind}
                          onChange={(e) => setEditTargetKind(e.target.value as "session" | "new-session")}
                        >
                          <option value="session">已有会话</option>
                          <option value="new-session">新建会话</option>
                        </select>
                      </label>
                      {editTargetKind === "session" ? (
                        <label>
                          <span>会话</span>
                          <select value={editSessionId} onChange={(e) => setEditSessionId(e.target.value)}>
                            <option value="">请选择会话</option>
                            {editSessionOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      <label>
                        <span>任务内容</span>
                        <textarea
                          value={editPrompt}
                          onChange={(e) => setEditPrompt(e.target.value)}
                          rows={4}
                        />
                      </label>
                      <label>
                        <span>重复</span>
                        <select
                          value={editKind}
                          onChange={(e) => setEditKind(e.target.value as "once" | "daily" | "weekly")}
                        >
                          <option value="once">仅一次</option>
                          <option value="daily">每天</option>
                          <option value="weekly">每周</option>
                        </select>
                      </label>
                      {editKind === "once" ? (
                        <label>
                          <span>执行时刻</span>
                          <input
                            type="datetime-local"
                            value={editRunAt}
                            onChange={(e) => setEditRunAt(e.target.value)}
                          />
                        </label>
                      ) : (
                        <label>
                          <span>执行时刻</span>
                          <input
                            type="time"
                            value={editTime}
                            onChange={(e) => setEditTime(e.target.value)}
                          />
                        </label>
                      )}
                      {editKind === "weekly" ? (
                        <WeekdayPicker value={editWeekdays} onChange={setEditWeekdays} />
                      ) : null}
                      <label>
                        <span>执行模型</span>
                        <select
                          value={editModelMode}
                          onChange={(e) => setEditModelMode(e.target.value as "minimax" | "follow" | "custom")}
                        >
                          <option value="minimax">MiniMax M3.1 Flash（默认，全天可用）</option>
                          <option value="follow">跟随会话当前模型</option>
                          <option value="custom">指定模型</option>
                        </select>
                      </label>
                      {editModelMode === "custom" ? (
                        <div className="settings-grid">
                          <label>
                            <span>供应商</span>
                            <input
                              value={editModelProvider}
                              onChange={(e) => setEditModelProvider(e.target.value)}
                              placeholder="account:bigmodel-start-plan"
                            />
                          </label>
                          <label>
                            <span>模型</span>
                            <input
                              value={editModelId}
                              onChange={(e) => setEditModelId(e.target.value)}
                              placeholder="GLM-5.3-Flash"
                            />
                          </label>
                          <label>
                            <span>思考档位</span>
                            <input
                              value={editReasoningLevel}
                              onChange={(e) => setEditReasoningLevel(e.target.value)}
                              placeholder="max"
                            />
                          </label>
                        </div>
                      ) : null}
                      <div className="job-actions">
                        <button className="primary" disabled={busy} onClick={() => void saveEdit()}>
                          保存
                        </button>
                        <button className="ghost" disabled={busy} onClick={() => setEditingJobId(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="job-actions">
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          void withBusy(() =>
                            callTool("run_now", { jobId: job.automationId }),
                          )
                        }
                      >
                        立即执行
                      </button>
                      <button className="ghost" disabled={busy} onClick={() => startEdit(job)}>
                        编辑
                      </button>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          void withBusy(() =>
                            callTool("update_job", {
                              jobId: job.automationId,
                              enabled: !job.enabled,
                            }),
                          )
                        }
                      >
                        {job.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        className="ghost danger"
                        disabled={busy}
                        onClick={() =>
                          void withBusy(() =>
                            callTool("remove_job", { jobId: job.automationId }),
                          )
                        }
                      >
                        删除
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="block">
        <h2>新建任务</h2>
        <label>
          <span>标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="定时巡检" />
        </label>

        <label>
          <span>执行目标</span>
          <select
            value={targetKind}
            onChange={(e) => setTargetKind(e.target.value as "session" | "new-session")}
          >
            <option value="session">已有会话</option>
            <option value="new-session">新建会话</option>
          </select>
        </label>

        {targetKind === "session" ? (
          <label>
            <span>会话</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">请选择会话</option>
              {sessionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            <span>新会话标题</span>
            <input
              value={targetTitle}
              onChange={(e) => setTargetTitle(e.target.value)}
              placeholder="定时巡检报告"
            />
          </label>
        )}

        <label>
          <span>任务内容</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述要完成的最终工作，直接写清楚要做什么。"
            rows={4}
          />
        </label>

        <label>
          <span>重复</span>
          <select
            value={scheduleKind}
            onChange={(e) => setScheduleKind(e.target.value as "once" | "daily" | "weekly")}
          >
            <option value="once">仅一次</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </select>
        </label>

        {scheduleKind === "once" ? (
          <label>
            <span>执行时刻</span>
            <input
              type="datetime-local"
              value={runAt}
              onChange={(e) => setRunAt(e.target.value)}
            />
          </label>
        ) : (
          <label>
            <span>执行时刻</span>
            <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
          </label>
        )}

        {scheduleKind === "weekly" ? (
          <WeekdayPicker value={weekdays} onChange={setWeekdays} />
        ) : null}

        <label>
          <span>执行模型</span>
          <select
            value={modelMode}
            onChange={(e) => setModelMode(e.target.value as "minimax" | "follow" | "custom")}
          >
            <option value="minimax">MiniMax M3.1 Flash（默认，全天可用）</option>
            <option value="follow">跟随会话当前模型</option>
            <option value="custom">指定模型</option>
          </select>
        </label>

        {modelMode === "custom" ? (
          <>
            <div className="settings-grid">
              <label>
                <span>供应商</span>
                <input
                  value={modelProvider}
                  onChange={(e) => setModelProvider(e.target.value)}
                  placeholder="account:bigmodel-start-plan"
                />
              </label>
              <label>
                <span>模型</span>
                <input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="GLM-5.3-Flash"
                />
              </label>
              <label>
                <span>思考档位</span>
                <input
                  value={reasoningLevel}
                  onChange={(e) => setReasoningLevel(e.target.value)}
                  placeholder="max"
                />
              </label>
            </div>
            <p className="hint">
              订阅账号套餐（如 account:bigmodel-start-plan）只在套餐覆盖的时段可用，
              白天指定会失败；思考档位必填，桌面端派发前会校验。
            </p>
          </>
        ) : (
          <p className="hint">
            {modelMode === "minimax"
              ? "默认用 MiniMax M3.1 Flash：全天可用的常规模型。"
              : "跟随会话当前选的模型；若会话里选的是夜间套餐，白天执行会失败。"}
          </p>
        )}

        <button
          className="primary"
          disabled={busy || !prompt.trim() || (targetKind === "session" && !sessionId)}
          onClick={() => void submit()}
        >
          登记
        </button>
      </section>

      <section className="block">
        <h2>运行日志</h2>
        {runs.length === 0 ? (
          <p className="empty">还没有运行记录。</p>
        ) : (
          <ul className="runs">
            {runs.slice(0, 30).map((run) => (
              <li key={run.runId}>
                <span className={`badge ${RUN_TONE[run.outcome ?? ""] ?? "idle"}`}>
                  {run.outcome ?? "进行中"}
                </span>
                <span className="run-meta">
                  {run.trigger === "manual" ? "立即执行" : "定时"} · {formatTime(run.scheduledAt ?? run.createdAt)}
                </span>
                {run.error ? <span className="job-error">{run.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("找不到挂载点");
  await app.connect();
  createRoot(root).render(
    <StrictMode>
      <App_ />
    </StrictMode>,
  );
}

void bootstrap().catch((error) => {
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `面板初始化失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
