# SAM.gov Sources Sought — P4 设计（美国联邦「早数月」意图源）

> 状态：**设计待认可**（2026-07-14）。方向已拍板（AskUserQuestion）：**纯 Intent 信号**（镜像 TED P3，非可直接成单的联邦线索）+ **CSV 优先 keyless** 摄取。
> 承重假设已**真探证实**（见 §2），未动任何代码。落地走 TDD + 真测 + 对抗复审 + PR，功能默认 **DISABLED**（见 §5/§6）。
> 对标：`docs/implementation-records/ted-provider-spec.md`（P3 招标 intent）、`docs/roadmap/decision-maker-p1-google-patents-inventor-design.md`（近期同类设计文档格式）。

---

## 0. 定位与边界（已认可）

- **是什么**：美国联邦采购在**正式招标之前**发布的 **Sources Sought**（市场调研通告）——政府说「我在考虑采购品类 X，谁有能力？」。它比 RFP/Solicitation **早数月**，是我们买家智能线（TED 招标 P3 / openFDA 清关 P3）里**最早的需求信号**。
- **定位 = 纯 Intent 信号**（镜像 TED P3）：Sources Sought → 记为**联邦机构买方**的一条 intent 事件（动六维 Intent 维），**不**把它当「可直接投标成单的联邦线索」。原因：外企投美国联邦标有法定门槛（Buy American / TAA / SAM 实体注册 / 潜在密级），机构本身极少是出海卖家的直接客户。价值在**品类需求情报**（美国联邦市场在该 NAICS 品类正有需求）+ 未来可延伸的中标 prime（P4.x）。
- **边界**：
  - 只摄 **Sources Sought**（P4）。Presolicitation/Solicitation/Award/Special Notice 等其它 `Type` 本期**不摄**（Award=中标方 prime 是未来 P4.x，需走 openFDA 同款个体户拒收，见 §5）。
  - 只经**公开 API / 每日 CSV 抽取**，**绝不爬 sam.gov 网页 UI**、**绝不碰敏感/管控端点**（实体管理/exclusions 等）。Sources Sought 合同机会是**完全公开**记录。
  - 止于 `attributes.intent.*` 投影 + 六维评分（与平台边界一致：QGO/触达归 SaaS）。

---

## 1. 为什么 = 早数月意图

| 信号 | 阶段 | 提前量 | 我方 event | strength |
|---|---|---|---|---|
| web_watch `SOURCING_OPENED` | 供应商招募页上线 | 实时 | 已有 | 1.0 |
| TED `TENDER_PUBLISHED` | 欧盟招标已发布 | 招标窗口内 | 已有 | 0.9 |
| openFDA `FDA_CLEARANCE` | 器械已清关上市 | 上市时点 | 已有 | 0.85 |
| **SAM `US_FED_SOURCES_SOUGHT`** | **联邦市场调研（招标前）** | **早数月** | **新增** | **0.7（建议，见 §6）** |

Sources Sought = 「政府还没发标、正在摸市场」——比一切「已发标」信号都早，但也更软（可能不转成真 RFP）。故 strength **低于开放招标**（用户明示），但仍是**真实需求**，压过纯关键词代理。

---

## 2. 承重假设已真探证实（2026-07-14，无 sandbox）

1. **keyless CSV 可达 ✅**：`GET sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv?api_key=null` → **HTTP 303** 重定向到预签名 S3（`falextracts.s3.amazonaws.com/...`，`content-disposition: attachment`）。**免鉴权、无 login.gov/审批**——避开 EPO OPS 式审批坑。（Opportunities API v2 无 key 走 404，我们不依赖它。）
2. **列结构含所需字段 + PII 可结构性剔除 ✅**（实测表头）：
   - 🟢 绿：`NoticeId`·`Title`·`Sol#`·`Department/Ind.Agency`·`Sub-Tier`·`Office`·`PostedDate`·`Type`·`ResponseDeadLine`·`NaicsCode`·`ClassificationCode`(PSC)·`PopCountry`·`Link`·`OrganizationType`·`CGAC`/`AAC Code`(机构码)。
   - 🔴 红（**摄取层白名单剔除，绝不入绿库**）：`PrimaryContactTitle/Fullname/Email/Phone/Fax`·`SecondaryContact*`（联系官）·`Awardee`（P4 不涉）。
