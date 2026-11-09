# AGENTS.md · zcode-task-scheduler

> Agent 进仓先读本文：项目定位、目录结构、形态不变量、门禁与红线。人向的安装与使用说明在 README.md。

## 项目定位

ZCode 夜间任务调度插件。给**已有会话**或**新建会话**预定任务，到点由后台调度器执行；执行有闸门（并发上限、速率闸），失败会在**同一个会话**里续跑重试。

- 插件形态：一个 ZCode 插件（`ui.surfaces` 侧栏面板 + MCP server + skill + 斜杠命令）。
- 执行引擎：独立常驻的 daemon 进程，通过 ZCode Protocol 驱动 ZCode 会话。
- 需求与设计：见 `docs/issues/001-feat-夜间任务调度面板.md`。
- 远程：`git@github.com:dreamariner/zcode-task-scheduler.git`，branch `main`。
- 挂载点：根仓 `dreamariner/zcode-task-scheduler/`（submodule）。

## 形态速记

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

四条不可省的不变量：

1. **MCP server 不能扛调度**。第三方插件的 `isolation` 声明会被忽略（官方 marketplace 之外一律按 session 隔离，见 `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`），且连接池在最后一个租约释放 30 秒后关闭连接（`adapters/src/mcp/pool.ts`）。所以调度必须在 daemon 里。
2. **daemon 必须单例**。插件 MCP server 每次会话启动都会连一次，用 pidfile 挡住重复拉起。
3. **重试必须回到同一个会话**。失败重试复用同一 `sessionId`，模型才能带着上下文接着做完；「新建会话」类型的任务在首次执行后绑定到那个新建出来的会话。
4. **协议是双向的**。服务端会反向发请求（权限、运行时偏好、官方 MCP 鉴权头），客户端必须应答，否则回合一直挂着。

## 目录结构

```
zcode-task-scheduler/
├── .zcode-plugin/plugin.json     # 插件清单：skills / commands / mcpServers / ui.surfaces / userConfig
├── src/
│   ├── shared/                   # 类型、路径解析、调度计算（三处共用）
│   ├── protocol/                 # ZCode Protocol 客户端与会话网关
│   ├── daemon/                   # 队列、限流、失败分类、执行器、调度循环、socket RPC
│   ├── server/                   # MCP server 入口与 socket 客户端
│   └── ui/                       # 侧栏面板（React + 官方 App 桥）
├── skills/zcode-task-scheduler/  # 教模型用这套工具
├── commands/                     # /night:plan、/night:status
├── scripts/                      # build / stage / 联调探针
├── tests/                        # vitest
└── stage/                        # 可安装产物（构建生成，不入库）
```

## 常用命令

```sh
pnpm install          # 装依赖
pnpm build            # 构建 + 产出 stage/ 可安装目录
pnpm typecheck        # 类型检查
pnpm test             # 单测
pnpm stage            # 只重做 stage/ 产物
node scripts/e2e-probe.mjs <工作区> <sessionId|new> "任务内容"   # 端到端联调
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
- 运行期状态只落 `${ZCODE_PLUGIN_DATA}`，不进版本库。
- 仓库里不出现密钥、token、本机绝对路径、用户会话内容。
- 行文不用破折号「——」。
- 公开仓对外不提及内部项目名。
- 改动 `src/protocol/` 时先对照官方源码：`zai-org/ZCode`（本机检出路径见 README）。
