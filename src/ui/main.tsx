import { StrictMode, useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";

interface SessionSummary {
  sessionId: string;
  title: string;
  status: string;
  updatedAt: number | null;
}

interface Job {
  id: string;
  title: string;
  target: { kind: "session" | "new-session"; sessionId?: string; title?: string; label?: string };
  prompt: string;
  schedule: { kind: "once" | "daily" | "weekly"; runAt?: number; timeOfDay?: number; weekdays?: number[] };
  enabled: boolean;
  maxAttempts: number;
  nextRunAt: number | null;
  lastStatus: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

interface RunRecord {
  id: number;
  jobId: string;
  attempt: number;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface Settings {
  defaultTimeOfDay: number;
  maxConcurrent: number;
  maxStartsPerMinute: number;
  minGapMs: number;
  taskTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  model: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
}

interface DaemonStatusInfo {
  pid: number;
  startedAt: number;
  launchSource: string;
  busyJobIds: string[];
  activeSlots: number;
  recentStarts: number;
}

interface ModelEntry {
  providerId: string;
  modelId: string;
  label: string;
  providerLabel?: string;
  reasoningLevels: string[];
  reasoningDefault?: string;
  disabledReason?: string;
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
    const days = (schedule.weekdays ?? [])
      .map((d) => WEEKDAY_NAMES[d] ?? String(d))
      .join("、");
    return `每周${days || "日"} ${formatClock(schedule.timeOfDay)}`;
  }
  return `每天 ${formatClock(schedule.timeOfDay)}`;
}

function describeTarget(job: Job, sessions: SessionSummary[]): string {
  if (job.target.kind === "new-session") {
    return `新建会话${job.target.title ? `：${job.target.title}` : ""}`;
  }
  const session = sessions.find((item) => item.sessionId === job.target.sessionId);
  return `已有会话${session?.title ? `：${session.title}` : `：${job.target.sessionId}`}`;
}

const STATUS_TONE: Record<string, string> = {
  succeeded: "ok",
  failed: "bad",
  retrying: "warn",
  running: "busy",
  scheduled: "idle",
  disabled: "idle",
};

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"] as const;

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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatusInfo | null>(null);
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

  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<"once" | "daily" | "weekly">("daily");
  const [editRunAt, setEditRunAt] = useState("");
  const [editTime, setEditTime] = useState("00:30");
  const [editWeekdays, setEditWeekdays] = useState<number[]>([0]);

  const refresh = useCallback(async () => {
    try {
      const [jobResult, sessionResult, statusResult, settingResult, modelResult, daemonResult] =
        await Promise.all([
          callTool("list_jobs") as Promise<{ jobs: Job[] }>,
          callTool("list_sessions") as Promise<{ sessions: SessionSummary[] }>,
          callTool("job_status") as Promise<{ runs: RunRecord[] }>,
          callTool("get_settings") as Promise<{ settings: Settings }>,
          callTool("list_models")
            .then((result) => (result as { models?: ModelEntry[] }).models ?? [])
            .catch(() => []),
          callTool("daemon_status")
            .then((result) => (result as { status?: DaemonStatusInfo }).status ?? null)
            .catch(() => null),
        ]);
      setJobs(jobResult.jobs ?? []);
      setSessions(sessionResult.sessions ?? []);
      setRuns(statusResult.runs ?? []);
      setSettings(settingResult.settings);
      setModels(modelResult);
      setDaemonStatus(daemonResult);
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
      });
      setTitle("");
      setPrompt("");
      setRunAt("");
    });
  }, [withBusy, title, prompt, targetKind, sessionId, targetTitle, scheduleKind, runAt, timeOfDay, weekdays]);

  const startEdit = useCallback((job: Job) => {
    setEditingJobId(job.id);
    setEditKind(job.schedule.kind);
    setEditRunAt(job.schedule.kind === "once" && job.schedule.runAt ? toLocalInput(job.schedule.runAt) : "");
    setEditTime(formatClock(job.schedule.timeOfDay));
    setEditWeekdays(job.schedule.weekdays ?? [0]);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingJobId) return;
    if (editKind === "weekly" && editWeekdays.length === 0) {
      setError("每周任务至少选择一天");
      return;
    }
    await withBusy(async () => {
      await callTool("update_job", {
        jobId: editingJobId,
        scheduleKind: editKind,
        ...(editKind === "once" ? { runAt: new Date(editRunAt).getTime() } : {}),
        ...(editKind === "daily" || editKind === "weekly"
          ? { timeOfDay: parseClock(editTime) ?? 0 }
          : {}),
        ...(editKind === "weekly" ? { weekdays: editWeekdays } : {}),
      });
      setEditingJobId(null);
    });
  }, [withBusy, editingJobId, editKind, editRunAt, editTime, editWeekdays]);

  /** 设置项守卫：清空输入框的瞬间会发出 NaN 或 0，直接拦下不发。 */
  const changeSetting = useCallback(
    (key: string, raw: string, min: number): void => {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min) return;
      void withBusy(() => callTool("update_settings", { [key]: value }));
    },
    [withBusy],
  );

  /** 切执行模型；换模型时思考等级重置为该模型的默认档。空键表示跟随默认。 */
  const changeModel = useCallback(
    (key: string) => {
      if (key === "default") {
        void withBusy(() =>
          callTool("update_settings", { model: { providerId: "", modelId: "" } }),
        );
        return;
      }
      const split = key.indexOf("/");
      const providerId = key.slice(0, split);
      const modelId = key.slice(split + 1);
      const model = models.find(
        (item) => item.providerId === providerId && item.modelId === modelId,
      );
      const level = model?.reasoningDefault ?? "";
      void withBusy(() =>
        callTool("update_settings", {
          model: {
            providerId,
            modelId,
            ...(level ? { options: { reasoningLevel: level } } : {}),
          },
        }),
      );
    },
    [withBusy, models],
  );

  /** 改思考等级；空表示用模型默认档。 */
  const changeReasoning = useCallback(
    (level: string) => {
      if (!settings) return;
      const trimmed = level.trim();
      void withBusy(() =>
        callTool("update_settings", {
          model: {
            ...settings.model,
            ...(trimmed ? { options: { reasoningLevel: trimmed } } : {}),
          },
        }),
      );
    },
    [withBusy, settings],
  );

  /** 调整任务执行顺序；同一会话的任务按这个顺序排队执行。 */
  const moveJob = useCallback(
    (jobId: string, direction: "up" | "down") => {
      void withBusy(() => callTool("move_job", { jobId, direction }));
    },
    [withBusy],
  );

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
        <h1>夜间调度</h1>
        <button className="ghost" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </header>

      <div className={`daemon-hint ${daemonStatus ? "" : "down"}`}>
        {daemonStatus
          ? `调度器运行中 · ${daemonStatus.launchSource}${
              daemonStatus.busyJobIds.length > 0 ? ` · 执行中 ${daemonStatus.busyJobIds.length}` : ""
            }`
          : "调度器不可达：到点不会执行。重开面板或会话会把它拉起来。"}
      </div>

      {error ? <div className="banner error">{error}</div> : null}

      <section className="block">
        <h2>任务清单</h2>
        <p className="hint">同一会话的任务按下面顺序排队执行，不并发；用箭头调整顺序。</p>
        {jobs.length === 0 ? (
          <p className="empty">还没有登记任务。</p>
        ) : (
          <ul className="jobs">
            {jobs.map((job, index) => (
              <li key={job.id} className="job">
                <div className="job-row">
                  <span className={`badge ${STATUS_TONE[job.lastStatus ?? ""] ?? "idle"}`}>
                    {job.lastStatus ?? "未运行"}
                  </span>
                  <span className="job-title">{job.title}</span>
                </div>
                <div className="job-meta">
                  <span>{describeTarget(job, sessions)}</span>
                  <span>{describeSchedule(job)}</span>
                  <span>下次 {formatTime(job.nextRunAt)}</span>
                  {!job.enabled ? <span>已停用</span> : null}
                </div>
                {job.lastError ? <div className="job-error">{job.lastError}</div> : null}
                {editingJobId === job.id ? (
                  <div className="edit-box">
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
                      onClick={() => void withBusy(() => callTool("run_now", { jobId: job.id }))}
                    >
                      立即执行
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => startEdit(job)}>
                      改期
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || index === 0}
                      title="上移"
                      onClick={() => moveJob(job.id, "up")}
                    >
                      ↑
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || index === jobs.length - 1}
                      title="下移"
                      onClick={() => moveJob(job.id, "down")}
                    >
                      ↓
                    </button>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        void withBusy(() =>
                          callTool("update_job", { jobId: job.id, enabled: !job.enabled }),
                        )
                      }
                    >
                      {job.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busy}
                      onClick={() => void withBusy(() => callTool("remove_job", { jobId: job.id }))}
                    >
                      删除
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block">
        <h2>新建任务</h2>
        <label>
          <span>标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="夜间巡检" />
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
              placeholder="夜间巡检报告"
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

        {scheduleKind === "weekly" ? <WeekdayPicker value={weekdays} onChange={setWeekdays} /> : null}

        <button
          className="primary"
          disabled={busy || !prompt.trim() || (targetKind === "session" && !sessionId)}
          onClick={() => void submit()}
        >
          登记
        </button>
      </section>

      {settings ? (
        <section className="block">
          <h2>全局设置</h2>
          <div className="settings-grid">
            <label>
              <span>默认执行时刻</span>
              <input
                type="time"
                value={formatClock(settings.defaultTimeOfDay)}
                onChange={(e) => {
                  const ms = parseClock(e.target.value);
                  if (ms === null) return;
                  void withBusy(() => callTool("update_settings", { defaultTimeOfDay: ms }));
                }}
              />
            </label>
            <label>
              <span>并发上限</span>
              <input
                type="number"
                min={1}
                value={settings.maxConcurrent}
                onChange={(e) => changeSetting("maxConcurrent", e.target.value, 1)}
              />
            </label>
            <label>
              <span>每分钟启动数</span>
              <input
                type="number"
                min={1}
                value={settings.maxStartsPerMinute}
                onChange={(e) => changeSetting("maxStartsPerMinute", e.target.value, 1)}
              />
            </label>
            <label>
              <span>最小间隔(ms)</span>
              <input
                type="number"
                min={0}
                value={settings.minGapMs}
                onChange={(e) => changeSetting("minGapMs", e.target.value, 0)}
              />
            </label>
            <label>
              <span>单次超时(ms)</span>
              <input
                type="number"
                min={60000}
                step={60000}
                value={settings.taskTimeoutMs}
                onChange={(e) => changeSetting("taskTimeoutMs", e.target.value, 60_000)}
              />
            </label>
            <label>
              <span>最大重试</span>
              <input
                type="number"
                min={0}
                value={settings.maxRetries}
                onChange={(e) => changeSetting("maxRetries", e.target.value, 0)}
              />
            </label>
          </div>
          <p className="hint">
            {settings.model.modelId
              ? "执行模型固定为下方所选；留「跟随默认」则用会话自己的模型。"
              : "执行模型跟随默认；要固定某个模型请在上面挑选。"}
          </p>
          <label>
            <span>执行模型</span>
            <select
              value={
                settings.model.modelId
                  ? `${settings.model.providerId}/${settings.model.modelId}`
                  : "default"
              }
              onChange={(e) => changeModel(e.target.value)}
            >
              <option value="default">跟随默认</option>
              {models
                .filter((model) => !model.disabledReason)
                .map((model) => (
                  <option
                    key={`${model.providerId}/${model.modelId}`}
                    value={`${model.providerId}/${model.modelId}`}
                  >
                    {(model.providerLabel ?? model.providerId)} · {model.label}
                  </option>
                ))}
              {settings.model.modelId &&
              !models.some(
                (model) =>
                  model.providerId === settings.model.providerId &&
                  model.modelId === settings.model.modelId,
              ) ? (
                <option value={`${settings.model.providerId}/${settings.model.modelId}`}>
                  {settings.model.providerId} · {settings.model.modelId}
                </option>
              ) : null}
            </select>
          </label>
          {settings.model.modelId ? (
            <label>
              <span>思考等级</span>
              {(() => {
                const selected = models.find(
                  (model) =>
                    model.providerId === settings.model.providerId &&
                    model.modelId === settings.model.modelId,
                );
                const current = settings.model.options?.reasoningLevel ?? "";
                if (selected && selected.reasoningLevels.length > 0) {
                  return (
                    <select value={current} onChange={(e) => changeReasoning(e.target.value)}>
                      <option value="">模型默认</option>
                      {selected.reasoningLevels.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  );
                }
                return (
                  <input
                    value={current}
                    placeholder="模型默认"
                    onChange={(e) => changeReasoning(e.target.value)}
                  />
                );
              })()}
            </label>
          ) : null}
        </section>
      ) : null}

      <section className="block">
        <h2>运行日志</h2>
        {runs.length === 0 ? (
          <p className="empty">还没有运行记录。</p>
        ) : (
          <ul className="runs">
            {runs.slice(0, 30).map((run) => (
              <li key={run.id}>
                <span className={`badge ${STATUS_TONE[run.status] ?? "idle"}`}>{run.status}</span>
                <span className="run-meta">
                  第 {run.attempt} 次 · {formatTime(run.startedAt)}
                </span>
                {run.errorMessage ? <span className="job-error">{run.errorMessage}</span> : null}
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