3. **零 schema 迁移 ✅**：`source_signal.providerKey`/`signalType`/`subjectCountry` 是自由 String、`taxonomyKeys`/`payload` 是 jsonb——新 provider `samgov` + 新 `signalType='US_FED_SOURCES_SOUGHT'` + `taxonomyKeys=['naics:...']` **纯增量落库，无需改表**（与专利缓存需新表/列的高风险相反）。

> ⚠️ 待实现期再确认：**每日增量文件名**（优先小体积 delta，避免每次 sweep 拉全量 ~100MB+；全量文件做初始 backfill/兜底，解析走**流式过滤 Type=Sources Sought** 控内存）。

---

## 3. 机制：镜像 TED P3，bulk-CSV「下载一次」变体

复用**收口⑤ ingest-once + 两层投影**同一条管线（`external-intent.workflow` 四段：枚举 ACTIVE ICP → 信号状态机过期 → 逐 ICP 确定性解析查询面 → 平台层按指纹去重拉取一次写 `source_signal` → 逐 ICP 只读投影进租户 canonical）。

**与 TED/openFDA 的唯一机制差异 = bulk-CSV vs query-by-code**：
- TED/openFDA：按码**服务端过滤**、每指纹一次 API 调用（CPV/FDA 码进指纹）。
- SAM：CSV 是**整包文件**、无服务端按码过滤 → **指纹 = provider+kind+window（NAICS 无关）**，`ingestSam` **每窗口下载一次**、流式过滤 `Type=Sources Sought`、**跨全部 NAICS 一次落库**（有界 maxRecords + TTL），**投影层逐 ICP 按 NAICS 子树过滤**。这正是「一次大扫 → 缓存 → 逐 ICP 零成本读」模式（同专利缓存的省钱思路），且 ingest-once 账本天然把所有 ICP 收敛成**每窗口一次下载**。

```
sweep ─┬─ ingestSam（每 window 一次）: CSV 303→S3 →流式 filter Type=Sources Sought
       │     → mapSamSourcesSought（白名单绿字段，剔 PII）→ source_signal（providerKey=samgov）
       └─ 逐 ICP projectSourcesSought: source_signal(samgov, ACTIVE, NAICS 子树重叠)
             → 按机构买方归并取最新 PostedDate → upsert canonical（government_buyer 标记+免责声明）
             → mergeIntent US_FED_SOURCES_SOUGHT 事件（动 Intent 维）→ field_evidence（public domain）
```

---

