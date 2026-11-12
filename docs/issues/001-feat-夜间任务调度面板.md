---
id: "001"
type: feat
title: 任务调度面板（投递式执行）
status: doing
priority: P1
labels: [plugin, scheduler, zcode]
created: 2026-11-09
updated: 2026-11-12
assignee: jianan
related: []
---

# 任务调度面板

> 2026-11-12 起形态变更为**投递式执行**：执行交回桌面端调度器，插件只写数据。背景与决策演进见下。

## 一、背景

### 1.1 起点

要在 ZCode 里让某个会话自动干活，起初只有两条路：

- **会话内 `CronCreate`**：只能绑定当前会话，给不了任意别的会话。
- **桌面端「自动化」管理页**：能建定时任务，但插件无法经这条链路给任意会话派活，模型也不可控。

于是先做了插件自建执行面的版本（独立 daemon + ZCode Protocol + 自建任务库）。

### 1.2 自建执行面撞到的真问题

无人值守执行要用**订阅账号模型**（Start Plan 等），必须拿到每次请求的鉴权材料。查官方源码确认：账号供应商的权益事实由桌面端宿主注入（`provider/updateAccountConfig`），请求期鉴权由宿主解析后应答（`interaction/requestProviderRuntimeHeaders`），worker 侧拿不到。

尝试在插件侧补齐这两件事，结论是走不通：

- 权益快照能从磁盘 builtin 声明构造并推给 CLI（这部分成功了，账号模型能进目录）；
- 但鉴权材料取不到：桌面端 3.18 把凭据升级成 `enc:v2:os:` 第二版加密（密钥只存系统钥匙串），官方端点 socket 按设计也不提供 JWT，插件无权访问系统钥匙串。

**结论**：在插件侧复刻桌面端的凭据体系既复杂又脆弱。正确解法是把执行交回桌面端。

### 1.3 为什么选插件形态

- 插件是唯一能给**任意工作区会话**派活的入口（官方自动化页与 `CronCreate` 都绑当前会话）；
- 面板能给任务挑目标、排期、启停、立即执行；
- 写数据面（`automations` 表）即可复用桌面端成熟的认领、派发、退避重试、结算链路。

## 二、目标

- 在面板里给已有会话或新会话登记定时任务，到点把消息投进去。
- 执行发生在桌面端自己的会话运行时里，模型与鉴权走桌面端当前状态，订阅账号模型可用。
- 任务能改期、停用、启用、立即执行、删除，运行结果可查。

## 三、方案

### 3.1 目标拓扑

```
面板（MCP App，插件沙箱 webview，会话侧栏 tab）
   │  App.callServerTool → 宿主 → stdio JSON-RPC
   ▼
MCP server（stdio；插件的薄控制面）
   │  读写 ~/.zcode/v2/tasks-index.sqlite 的 automations / automation_runs
   ▼
桌面端调度器（宿主自带，20 秒轮询）认领 → host 在桌面端会话运行时里投递 prompt
```

### 3.2 关键决策

- **D-1：执行交回桌面端调度器，不自建 daemon。**
  理由：桌面端已有完整的认领、派发、退避重试、结算链路；在它自己的运行时里执行，模型选择、上下文、鉴权都是桌面端当前状态，订阅账号模型天然可用。代价是桌面端必须开着，错过窗口不补跑。
- **D-2：只写带 `zts_` 前缀的行。**
  automations 表是用户自己的定时任务也在用的，插件不能碰别人的行。
- **D-3：写入形状与官方严格一致。**
  `model_selection` 用字面量 `"null"` 表示跟随工作区首选（SQL NULL 是缺配置，桌面端直接拒派发）；显式模型必须带 `options.reasoningLevel`。
- **D-4：目标会话用 task_id 表达。**
  桌面端 tasks 表的 `task_id` 就是 CLI 会话 id（实测目标会话直接对应一行），插件的 sessionId 可直接当 `target_task_id`。

### 3.3 数据模型

- `automations`：任务定义。插件写 `automation_id`（`zts_` 前缀）、`title`、`prompt`、`cron_expr`、`workspace_*`、`target_task_id`、`mode='yolo'`、`model_selection`、`next_run_at`、`enabled`、`lifecycle_status`。
- `automation_runs`：运行记录。桌面端回写 `outcome`、`session_id`、`error`、`attempts`。
- `tasks`：只读，用来给面板列会话。

### 3.4 排期

五段式 cron（分 时 日 月 周），用 `croner` 计算 `next_run_at`（与桌面端同一库同一语义）。一次性任务 `recurring=0, max_runs=1`；每天 `分 时 * * *`；每周 `分 时 * * 周几列表`。

### 3.5 立即执行

仿官方 `automationRepo.enqueueManualRun`：`BEGIN IMMEDIATE` 事务，`automations.running=1`（守卫 `running=0`），插入 `trigger='manual'` 的 run 行，由桌面端调度器认领后立刻派发。

## 四、影响面

### 4.1 范围外

- 不做多用户、不做跨机器编排。
- 不做任务依赖编排。
- 不接管 ZCode 自带的「自动化」页。
- 不做 individual/team 套餐的项目 token 铸造（那是桌面端的职责）。

## 五、验收标准

- [x] 插件能通过本地市场安装，无诊断错误。
- [x] 侧栏面板能渲染（`ui://zcode-task-scheduler/panel.html` 以 `text/html;profile=mcp-app` 提供）。
- [x] 面板能列会话、登记任务、看运行日志。
- [x] 到点被桌面端调度器认领并投递（`dispatch_status='dispatched'`）。
- [x] 目标会话收到消息，桌面端侧栏里该会话继续。
- [x] **订阅账号模型实跑成功**：显式指定 `account:bigmodel-start-plan/GLM-5.3-Flash`，`model_usage` 出现该 provider 的新行。
- [x] `model_selection` 写成 SQL NULL 会被桌面端拒派发，改成字面量 `"null"` 后正常。
- [x] 显式模型缺思考档位会被拒，补上 `options.reasoningLevel` 后正常。
- [x] 旧版自建任务库的一次性迁移（`state.db` → `state.db.migrated`）。

## 六、依赖

- ZCode 桌面端（插件沙箱、MCP Apps、tasks-index 调度器）。
- 本机 Node 24+（`node:sqlite` 需要）。

## 七、进度日志

- 2026-11-09 15:20  jianan  立项，插件骨架与本地市场打通，诊断清零。
- 2026-11-09 15:20  jianan  自建执行面版本联调通过（独立 daemon + ZCode Protocol）。
- 2026-11-12 00:30  jianan  确认自建执行面无法取得订阅账号模型的鉴权材料（凭据 v2 加密 + 钥匙串，官方端点不提供 JWT），用户裁定改为投递式执行。
- 2026-11-12 11:46  jianan  投递式真机验证通过：桌面端认领并派发到目标会话，模型用量出现 `account:bigmodel-start-plan/GLM-5.3-Flash`，run 结算 `succeeded`。
- 2026-11-12 11:52  jianan  删除 daemon/protocol 执行面与自建任务库，改为只写桌面端 automations 表；旧库改为一次性迁移。
