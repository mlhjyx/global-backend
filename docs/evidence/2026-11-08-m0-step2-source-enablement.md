# M0 步2 · 数据源逐源启用：真测证据与 lineage 合同阻塞（2026-11-08）

> 结论：**第①步（source_policy）对五个相关域全部满足（未改动任何行）；第②步（真实 API 小样本真测）
> wikidata ✅ 14 家、ted ✅ 22 家中标公司；openstreetmap ⏳ 上游 Overpass 三端点全部不可用（502/超时，
> 需换时间窗重测）；openfda ❌ 真实响应被 `openfda-search/v1` 投影 `maxItems: 12` 拒绝（provider
> 每次取 ≥50 条——既有单测夹具掩盖的真实契约缺陷）。**
>
> **第③步（翻 data_provider.status ENABLED）与第④步（planner 覆盖核查）对四个发现源全部被
> 「受治理公司血缘」闸门结构性阻塞**——wikidata/openstreetmap/ted/openfda 都没有声明
> `companyResultLineage`，即使 ENABLED 也不会被 planner 规划、执行器不路由，查询按
> `SOURCE_LINEAGE_UNAVAILABLE` 跳过（2026-11-06 wikidata 已实测并回退 DISABLE）。解除需要一次
> 「lineage 合同升级」（含新迁移换合同哈希），DRAFT 设计见
> `docs/superpowers/plans/2026-11-08-structured-source-lineage-contract.md`；按 §0.6 任务启动门
> 需产品负责人过目，且 `discovery.activities.ts`（producer 集所在文件）正由整改会话
> acq-remediation 在飞，本步不自行改动。
>
> directory 已在启用状态且有血缘与真实 run 供给（run `d51431d8`：directory 361 条 ACCEPTED →
> 366 家公司 → quickScan 378 判 → leads 172），其四步仪式证据一并归档于 §4.5。

## 1. 范围与四步仪式

计划 §0.2 步2（Q33③ 逐源启用，先三后二）：wikidata → openstreetmap → ted，随后 directory、openfda；
samgov / google_patents 暂不批。每源四步：

1. **source_policy 白名单录入**（治理流程；只管域名启停——真值闸门在 `data_provider.status`）；
2. **小样本真测**（golden mini-run 3–5 家口径，不烧完整 run；本记录用受治理 ToolBroker 直测 provider，
   不写库、不落 run）；
3. **翻 `data_provider.status` ENABLED**；
4. **planner 覆盖核查**（查询计划出现该源、run 内有 perSource 供给）。

**改动前真库快照（2026-11-08，`data_provider`，只读核对）**：

| key | class | status |
| --- | --- | --- |
| wikidata | company_registry | DISABLED |
| openstreetmap | industry_data | DISABLED |
| ted | public_intelligence | DISABLED |
| openfda | public_intelligence | DISABLED |
| directory | industry_data | ENABLED |

本记录**未改动任何 `data_provider` 或 `source_policy` 行**（SELECT 核对时不加锁；A 线整改会话在
`source_policy` 的录入不受影响）。

## 2. 第②步：真实 API 小样本真测（2026-11-08）

方法：源码级 `ToolBroker`（`buildToolBroker`）+ 真实 `source_policy` 读取（`sourcePolicyReaderFrom`，
fail-closed）——出网闸门与生产同一实现；结构化源成本为 0，执行预算用仓库 `test-support` 的内存账本
（不写预算表、不建预算账户）。直接实例化 provider，以一次性 `workspaceId` 上下文调用
`discoverCompanies`；不写 `raw_source_record`、不建 run。

| 源 | 查询 | 结果 | 判定 |
| --- | --- | --- | --- |
| wikidata | industry=`machine tools`（Q1857831）+ country=`germany`（Q183），limit 15 | **14 家**（`machine tools` 无命中，回退 `manufacturing`；样例见附录 A） | ✅ 真 API 供给，每条带 `wikidata_qid`/官网/国家 |
| openstreetmap | industry=`metal fabrication`（craft=metal_construction/blacksmith）+ country=`germany`（Deutschland），limit 15 | **0 家**——上游不可用：`overpass-api.de` 返回 502「at capacity」，两个镜像（kumi/mail.ru）连接超时；同日手工 curl 同样失败（`example.org` 200，出网正常） | ⏳ 上游不可用，需换时间窗重测；provider 代码路径正常执行 |
| ted | CPV `42120000` + buyer_country `DEU` + since_days 90，limit 15 | **22 家中标公司**（样例见附录 A） | ✅ 真 API 供给，每条带公司名/国别/税号/官网 |
| openfda | product_code `LLZ` + trade_side=`importer`，limit 15 | **0 家**——上游可达但真实响应被 durable 投影契约拒绝：provider 每次至少取 `max(limit,50)` 条，而 `openfda-search/v1` 投影 `establishments`/`clearances` 均 `maxItems: 12`（`source-result-projections.ts`）→ `TOOL_DURABLE_RESULT_PROJECTION_REJECTED` | ❌ **契约缺陷**（非上游问题）：超出 12 条必拒，需小修投影上界或工具截断 |

