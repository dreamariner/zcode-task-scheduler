---
id: "001"
type: feat
title: 夜间任务调度面板
status: doing
priority: P1
labels: [plugin, scheduler, zcode]
created: 2026-11-09
updated: 2026-11-09
assignee: jianan
related: []
---

# 夜间任务调度面板

## 一、背景

### 1.1 现状

要在 ZCode 里让某个会话在半夜自动干活，现在只有两条路：

- **会话内 `CronCreate`**：只能在当前会话里建定时任务，绑定当前会话（`targetTaskId` 由 runtime 注入，模型不可控），给不了任意别的会话。
- **桌面端「自动化」管理页**：能建定时任务，但调度器（`packages/desktop/src/scheduler/index.ts`）认领到期任务时**没有并发上限**，到点会全部同时派发；错过窗口超过 5 分钟直接跳过不补跑；失败重试是「投递失败重试」，不是「任务失败后在会话里续跑」。

另外定时任务定义有**全局 20 条上限**（`docs/automation-create-limit.md`），所有创建入口共用。

### 1.2 现状的结构性问题（带证据）

| 问题 | 证据 |
|---|---|
| 没有并发闸 | `packages/desktop/src/scheduler/index.ts` 的 `claimDue` 一次认领所有到期项，没有上限参数 |
| 错过即丢 | 同文件 `MISFIRE_GRACE_MS = 5 * 60_000`，过期记 `computer_asleep_or_app_not_running` 跳过 |
| 重试不到任务层 | 同文件 `markDispatchFailed` 只处理派发失败，任务本身失败后没有续跑机制 |
| 不能派给任意会话 | `packages/shared/src/automation-types.ts:84`：`targetTaskId` 由 runtime 注入，模型不可控 |
| 插件不能常驻 | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:190-195`：`isolation` 只对官方 marketplace 生效，第三方插件一律 session 隔离；`adapters/src/mcp/pool.ts:18`：连接池空闲 30 秒即关 |

### 1.3 为什么选插件形态

需求方要的是「在 ZCode 界面里给会话派任务」，交互必须在宿主里。ZCode 插件是唯一能同时做到「有界面」和「能驱动会话」的形式：

- `plugin.json` 的 `ui.surfaces[]` 开出会话侧栏面板（`UI_PLUGIN.md` 官方文档）。
- 插件的 MCP server 通过 ZCode Protocol 驱动会话（`session/resume`、`session/send`）。

## 二、目标

1. 在 ZCode 界面里给**已有会话**预定任务，或**新建会话**执行任务。
2. 半夜触发，执行**限流**，并发**不超过 3**。
3. 中途失败能**检测**，并在**原会话**里重试续跑。
4. 形态是 ZCode 插件，可从插件市场安装。

## 三、方案

### 3.1 目标拓扑

```
面板（MCP App，插件沙箱 webview，会话侧栏 tab）
   │  App.callServerTool → 宿主 → stdio JSON-RPC
   ▼
MCP server（stdio；插件的薄控制面）
   │  Unix socket ${ZCODE_PLUGIN_DATA}/daemon.sock
   ▼
daemon（插件拉起的 detached 进程；执行面）
   │  spawn: node <zcode.cjs> app-server
   ▼
ZCode 会话（resume 已有 / create 新建）
```

### 3.2 关键决策

**D-1：调度放在独立 daemon，而不是插件 MCP server。**
理由：第三方插件的 `isolation` 声明被忽略（`plugins/mcp.ts:190-195`），MCP server 是会话级短命进程，连接池空闲 30 秒即被回收（`mcp/pool.ts:18`）。面板挂在当前会话上，会话关就没了。半夜执行不能依赖人开着会话。
替代方案：(a) 用桌面端原生 automation，缺点见 1.1，不满足并发与续跑要求；(b) 面板页自己轮询，缺点是面板 TTL 一小时、离屏即回收。

**D-2：执行引擎用 ZCode Protocol，不自己造协议层。**
理由：`session/resume` + `session/send` 是官方方法，`turn.terminal` 事实自带 `status` / `errorCode` / `errorMessage` / `errorRetryable`（`packages/shared/src/zcode-protocol-v4/telemetry.ts:230-247`），失败判定有权威信号。
替代方案：headless CLI（`zcode --resume <sess> -p "..."`）每轮起一个进程，实现更简单但拿不到 errorCode，重试分类只能靠文本匹配。

**D-3：重试回到同一个会话。**
理由：会话保留完整历史，模型才能「从中断处继续」而不是从头再来。实现上「新建会话」类型的任务在首次执行后把 `bound_session_id` 固定下来，后续尝试复用。
替代方案：重试时新建会话，代价是丢掉全部上下文。

**D-4：新建会话要额外写一条桌面端任务索引行。**
理由：桌面端侧栏列表只认「桌面端自己 app-server 内存里的会话」（`v4-bridge.ts` 的 `listWorkspaceSessionIds`），磁盘会话基线只服务远程工作区。daemon 用独立 CLI 进程建的会话，内容进了共享会话库却不会出现在侧栏。
做法：新建会话后向 `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 表写一行（主键 `workspace_key` + `task_id`），满足侧栏查询条件 `cli_created_at IS NOT NULL`。只写自己那一行，失败只记日志不影响任务执行。
风险：这一层耦合宿主内部表结构，宿主升级换列时会失效，代码里按「只写实际存在的列」兜底。

