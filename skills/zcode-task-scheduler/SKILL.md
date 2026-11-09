---
name: zcode-task-scheduler
description: Use when the user wants to schedule work for later, queue a task onto an existing conversation, run something overnight, or check what the night scheduler has queued. Covers the night-scheduler plugin's MCP tools for listing conversations, registering scheduled jobs, running them immediately, and inspecting run history.
---

# 夜间任务调度

这个插件把「今晚要跑的事」登记成任务，到点由后台调度器执行。

## 能力边界

- 只能派到**当前工作区**的会话。
- 目标有两种：已有会话，或到点时新建一个会话。
- 执行有闸门：全局并发上限、每分钟启动数、相邻启动最小间隔、单次超时。
- 失败会自动在**同一个会话**里续跑重试，不会另起会话。

## 工具

| 工具 | 用途 |
|---|---|
| `list_sessions` | 列工作区会话，用来挑执行目标 |
| `list_jobs` | 列已登记的任务 |
| `add_job` | 登记任务 |
| `update_job` | 改期、改内容、停用 |
| `remove_job` | 删除任务 |
| `run_now` | 立即执行一轮 |
| `job_status` | 任务状态与最近运行记录 |
| `get_settings` / `update_settings` | 全局设置（并发、速率、超时、重试、模型） |

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
    "title": "夜间巡检",
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

## 注意

- 提示词要直接描述「要完成的最终工作」，执行者就是执行这件事的 Agent。
- 派到长会话前先提醒用户：长会话的上下文会让首轮消耗很大，专用会话更合适。
- 派单前先看一眼 `job_status`，确认没有同类任务在排队。
- 用户问「跑完了吗」时用 `job_status` 看结果，不要凭印象回答。
