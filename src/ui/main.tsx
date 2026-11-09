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

function describeSchedule(job: Job): string {
  const schedule = job.schedule;
  if (schedule.kind === "once") {
    return schedule.runAt ? `一次性 · ${formatTime(schedule.runAt)}` : "一次性";
  }
  if (schedule.kind === "weekly") {
    const names = ["日", "一", "二", "三", "四", "五", "六"];
    const days = (schedule.weekdays ?? []).map((d) => names[d] ?? String(d)).join("、");
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

function App_(): JSX.Element {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
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

  const refresh = useCallback(async () => {
    try {
      const [jobResult, sessionResult, statusResult, settingResult] = await Promise.all([
        callTool("list_jobs") as Promise<{ jobs: Job[] }>,
        callTool("list_sessions") as Promise<{ sessions: SessionSummary[] }>,
        callTool("job_status") as Promise<{ runs: RunRecord[] }>,
        callTool("get_settings") as Promise<{ settings: Settings }>,
      ]);
      setJobs(jobResult.jobs ?? []);
      setSessions(sessionResult.sessions ?? []);
      setRuns(statusResult.runs ?? []);
      setSettings(settingResult.settings);
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
    const clock = timeOfDay.split(":");
    const timeOfDayMs =
      (Number(clock[0] ?? 0) * 60 + Number(clock[1] ?? 0)) * 60 * 1000;
    await withBusy(async () => {
      await callTool("add_job", {
        title: title.trim() || "未命名任务",
        prompt,
        targetKind,
        ...(targetKind === "session" ? { sessionId } : { targetTitle }),
        scheduleKind,
        ...(scheduleKind === "once"
          ? { runAt: new Date(runAt).getTime() }
          : { timeOfDay: timeOfDayMs }),
      });
      setTitle("");
      setPrompt("");
      setRunAt("");
    });
  }, [withBusy, title, prompt, targetKind, sessionId, targetTitle, scheduleKind, runAt, timeOfDay]);

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

      {error ? <div className="banner error">{error}</div> : null}

      <section className="block">
        <h2>任务清单</h2>
        {jobs.length === 0 ? (
          <p className="empty">还没有登记任务。</p>
        ) : (
          <ul className="jobs">
            {jobs.map((job) => (
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
                </div>
                {job.lastError ? <div className="job-error">{job.lastError}</div> : null}
                <div className="job-actions">
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => void withBusy(() => callTool("run_now", { jobId: job.id }))}
                  >
                    立即执行
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
                  const [hour, minute] = e.target.value.split(":").map(Number);
                  void withBusy(() =>
                    callTool("update_settings", {
                      defaultTimeOfDay: ((hour ?? 0) * 60 + (minute ?? 0)) * 60 * 1000,
                    }),
                  );
                }}
              />
            </label>
            <label>
              <span>并发上限</span>
              <input
                type="number"
                min={1}
                value={settings.maxConcurrent}
                onChange={(e) =>
                  void withBusy(() =>
                    callTool("update_settings", { maxConcurrent: Number(e.target.value) }),
                  )
                }
              />
            </label>
            <label>
              <span>每分钟启动数</span>
              <input
                type="number"
                min={1}
                value={settings.maxStartsPerMinute}
                onChange={(e) =>
                  void withBusy(() =>
                    callTool("update_settings", { maxStartsPerMinute: Number(e.target.value) }),
                  )
                }
              />
            </label>
            <label>
              <span>最小间隔(ms)</span>
              <input
                type="number"
                min={0}
                value={settings.minGapMs}
                onChange={(e) =>
                  void withBusy(() =>
                    callTool("update_settings", { minGapMs: Number(e.target.value) }),
                  )
                }
              />
            </label>
            <label>
              <span>单次超时(ms)</span>
              <input
                type="number"
                min={60000}
                step={60000}
                value={settings.taskTimeoutMs}
                onChange={(e) =>
                  void withBusy(() =>
                    callTool("update_settings", { taskTimeoutMs: Number(e.target.value) }),
                  )
                }
              />
            </label>
            <label>
              <span>最大重试</span>
              <input
                type="number"
                min={0}
                value={settings.maxRetries}
                onChange={(e) =>
                  void withBusy(() =>
                    callTool("update_settings", { maxRetries: Number(e.target.value) }),
                  )
                }
              />
            </label>
          </div>
          <p className="hint">
            模型：{settings.model.providerId}/{settings.model.modelId}
            {settings.model.options?.reasoningLevel
              ? `（思考等级 ${settings.model.options.reasoningLevel}）`
              : ""}
          </p>
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
