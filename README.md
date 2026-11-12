# zcode-task-scheduler

ZCode 任务调度插件。给**已有会话**或**新建会话**预定任务，到点由桌面端调度器把消息投进目标会话执行；日夜皆可，夜间跑批只是典型用法。

## 它做什么

- **面板**：ZCode 会话侧栏开一个「任务调度」标签页，任务清单、新建任务、运行日志都在里面。
- **对话侧**：`/schedule-plan` 派单，`/schedule-here` 给当前会话派单，`/schedule-status` 汇报。
- **执行**：到点把任务内容当消息投进目标会话（已有会话直接续跑，新会话到点新建），由桌面端自己的会话运行时执行。
- **模型**：默认用 MiniMax M3.1 Flash（白天可用）；也可在新建任务时指定别的模型（夜间套餐等），或选择跟随会话当前模型。
- **失败重试**：由桌面端调度器的退避策略负责，结果回写到任务的运行记录里。

## 安装

先把源码构建出可安装目录：

```sh
pnpm install
pnpm build          # 产出 stage/
```

再登记本地市场并安装（CLI 与桌面端要指向同一份配置）：

```sh
CLI="/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
node "$CLI" plugins marketplace add "$PWD/stage" --scope user
node "$CLI" plugins install zcode-task-scheduler@zcode-task-scheduler-local --scope user
```

也可以走界面：**插件市场 → 添加 → 添加插件市场**，粘贴 `<仓库>/stage` 这个目录，然后 **个人 → zcode-task-scheduler-local → 任务调度 → 安装**。

改完源码要刷新市场快照再重装：

```sh
node "$CLI" plugins marketplace update zcode-task-scheduler-local
node "$CLI" plugins install zcode-task-scheduler@zcode-task-scheduler-local --scope user
```

装好后打开面板：**设置 → 插件 → 任务调度 → 打开**，或在会话侧栏找到「任务调度」标签页。

> **重要**：插件的 MCP server 是在**会话创建时**被并进该会话的运行时配置的。先开会话、后装插件，这个会话里就没有本插件的 MCP server，面板会报 `MCP App connection is unavailable`。宿主也不会在插件 MCP server 意外断开后自动重连（连接池只在会话启动时连一次）。所以**重装插件、或插件 MCP server 掉线之后，已经开着的会话都要重载一次**（应用头部「重新加载会话」，或从侧栏重新打开该会话）才能用面板；新建的会话直接可用。

## 用法

面板里三块：

1. **任务清单**：每条任务显示目标、计划时间、执行模型、已执行次数；可立即执行、改期、停用、删除。
2. **新建任务**：选目标（已有会话 / 新建会话）、写任务内容、定时间（仅一次 / 每天 / 每周几）、可选指定执行模型，登记。
3. **运行日志**：最近若干次执行的结果（定时触发 / 立即执行、结果、错误）。

对话里也可以直接派：

> 把「巡检工作区的依赖更新情况」派到「定时巡检」这个会话，每天 00:30 跑

## 行为说明

- **执行由桌面端调度器代劳**：本插件只把任务写成桌面端 `automations` 表的一行（`~/.zcode/v2/tasks-index.sqlite`），桌面端自带的调度器进程（20 秒轮询）认领后在**桌面端自己的会话运行时**里投递 prompt。因此模型选择、上下文、鉴权全走桌面端当前状态，订阅账号模型（Start Plan 等）可以正常使用，插件全程不接触任何凭据。
- **桌面端必须开着**：桌面端退出或关机期间错过的窗口不会补跑。一次性任务有 1 分钟宽限，循环任务有 5 分钟宽限，超出即记 skipped。
- **任务条数上限 20 条**（桌面端官方约定）：插件只统计自己写的行（id 前缀 `zts_`），你在桌面端自己建的定时任务不计入、也不被插件读写。
- **插件面板只能开在当前会话的侧栏**，这是宿主给的唯一落点；Web、手机、远程工作区不支持。
- **执行模型**：默认 **MiniMax M3.1 Flash**（全天可用的常规模型）。订阅账号套餐（Start Plan 等）只在套餐覆盖的时段（夜间）可用，白天指定它会被桌面端判为不可用而失败，所以默认不跟随会话当前模型；需要夜间套餐时在面板「指定模型」里填（如 `account:bigmodel-start-plan` + `GLM-5.3-Flash` + 思考档位 `max`），桌面端派发前会校验模型与思考档位，写错会在运行记录里看到「模型选择不可用」。
- **失败重试与并发**：由桌面端调度器负责（退避重试、单任务串行），插件不另起执行面。
- **上下文成本**：派到长会话上，首轮消耗会非常大（实测 39 万 token）；派到专用会话只要 2.5 万。
- **旧版迁移**：2026-11-12 之前插件自带调度器与自己的任务库。首次启动新版时会把旧库里的启用任务迁到桌面端调度器，旧库改名保留为 `state.db.migrated`。
- **耦合点**：插件直写桌面端的 `tasks-index` 库（automations / automation_runs / tasks 三张表）。宿主改表结构时写入会失败（表缺失时面板显式报错），代价只是任务登记不上，执行逻辑不受影响。

## 开发

```sh
pnpm typecheck
pnpm test
```

改动 `src/automation/store.ts` 时，先对照官方源码：`zai-org/ZCode` 的 `packages/services/src/session/automationRepo.ts`（认领与 manual run 事务）、`packages/services/src/session/tasksDatabase/schema-v1.ts`（表结构）、`packages/desktop/src/host/index.ts`（dispatchCronRun 派发）。

## 许可

Apache-2.0
