---
date: 2026-11-26
pr:
title: "feat(contacts,report): wire governed social people search tools, fix six live battle CSV bugs, and upgrade battle CSV to 21 columns (Batch 1.8A)"
---

- 起因：生产实测意大利光伏客户作战清表暴露两类核心阻塞：(1) 社媒找决策人仍只依赖免费 SearXNG，导致 Exa People / Serper LinkedIn X-Ray 尚未接入受治理工具链，且 `contact_discovery_attempted_at` 缺少写回导致 0 联系人公司反复重试；(2) 作战清表存在 6 项现网缺陷（#96-1 意语转交信混入中文部门名且具名 `CATCH_ALL_RISKY` 落入 C 级；#96-2 任意 `<form>` 与商品 URL 误判为供应商门户；#96-3 证据摘要只剩 `fit=match` 缺失评审理由与官网品牌；#96-4 卖方中文名退化且 `sellerInboundFooter` 与 `validateLinkedInConnectionNote` 未接线；#96-5 `.com` 域带 `+39` 电话仍判 `UNKNOWN` 引发 Art.14 漏排；#96-6 公司 LinkedIn 混入个人主页列），同时缺乏真实信号 Trigger、同事内推转介包与当地时区拨号提示。
- 改动：
  1. 在 `apps/api/src/adapters/search-providers.ts` 与 `apps/api/src/tools/search-provider-tools.ts` 接入两只受治理个人数据工具 `social.search_serper`（Serper LinkedIn X-Ray）与 `social.search_exa_people`（Exa People，避开 `excludeDomains` 400 坑并解析 `entities[0].properties`/`author`），同步打通 `durable-result-strategy.ts`、`catalog-result-projections.ts`、`domain-ack-consumer-bindings.ts`（46→48）、`contact-discovery-core.ts`、`task-registry.ts`、`execution-envelope.ts`、`workspace-technical-budget-envelope.ts`、`docs/governance/durable-result-strategies.json` 与 `scripts/execution-authority-policy.mjs`（33→35）。
  2. 拆分 `apps/api/src/discovery/providers/social-role-lexicon.ts` 补齐意/西/法/葡/荷职位词、法律形式与行业泛词，改造 `apps/api/src/discovery/providers/social-presence.provider.ts` 按 4 轨顺序执行 Exa People → Serper X-Ray（累计去重 >=8 提前收敛）→ SearXNG 降级兜底并真实累加成本，在 `contact-discovery-core.ts` 非预算截断完成时写回 `contactDiscoveryAttemptedAt` 水印，同时将 `social-presence.provider.ts` 行数降至 800 行以内并清理 G9 基线条目。
  3. 根治 #96 六项现网缺陷：新增 `localizedDepartmentLabel` 并把具名非 INVALID 个人邮箱归 B 级；收紧 `find-legal-pages.ts` 路径段与 `collect-company-channels.ts`/`company-channels.ts` 表单检测，区分真正 `supplier_page` 与普通联系页；`weekly-report.service.ts` 批量联查 `judgmentRecord` 与 `companySignal` 充实证据摘要与真实 Trigger；新增 `apps/api/src/report/battle-seller-context.ts` 提取外语卖方名、产品摘要与入站页脚并对 `linkedinNote` 强制执行 `validateLinkedInConnectionNote`；扩展 `prefilter-country.ts` / `jurisdiction-resolver.ts` 接入渠道电话区号复判并在 `battle-csv-builder.ts`/`contact-persist.ts`/`company-enrichment-commit.ts`/`contact-discovery-core.ts` 回填国别闭合 Art.14 缺口；严格分离个人领英与公司领英（`Co-LI:`）。
  4. 将 Battle CSV 从 19 列升级为 21 列（末尾追加 `同事内推转介包(<=60词)` 与 `当地工作时区与拨号提示`，前 19 列完全向后兼容），新增 `report -> signals` 模块边界基线并同步导出 OpenAPI 契约。
- 测试：补齐并运行两只新工具、Exa People 解析、4 轨早停与多语种词表、水印与电话国家回填、#96 六项现网回归、外语卖方上下文与 21 列 Battle CSV 全部单测，并通过 `pnpm --filter @global/api build`、`pnpm openapi:export` 及全量治理快门。
- 未做：0 数据库迁移、未改动 4 个 sha256 锁定核心文件与 `contact-enrichment-safety.composition.ts`（留给 Batch 1.8B）；真实外部 Exa/Serper 线上实测待合并发版后验证。