## 4. 落地触点（grounded；~12 处，全增量，**无 schema 迁移**）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `adapters/sam-api.ts`（新） | `fetchSourcesSought(params)`：keyless CSV 303→S3 下载 + 流式解析 + 过滤 `Type=Sources Sought` → `SamSourcesSought[]`（绿字段）。CSV 解析用成熟库（`csv-parse`，free-first 复用）。SSRF：URL 固定官方域，走 broker。 |
| 2 | `tools/source-tools.ts` | 新 `samgov.search` Tool：`sourcePolicy:'required'`，`policyDomain:'sam.gov'`，`personalData:true`（含联系官，抽取面隔离），`allowedPurpose:['intent']`（+discovery/enrichment 视需要）。加入 `registerSourceTools`。新增 `SamSearchInput/Output` 类型。 |
| 3 | `signals/signal-mappers.ts` | 新 `US_FED_SOURCES_SOUGHT` + `SOURCES_SOUGHT_STRENGTH=0.7` + `SAM_PAYLOAD_KEYS`（白名单）+ `sourcesSoughtTtlDays()`（默认 120，env）+ `mapSamSourcesSought(row, observedAt): MapOutcome`。买方=`Department — Sub-Tier`、country 恒 `US`、`taxonomyKeys=['naics:'+code]`、externalId=`NoticeId`、occurredAt=`PostedDate`。**payload 白名单剔 PII**。机构=法人 → 不套个体户判定（同 TED buyer）。`SignalDraft.providerKey` 拓 `'samgov'`。 |
| 4 | `signals/signal-query.ts` | 新 `CanonicalSamSpec`（**无 naicsCodes**，NAICS 无关：`sinceDays`/`maxRecords`）+ `canonicalSamSpec` + `queryFingerprint` 加 sam 分支 + `CanonicalQuerySpec` 并入。 |
| 5 | `signals/signal-ingest.service.ts` | 新 `ingestSam(params)`（镜像 ingestTed）→ `broker.invoke('samgov.search')` → `mapSamSourcesSought`。`IngestOutcome.provider`/`emptyOutcome` 拓 `'samgov'`。 |
| 6 | `discovery/icp-to-naics.ts`（新） | `resolveIcpToNaics`：industry `crosswalk.naics` 锚定 + product 精修（限子树）+ **US 市场门**（同 openFDA 方向：非美目标 → 跳过）。`NaicsTaxonomyPort`。（**不做** `buildSamQuery` 发现注入——纯 intent 源不进发现查询计划，见 §7。） |
| 7 | `intent/sam-intent-projection.service.ts`（新） | `SamIntentProjectionService.projectSourcesSought`（镜像 `TedIntentProjectionService`）：读 `source_signal(samgov, US_FED_SOURCES_SOUGHT, ACTIVE)` **无国别过滤**（恒 US）+ `naicsOverlap` 子树 → 按机构归并 → `projectOne` upsert canonical（`government_buyer:true`+`sam_market_signal:true`+`disclaimer`）+ `US_FED_SOURCES_SOUGHT` 事件 + field_evidence（public domain）。新 `naicsOverlap`（前缀双向，NAICS 无尾零）。 |
| 8 | `signals/intent-recompute.service.ts` | `ProjectionSurface` 加 `{provider:'samgov', naicsCodes[]}`；`surfaceMatches` 加 samgov 分支（NAICS 重叠、恒 US 无国别门、无个体户门）；`signalEvidence` 加 samgov。**收敛必接**（否则过期 SAM 信号被误清/误注入）。 |
| 9 | `temporal/external-intent.activities.ts` | `LiveProviderState`+`samgov`；`liveEnabled` 查 samgov key；`listExternalIntentTargets` 返 `samgovEnabled` + 全停短路含 samgov；`ResolvedIntentTarget`+`naicsCodes`；`resolveExternalIntentTarget` 调 `resolveIcpToNaics`；`IngestSweepSummary`+`samSpecs`；`ingestExternalSignals` +`samgovEnabled` + 单 SAM 指纹（iff 任一 ICP 有 NAICS）+ `ingestSam` 循环（live.samgov 门）；`recomputeExpiredIntent` 面聚合加 samgov；`ExternalIntentIcpResult`+`sourcesSought?`；`projectExternalIntentForIcp` +`samgovEnabled` + samgov 投影分支。 |
| 10 | `temporal/external-intent.workflow.ts` | 解构 `samgovEnabled`；全停判含 samgov；resolved 兜底 `naicsCodes:[]`；ingest/project 传 `samgovEnabled`；agg 加 `samCompaniesTouched/samEvents`。**Temporal 决定论**：SAM 全部**穿在既有活动调用内**（改的是活动**入参/返回**，非命令序列）→ **无需新 `patched()` 门**（recompute 已被 `external-intent-recompute-v1` 覆盖）。 |
| 11 | `discovery/provider.registry.ts` seed | `data_provider` 加 `samgov`（class `public_intelligence`，**status DISABLED**，见 §6）；`source_policy` 加 `sam.gov`（sourceType `gov_opportunity`，personalData=true，allowedPurpose `['intent']`，notes=public domain 署名非义务 + 「Sources Sought=市场调研非招标」红线 + 联系官 🔴 隔离 + 只公开 API/CSV 不爬 UI）。 |
| 12 | 词表 seed（`scripts/seed-taxonomy.mjs` + `CanonicalNode.crosswalks.naics`） | NAICS 子树种子（curated，覆盖已测 ICP 域：泵 333914 / 测量仪 3345 / 放射器械 334517·339112 …）+ industry 节点挂 `crosswalks.naics`。镜像 CPV 子树 seed。 |

