---
date: 2026-11-12
title: Add a test-only diagnostic for TED buyer/winner role risk
---

- 起因：TED 每条记录的主体是中标方，买方事实只留在 `attributes.ted`，下游资格判断不校验买卖关系；仅 DE 的目标会接受 FR 中标方。按「先诊断、后改生产代码」的要求先钉住现状。
- 改动：新增 `ted-role-diagnostic.spec.ts`。表征测试钉住当前行为（记录主体为中标方 FR、买方国家保留 alpha-3 `DEU`、无 `relationships`、无触发词的 ICP 下评分不读买方事实；有触发词时 `buyer_names` 会经关键词代理影响 intent），两个 `it.fails` 用例编码期望契约（显式买卖关系、DE-only 目标拒绝无买方证据的 FR 中标方），另加同国中标方应被接受的现状保护用例。
- 测试：`ted-role-diagnostic.spec.ts` 4 passed + 2 expected fail；无生产代码改动。
- 未做：未修缺陷；后续修复 PR 必须同时把 `it.fails` 转为普通断言。
