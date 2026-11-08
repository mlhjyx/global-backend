# M0 步2 · 数据源逐源启用：真测证据与 lineage 合同阻塞（2026-11-08）

> 结论：**第①步（source_policy）对五个相关域全部满足（未改动任何行）；第②步（真实 API 小样本真测）
> wikidata ✅ 14 家、ted ✅ 22 家中标公司；openstreetmap ⏳ 上游 Overpass 三端点全部不可用（502/超时，
> 需换时间窗重测）；openfda ❌ 真实响应被 `openfda-search/v1` 投影 `maxItems: 12` 拒绝（provider
> 每次取 ≥50 条——既有单测夹具掩盖的真实契约缺陷）。**
>
> **午间更新（2026-11-08，lineage 合同升级落地后）：**上午的结构性阻塞（见 §3）已通过 lineage v3
> 合同升级解除并随镜像 `a2889542`（源 `e6e579d4`）发车（#846/#874/#850，#882 修复缓存收据），
> 第③④步进入验收：
> **wikidata ✅ 四步全完成**（run `ce35d007`：perSource `company_registry` rawCount=23、物化 21 家、
> 深判 19 家）；**ted ✅ 计划注入 + 供给证据**（本工作区 plan `e77fd2ba` 确定性注入「ICP→CPV 冷路径
> 解析」TED 查询；执行时因存量池优先未跑源查询，供给证据取自同镜像并行工作区 run `78dd56fe`：
> TED accepted 5 / rejected 14，perSource `public_intelligence` providers 含 ted——见 §6.2）；
> **directory ✅ 复核**（run `a96dfc89`：292 条 ACCEPTED/perSource 归因，见 §4.5）；
> **openfda ✅ 四步全完成**（②#850 修复后真测 33 家，③ ENABLED，④ 晚补测：美国医械 ICP 注入 +
> run `4fef3c50` 供给 20 条，见 §4.4/§7）；
> **openstreetmap 上游全日不可用**（502/超时），维持 DISABLED 待换窗口重测。
> 另发现一个 run 级可靠性缺口（`quickJudgeBatch` 重试后 `BudgetOperationReplayError` 致命，
> 见 §5 与 §6.3）。
>
> directory 的四步仪式历史证据（run `d51431d8`：directory 361 条 ACCEPTED → 366 家公司 →
> quickScan 378 判 → leads 172）保留于 §4.5。

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
- **③ data_provider.status**：`ENABLED`（2026-11-08 午后，lineage v3 发车后翻转；真库现值核对）。
- **④ planner 覆盖**：✅ run `ce35d007-00c5-4c2c-bc14-fc2d3156281d`（plan `fbaa08b6`）——查询 ordinal 0
  `source_hint=wikidata`；回执 accepted 23（duplicate 1、quarantined 1、governanceDenied 1）；
  perSource `company_registry: provider=wikidata rawCount=23`；全 run 物化 21 家、深判 19 家
  （match 1 / weak 6 / mismatch 12）。明细见 §6.1。
- **回退**：`UPDATE data_provider SET status='DISABLED' WHERE key='wikidata'`。
- **备注**：`wikidata` 行同时门控富集适配器 `WikidataEnrichmentProvider`（`routeEnrichment` 无血缘闸门）；
  若要单独启用富集侧，需另行真测与决定，不属于本步「发现供给」验收。

### 4.2 openstreetmap

- **① source_policy**：已满足，未改动。`overpass-api.de` `APPROVED` / `REVIEWED_OK` /
  `personal_data=false` / `allowed_purpose=[discovery,enrichment]` / 365 天。
- **② 真测**：**未通过（上游不可用）**——上午 `overpass-api.de` 502「at capacity」、kumi/mail.ru 镜像
  连接超时；下午 10:1x UTC 复测仍不可用（`overpass-api.de` 406 后 25 s 超时、`overpass.kumi.systems`
  20 s 超时；`example.org` 200 证明出网正常）。provider 与 broker 路径本身执行正常（无治理拒绝日志）。
  **待换时间窗重测后才可判第②步通过**。
- **③ data_provider.status**：维持 `DISABLED`，未翻（第②步未过）。
- **④ planner 覆盖**：不适用（未启用）。
- **回退**：无需（状态未变）。

### 4.3 ted

