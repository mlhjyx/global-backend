---
date: 2026-11-09
title: P3 J11 — judge 金标清单 v1（15 例）与确定性 CI 校验
---

- 起因：ch04 §4.3.10.1 层 D —— rubric/schema/聚合器已经冻结（J09/J10），但没有金标用例把「什么输入必须得到什么 verdict」钉死；没有它，任何 prompt/rubric 漂移都只能靠人眼发现。
- 改动：
  - `evals/golden-judgments/`：`manifest.json`（`golden-judgments/v1`，含 rubric/prompt/schema 身份与每例 fileSha256、inputDigest、split、expectedLabel、expectedReasonCodes）+ 15 个手写用例，覆盖 FIT 金样例、C1/C2 双硬门竞品、证据缺失/span 不匹配/过期/URL 拒绝、页面注入、borderline、低分 NOT_FIT、规模越界、模型拒答、全不适用、score 缺失、权重归一。
  - `scripts/validate-judgment-evals.mts`：零模型、零数据库的确定性校验——manifest 身份与代码常量（RUBRIC_VERSION/RUBRIC_SHA256/PROMPT_HASH/judge-output 版本）一致；fixture sha256 与 inputDigest 与 manifest 逐字一致；输出过 judge-output/v2 结构校验；证据校验 + 确定性聚合后的 verdict 与 reason 码与期望完全一致；锚点完整性与 required ensure 场景覆盖；PII（邮箱/电话）扫描。
  - `package.json`：`docs:verify` 追加该脚本（Copy 绑定文件已按流程重签），CI 的治理 job 每 PR 自动执行。
- 测试：本地 `pnpm exec tsx scripts/validate-judgment-evals.mts` 15/15 用例通过；故意改一个 case 的 expectedLabel 或 fixture sha256 会红（负向验证在实现时手工跑过）。
- 未做：金标真实标注集（J13，需双人标注与 kappa）、模型层跑分与 eval_receipt（J19）、conformal 数学单测（J15）。
