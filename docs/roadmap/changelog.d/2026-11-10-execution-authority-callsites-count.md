---
date: 2026-11-10
title: Align the execution-authority callsite count with main after the deepseek and smtp merges
---

- 起因：main 上 #977（SMTP 二票接线，新增 `smtp-probe.provider.ts#smtp.rcpt_probe#1` callsite）与 #976（deepseek.search callsite）先后合入，各自单独绿，但合并后 `EXPECTED_TOOL_CALLSITES` 真值为 46，而 spec 的长度断言仍是 45（文本无冲突的语义冲突），main push CI 的 `build · typecheck · test` 因此在 Docs governance 步骤失败。
- 改动：`scripts/execution-authority-policy.spec.mjs` 两处断言 45→46（inventory 长度与 `physicalToolCallsiteCount`）；常量与清单本身不变（policy 输出 `PASS tools=22 modelTasks=15 toolCallsites=46`）。
- 测试：`node scripts/execution-authority-policy.mjs` PASS；`node --test scripts/execution-authority-policy.spec.mjs` 17/17。
- 未做：不部署、不发车；不触碰任何工具、任务或投影定义。