四源出网均经 `wikidata.sparql` / `osm.overpass` / `ted.search` / `openfda.search` 工具
（`sourcePolicy: required`，策略域 `query.wikidata.org` / `overpass-api.de` / `api.ted.europa.eu` /
`api.fda.gov`）。openFDA 的失败发生在 broker 结算的投影校验，说明真实 API 已返回数据、缺陷在
契约面而非网络面。

## 3. 第③④步的阻塞：受治理公司血缘闸门

- 闸门定义：`apps/api/src/discovery/company-discovery-lineage.ts:129`（`declaresDiscoveryCompanyLineage`
  只认 `companyResultLineage === DISCOVERY_COMPANY_RESULT_LINEAGE_V1`）。
- 当前声明方：`public-web.provider.ts:123`、`directory.provider.ts:98`、`trade-fair.provider.ts:39`；
  wikidata / osm / ted / openfda 的 provider 类均未声明。
- 规划侧：`plan-query-sources.ts:200`（`withCompanyLineage`）、`:253`（planner 提示只列可运行源）、
  `:359`（TED/openFDA 冷路径仅在源可运行时注入）——无血缘源不进提示、冷路径不注入，模型写到这些源的
  查询移出计划并记 `SOURCE_LINEAGE_UNAVAILABLE`。
- 执行侧：`provider.registry.ts:571`（`routeCompanyDiscovery` 只路由有血缘的 ENABLED 适配器）；
  查询路由不到适配器时写零回执并按 `SOURCE_LINEAGE_UNAVAILABLE` 计数（run 至少 PARTIAL，不失败）。
- 合同升级成本（2026-10-11 lineage gate 的显式遗留）：两份合同对象（回执合同
  `company-discovery-lineage.ts` 的 `PROVIDER_RECEIPT_CONTRACT`；查询血缘合同
  `discovery-query-governed-lineage.ts` 的 `PROVIDER_CONTRACT`）+ 消费绑定
  `durable-results/domain-ack-consumer-bindings.ts`（现绑定的四个工具 id 均不在发现域
  `CanonicalCompany`：`ted.search`→`TenderEvidence`、`openfda.search`→`ProductRegistrationEvidence`、
  `osm.overpass`→`LocationEvidence`、`wikidata.sparql`→`TaxonomyEvidence`；`CanonicalCompany` 侧
  只有 `wikidata.entity`（富集解析器））+ **新迁移替换 `append_discovery_query_lineage_v2` 函数中钉死的合同哈希
  `eb5f6f09…`（v2 定义在 `packages/db/prisma/migrations/20260830130200_discovery_query_lineage_execution_outcome/`）**
  + 四个 provider 接线 `ctx.onDurableReceipt`（ToolBroker 结算已产 durable receipt，
  `tool-broker.ts:866-882`）+ `discovery.activities.ts:707` 的 `DISCOVERY_DOMAIN_ACK_PRODUCERS`
  需补 `ted.search`（其余工具 id 已在集合内）。
- 因此这一步不是配置项，是**合同升级工作项**：按 §0.6 先出设计文档、过产品负责人，且涉及
  `discovery.activities.ts`（整改会话在飞），需与其排序。

## 4. 每源启用记录

### 4.1 wikidata

- **① source_policy**：已满足，未改动。`query.wikidata.org`、`www.wikidata.org` 均
  `APPROVED` / `terms_status=REVIEWED_OK` / `personal_data=false` / `allowed_purpose=[discovery,enrichment]` /
  `retention_days=365`（registry seed 建行，本次仅 SELECT 核对）。
- **② 真测**：见 §2，**14 家**带 QID/官网/国家/员工数；样例见附录 A。
- **③ data_provider.status**：维持 `DISABLED`，未翻。原因：无血缘，翻 ENABLED 对发现供给为零
  （planner 不列、执行器不路由）；2026-11-06 曾翻 ENABLED 后因同一原因回退 DISABLED。
- **④ planner 覆盖**：不适用（未启用）；启用后也将因无血缘记 `SOURCE_LINEAGE_UNAVAILABLE`。
- **回退**：无需（状态未变）。
- **备注**：`wikidata` 行同时门控富集适配器 `WikidataEnrichmentProvider`（`routeEnrichment` 无血缘闸门）；
  若要单独启用富集侧，需另行真测与决定，不属于本步「发现供给」验收。

