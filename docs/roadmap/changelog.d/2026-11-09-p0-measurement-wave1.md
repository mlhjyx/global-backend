---
date: 2026-11-09
title: Add the P0 measurement wave 1 — metric dictionary, read-only funnel and RISKY baselines, capture-recapture scaffold
---

- 起因：GainOS 深化计划 v3.0 第 1 章（测量与真值，P0）要求先有分母与真值再谈优化；当前「召回率」「precision」「可触达率」从未被测量，库内「有邮箱」存在三种口径，RISKY 270 条邮件从未做过邮箱级验证。
- 改动：
  - 新增 `docs/metrics/metric-dictionary.md`：v1.0 指标字典，T0–T4 + Guardrail 共 44 个指标（VRIC_1000_STRICT/PLUS 分离、RR1/RR3 强制成对报告、分子/分母/排除项/窗口/分层/CI 规则、口径与现有表的映射、版本与变更流程）。
  - 新增 `scripts/metrics/funnel-baseline.mjs`：只读漏斗基线脚本（`PGOPTIONS=-c default_transaction_read_only=on`；公司池→lead→fit=match→域名→邮箱→电话→VALID，按 workspace/国家/来源拆分，Wilson 95% CI，不解密 PII）。
  - 新增 `scripts/metrics/risky-inventory.mjs`：只读 RISKY 盘点脚本（status×catch_all×verification_method×source_type×email_type 交叉表、公司/域名级汇总、SMTP 探测聚合，不读取 `contact_point.value`）。
  - 新增 `scripts/metrics/capture-recapture.mjs` + `scripts/metrics/lib/psql.mjs`：两 frame 确定性键匹配（domain/registry_id/归一 name+country）+ Chapman 估计量与诊断门（m11<5 不出 N̂），为 ch01 PR-13 留接口。
  - 新增 `scripts/metrics/capture-recapture.test.mjs` 与 `scripts/metrics/lib/psql.test.mjs`（node:test，26 例）并从 `scripts/governance-contracts.spec.mjs` 导入，使 `docs:verify` 的可达性检查成立。
  - 新增两份时点证据：`docs/evidence/2026-11-09-funnel-baseline.md`（全库 2,423 公司/403 match/73 有邮箱 18.1%/4 电话/0 VALID；主租户 787/128/9/0）与 `docs/evidence/2026-11-09-risky-inventory.md`（274 邮箱=270 RISKY（246 从未验证+24 pattern_guess）+3 UNVERIFIED+1 INVALID；250 条无 source_type；135 次 SMTP 探测均为域名级）。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 26/26 通过（等价于 `cd scripts/metrics && node --test`；本机 Node v22.23.1 的测试运行器不接受目录参数）；两个数据库脚本已在 `global_dev` 只读实跑，写语句实测被只读事务拒绝；`pnpm docs:verify` 的 verify-docs 子项本地已通过（0 errors）。
- 未做：不部署、不发车；不改任何主链代码与数据库 schema；金标集（E3）、frame 抽样召回、竞品对照（E5）与三源 log-linear CR 不在本波。