> **测试**（TDD）：mapper（PII 剔除/US 国别/NAICS 键/skip 分支）·canonicalSamSpec+fingerprint·resolveIcpToNaics（crosswalk/US 门/精修）·naicsOverlap·projection（镜像 ted-intent 测）·recompute samgov 面·ingestSam（mock broker）。CI 纯单测。
> **真测**：`scripts/verify-sam-sources-sought.mts`——真 CSV 拉取（**先证 keyless 仍通**）→ 过滤 Sources Sought → 落库 → 对某测试 ICP（如 NAICS 3345/3339）投影 → 断言 intent 事件、零 PII、幂等、SUSPENDED 零落地。app_user `is_superuser` guard。

---

## 5. 合规红线

- **许可 = 美国政府作品公共领域**（17 U.S.C. §105）：署名**非义务**（同 openFDA CC0，异于 TED CC BY 强制署名）。`license='Public Domain (U.S. Government Work)'`，存 provenance 但无署名义务。
- **🔴 PII 隔离**：`PrimaryContact*`/`SecondaryContact*`（联系官姓名/邮箱/电话）是具名个人 → **摄取层 payload 白名单结构性剔除**（`SAM_PAYLOAD_KEYS` 只含 `naics/notice/notice_type/response_deadline/source`），**绝不入绿 `source_signal`**。买方=联邦机构（法人组织，绿）。
- **访问纪律**：只经公开 CSV 抽取 / 公开 API；**绝不爬 sam.gov 网页**、**绝不触敏感端点**。`source_policy` 行=显性登记，SUSPENDED 即 broker 单点全链停抓。
- **市场信号免责声明**（同 openFDA「注册≠核准」）：`attributes` 恒置 `disclaimer`=「Sources Sought=市场调研阶段，非既有招标/合同；外企投联邦标有法定门槛（Buy American/TAA/SAM 注册）；本条为品类需求信号，非可直接成单线索」。
- **未来 Award（P4.x）警示**：若延伸摄 Award notice（中标方 prime），`Awardee` 可为个体户自然人 → **必须走 openFDA 同款 `isLikelyIndividualApplicant` 拒收**，绝不复用买方 mapper 路径。

---

## 6. 关键决策 + 推荐值

| 决策 | 推荐 | 理由 |
|---|---|---|
| event/strength | `US_FED_SOURCES_SOUGHT` / **0.7** | 低于 TENDER 0.9（更早更软），高于纯关键词代理；env 可调。 |
| TTL | **120 天**（env `SIGNAL_TTL_SOURCES_SOUGHT_DAYS`） | Sources Sought 到真 RFP 常隔数月，意图窗比招标（90d）更长。 |
| 买方身份 | `Department — Sub-Tier`，country 恒 `US`，`companyIdentity().dedupeKey` | 与 TED/FDA 一致的**名基身份**（便于 recompute/投影同键）；Sub-Tier=机构/局级，粒度合适（不按 Office 碎片化）。备选=CGAC/AAC 码基身份（更稳，若名冲突再切）。 |
| 摄取形状 | **下载一次/窗口**（指纹 NAICS 无关）+ 投影层按 NAICS 过滤 | 匹配 bulk-CSV 本质；ingest-once 天然收敛全 ICP 到一次下载。 |
| data_provider 初始态 | **DISABLED**（同 google_patents 先例） | 真测通过前不路由；翻 ENABLED 由 ops 手动（`update:{}` 不覆盖手改）。**注**：本源**不物化 PII**（联系官不入库），故**不像专利缓存那样需 LIA/DPIA 门**——DISABLED 仅因「真测未过」，真测绿即可翻（见 §7 待你拍板）。 |