- **① source_policy**：已满足，未改动。`api.ted.europa.eu` `APPROVED` / `REVIEWED_OK` /
  `personal_data=true`（具名联系人隔离）/ `allowed_purpose=[discovery,enrichment,intent]` / 365 天；
  CC BY 4.0 署名义务由 provider 逐条带 `license` 字段承载。
- **② 真测**：见 §2，**22 家中标公司**（公司名/国别/税号/官网）；样例见附录 A。
- **③ data_provider.status**：`ENABLED`（2026-11-08 午后，lineage v3 发车后翻转；真库现值核对）。
- **④ planner 覆盖**：✅ 确定性注入已验证（plan `e77fd2ba`，ICP `be525835…`「德国与法国工业机械
  （泵阀/轴承）制造商采购ICP」，industry=机械制造 → ISIC 28 `cpv 42120000`）：计划首条即
  `source_hint=ted`，rationale「TED 欧盟中标发现（ICP→CPV 冷路径解析）」。**覆盖门按设计 fail-closed**：
  同一 workspace 的马来西亚市场 ICP（targetMarkets=MY）生成计划时得到显式告警「TED 仅覆盖
  EU/EEA/UK 买方 (MY（马来西亚）)」并跳过注入——非 EU 市场 ICP 不会拿到 TED 查询。
- **④ 供给证据（同镜像并行工作区）**：run `78dd56fe-…`（2026-11-08 10:12–10:34，workspace
  `d46d2170…`，ICP `b01190da…`「德国与法国的精密设备及工业机械制造商」，plan `826dab16…`）：
  TED 查询（ordinal 0）accepted 5 / rejected 14（`PROVIDER_PAYLOAD_SCHEMA_INVALID`，
  `raw_source_record` 5 ACCEPTED / 14 REJECTED）；perSource `public_intelligence`
  `providers=["public_web","ted"]`、rawCount=24。本工作区的执行行为见 §6.2（存量池优先未跑源查询）。
- **回退**：`UPDATE data_provider SET status='DISABLED' WHERE key='ted'`。

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
- **③ data_provider.status**：`ENABLED`（2026-11-08 午后；②的投影缺陷已由 #850 修复——`maxItems`
  12→50，与 provider「≥50 条」取数口径一致，修复后真实取样 33 家，证据见
  `docs/evidence/2026-11-08-openfda-projection-bound-fix.md`）。
- **④ planner 覆盖**：✅ 2026-11-08 晚补测完成（详见 §7）：ICP `5456ee75…`「美国医疗器械
  （放射影像）制造商采购ICP（openFDA 覆盖验证 E2E）」（industry=医疗器械→ISIC 325 `fdaPanels:
  ['RA']`，targetMarkets=美国）→ plan `ecae3b67…` 首条即 `source_hint=openfda`（rationale
  「openFDA 器械注册发现（ICP→FDA 产品码冷路径解析）」）→ run `4fef3c50…` 内 perQuery
  accepted 20 / rejected 24，perSource `public_intelligence` `provider="openfda+public_web"`。
  此前"未验证"的原因已解除：电子/包装 ICP 无 fdaPanels 锚、机械 ICP 目标市场不含美国（显式告警），
  crosswalk 门按设计 fail-closed。
- **回退**：`UPDATE data_provider SET status='DISABLED' WHERE key='openfda'`。

### 4.5 directory（后二之一，已启用）

- **① source_policy**：逐域录入完成（2026-11-06，负责人批准）：`dongguan.11467.com`、
  `zhuhai.11467.com`、`muneian.com`，均 `APPROVED`、`company_registry`、365 天。
- **② 真测**：run `d51431d8-5724-4d58-a011-d65c13cb6cd1`（2026-11-06，ICP「珠三角电子与精密制造企业
  定制吸塑包装ICP」）——directory perSource `rawCount=361`（accepted 361 / rejected 109 / duplicate 68 /
  quarantined 108 / governanceDenied 217）。
- **③ data_provider.status**：`ENABLED`（长期启用；真供给在 #826–#829 检索层与载荷契约修复后达成）。
- **④ planner 覆盖**：`discovery_query_plan` 实际计划含 `source_hint=directory`
  （`d152a5ba…` 6 条、`d923aa8a…` 1 条、`21e2b0fa…` 1 条）；run 内 perSource 归因见上。
- **④ 复核（lineage v3 镜像）**：run `a96dfc89-7c14-4110-ac46-f8c0980d7d00`（2026-11-08 05:24，
  镜像 `86d623ee`；directory 路径在后续镜像未改）：perSource `industry_data` rawCount=292，
  全部来自已验证的 `dongguan.11467.com`。