### 4.2 openstreetmap

- **① source_policy**：已满足，未改动。`overpass-api.de` `APPROVED` / `REVIEWED_OK` /
  `personal_data=false` / `allowed_purpose=[discovery,enrichment]` / 365 天。
- **② 真测**：**未通过（上游不可用）**——`overpass-api.de` 502「at capacity」、kumi/mail.ru 镜像连接
  超时（2026-11-08 同日多次重试与手工 curl 均失败；`example.org` 200 证明出网正常）。provider 与
  broker 路径本身执行正常（无治理拒绝日志）。**待换时间窗重测后才可判第②步通过**。
- **③ data_provider.status**：维持 `DISABLED`，未翻（同 4.1 原因；且第②步未过）。
- **④ planner 覆盖**：不适用（未启用）。
- **回退**：无需（状态未变）。

### 4.3 ted

- **① source_policy**：已满足，未改动。`api.ted.europa.eu` `APPROVED` / `REVIEWED_OK` /
  `personal_data=true`（具名联系人隔离）/ `allowed_purpose=[discovery,enrichment,intent]` / 365 天；
  CC BY 4.0 署名义务由 provider 逐条带 `license` 字段承载。
- **② 真测**：见 §2，**22 家中标公司**（公司名/国别/税号/官网）；样例见附录 A。
- **③ data_provider.status**：维持 `DISABLED`，未翻。TED 查询只由 ICP 冷路径确定性生成
  （`SYSTEM_PLANNED_SOURCE_KEYS`），而冷路径注入同样要求血缘（`:359`）——无血缘时启用同样零供给。
- **④ planner 覆盖**：不适用（未启用）。
- **回退**：无需（状态未变）。

### 4.4 openfda（后二之一）

- **① source_policy**：已满足，未改动。`api.fda.gov` `APPROVED` / `REVIEWED_OK` / `personal_data=true` /
  `allowed_purpose=[discovery,enrichment,intent]` / 365 天。
- **② 真测**：**未通过（契约缺陷）**——真实 API 有响应，但 broker 结算时 `openfda-search/v1`
  投影拒绝：provider 每次至少取 `max(query.limit, 50)` 条（`openfda.provider.ts` 的
  `maxRecords = min(max(limit,50),250)`），而投影 schema 对 `establishments`/`clearances` 均设
  `maxItems: 12`（`durable-results/source-result-projections.ts`）→ 真实数据必然超界。该缺陷说明
  既有单测夹具（≤12 条）未覆盖真机数据形状，需小修（抬高投影上界并论证大小，或工具按 12 截断）
  并补真实形状测试。仓内 `verify-openfda-discovery.mts` 的 Tier 2 还断言 `executeQuery` 命中
  openfda——在血缘闸门下同样已过时，见 §5。
- **③ data_provider.status**：维持 `DISABLED`。
- **④ planner 覆盖**：不适用（未启用）。
- **备注**：与 ted 相同，冷路径源，无血缘即零供给；其绑定在消费侧现为 intent 域
  `ProductRegistrationEvidence`，发现域 `CanonicalCompany` 绑定待合同升级补。启用前需先修投影上界。

### 4.5 directory（后二之一，已启用）

- **① source_policy**：逐域录入完成（2026-11-06，负责人批准）：`dongguan.11467.com`、
  `zhuhai.11467.com`、`muneian.com`，均 `APPROVED`、`company_registry`、365 天。
- **② 真测**：run `d51431d8-5724-4d58-a011-d65c13cb6cd1`（2026-11-06，ICP「珠三角电子与精密制造企业
  定制吸塑包装ICP」）——directory perSource `rawCount=361`（accepted 361 / rejected 109 / duplicate 68 /
  quarantined 108 / governanceDenied 217）。
- **③ data_provider.status**：`ENABLED`（长期启用；真供给在 #826–#829 检索层与载荷契约修复后达成）。
- **④ planner 覆盖**：`discovery_query_plan` 实际计划含 `source_hint=directory`
  （`d152a5ba…` 6 条、`d923aa8a…` 1 条、`21e2b0fa…` 1 条）；run 内 perSource 归因见上。
- **归因漏斗（启用后，run `d51431d8`）**：directory raw 361 + public_web raw 5 → companies 366 →
  quickScan 378 判（match 112 / weak 60 / mismatch 206）→ leads 172 → deep targets 172
  （done 80 / failed 92，`failure_rate_high` 告警）→ 事件 cost=1.78。