**D-5：不复用官方 automation 做执行引擎。**
理由：并发无上限、错过即丢、重试不到任务层、20 条全局上限，四条都与需求冲突。详见 1.1。

### 3.3 数据模型

`jobs` 表：任务定义、目标（`session` / `new-session`）、计划规则（`once` / `daily` / `weekly`）、归属工作区、下次执行时刻、状态、连续失败数、绑定的会话。
`runs` 表：每次尝试的 attempt、会话、起止时间、状态、错误码、错误信息、token 数。
`settings` 表：全局设置一行 JSON。

存储位置 `${ZCODE_PLUGIN_DATA}/state.db`（`node:sqlite`，写事务 `BEGIN IMMEDIATE` + busy 重试）。

### 3.4 限流与失败分类

| 闸 | 默认值 |
|---|---|
| 全局并发 | 3 |
| 每分钟启动 | 6 |
| 相邻启动最小间隔 | 10 秒 |
| 每会话并发 | 1 |
| 单次超时 | 30 分钟 |

失败分类优先用运行时的 `errorRetryable`；没有该信号时按错误码匹配（网络、限流、5xx 可重试；配置类、模型请求类、鉴权类不可重试）。可重试的失败按 60 秒、120 秒退避重试，续跑提示词带上次失败原因。

### 3.5 协议要点

- 传输是换行分隔 JSON，信封是 `{id, method, params}` / `{id, result}` / `{id, error}`，**不是标准 JSON-RPC**，也没有 initialize 握手。
- 服务端会反向发请求，必须应答：`session/requestRuntimePreferences`、`interaction/requestPermission`（无人值守回 allow）、`interaction/requestUserInput`（回 decline）、`interaction/requestProviderRuntimeHeaders`、`interaction/requestOfficialMcpAuthHeaders`（回 `ok:false`）。
- `modelSelection` 的思考等级在 `options.reasoningLevel`，不在顶层；minimax 系列不带会被判配置错误。
- `session/create` 返回的是会话快照本身，会话 id 在 `result.session.sessionId`；`result.projection.sessionId` 在事件流为空时是 `"unknown"`，不能当 id 用。
- 启动 CLI 必须显式带 `app-server` 子命令，否则会进 TUI 模式，而桌面端内置的 `zcode.cjs` 不是 SEA 产物，TUI 依赖装在别处，起不来。

## 四、影响面

### 4.1 范围外

- 不做多用户、不做跨机器编排。
- 不做任务依赖编排（任务之间不排队等待彼此）。
- 不接管 ZCode 自带的「自动化」页。

## 五、验收标准

- [x] 插件能通过本地市场安装，无诊断错误。
- [x] 侧栏面板能渲染（`ui://zcode-task-scheduler/panel.html` 以 `text/html;profile=mcp-app` 提供）。
- [x] 面板能列会话、登记任务、看运行日志。
- [x] 给已有会话派任务并执行成功（实测 `turn.terminal status:"success"`）。
- [x] 新建会话型任务执行成功，且该会话出现在桌面端侧栏索引里。
- [x] 失败会在同一个会话重试，续跑提示词带上次失败原因。
- [x] 并发上限 3、速率闸、每会话单槽由单测覆盖。
- [ ] 面板在桌面端实际点开并完成一次登记（需要人在界面里确认）。

## 六、依赖

- ZCode 桌面端（插件沙箱、MCP Apps、ZCode Protocol）。
- 本机 Node 24+（`node:sqlite` 需要）。

## 七、进度日志

- 2026-11-09 15:20  jianan  立项，插件骨架与本地市场打通，诊断清零。
- 2026-11-09 15:20  jianan  联调通过：已有会话执行成功（tokens 391044），新建会话执行成功（tokens 25462）并进入桌面端侧栏索引。
