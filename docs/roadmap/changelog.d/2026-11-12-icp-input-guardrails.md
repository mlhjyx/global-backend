---
date: 2026-11-12
title: Guard ICP inputs with explicit market confirmation and product selection
---

- 起因：ICP 生成把档案里 AI 预填/历史目标市场当作确认输入，注册引导取消勾选的产品会被直接删除，用户取消全部产品后仍能生成 ICP，输入与用户意图不一致。
- 改动：
  - 注册引导 `products` 允许 0~5 个：空数组=明确取消全部，缺省=本次不改动；取消勾选改写 `Offering.attributes.selectedByUser=false`，不再删除抽取行；只有空白项返回 400，不当作取消全部。
  - 理解重抽取（`persistOfferings`）整体替换 `attributes` 时保留 `selectedByUser`/`selectedAt`，用户选择不会因补官网/重试理解被抹掉。
  - ICP 生成新增可选 `confirmedTargetMarkets`（仅 ICP 端点），只有本次请求显式确认的 ISO2 市场是硬目标；AI 预填/档案市场标注为「未确认，仅供建议」；JSON null 按未提供处理。
  - `companyAttributes` 在三种基准下都记录 `inputBasis` / `marketBasis` / `inputProducts` / `modelSuggestedMarkets`；开关 `ICP_INPUT_GUARDRAILS` 默认关（关闭时提示词与旧实现逐字节一致），旧 ICP 不被改写。
  - 全部产品被取消时返回 `NO_SELECTED_PRODUCTS`，且在消耗一次性 Grant 之前拒绝。
- 测试：`icp.service.spec.ts`、`icp.controller.spec.ts`、`onboarding-facts.service.spec.ts` 共 113 tests passed；全量 13252 passed；`gctl check` 的 governance/lint/build 与 `pnpm governance:verify` 通过；`openapi.json` 已重导出。
- 未做：开关默认保持关闭，未在 dev 打开；评分血统（PR-06a/06b）留待下一批。
