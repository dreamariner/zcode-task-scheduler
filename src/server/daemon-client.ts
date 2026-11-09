import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pluginRoot, socketPath } from "../shared/paths.js";

export interface DaemonClientOptions {
  env?: NodeJS.ProcessEnv;
  /** daemon 入口脚本（相对插件根）。 */
  entry?: string;
  /** 拉起 daemon 前的等待上限（毫秒）。 */
  startupTimeoutMs?: number;
  log?: (message: string) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

/**
 * daemon 的 socket 客户端。
 *
 * daemon 是脱离 ZCode 独立常驻的进程（插件 MCP server 是会话级的，30 秒空闲即被
 * 宿主回收，见 apps/zcode-cli/packages/adapters/src/mcp/pool.ts）。这里在需要时
 * 把它拉起来，并通过 Unix socket 调用。
 */
export class DaemonClient {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  private constructor(
    private readonly options: DaemonClientOptions,
  ) {}

  static async connect(options: DaemonClientOptions = {}): Promise<DaemonClient> {
    const client = new DaemonClient(options);
    await client.ensureDaemon();
    await client.openSocket();
    return client;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket) throw new Error("daemon 连接未建立");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** 连接是否还在。调度器崩了或空闲自退后，这个值会变成 false。 */
  get connected(): boolean {
    return this.socket !== null;
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** 探测 daemon 是否已在跑；不在就拉起一个。 */
  private async ensureDaemon(): Promise<void> {
    if (await this.pingExisting()) return;
    this.spawnDaemon();
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      await delay(200);
      if (await this.pingExisting()) return;
    }
    throw new Error("daemon 启动超时");
  }

  private async pingExisting(): Promise<boolean> {
    const file = socketPath(this.env);
    if (!existsSync(file)) return false;
    try {
      await this.withSocket(file, 1500, (socket) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("ping 超时")), 1500);
          socket.once("data", (chunk) => {
            clearTimeout(timer);
            resolve();
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          socket.write(`${JSON.stringify({ id: 1, method: "ping", params: {} })}\n`);
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private spawnDaemon(): void {
    const env = this.env;
    const entry = join(pluginRoot(env), this.options.entry ?? "dist/daemon.mjs");
    if (!existsSync(entry)) {
      throw new Error(`找不到 daemon 入口：${entry}`);
    }
    // 以 launcher 角色启动：入口脚本会再 fork 一次真正的调度器并立刻退出，
    // 让调度器的父进程变成 init。宿主回收会话级 MCP server 时按 PPID 树清理子树，
    // 直接挂载会让调度器跟着一起死。
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: "ignore",
      env: { ...env, ZCODE_DAEMON_ROLE: "launcher" },
    });
    child.unref();
    this.log(`尝试拉起 daemon（launcher pid=${child.pid}，若已有实例在跑这个进程会自行退出）`);
  }

  private openSocket(): Promise<void> {
    const file = socketPath(this.env);
    return this.withSocket(file, 5000, (socket) => {
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("error", () => undefined);
      socket.on("close", () => {
        this.socket = null;
        for (const [, entry] of this.pending) {
          entry.reject(new Error("daemon 连接已关闭"));
        }
        this.pending.clear();
      });
    });
  }

  private onData(chunk: string): void {
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
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message ?? "daemon 调用失败"));
      return;
    }
    entry.resolve(message.result);
  }

  private withSocket(
    file: string,
    timeoutMs: number,
    setup: (socket: Socket) => Promise<void> | void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = connect(file);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("连接 daemon socket 超时"));
      }, timeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      Promise.resolve()
        .then(() => setup(socket))
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timer);
          socket.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
