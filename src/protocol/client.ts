import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { APP_SERVER_SUBCOMMAND, type CliLaunch } from "../shared/paths.js";

/**
 * ZCode Protocol 的 stdio 客户端。
 *
 * 传输细节（对齐官方源码 apps/zcode-cli/packages/bootstrap/src/zcode-protocol）：
 * - 帧只按 LF 分帧，写帧是 `JSON.stringify(message) + "\n"`；
 * - 信封不是标准 JSON-RPC：请求 `{id, method, params}`，响应 `{id, result}` 或 `{id, error}`；
 * - 服务端可以反向发请求 `{id, method, params}`，客户端必须应答，否则调用方会一直挂着；
 * - 没有 initialize 握手，直接发请求即可。
 */
export interface ProtocolEvent {
  method: string;
  params: unknown;
}

export interface ProtocolClientOptions {
  launch: CliLaunch;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onLog?: (message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class ProtocolRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly method: string,
  ) {
    super(message);
    this.name = "ProtocolRequestError";
  }
}

export class ProtocolClient extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly serverHandlers = new Map<string, ServerRequestHandler>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly options: ProtocolClientOptions,
  ) {
    super();
    this.child = child;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.options.onLog?.(`[cli stderr] ${chunk.trimEnd()}`);
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const reason = `ZCode CLI 进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）`;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new ProtocolRequestError(reason, -32000, entry.method));
      }
      this.pending.clear();
      this.emit("close", reason);
    });
  }

  static start(options: ProtocolClientOptions): ProtocolClient {
    // 必须显式带上 app-server 子命令：不给子命令时 CLI 会进 TUI 模式，
    // 而桌面端内置的那份 zcode.cjs 不是 SEA 产物，TUI 依赖装在别处，起不来。
    const child = spawn(
      options.launch.command,
      [...options.launch.args, APP_SERVER_SUBCOMMAND],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: options.cwd,
        env: options.env ?? process.env,
      },
    ) as ChildProcessWithoutNullStreams;
    return new ProtocolClient(child, options);
  }

  /** 注册服务端反向请求的应答器。 */
  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverHandlers.set(method, handler);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ProtocolRequestError("ZCode CLI 进程已退出", -32000, method));
    }
    const id = this.nextId++;
    const timeout = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolRequestError(`请求超时：${method}`, -32000, method));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new ProtocolRequestError("客户端已关闭", -32000, entry.method));
    }
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.onLog?.(`[cli] 无法解析的帧：${line.slice(0, 200)}`);
      return;
    }

    const hasId = typeof message.id === "number" || typeof message.id === "string";
    const hasMethod = typeof message.method === "string";

    if (hasId && hasMethod) {
      void this.answerServerRequest(message.id as number | string, message.method as string, message.params);
      return;
    }

    if (hasId) {
      const id = message.id as number;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error && typeof message.error === "object") {
        const error = message.error as { code?: number; message?: string };
        entry.reject(
          new ProtocolRequestError(
            error.message ?? "未知错误",
            typeof error.code === "number" ? error.code : -32000,
            entry.method,
          ),
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }

    if (hasMethod) {
      this.emit("event", { method: message.method as string, params: message.params } satisfies ProtocolEvent);
    }
  }

  private async answerServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.serverHandlers.get(method);
    if (!handler) {
      this.options.onLog?.(`[cli] 未处理的服务端请求：${method}`);
      this.write({ id, error: { code: -32601, message: `未支持的请求：${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ id, result: result ?? {} });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.write({ id, error: { code: -32000, message } });
    }
  }
}
