---
date: 2026-11-08
title: Add the SKILL.md package spec v0 with validator and builtin catalog
---

- 起因：M1 步 7（S0 Skill Runtime v0）需要让 AI 技能有正式包规范与登记来源；设计见 `docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`（已批准）。
- 改动：
  - 新增 SKILL.md 严格子集解析器与 manifest 校验：标准字段（AAIF / agentskills.io）+ `metadata.platform.*` 扩展；`task-contract-digest` 钉住执行语义（不含 model，模型属部署策略）。
  - 新增三个存量技能的 SKILL.md（`company.understanding.extract` / `company.understanding.extract_offerings` / `discovery.qualify_fit`）与生成目录 `apps/api/src/skills/generated/builtin-skill-catalog.ts`。
  - 新增 `pnpm skills:generate` / `pnpm skills:validate` 脚本（严格子集解析，无新依赖、未动锁文件）。
- 测试：`apps/api/src/skills` 单测 30 例（解析/校验负向、生成物新鲜度、契约摘要）；全量零容器单测本地通过（两处已知负载假红单跑全绿）。
- 未做：注册表/解析器/adapter 接线（S0-2）与 ops 启停（S0-3）。
