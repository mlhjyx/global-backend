---
date: 2026-11-02
title: Refresh current status to the 2026-11-02 baseline and move the release plan to docs/status
---

- 起因：`docs/status/current.md` 停在 2026-10-30，与 10-31 之后的 R4 权威迁移、GrowthOS 退役、十班车、联系人线 M1–M4、Phase 1a 安全热修不符（run/lead/个人数据表计数、身份分工、模型路由均是旧值）；ADR registry 与冲突登记多处仍写「R4 撤销链未打通」「Grant 由 GrowthOS 签发」「L4-G23 未做」；文档规则要求的 `docs/status/release-plan.md` 承接一直没有执行。
- 改动：
  - `docs/status/current.md` 刷新到 2026-11-02 基线（35 次 run：13 PARTIAL/22 FAILED/0 COMPLETED；lead 5 221；个人数据三表 80/61/268；outbox 468 全 ACKED；运行镜像 `a428afab`（build `2fa46564`）；身份与 R4 权威在 gain-saas；模型路由 `qualify_fit→gemini-3.8-flash`）。
  - `docs/roadmap/release-plan.md` 迁到 `docs/status/release-plan.md`，全部现行引用与机器规则（`docs-verification-policy.json`、三个治理脚本）同步；`docs/archive/` 历史文档不改。
  - ADR registry `PRD4-D2` 行、冲突登记 `PRD4-D2/D6/D9/D13/D16/D18`、§1.1 核验基线、capability-register 基线：按 2026-11-01/11-02 的 live 事实与拍板结果刷新或标注历史。
  - `docs/README.md` 增加「历史与冻结文档的定位」：research/platform-top-level-design-v1 为 SUPERSEDED、frontend/ 为目标规范非 as-built、site-builder 为冻结线。
- 测试：`node scripts/verify-docs.mjs` PASS（0 errors / 1 既有历史告警）；`node --test scripts/model-candidate-baseline.spec.mjs` 7/7。
- 未做：不改 `docs/archive/` 与历史研究正文；gain-saas 仓的 PRD 提评审在 gain-saas 另开 PR；文档正文不写入任何未核验的运行断言。
