---
date: 2026-11-08
title: Add the two deterministic service skills, imported A-tier skills and the Golden Set CI layer
---

- 起因：S1 Pack v1 第 4 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准；S0 已于 2026-11-07 发车）——落两个新技能（制裁筛查 / Incoterms 报价）、导入 A 档 2 个外部技能的引擎化衍生版，并把 Golden Set 的零模型层接进 CI。
- 改动：
  - 服务型技能接线：`executeServiceSkill` 闭集分派两个 handler——`sanctions.screen.v1`（复用 Qualify 第五门的制裁匹配引擎，只读；索引未启用/为空或名字无可比 token 时如实 `not_screened`；`threshold ∈ (0,1]`；命中 >50 条截断并置 `truncated`）与 `quoting.incoterms.v1`（Incoterms 2020 卖方成本矩阵，BigInt 分整数 + 十进制四舍五入，换算/加价全整数域；`marginPct` 为成本加价；汇率只覆盖单一外币，缺汇率/多外币/goods 缺失/金额越界直接拒绝；L1 只读：无 PI/CI/PL 字段、`humanGate=true`）。
  - 新增 SKILL.md 包：`compliance/sanctions-screen` 与 `growth_motion/incoterms-quote`（skill-kind=service，绑定 handler，不绑任务契约、不声明工具）。
  - 导入管线：`imported/<source-id>/<skill>/SKILL.md` 布局；加载器新增许可（仅 MIT/Apache-2.0）、NOTICE（Upstream/Commit/License/Modified）与安全扫描（禁止任何代码围栏、可执行 HTML/`javascript:`、非 NOTICE 外链、`scripts/` 目录）门，强制 `tenant-default: disabled`，**违规技能不产出目录记录**。首批衍生版 `research.account_research`、`triage.lead_triage`（源自 Anthropic knowledge-work-plugins，Apache-2.0），配新任务契约与 5 条评测用例。
  - Golden Set CI：所有技能（含 S0 三个存量技能新增清单）与内容包各 ≥5 条闭集断言用例；service 技能在 CI 真实执行——制裁筛查用真实匹配引擎（`buildSanctionsIndex`+`screenName`）搭内存索引做精确断言，报价断言精确金额；模型技能以固定选择器下的「策略简报 + SKILL.md 正文」渲染快照钉住摘要（改正文/包内容必须显式重钉）。
  - 生成器/校验脚本扫描 builtin+imported 两个根；技能目录 seed 注册 7 个技能（导入技能默认关闭，`SKILL_TENANT_NOT_ENABLED`，ops 覆盖后可用；静态 resolver 对默认关闭技能一律拒绝）。
- 测试：单测 198 例（报价十进制/整数域数学与拒绝矩阵、制裁 guard/截断/真实引擎评测、导入许可/NOTICE/扫描/scripts 负向与 loader 不产出违规记录、resolver 导入租户启用流与服务 handler 漂移、渲染快照）。脚本 `skills:validate` / `skills:evals:validate` 全绿。
- 未做：模型技能发布层评测回执执行器（S2）；策略简报与导入技能接入现有 run（M2.1）；S1 表/seed 的部署发车需产品负责人单独授权。