---

## 7. 主动提出（没问但联想到的）

1. **⚠️ 每次 sweep 下载全量 CSV 体积**：`ContractOpportunitiesFullCSV.csv` 是全部活跃机会（~100MB+）。→ 实现期优先找**每日 delta 抽取**（小）；全量做初始/兜底；解析**流式过滤**控内存。**待实现期确认 delta 文件名**。
2. **联邦机构「买方即线索」的污染权衡**：TED 的欧盟公共买方（如德国医院买泵）是**可信客户**；SAM 的联邦机构对出海卖家**基本非直接客户**。镜像 TED 会往线索池塞一批「联邦机构」实体。缓解=`government_buyer`+`sam_market_signal` 标记 + disclaimer + 无可达联系人 → 六维评分（Reachability 低）自然压低。**替代方案**（未来 P4.1）：建「品类级市场意图」聚合层，用 Sources Sought **抬升该 NAICS 品类的既有线索**，而非新建机构实体——但这是新概念、更大改动。**推荐**：P4 先镜像 TED（最小/一致/已验证），上线后看真实产出再决定是否投资品类聚合层。← **想听你意见**。
3. **DISABLED 的理由与专利缓存不同**：专利缓存 DISABLED 是因**门前物化发明人 PII 静态存储**需你先签 LIA/DPIA；SAM **不物化 PII**（联系官不入库、买方是机构），DISABLED 仅因「真测未过」。→ **真测绿后可直接翻 ENABLED，无需你签 LIA/DPIA**（除非你希望对任何新外部源都走签署门）。← **请确认这个区分。**
4. **NAICS↔ISIC crosswalk**：已种 ISIC，官方有 Census ISIC↔NAICS concordance。`resolveIcpToNaics` 可复用「industry→ISIC→NAICS」而非只靠新 `crosswalk.naics`——减少种子工作量。实现期评估。
5. **PSC（ClassificationCode）作为 NAICS 的补充匹配键**：SAM 同时有 NAICS 和 PSC（产品服务码）。P4 先用 NAICS（与 ICP 行业解析一致）；PSC 作为未来精修（有些机会 NAICS 宽、PSC 更准）。
6. **DAT-011 / 保留期**：Sources Sought 含 `ResponseDeadLine`——过期（deadline 已过 + TTL）的信号走既有 `expireStaleSignals` + recompute 收敛，无新机制。

---

## 8. 落地步骤（TDD，功能默认 DISABLED）

0. **真探 delta 文件名 + keyless 仍通**（承 §2；实现第一步再确认一次，防端点漂移）。
1. **词表**：`CanonicalNode.crosswalks.naics` + NAICS 子树种子（curated）。RED 单测 `resolveIcpToNaics`。
2. **adapter** `sam-api.ts`（CSV 303→S3 流式解析 + Type 过滤）。
3. **摄取层**：`signal-mappers`（`mapSamSourcesSought` + 常量）、`signal-query`（`canonicalSamSpec`）、`signal-ingest`（`ingestSam`）、`source-tools`（`samgov.search`）。RED→GREEN 单测（PII 剔除是重点断言）。
4. **投影层** `sam-intent-projection.service.ts` + `naicsOverlap`。单测镜像 ted-intent。
5. **收敛** `intent-recompute` samgov 面。单测。
6. **编排** `external-intent.{activities,workflow}` 全链接线 + `provider.registry` seed（DISABLED + source_policy）。
7. **本地必绿**：`db generate`（无迁移）→ `api build`（tsc）→ `api test`（vitest）。
8. **真测** `verify-sam-sources-sought.mts`（真 CSV、无 sandbox、app_user guard）。
9. **对抗复审**（PII 剔除 / 决定论 / 收敛 / 幂等 / SUSPENDED）→ 处置 → PR 到 main（默认 DISABLED，PR 里提醒 ops 真测绿后翻 ENABLED）。

