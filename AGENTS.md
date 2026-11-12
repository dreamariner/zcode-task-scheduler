# AGENTS.md · zcode-task-scheduler

> Agent 进仓先读本文：项目定位、目录结构、形态不变量、门禁与红线。人向的安装与使用说明在 README.md。

## 项目定位

ZCode 任务调度插件。给**已有会话**或**新建会话**预定任务，到点由**桌面端调度器**把消息投进目标会话执行（日夜皆可）。

- 插件形态：一个 ZCode 插件（`ui.surfaces` 侧栏面板 + MCP server + skill + 斜杠命令）。
- 执行引擎：**桌面端自带**的调度器（`packages/desktop/src/scheduler`）。本插件只写数据，不跑进程。
- 远程：`git@github.com:dreamariner/zcode-task-scheduler.git`，branch `main`。
- 挂载点：根仓 `dreamariner/zcode-task-scheduler/`（submodule）。

## 形态速记

```
面板（MCP App，插件沙箱 webview，会话侧栏 tab）
   │  App.callServerTool → 宿主 → stdio JSON-RPC
   ▼
MCP server（stdio；插件的薄控制面）
   │  读写 ~/.zcode/v2/tasks-index.sqlite 的 automations / automation_runs
   ▼
桌面端调度器（宿主自带，20 秒轮询）认领 → host 在桌面端会话运行时里投递 prompt
```

四条不可省的不变量：

1. **插件不自己执行**。执行发生在桌面端的会话运行时里，所以模型选择、上下文、鉴权都走桌面端当前状态，订阅账号模型（Start Plan 等）才能用。插件一旦自己拉 CLI 进程，就得自己解决凭据与鉴权，那条路走不通（见「踩过的坑」最后一条）。
2. **只写带 `zts_` 前缀的行**。桌面端的 automations 表是用户自己的定时任务也在用的，插件不能碰别人的行。
3. **写入形状必须与官方一致**。`model_selection` 用字面量 `"null"` 表示「跟随工作区首选」（SQL NULL 是缺配置，桌面端直接报「模型选择不可用」）；显式模型必须带 `options.reasoningLevel`。
4. **协议是双向的**（插件仍与宿主对话）：宿主随工具调用注入 `_meta.session_id`，模型与指令都拿不到自己的会话 id。

## 目录结构

```
zcode-task-scheduler/
├── .zcode-plugin/plugin.json     # 插件清单：skills / commands / mcpServers / ui.surfaces
├── src/
│   ├── automation/                # 桌面端 automations 表读写（唯一执行面）
│   │   ├── store.ts               # 建任务、改期、停用、立即执行、读运行记录
│   │   └── migrate.ts             # 旧版 state.db 一次性迁移
│   ├── server/                    # MCP server 入口与工具
│   ├── shared/                    # 路径等少量共用
│   └── ui/                        # 侧栏面板（React + 官方 App 桥）
├── skills/zcode-task-scheduler/  # 教模型用这套工具
├── commands/                      # /schedule-plan、/schedule-here、/schedule-status
├── scripts/                       # build / stage
├── tests/                         # vitest
└── stage/                         # 可安装产物（构建生成，不入库）
```

## 常用命令

```sh
pnpm install          # 装依赖
pnpm build            # 构建 + 产出 stage/ 可安装目录
pnpm typecheck        # 类型检查
pnpm test             # 单测
node scripts/stage.mjs                                          # 只重做 stage/ 产物
```

装到 ZCode（CLI 与桌面端用同一份配置）：

```sh
CLI="/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
node "$CLI" plugins marketplace add "$PWD/stage" --scope user
node "$CLI" plugins marketplace update zcode-task-scheduler-local   # 改了源码后刷新快照
node "$CLI" plugins install zcode-task-scheduler@zcode-task-scheduler-local --scope user
```

## 红线

- 构建产物不入库（`dist/`、`stage/` 已在 `.gitignore`）。
- 仓库里不出现密钥、token、本机绝对路径、用户会话内容。
- 行文不用破折号「——」。
- 公开仓对外不提及内部项目名。
- 改动 `src/automation/` 时先对照官方源码：`zai-org/ZCode`（本机检出路径见 README）。

## 踩过的坑（宿主行为，改代码前先看这里）

- **插件 MCP server 只在会话创建时并进运行时配置**。先开会话、后装插件（或重装插件），那个会话里就没有本插件的 MCP server，面板直接报 `MCP App connection is unavailable`。宿主不会自动刷新已开会话的 MCP 配置，只能重建会话运行时（应用头部「重新加载会话」，或重新打开该会话）。
- **宿主回收会话级 MCP server 时按 PPID 树杀整棵子树**（SIGINT → SIGTERM → SIGKILL，见官方 `apps/zcode-cli/packages/adapters/src/mcp/process-tree.ts`）。
- **第三方插件声明的 `isolation` 会被忽略**（官方源才认），插件 MCP server 一律会话级。
- **面板只能开在会话侧栏**，`availability` 只接受 `session`；页面没有任何会话 API。
- **桌面端 automations 表的写入契约很挑**：`model_selection` 必须是字符串 `'null'`（跟随工作区首选）或完整 JSON（显式模型，且带 `options.reasoningLevel`），SQL NULL 会被判为「缺配置」直接拒绝派发；`cron_expr` 是五段式（分 时 日 月 周），一次性任务用 `recurring=0, max_runs=1`。
- **账号型模型不要在插件侧解决鉴权**。账号供应商（`account:` 前缀）的权益事实由桌面端运行时注入，请求期鉴权材料由桌面端解析后应答，worker 侧拿不到；桌面端 3.18 还把凭据升级成 `enc:v2:os:` 第二版加密，密钥只存系统钥匙串，插件无权访问。因此正确做法就是把执行交回桌面端：写一行 automations，让它在自己的运行时里投递。**不要试图在插件里复刻桌面端的凭据体系。**
