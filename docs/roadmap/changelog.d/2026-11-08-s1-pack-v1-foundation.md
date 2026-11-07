---
date: 2026-11-08
title: Add pack schemas, the first content catalog and the golden-set harness
---

- 起因：S1 Pack v1 第 1 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准）——先落不依赖部署的纯模块：四类 Pack Schema、内容目录、冲突裁决与评测骨架。
- 改动：
  - 四类 Pack JSON Schema（Compliance / Data Source / Growth Motion / Industry，共同信封 + 类型化规则）+ 平台语义校验（key/目录/许可 notice/规则 id 唯一）与确定性冲突裁决（优先级排序、forbid 吸收、同层更严格胜出，拒绝项显式记录）。
  - 首批内容目录 7 个：合规（双用途复核）、数据源边界、DACH 分销商动作、金属加工行业，以及 C 档 3 个去营销化内容包（competitive-intelligence / customer-research / pricing，均带 SPDX 与来源 notice）。
  - Golden Set 骨架：评测清单闭集断言词汇（11 种）与零模型执行器；`pnpm packs:generate/validate`、`pnpm skills:evals:validate` 脚本；第三方技能目录一致性 CI（schema + 快照 SHA-256 + 首批 10 个）。
  - `nest-cli.json` 增加 Pack schema 资源复制；根 `package.json` 增 3 个 script（Copy 绑定重签，HASH_ONLY）。
- 测试：新增 30 例（schema 正/负、冲突裁决、内容目录与生成物一致、评测清单与执行器、第三方目录一致性）；`src/skills` 合计 100 例通过；`gctl check --fast`、`docs:verify` 全绿。
- 未做：Pack 表/解析器/策略快照（S1-2，等 S0 发车验收）、Pack Studio（S1-3）、两个新技能与导入 A 档（S1-4）。
