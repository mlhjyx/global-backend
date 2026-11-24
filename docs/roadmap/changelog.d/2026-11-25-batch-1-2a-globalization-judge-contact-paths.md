---
date: 2026-11-25
pr:
title: Batch 1.2-A — 全球化 55+ 市场 ISO-3166 词表与阿拉伯语支持、终判白名单校准、去德国工业泵硬编码、ReDoS 与假友词防护及多语种联系入口扩展
---

- 起因：面向全球光伏与泛制造出口场景时，现网发现链路存在七处硬限制：① `JUDGE_MODEL_ALLOWLIST` 未纳入经实测校准的 `gpt-6.2-sol`、`claude-sonnet-5-5`、`gemini-4-argon`、`gpt-6-luna`，终判仍被锁死在 28s 的 `deepseek-v4-pro`；② `search-localization.ts` 与 `vocab.ts` 仅硬编码 19 国、缺阿拉伯语（`ar`）及中东/拉美/东盟区域展开，且在 `zh`/`ja`/`ko` 中误删 `HJT 700W+`/`TOPCon`/`IEC 61215` 等纯技术规格词；③ `wikidata.provider.ts` 与 `mapCountryToQid` 在未收录国家时未 fail-closed 且漏掉 ISO2 反查；④ `fit-rubric.ts` 与 `buyer-procurement-scenarios.ts` 残留德国工业泵硬编码文案；⑤ `rule-engine.ts` `matches` 正则缺线性 ReDoS 护栏、`industry-map.ts` 缺 `pumpkin→pump`/`leader→lead` 假友词拦截；⑥ `evidence-bundle.ts` 的 `MAX_SUMMARY_FACTS=3` 过窄；⑦ `contact-paths.ts` 仅覆及德/英少量联系路径，缺意/西/法/葡/荷/波/土联系页、法定页与供应商门户词。
- 改动：
  - `apps/api/src/ai-tasks/judge-model-routing.ts` & `.spec.ts`：向 `JUDGE_MODEL_ALLOWLIST` 增补经 4router.ai 实测与硬边界深判校准（3/3 + 逐字引证 + 0% 膨胀）的 `gemini-4-argon`、`gpt-6.2-sol`、`claude-sonnet-5-5`、`gpt-6-luna`。
  - `apps/api/src/discovery/vocab.ts`、`search-localization.ts`、`apps/api/src/icp/icp-planner-language.ts` & 单测：扩展至 55+ 全球核心出口市场（AE/SA/BR/MX/CA/AU/SG/PH/IN/ZA 等）并补 `Intl.DisplayNames` 任意合法 ISO-3166 alpha-2 动态回退；新增阿拉伯语（`ar`）与 `DACH`/`BENELUX`/`NORDICS`/`GCC`/`MENA`/`LATAM`/`ASEAN` 区域展开；保留 `zh`/`ja`/`ko` 中的技术型号/标准规格词；修复 `mapCountryToQid` ISO2 反查。
  - `apps/api/src/discovery/providers/wikidata.provider.ts` & `.spec.ts`：显式指定未映射国家时 fail-closed 返回空血缘，杜绝 `region` 覆盖显式 `country`；抽取共享 `apps/api/src/discovery/company-name-format.ts` 供 `public-web.provider.ts` 与 `directory.provider.ts` 复用。
  - `apps/api/src/discovery/judgment/fit-rubric.ts` & `buyer-procurement-scenarios.ts`：泛化 `procurementRubric()` 与 `draftBuyerProcurementScenarios()` 脱离德国工业泵硬编码，同时保持 `RUBRIC_SHA256`、`PROMPT_HASH` 与 `draftIndustrialPumpBuyerScenarios()` 严格向后兼容。
  - `apps/api/src/icp/rule-engine.ts`、`apps/api/src/registry/industry-map.ts`、`apps/api/src/discovery/evidence-bundle.ts` & 单测：新增确定性 ReDoS 拦截与 4,000 字符 haystack 封顶；新增 `SUBSTRING_FALSE_FRIENDS` 假友词拦截（保留德语复合词 `Kreiselpumpen`）；将 `MAX_SUMMARY_FACTS` 由 3 提升至 10。
  - `apps/api/src/discovery/website-profile/contact-paths.ts` & `.spec.ts`：扩展意/西/法/葡/荷/波/土及全球英语联系页、法定声明页与供应商准入门户识别，严格维持 6 类零 PII 契约。
- 测试：15 套核心单测 + 17 套 judgment/public-web 单测全过，`pnpm benchmark:discovery`（5/5）、`pnpm --filter @global/api build`、`G9/G15/G16/G17`、`pnpm docs:verify`、`pnpm --filter @global/api lint` 与 `gitleaks` 全部通过。
- 未做：不含实时搜索源（Serper/Exa/Google Maps）与 IR 四级漏斗（归 PR 1.2-B）、不含 S2 PDF 辅助抽取与 `document-claim-basis.ts` N+1 优化（归 PR 1.2-C）；无数据库迁移、无 OpenAPI 变更；未部署。