- **供给随查询/市场变化（同镜像旁证）**：同一部署上，DE/US 电子 ICP 的德语录 directory 查询
  （plan `fbaa08b6` ordinal 1）真实执行为 0 供给（非血缘问题，rejected=0、无治理拒绝）；另一会话
  工作区的 directory 查询命中 `vdw.de` 78 条但按 `SOURCE_POLICY_MISSING` 全部隔离——治理闸门按设计
  工作（该域未录入 source_policy），不是 provider 缺陷。
- **归因漏斗（启用后，run `d51431d8`）**：directory raw 361 + public_web raw 5 → companies 366 →
  quickScan 378 判（match 112 / weak 60 / mismatch 206）→ leads 172 → deep targets 172
  （done 80 / failed 92，`failure_rate_high` 告警）→ 事件 cost=1.78。
- **主指标（深判通过率）**：该 run 的 quickScan match 率 29.6%（112/378）；deep 完成率 46.5%
  （80/172）。作为「启用前后对比」的启用后基线；启用前对照（run `86cb6ab4`，directory 查询 6 条
  全部零产出）：public_web 9 条 raw → companies 9 → quickScan 13 判（match 4 / weak 2 / mismatch 7）、
  deep 6/6——见计划 §0.2 步1 记录。

## 5. 相关缺口与后续

- **lineage 合同升级（已完成）**：设计 `docs/superpowers/plans/2026-11-08-structured-source-lineage-contract.md`
  （APPROVED）。落地：#846（合同 v3：两份合同键 + 消费绑定 + 迁移换哈希 + 四 provider 接收据）、
  #874（v1 append 函数 provider 允许清单：真实 run `f841d9f1` 首跑暴露的 `DOMAIN_ACK…INVALID` 根因）、
  #850（openFDA 投影上界）、#882（缓存命中零成本收据重放，P1）。镜像 `a2889542`/源 `e6e579d4` 起生效。
- **openFDA 投影上界缺陷（已修复）**：`maxItems` 12→50 与 provider「≥50 条」口径对齐，修复后真实
  取样 33 家；证据 `docs/evidence/2026-11-08-openfda-projection-bound-fix.md`。
- **OSM 上游可用性**：2026-11-08 全日三个 Overpass 端点不可用（上午 502、下午 406/超时），第②步
  需换时间窗重测；若长期不可用，可评估为 `osm.overpass` 增设备用端点（工具已支持 `OVERPASS_URL`
  覆盖与三端点回退，缺的是可用端点）。
- **openFDA ④ 已闭环**（2026-11-08 晚，§7）：美国医械 ICP 注入 + 真供给 20 条；此前"缺 crosswalk
  对象"的结论已随补测解除。
- **TED 拒绝面**：另会话 2026-11-08 run 中 TED 原始记录 5 ACCEPTED / 14 REJECTED
  （`PROVIDER_PAYLOAD_SCHEMA_INVALID`，`raw_source_record.disposition_code`）；拒绝率高，后续可用
  `RAW_SOURCE_SCHEMA_PROBE` 取样定位被拒载荷形状（取样后该探针已移除）。
- **`BudgetOperationReplayError` 重试不可恢复（run 级缺陷，详见 §6.3）**：`quickJudgeBatch` 批量
  协议无 durable 投影，活动重试即命中残留操作并直接终止 run；建议补投影/心跳或先降级逐家。
- **存量池优先跳过计划查询**：当工作区存量候选已足够（如本工作区 pool 752/quick 436），run 不执行
  计划的源查询（§6.2）；如不符合产品预期需调整 Run 2.0 语义。
- **过时的验证脚本**：`apps/api/scripts/verify-ted-discovery.mts` 与 `verify-openfda-discovery.mts`
  的 Tier 2（`executeQuery` 落库段）写于血缘闸门之前，血缘 v3 落地后已恢复可用，建议随下次触碰一并
  实跑核对。脚本本身未改（不在本步范围）。
- **samgov / google_patents**：按计划维持不批、不变。

## 6. 验收 run 明细（2026-11-08 午后，镜像 `a2889542` / 源 `e6e579d4`）

### 6.1 复跑（run `ce35d007`，plan `fbaa08b6`，ICP「德国与美国电子精密制造企业定制吸塑包装采购商（海外验证）」）

