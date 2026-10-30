---
date: 2026-10-30
title: Let each acquisition task pick its own model
---

- 起因：2026-10-30 产品负责人要求获客不要一个模型打天下，按各模型特点分配。#695 只给了两个档位（抽取档、推理档），像 fit 判定、开发信草稿、词表归一这类需求差异明显的任务只能挤在同一档里。
- 改动：
  - `apps/api/src/ai-tasks/task-registry.ts` 新增 `MODEL_ACQUISITION_TASK_MODELS`（JSON 对象，taskId → 模型名）。列出的任务用各自的模型，其余仍走 `MODEL_ACQUISITION_MODEL` / `MODEL_ACQUISITION_REASONING_MODEL` 两档默认；未知 taskId 与非字符串值忽略；整段 JSON 解析失败时整体忽略，一个笔误不会让进程起不来或静默清空未列出的任务。
  - 导出 `parseTaskModelOverrides` 供测试与运维核对。
- 测试：`task-registry.spec.ts` 10 例全绿——新增 3 例覆盖解析（丢非字符串、非法 JSON、空值）、覆盖只作用于列出的任务（其余保持档位默认）、非法映射整体回落档位默认。
- 未做：默认不放任何覆盖（不配 env 时行为与 #695 完全一致）；模型清单与身份门未改，仍要求上游回显请求的模型名或已登记的 `MODEL_IDENTITY_SUBSTITUTES`。
