---
date: 2026-11-10
title: execution-authority spec callsite 计数对齐 46（修 main governance 红）
---

- 起因：#976（deepseek.search/fetch 工具）与 #977（SMTP 第二票）先后合入后，`scripts/execution-authority-policy.mjs` 的 `EXPECTED_TOOL_CALLSITES` 变为 46，而 `scripts/execution-authority-policy.spec.mjs` 仍断言 45，governance 在 main 上红并阻塞其它 PR。
- 改动：仅把 spec 两处断言（清单长度与 `physicalToolCallsiteCount`）从 45 改为 46；policy 清单与运行代码不动。
- 测试：CI 的 governance job 在 PR head 上通过；main 合并后再以 main CI 复核。
- 未做：无。