- **环境**：`/health/build` 报 `build_sha=e6e579d4…`、`image_digest=sha256:a2889542…`、attested；
  #882 缓存收据修复在镜像内，`ACQ_LLM_CACHE` 已由主会话移除（默认 on）。
- **查询**：8 条（wikidata 1 + directory 1 + public_web 6）全部有回执；逐个 perQuery 见 §4.1–4.5。
- **漏斗**：raw（wikidata 23 + public_web 21）→ 物化 21 家 → websiteProfile profiled 11 / matched 6 /
  backfilled 1 / unclassified 0 → 深判 19（fitUnjudged 0）：match 1 / weak 6 / mismatch 12 →
  通过率 5.3%。近期基线：a96dfc89 0/89、bdb70e30 1/145、e9c764ab 1/51（0–0.7%），**主指标无回退**。
- **PARTIAL 原因**：4 家 `websiteProfile` 不可重放（crawl4ai 502 / 上游站点超时），run 以 PARTIAL
  收尾（failures=0，非血缘问题）。
- **contacts**：2 家公司、1 人、1 邮箱（emailGuess risky 1 / probes 1 / persisted 1）。
- **#882 回归**：worker 日志出现 `[llm-cache] task=… hit=true` 且无 `RECEIPT_MISMATCH` /
  `DOMAIN_ACK…INVALID`——缓存命中走零成本收据重放，血缘不再被缓存命中作废。
- **并发注记**：执行窗口内另有 3 个 run 并发（另会话 2 个 + 同计划重复触发 1 个），
  `qualifyFitForRun` 出现一次 Prisma P2028（交互事务 5000 ms 超时 7057 ms），Temporal 重试成功。
  维持 RUNBOOK「一次只跑一个 run」。
- **同计划重复执行（观察）**：`b82756fc`（+42 s，中途被取消，FAILED: CancelledFailure @
  websiteProfile）与 `4a639ea4`（09:48 另行触发，PARTIAL，fit 0/15、companies 3）——重复触发来源
  未定（同一驱动被多次调用或并发会话），不影响本次验收证据（以 `ce35d007` 为准）。
- **档位注记**：本 run 的深判发生在 `MODEL_ACQUISITION_TASK_MODELS` 临时覆盖档期间；10:0x UTC
  主会话恢复原档（`discovery.qualify_fit=gemini-3.8-flash`）后才起的 run（§6.2）用的是原档，
  两组深判数字不可直接横比。

### 6.2 TED 验收 run（run `aae4a06a`，plan `e77fd2ba`，ICP `be525835…`（机械制造，DE/FR））

- **ICP 构造**：从卖家公司生成新 ICP 后 PATCH（industry=机械制造 → ISIC 28 `cpv 42120000`；
  country=DE/FR；targetMarkets=德国/法国/欧洲；trade_side=manufacturer）并激活。首版 targetMarkets
  仍是生成时的 MY（马来西亚），计划生成被 TED 覆盖门显式拒绝（「TED 仅覆盖 EU/EEA/UK 买方」）；
  PATCH 目标市场后重新生成计划，TED 查询按冷路径注入。
- **计划**：8 条（ted 1 + wikidata 1 + directory 1 + public_web 6），已确认。
- **执行（两次，均未跑源查询）**：`aae4a06a`（attempt 1）在 quickScan 阶段因 `BudgetOperationReplayError`
  失败（`nonRetryable`，见 §6.3）；`7ce7d6f9`（重试，新 attemptId）PARTIAL 完成：phase 仅 quick+deep，
  **plan 的 8 条源查询未执行**（perQuery/perSource 为空、rawGovernance 全零）。原因：本工作区存量池
  752 家、prefilter+quick 判 436 家（match 2 / weak 3 / mismatch 431）已够出 5 个 leads，Run 2.0
  存量优先策略跳过了新源查询。**这是工作区状态决定的执行行为，不是 TED 注入失败**；TED 的真实供给
  证据因此取自同镜像的并行工作区 run `78dd56fe`（见 §4.3 的 ④ 条目）。待与 M0 owner 确认该
  「池充足即跳过计划查询」语义是否符合预期。

### 6.3 新发现：`quickJudgeBatch` 的预算操作残留使重试不可恢复（run 级致命）

- **现象**：run `aae4a06a`（本工作区，TED 验证）attempt 1 失败后 Temporal 重试 attempt 2，
  `quickJudgeBatch` 抛 `BudgetOperationReplayError`（`nonRetryable`）→ 整个 run FAILED；
  另一工作区 run `78dd56fe` 的 `signalsCompanyOnce` / `profileCompanyOnce` 也报同类残留错误
  （该 run 容忍为 company 级失败，最终 PARTIAL）。
