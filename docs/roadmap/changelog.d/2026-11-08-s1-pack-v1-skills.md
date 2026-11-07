---
date: 2026-11-08
title: Add the two deterministic service skills, imported A-tier skills and the Golden Set CI layer
---

- 起因：S1 Pack v1 第 4 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准；S0 已于 2026-11-07 发车）——落两个新技能（制裁筛查 / Incoterms 报价）、导入 A 档 2 个外部技能的引擎化衍生版，并把 Golden Set 的零模型层接进 CI。
- 改动：
  - 服务型技能接线：`executeServiceSkill` 闭集分派两个 handler——`sanctions.screen.v1`（复用 Qualify 第五门的制裁匹配引擎，只读、命中截断 50、索引未启用时如实 `not_screened`）与 `quoting.incoterms.v1`（Incoterms 2020 卖方成本矩阵，分整数累加；跨币种必须输入汇率，缺汇率/goods 行直接拒绝；L1 只读：无 PI/CI/PL 字段、`humanGate=true`）。
  - 新增 SKILL.md 包：`compliance/sanctions-screen` 与 `growth_motion/incoterms-quote`（skill-kind=service，绑定 handler，不绑任务契约、不声明工具）。
  - 导入管线：`imported/<source-id>/<skill>/SKILL.md` 布局；加载器新增许可（仅 MIT/Apache-2.0）、NOTICE（Upstream/Commit/License/Modified）与安全扫描（禁止可执行代码围栏、非 NOTICE 外链、`<script>`）门，且强制 `tenant-default: disabled`。首批衍生版 `research.account_research`、`triage.lead_triage`（源自 Anthropic knowledge-work-plugins，Apache-2.0），配新任务契约与 5 条评测用例。
  - Golden Set CI：所有技能（含 S0 三个存量技能新增清单）与内容包各 ≥5 条闭集断言用例；service 技能与内容包在 CI 真实执行并精确断言；模型技能以固定选择器下的「策略简报 + SKILL.md 正文」渲染快照钉住摘要（改正文/包内容必须显式重钉）。
  - 生成器/校验脚本扫描 builtin+imported 两个根；技能目录 seed 注册 7 个技能（导入技能默认关闭，`SKILL_TENANT_NOT_ENABLED`，ops 覆盖后可用）。
- 测试：单测 180 例（handler 数学与拒绝矩阵、导入许可/NOTICE/安全扫描负向、resolver 导入技能租户启用流与服务技能 handler 漂移、service 技能逐用例真实执行、渲染快照）。脚本 `skills:validate` / `skills:evals:validate` 全绿。
- 未做：模型技能发布层评测回执执行器（S2）；策略简报与导入技能接入现有 run（M2.1）；S1 表/seed 的部署发车需产品负责人单独授权。
