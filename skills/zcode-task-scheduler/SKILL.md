---
name: zcode-task-scheduler
description: Use when the user wants to schedule work for later, queue a task onto an existing conversation, run something overnight, or check what the scheduler has queued. Covers this task-scheduler plugin's MCP tools for listing conversations, registering scheduled jobs, running them immediately, and inspecting run history.
---

# 任务调度

这个插件把「以后要跑的事」登记成任务，到点由**桌面端调度器**把消息投进目标会话执行。

## 能力边界

- 只能派到**当前工作区**的会话。
- 目标有两种：已有会话，或到点时新建一个会话。
- 执行发生在桌面端自己的会话运行时里：模型与上下文跟随任务指定的模型，桌面端负责鉴权与重试。
- **投递节流**：全局最多 3 条同时在投，其余排队等槽位；同一会话的任务按登记顺序串行投递，前一条没结束下一条不投。
- 桌面端必须开着；关机或退出期间错过的时间点不会补跑。

## 工具

| 工具 | 用途 |
|---|---|
| `list_sessions` | 列工作区会话，用来挑执行目标 |
| `list_jobs` | 列已登记的任务 |
| `add_job` | 登记任务（目标要给会话 id 或新建会话） |
| `add_job_here` | 给当前会话登记任务（目标自动取当前会话，只能在会话内用） |
| `update_job` | 改期、改内容、停用或启用 |
| `remove_job` | 删除任务 |
| `run_now` | 立即执行一轮 |
| `job_status` | 任务状态与最近运行记录 |

## 登记一个任务

先列会话确认目标：

```json
{"name": "list_sessions", "arguments": {}}
```

再登记：

```json
{
  "name": "add_job",
  "arguments": {
    "title": "定时巡检",
    "prompt": "巡检工作区的依赖更新情况，把结论写成一段简报。",
    "targetKind": "session",
    "sessionId": "sess_xxx",
    "scheduleKind": "daily",
    "timeOfDay": 1800000
  }
}
```

`timeOfDay` 是当天零点起的毫秒偏移，`00:30` 对应 `1800000`。

到点新建会话则把 `targetKind` 换成 `new-session`，并给 `targetTitle`。

一次性任务用 `scheduleKind: "once"` 加 `runAt`（毫秒时间戳）。每周任务用 `scheduleKind: "weekly"` 加 `weekdays`（0 是周日）。

### 指定执行模型

默认用 **MiniMax M3.1 Flash**（全天可用的常规模型）。订阅账号套餐（如 `account:bigmodel-start-plan`）只在套餐覆盖的时段（夜间）可用，白天指定会失败。

```json
{
  "name": "add_job",
  "arguments": {
    "title": "史料核对",
    "prompt": "核对史料引用的准确性与出处。",
    "targetKind": "session",
    "sessionId": "sess_xxx",
    "scheduleKind": "daily",
    "timeOfDay": 1800000,
    "model": {
      "providerId": "account:bigmodel-start-plan",
      "modelId": "GLM-5.3-Flash",
      "reasoningLevel": "max"
    }
  }
}
```

`reasoningLevel` 必填：桌面端派发前会校验模型与思考档位，缺档位会被判为「模型选择不可用」而拒绝执行。

想完全跟随会话当前模型就传 `"followSessionModel": true`（注意：会话里若选的是夜间套餐，白天执行会失败）。

## 注意

- 提示词要直接描述「要完成的最终工作」，执行者就是执行这件事的 Agent。
- 派到长会话前先提醒用户：长会话的上下文会让首轮消耗很大，专用会话更合适。
- 派单前先看一眼 `job_status`，确认没有同类任务在排队（也能看到在投数与排队数）。
- 用户问「跑完了吗」时用 `job_status` 看结果，不要凭印象回答。
- 任务会以无人值守方式全权限执行，登记前务必向用户复述一遍目标会话和时间。
- 定时任务条数上限 20 条（官方约定），登记前先 `list_jobs` 看看。
- 用户想在某个会话里给自己派任务时用 `add_job_here`：会话 id 由宿主随工具调用注入，模型自己拿不到，不要用 `add_job` 硬填。