- **机制**（源码核实）：模型预算操作键 = `accountKey` + task + model + prompt + system + schema
  （`router-model-gateway.ts` 的 `paidOperationKey`）；`accountKey` = run 的请求哈希
  （`discovery.run:discovery_run:request:<sha>`）。`quickJudgeBatch` 的**批量协议无 durable 投影**
  （源码注释「批量协议暂无 durable 投影」），结算后不留可重放结果；活动一旦需要重试（超时/上游
  控制错误），重放同一操作即报「already exists without a durable result」→ fail-closed 且不可恢复。
  逐家降级路径带 `fit-judgment/v1` 回执，不受此影响。
- **影响**：上游拥塞/超时下一次活动重试即可让整个 run 失败；当天多次 run 失败均与此同源或叠加。
- **建议（交 M0/discovery owner）**：批量协议补 durable 投影（或对「已结算无结果」的操作按可重算
  处理）；给 `quickJudgeBatch` 加 heartbeat/调大 start-to-close；批量失败先降级逐家（已有回执路径）
  再考虑整批重试。属 discovery 编排/预算代码，未在本步改动。

## 7. openFDA ④ 补测（2026-11-08 晚，取证窗口）

- **背景**：Run 2.0 池优先（`DISCOVERY_RUN2_QUICK_SCAN=on`，池内候选 ≥ 阈值 20 即跳过整轮搜索）
  使常规 run 不再执行计划查询（§6.2）。经主会话批准开 ≤15 分钟取证窗口：临时设
  `DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD=1000`（合法上限）并仅重建 api（`runtime.sh up -d
  --no-deps --force-recreate api`，不动 worker/platform-worker），run 查询段完成后**立即删除该行并
  再次重建 api**；容器内已核实 `threshold=unset`、`DISCOVERY_RUN2_QUICK_SCAN=on` 原样。
  **此为取证窗口的临时阈值，非常态配置。**窗口实际占用 11:28:56–11:33:38 UTC ≈ 5 分钟。
- **ICP**：`5456ee75-ffdb-5de7-985e-7e7da675f835`「美国医疗器械（放射影像）制造商采购ICP
  （openFDA 覆盖验证 E2E）」：industry=医疗器械（→ISIC 325，种子 `fdaPanels: ['RA']`）、
  targetMarkets=美国、trade_side=manufacturer。（E2E 标记测试对象，不涉真实客户数据。）
- **计划**：`ecae3b67-cffa-55e2-b748-e8585e78d0cd`——首条 `source_hint=openfda`（rationale
  「openFDA 器械注册发现（ICP→FDA 产品码冷路径解析）」），另有 wikidata×1、directory×1、
  public_web×2；5 条查询全部执行（5/5 回执）。
- **结果（run `4fef3c50-fd6d-49a9-a626-41bdeaae4f8a`，11:28:56–11:33:08 UTC，PARTIAL）**：
  - openFDA（ordinal 0）：accepted **20** / rejected 24（`PROVIDER_PAYLOAD_SCHEMA_INVALID`；
    `raw_source_record` 20 ACCEPTED + 24 REJECTED）；
  - perSource `public_intelligence`：`provider="openfda+public_web"`、rawCount 30（openfda 20 +
    public_web 10）、rejectedCount 24、governanceDenied 24；
  - wikidata 7；directory 0（21 条 quarantined）；
  - quickScan：pool 787、candidates 407、prefilteredOut 93、judged 442（match 1 / mismatch 441）
    → leads 1 → deep 1/1 failed（`failure_rate_high` → PARTIAL，非源问题）。
- **判定**：**openFDA 四步全部完成**——① `api.fda.gov` 域已在 source_policy（APPROVED）② 真测
  （#850 修复后真实取样 33 家）③ `data_provider.status=ENABLED` ④ 本 run 的计划注入 + perSource
  供给双证。
- **遗留**：openFDA 本次拒绝率 24/44≈55%（`PROVIDER_PAYLOAD_SCHEMA_INVALID`，与 TED 的 14/19 同
  代码）；两份源都在真实载荷形状上被契约拒绝，建议后续用受控探针取样定位被拒子句（`RAW_SOURCE_SCHEMA_PROBE`
  已随取样完成移除，重启后可再按需开启）。

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
