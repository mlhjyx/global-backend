---
date: 2026-11-14
title: Make TED buyer/winner roles explicit and gate supply-side records
---

- 起因：PR-03 诊断证实两侧都有缺陷——TED provider 只把买方事实放在 `attributes.ted`、没有显式买卖关系；下游又把中标方记录（供给侧）当作潜在买家。ICP 带触发词时，买方名称还会被算成中标方公司的需求信号。
- 改动：
  - TED provider 输出新增 `ted.self_role='winner'` 与 `ted.relationships`（buyer/winner 条目；关系里的国家归一为 alpha-2，`buyer_countries` 保留源始 alpha-3）。
  - Raw 归一化/校验接受并最小化关系结构（只留 `role`/`country`/`identifier`，名称照旧不落 Raw）；canonical 属性随之带上 `self_role`/`relationships`。
  - 新增开关 `TED_BUYER_ROLE_GATE`（默认关）：打开时 `scoreLead` 把 winner-only 记录显式 rejected（reasonCode `TED_WINNER_SUPPLY_SIDE`），且 `ted` 命名空间不再参与 Intent 关键词代理；无 `self_role` 的旧数据不受影响。
  - PR-03 的两个 `it.fails` 转为普通断言；补 buyer-role 证据与开关默认关的用例。
- 测试：`ted-role-diagnostic.spec.ts`、`ted.provider.spec.ts`、`provider-raw-boundary.integration.spec.ts` 定向覆盖；完整套件由 CI 跑。
- 未做：开关默认关闭，需产品确认后再在 dev/线上开启；不物化 TED 买方主体，也不改 `source_signal` 需求信号链路。
