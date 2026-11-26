---
date: 2026-11-26
pr:
title: "feat(discovery,vies): 接入欧盟官方免费 VIES 税号 T1 交叉核验与欧盟税号提取"
---

- 起因：意大利等欧洲 B2B 中小企业大多没有 LEI 且不入 Wikidata，仅凭官网自述（T3）难以通过独立源交叉核验；同时 `website_profile` 此前只识别德国 `USt-IdNr.` 且页文脱敏会把无国别前缀的 11 位意大利 `P.IVA` 误当作电话号抹掉，导致大量真实欧盟买家缺少独立 T1 核验信号。
- 改动：
  1. **欧盟 27 国 + XI 税号提取与官网画像增强**：新增 `apps/api/src/discovery/website-profile/eu-vat.ts`（支持 EU 27 + `XI`、`GR -> EL` 映射、IT/DE/FR/BE/NL/PL 校验位与 JSON-LD / 标签优先提取）；更新 `impressum.ts`、`website-profile.provider.ts`（扩展欧洲各国法律页路径、首页/法律页字段级合并、`_parser_version = website-profile/v2` 标记）及 `site-builder/agents/pii.ts`（`scrubPiiKeepingTaxIds` 放行欧盟税号与带标签 11 位意大利 `P.IVA`，不改写普通 `scrubPii`）。
  2. **欧盟官方免费 VIES 适配器与受治理工具 `vies.check`**：新增 `apps/api/src/adapters/vies.ts`（经 `requestPublicHttp` 调欧盟 VIES REST API，`maxRedirects: 0`、10s 超时、64KB 上限、解析 `userError` 与 `errorWrappers[].error`、按成员国进程级限流冷却并确保瞬时错误不触发运行级控制错误）；新增 `apps/api/src/durable-results/vies-result-projection.ts`（`vies-check/v1`，回执层剥离街道地址）与 `apps/api/src/tools/vies-tools.ts`（`vies.check`，1 rps / 1 并发、0 美分成本），并在 `source-tools.ts`、持久化结果策略、收据事实、域确认绑定、预算信封及 `scripts/execution-authority-policy.mjs` 中完成注册，未触碰任何 4 个 sha256 锁定文件。
  3. **VIES T1 交叉核验与编排接线**：新增 `apps/api/src/discovery/providers/vies.provider.ts`（支持意大利公司法律后缀归一、严格名称相似度 >= 0.72 或双锚定匹配、德/西 `"---"` 脱敏名 fail-closed 拒通过）；接入 `canonical-company-attributes.ts`、`evidence-bundle.ts`（`T1` / `vat_registry`）、`enrichment-identity.ts`（含 `country` 为空时按 ccTLD 回退校验）、`company-normalization.ts`、`prefilter-country.ts`、`lead-package.ts`、`corroboration-enrichment.ts`、`discovery.activities.ts` 与 `discovery.run2.pipeline.activities.ts`（调整 `profileCompanyOnce` 顺序先跑官网画像再跑交叉核验）。
  4. **Provider 注册、幂等迁移与治理文档**：在 `provider.registry.ts` 与 `provider-source-classes.json` 注册 `vies` 并播种 `ec.europa.eu` 源策略；新增幂等 SQL 迁移 `packages/db/prisma/migrations/20261126090000_seed_vies_provider_and_policy/migration.sql`；更新 `docs/governance/provider-registry.json` 并重新生成 `docs/backend/provider-registry.md`。
- 测试：完成 `@global/api` 构建、全部新增与受影响 Vitest 单测套件，以及 `execution-authority-policy`、`check-file-budgets`、`governance-module-boundaries`、`governance-unsafe-raw-sql`、`governance:verify`、`copy-fixed-source-impact`、`governance-document-drift`、`pnpm docs:verify` 与 `gitleaks` 本地门禁全绿。
- 未做：本 PR 仅包含蓝图 Part 1（VIES T1 交叉核验与欧盟税号提取），不包含 Part 2 历史记录重评队列；未在生产或活体 `global_dev` 数据库执行 `prisma migrate deploy` 与端到端部署验收。
