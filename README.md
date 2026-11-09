# zcode-task-scheduler

ZCode 夜间任务调度插件。给**已有会话**或**新建会话**预定任务，半夜限流执行，失败在原会话续跑。

## 它做什么

- **面板**：ZCode 会话侧栏开一个「夜间调度」标签页，任务清单、新建任务、全局设置、运行日志都在里面。
- **对话侧**：`/night:plan` 派单，`/night:status` 汇报。
- **执行**：后台调度器到点把任务投进目标会话；已有会话直接续跑，新会话到点新建。
- **限流**：全局并发上限、每分钟启动数、相邻启动最小间隔、单次超时，都可在面板里改。
- **失败续跑**：失败自动在**同一个会话**里重试，提示词带上次失败原因，模型接着做完。

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

也可以走界面：**插件市场 → 添加 → 添加插件市场**，粘贴 `<仓库>/stage` 这个目录，然后 **个人 → zcode-task-scheduler-local → 夜间任务调度 → 安装**。

改完源码要刷新市场快照再重装：

```sh
node "$CLI" plugins marketplace update zcode-task-scheduler-local
node "$CLI" plugins install zcode-task-scheduler@zcode-task-scheduler-local --scope user
```

装好后打开面板：**设置 → 插件 → 夜间调度 → 打开**，或在会话侧栏找到「夜间调度」标签页。

> **重要**：插件的 MCP server 是在**会话创建时**被并进该会话的运行时配置的。先开会话、后装插件，这个会话里就没有本插件的 MCP server，面板会报 `MCP App connection is unavailable`。宿主也不会在插件 MCP server 意外断开后自动重连（连接池只在会话启动时连一次）。所以**重装插件、或插件 MCP server 掉线之后，已经开着的会话都要重载一次**（应用头部「重新加载会话」，或从侧栏重新打开该会话）才能用面板；新建的会话直接可用。

## 用法

面板里四块：

1. **任务清单**：每条任务显示目标、计划时间、上次结果、重试次数；可改期、停用、立即执行、删除。
2. **新建任务**：选目标（已有会话 / 新建会话）、写任务内容、定时间（仅一次 / 每天 / 每周）、登记。
3. **全局设置**：默认执行时刻、并发上限、每分钟启动数、最小间隔、单次超时、最大重试、模型。
4. **运行日志**：最近若干次执行的结果。

对话里也可以直接派：

> 把「巡检工作区的依赖更新情况」派到「夜间巡检」这个会话，每天 00:30 跑

## 行为说明

- **插件面板只能开在当前会话的侧栏**，这是宿主给的唯一落点；Web、手机、远程工作区不支持。
- **调度器是独立进程**，不依赖桌面端开着；关掉 ZCode 也不影响当夜任务。跨重启存活需要额外装 launchd。
- **调度器用两次 fork 脱离会话进程树**：宿主回收会话级 MCP server 时会按 PPID 树把整棵子树干掉（SIGINT → SIGTERM → SIGKILL），调度器若挂在 MCP server 下面会被一起收掉，所以它先经一个中转进程起、自己被 init 收养（PPID 变成 1）后再干活。实测：关掉会话、等宿主回收完，调度器仍活着。
- **调度器随插件加载启动**，队列空且半小时无活动时自行退出，下次打开插件会再拉起来。
- **错过窗口**：超过 24 小时仍未执行的任务会被跳过，不会补跑。
- **上下文成本**：派到长会话上，首轮消耗会非常大（实测 39 万 token）；派到专用会话只要 2.5 万。
- **CLI 路径**：默认自动探测桌面端内置的 ZCode CLI；可在插件配置里指定（填 `auto` 表示自动探测）。

## 开发

```sh
pnpm typecheck
pnpm test
node scripts/e2e-probe.mjs /path/to/workspace <sessionId|new> "任务内容"
node scripts/daemon-lifecycle-probe.mjs /path/to/workspace   # 验调度器能否扛住会话回收
```

改动协议相关代码时，先对照官方源码 `zai-org/ZCode`（本机检出路径自行替换）。

## 许可

Apache-2.0
