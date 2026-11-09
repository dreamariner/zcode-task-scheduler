import type { SessionGateway } from "../protocol/gateway.js";
import { ProtocolSessionGateway } from "../protocol/gateway.js";
import type { WorkspaceRef } from "../protocol/session.js";
import type { CliLaunch } from "../shared/paths.js";

/**
 * 按工作区复用 CLI 进程。
 *
 * 官方约束是「一个 workspaceKey 最多一个聊天 CLI 进程」，所以这里按 workspaceKey
 * 建池：同一工作区的多个任务共用一个 app-server 进程，不同工作区各起一个。
 */
export class GatewayPool {
  private readonly gateways = new Map<string, SessionGateway>();

  constructor(
    private readonly launch: CliLaunch | null,
    private readonly options: { cwd?: string; env?: NodeJS.ProcessEnv; log?: (m: string) => void } = {},
  ) {}

  get available(): boolean {
    return this.launch !== null;
  }

  get launchSource(): string {
    return this.launch?.source ?? "未探测到";
  }

  for(workspace: WorkspaceRef): SessionGateway {
    if (!this.launch) {
      throw new Error("未探测到可用的 ZCode CLI，请在插件配置里指定 CLI 路径");
    }
    const existing = this.gateways.get(workspace.workspaceKey);
    if (existing) return existing;
    const gateway = ProtocolSessionGateway.start({
      launch: this.launch,
      cwd: this.options.cwd ?? workspace.workspacePath,
      env: this.options.env,
      onLog: this.options.log,
    });
    this.gateways.set(workspace.workspaceKey, gateway);
    return gateway;
  }

  async closeAll(): Promise<void> {
    const gateways = [...this.gateways.values()];
    this.gateways.clear();
    for (const gateway of gateways) {
      await gateway.close().catch(() => undefined);
    }
  }
}
