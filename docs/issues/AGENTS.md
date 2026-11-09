# docs/issues 索引

本目录是需求与设计的唯一真相源。编号三位递增，文件名 `0XX-<type>-<kebab-case-标题>.md`。

| type 取值 | 含义 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `chore` | 杂务（依赖、构建、配置） |
| `refactor` | 重构 |
| `docs` | 文档 |

| status 取值 | 含义 |
|---|---|
| `open` | 未开始 |
| `doing` | 进行中 |
| `blocked` | 被阻塞 |
| `done` | 已完成 |

## 清单

| 编号 | 标题 | 状态 |
|---|---|---|
| 001 | [feat: 夜间任务调度面板](001-feat-夜间任务调度面板.md) | doing |

## 写作要求

- frontmatter 必填：`id` / `type` / `title` / `status` / `priority` / `labels` / `created` / `updated` / `assignee` / `related`。
- 正文六节：背景 → 目标 → 方案 → 影响面 → 验收标准 → 依赖；末尾加进度日志。
- 进度日志每行 `- YYYY-MM-DD HH:MM  jianan  说明`。
- 关键决策用 `D-1` / `D-2` 编号，每条写清理由与替代方案。
