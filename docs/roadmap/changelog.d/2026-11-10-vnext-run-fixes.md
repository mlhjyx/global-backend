---
date: 2026-11-10
title: 修复验证 run 遗留的三处采集缺陷：web_search 单条非法域作废整批、单公司抓取失败连坐、TED 数字税号与超长数组拒收
---

- 起因：run 7a616c8a（fded81d1）的漏斗分析暴露三处非阻塞缺陷：① model_web_search 探索环里一条非法域名（`candidates[11]`）让整批候选作废；② profileCompanyOnce 把单家公司的站点抓取失败（crawl4ai 反爬/502/超时）放大成活动失败，deep 阶段 11 个目标 7 个连带失败（PARTIAL failure_rate_high）；③ TED 真实中标数据 85/88 条被 raw schema 拒收——纯数字国家税号（意大利 partita IVA 11 位）撞上防电话 PII 守卫、CPV 数组超 20 项触发容器守卫、名称含 ’/–/" 或超 16 词。
- 改动：
  - `apps/api/src/discovery/model-web-search/model-web-search.ts`：`parseModelWebSearchAnswer` 改为**按条过滤**——单条候选域名/证据/名称不合规只丢该条，全部丢光才报错；每条候选仍在 provider 层做域名与「证据必须出现在真实检索结果」的落地校验。
  - `apps/api/src/temporal/discovery.run2.pipeline.activities.ts`：`profileCompanyOnce` 的失败边界改为「账本/预算/回执类失败上抛，其余软失败 + 日志」——覆盖档案抓取与持久化两段；`RUN_LEVEL_FAILURE_TOKENS` 定义在文件头。
  - `apps/api/src/discovery/providers/ted.provider.ts`：CPV/买方国别去重并截断到 20；联合体整句 winner-identifier 不再当标识符；名称排版标点（’ – "）换 ASCII、超 16 词按词截断。
  - `apps/api/src/discovery/raw-source-provider-schema.ts`：仅对 ted 的 identifier / attributes.ted.winner_identifier 放行纯数字国家税号（6–20 位；登记号是公司事实、scheme 已带国别，防电话守卫的意图不受影响）。
- 测试：真实 TED 数据探针（257 条中标→公司记录）通过率 19/257 → **257/257**；ted/model-web-search/schema-probe/public-web-raw-governance/directory/openfda/run2 活动与失败接线共 11 个 spec 全绿；gctl check 全量通过。
- 未做：taxonomy「太阳能光伏→ISIC 2610（半导体）」导致的 wikidata 精度问题（40 家 mismatch 的主因）未在本 PR 处理，按 vNext 词表路线另行评估；signals 阶段 BUDGET_AUTHORITY_NOT_READY 属既有平台预算权威缺口。