---

## 9. 与既有线的关系

- 是买家智能 P1「免费外部源」里 **TED v3 线的 P4 = SAM.gov Sources Sought**（AGENTS.md §6）——早于 TED 招标/openFDA 清关的**招标前**意图。
- 复用管线**零新 SourceClass**（归 `public_intelligence`），零 schema 迁移，纯增量。
- 后续：P4.x Award notice（中标 prime=可成单客户，走个体户拒收）· PSC 精修 · 品类市场意图聚合层（§7.2）。

---

## 10. 实测记录（2026-07-14，真库真 CSV，无 sandbox）—— ✅ 全绿

§8 步骤 0-9 全落地。`verify-sam-sources-sought.mts` 六段全过（真 keyless CSV 下载）：

- **Tier 0 词表+RLS**：RLS 连接非 superuser（withWorkspace 真生效）；泵 ICP→广锚 `333`；`resolveNaicsForProduct('pumps',['333'],allowLlm:false)`→`333914`（seed 别名**确定性**精修，零 LLM）；EU-only ICP→零 NAICS（US 市场门）。
- **Tier 1 真 CSV**：近 120 天取最新 300 条 Sources Sought（真机构：Air Force / VA / Navy / DoD / NIST）；每条发布日 ISO 合法；🔴 序列化**零邮箱、零 PrimaryContact/SecondaryContact**（adapter 只读绿列，结构性隔离）。实测 NAICS 2 位前缀 top1 = `33`（制造）——联邦 Sources Sought 制造品类不稀疏，放宽兜底未触发。
- **Tier 2 摄取+投影**：ingest 300→262 signal（38 条无 NAICS 显性 `no_taxonomy` 跳过，不静默丢）；制造 ICP `[333,334,3391,332]` 投影匹配 78 signal→**12 家联邦机构买方 canonical**（VA/NIST/DLA/Army/Indian Health Service）；全 `country=US`、`government_buyer`、`sam_market_signal`、`sam_disclaimer`；event `US_FED_SOURCES_SOUGHT` strength 0.7；field_evidence `license='Public Domain (U.S. Government Work)'`（署名非义务）、无邮箱。
- **Tier 2b 幂等**：同参再投影 companiesTouched=0/eventsProjected=0，field_evidence 24→24（不堆行、evidence 形状 projectOne↔recompute 一致）。
- **Tier 3 评分**：Intent 维 0→0.683、**demandProof 0→0.683**、intentSignals 含 `US_FED_SOURCES_SOUGHT`、总分 0.1425→0.245。
- **Tier 4 §8.8 负向门**：`sam.gov` policy SUSPENDED → `ingestSam` fail-closed（`ToolPolicyDenied`，零落库、不发请求）。

**实现期两处主动精修**（真测/复审发现，非原设计）：
1. **`US_FED_SOURCES_SOUGHT` 接进 `DEMAND_PROOF_EVENT_TYPES`**（`lead/scoring.ts`）：Sources Sought = **买方侧**需求（招标前市场调研=最早需求证据），与 TED `TENDER_PUBLISHED` 同类，应驱动 demandProof 观测维（`FDA_CLEARANCE` 属卖方侧上市时机，仍只留 Intent 维）。demandProof 不进 totalScore（观测维零权重）→ 六维总分不变，仅快照预留槽填数值。
2. **`samBuyerName` 折叠 Department==Sub-Tier**（`signal-mappers.ts`）：SAM 常把部级机构两列同名（"VA — VA"）→ 折叠单值，避免冗余身份与 dedupeKey 抖动。

**质量**：`db generate`（零迁移）→ `api build`（tsc）→ `api test`（vitest **1048 全绿**，94 文件）→ 真测六段全绿。翻 `data_provider.samgov` ENABLED 免 LIA/DPIA（**不物化 PII**，同 TED/openFDA 档）——ops 显式动作。