- **主指标（深判通过率）**：该 run 的 quickScan match 率 29.6%（112/378）；deep 完成率 46.5%
  （80/172）。作为「启用前后对比」的启用后基线；启用前对照（run `86cb6ab4`，directory 查询 6 条
  全部零产出）：public_web 9 条 raw → companies 9 → quickScan 13 判（match 4 / weak 2 / mismatch 7）、
  deep 6/6——见计划 §0.2 步1 记录。

## 5. 相关缺口与后续

- **openFDA 投影上界缺陷（新发现，独立于血缘）**：`openfda-search/v1` 的 `maxItems: 12` 与
  provider 的「≥50 条」取数口径冲突，真实 API 响应必被拒；openFDA 启用前必须先修（小修 + 真实
  形状测试）。该缺陷不影响 wikidata/osm/ted。
- **OSM 上游可用性**：2026-11-08 三个 Overpass 端点均不可用（502/超时），第②步需换时间窗重测；
  若长期不可用，可评估为 `osm.overpass` 增设备用端点（工具已支持 `OVERPASS_URL` 覆盖与三端点
  回退，缺的是可用端点）。
- **过时的验证脚本**：`apps/api/scripts/verify-ted-discovery.mts` 与 `verify-openfda-discovery.mts`
  的 Tier 2（`executeQuery` 落库段）写于血缘闸门之前，今天运行会因 `SOURCE_LINEAGE_UNAVAILABLE`
  失败；合同升级落地后应恢复可用。脚本本身未改（不在本步范围）。
- **lineage 合同升级建议范围**（设计见 `docs/superpowers/plans/2026-11-08-structured-source-lineage-contract.md`）：
  合同 v3（两份合同键 + 消费绑定 + 迁移换哈希）→ 四 provider 接 receipt 与记录覆盖索引 →
  `DISCOVERY_DOMAIN_ACK_PRODUCERS` 补 `ted.search` → 负向测试（无回执的记录不得物化）→
  再执行本记录 §4.1–4.4 的第③④步。
- **samgov / google_patents**：按计划维持不批、不变。

## 附录 A：探针原始输出（2026-11-08）

探针：源码级 broker（真实 `source_policy` 读取 + `test-support` 内存预算账本）直调 provider；
命令 `PROBE_APP=<worktree>/apps/api tsx --tsconfig apps/api/tsconfig.json …`（脚本未入库）。

```
=== wikidata ===
   (machine tools 无命中，回退 manufacturing)
   records=14
   · Siedle  domain=siedle.de country=DE employees=—
   · Leifheit  domain=leifheit-group.com country=DE employees=—
   · Everllence  domain=everllence.com country=DE employees=—
   · Macherey-Nagel  domain=mn-net.com country=DE employees=195
   · Mafell  domain=mafell.de country=DE employees=—
   · Leybold GmbH  domain=leybold.com country=DE employees=—
   PASS wikidata 真 API 返回 ≥1 家公司
   PASS 每条都带 wikidata_qid（外部键）

=== openstreetmap ===
   records=0
   FAIL openstreetmap 真 API 返回 ≥1 家实体

=== ted ===
   records=22
   · Neuman & Esser Deutschland GmbH & Co. KG  [DE] domain=— cpv=45200000,42123000,…
   · KDS Kompressoren- und Druckluftservice GmbH_Niederlassung Dr. Gustav Gail  [DE] domain=kds-group.de cpv=42123000,…
   · aquila wasseraufbereitungstechnik gmbh  [DE] domain=— cpv=45212212,…,42120000,…
   · Noordtec GmbH & Co. KG  [AT] domain=lmf.at cpv=42123100,…
   · Leobersdorfer Maschinenfabrik GmbH  [DE] domain=noordtec.de cpv=42123100,…
   · ABG Anlagen-, Bau- und Betriebsgesellschaft mbH  [DE] domain=— cpv=50000000,…
   PASS ted 真 API 返回 ≥1 家中标公司
   PASS 每条都有公司名

=== openfda ===
[tool-broker] ERROR openfda.search durable projection rejected the tool result
[openfda] discover failed: ToolDurableResultProjectionError: TOOL_DURABLE_RESULT_PROJECTION_REJECTED: d223af36…
   records=0
   FAIL openfda 真 API 返回 ≥1 家注册公司
```

OSM 上游同日手工核对：

```
POST https://overpass-api.de/api/interpreter        → HTTP 502「at capacity」
POST https://overpass.kumi.systems/…/interpreter    → curl (28) timeout, 0 bytes (40s)
POST https://maps.mail.ru/osm/tools/overpass/…      → curl (28) timeout, 0 bytes (40s)
GET  https://example.org                            → HTTP 200（出网正常）
```
