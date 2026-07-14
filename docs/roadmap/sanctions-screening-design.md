# 制裁名单筛查 —— Qualify 第五门设计（出口管制合规硬门）

> 状态：**设计待认可**（2026-07-14）。四项方向已拍板（AskUserQuestion）：**① Phase 1 仅公司/实体**；**② 名单集=OFAC(SDN+Consolidated)+EU FSF**；**③ 命中处置=第 5 队列 `sanctions_hold` + 审计件 + `decide(accept)` 硬拦**；**④ 复筛=qualify+decide 筛 + 名单每日刷新**（存量 delta 复筛=Phase 1.5）；**⑤ 上线=种子 DISABLED，真测绿后 ops 翻 ENABLED**。
> 承重假设已**真探证实**（见 §2，OFAC SDN 一手拉取；EU token 研究证实），未动任何代码。落地走 TDD + 真测 + 对抗复审 + PR。
> 对标：`docs/roadmap/sam-sources-sought-p4-design.md`（近期同格式立项 spec）、`docs/implementation-records/openfda-provider-spec.md`（公共领域源 + 个体户拒收先例）。上位决策：`docs/adr/registry.md` **ADR-010**（「（待拍板）制裁名单筛查作 qualify 第五门」——本文即其落地）、ADR-005（执行门/Broker）、ADR-006（Evidence/Signal 事实源）。
> 参考实现（**只借代码思路，绝不摄入其聚合数据**，见 §5 许可硬阻断）：**moov-io/watchman**（Go, Apache-2.0，OFAC/EU/UK 全管线 + Jaro-Winkler）、`opensanctions/nomenklatura`（Python, MIT，匹配逻辑）。

---

## 0. 定位与边界（已认可）

- **是什么**：把发现/资格阶段的**目标公司名**，比对官方制裁/禁止交易名单（OFAC SDN + OFAC Consolidated + EU FSF），**命中 → 进隔离队列人工复核**。作 qualify 的**第五道合规硬门**（在六维评分 + 四门 fit-judge 之侧）。
- **为什么在本仓**：制裁筛查 = 产品核心承诺「**合规可用**」的一部分（`product-scope.md §1`），LeadQualifiedPackage 明列交付「合规结论」（§术语表）。边界判据「动『挖、并、证、分、存』是本仓」——筛查=「证/分/存」，在界内。**不越界**（QGO/触达/裁决归 SaaS）。
- **定位 = 合规硬门/阻断，非评分维度**：与 TED/openFDA/SAM（喂六维分的 **intent 信号**）**本质不同**。制裁命中不是「低分」而是「**合规硬停**」——降分仍可能被交付，转嫁出口管制风险。故**不进 `scoring.ts` 六维**，走独立门 + 独立处置 + 硬拦交付。
- **边界（Phase 1）**：
  - **仅筛公司/实体**：只比对目标 `canonical_company` 名 vs 名单 `sdnType=Entity` 条目。**个人决策人筛查 + OFAC 50% 股权穿透 = Phase 2 单独立项**（个人数据匹配面更大）。
  - 只摄 OFAC(SDN+Consolidated) + EU FSF（美+欧两大主源）。**UK FCDO + UN = Phase 1.5**（都免费，parser-per-list 增量便宜）。
  - **人在环、不自动裁决**：命中 → `sanctions_hold` 隔离队列 + 人工复核，**绝不自动定罪/自动拉黑**（误报会误伤合规公司），也**绝不自动交付**（漏报会把风险推给客户）。
  - 止于 qualify 门 + LeadQualified 快照的合规结论字段（与平台边界一致）。

---

## 1. 为什么 = 转嫁风险的双向严重性

| 错误 | 后果 | 设计对策 |
|---|---|---|
| **假阴性**（漏掉真制裁对象） | 把被制裁公司推荐给客户 = **转嫁出口管制风险**（客户可能违反 OFAC/EU 制裁） | 召回优先（宁多报进人工队列）；名单每日刷新；`decide(accept)` 硬 re-check（不可绕） |
| **假阳性**（误伤合规公司） | 错误隔离合法客户，误伤增长 | 人在环复核；弱别名不作首要键；国别背离降分；已清标记抑制（false positive 不复发） |

两类错误都严重 → **高精度 + 召回优先 + 人工复核 + 可审计**（命中留证据痕）。

---

## 2. 承重假设已真探证实（2026-07-14，无 sandbox）

1. **OFAC SDN 一手拉取 ✅**：`GET https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML`（`-L` 跟 302 + **User-Agent 必带**，无 UA 拿空/403）→ **200 text/xml，28.7 MB，`Record_Count 19156`，`Publish_Date 07/13/2026`（日更，`Last-Modified` 当日）**。`CONSOLIDATED.XML` 同渠道亦活。
2. **Entity/Individual 结构性分型 ✅**（实测计数）：`<sdnType>` = **Entity 9810 / Individual 7505 / Vessel 1497 / Aircraft 344**。→ **Phase 1 companies-only = 摄取层白名单只留 `sdnType=Entity`，drop 全部 7505 Individual**——天然不存 person PII，红线「具名个人默认隔离」由构造满足。
3. **强/弱别名结构性可辨 ✅**（实测 XML）：`<akaList><aka>` 每条带 `<category>strong|weak</category>` + `<type>a.k.a.</type>`；条目带 `<programList><program>`（制裁项目/regime，如 CUBA）+ `<addressList><country>`（国别佐证）。→ 匹配设计可直接消费强/弱别名区分。
4. **EU FSF 免鉴权可达 ✅（研究证实）**：`webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw`（=base64`"token-2017"`，**固定公开 token 非人肉密钥**，EU 自家 RSS 索引 `.../fsf/public/rss` 公布）。EU Login 墙只挡 portal UI，不挡 token 文件端点。分 person/entity 分型。
5. **零阻断名单 ✅**：所有源免费、无付费 license、无不可得 token。**唯一真阻断 = 绝不把 OpenSanctions 聚合数据当免费商用**（见 §5）。

> ⚠️ 实现期再确认：**EU FSF 的 EU 自有再用许可**（大概率 Decision 2011/833/EU=CC-BY 式，研究未逐字证实，5 分钟核 FSF User Manual）；**名单增量/版本水位**（OFAC 无 delta 文件 → 每日拉全量 28MB **流式过滤 Type=Entity** 控内存，`contentHash` diff 只落变更）；**UN URL 我实测 404**（研究说 302→签名 blob，Phase 1.5 接入时重探）。

---

## 3. 机制：镜像**两套**已有模式（非 intent 管线）

制裁镜像的是**参考数据摄取（采集层）** + **qualify 硬门（评分队列/decide 存储门）**，**不**镜像 TED/FDA 的 intent 投影。

```
[A 摄取/刷新]  Temporal Schedule（每日）→ sanctionsRefreshWorkflow
  └─ 逐 source（ENABLED）: broker.invoke('sanctions.download', {UA})  ← ADR-005 出网门 + source_policy fail-closed + SUSPENDED kill-switch
        → 流式 parse（OFAC XML / EU FSF XML）→ 白名单只留 sdnType=Entity（drop Individual）
        → normForMatch 归一 → upsert sanctions_entity（by source+externalId，contentHash diff）
        → 更新 sanctions_source（publishDate/recordCount/lastRefreshedAt/status 审计）
[内存索引]  SanctionsScreeningService 初始化 + 每次刷新 → 从 DB 建进程内索引（~3万条，毫秒级匹配）

[B qualify 第五门]  对目标公司名 screen（复用 name-match，召回优先）
  ├─ qualify 时（评分侧）: 命中 → 写 sanctions_screening_result（potential_match）→ Lead.queue='sanctions_hold'
  └─ decide(accept) 硬 re-check: 未决命中 → throw SANCTIONS_HOLD_UNRESOLVED（绝不建/发快照）
        清白 → 快照合规结论 sanctions_screening={status:clear, screened_at, lists, list_versions}
```

**与采集层/评分的复用点**：`AcquisitionService.acquire`（fetch→clean→diff→persist→审计）的**流程范式** + `ensure-schedules.ts` SPECS **Schedule 范式**（env 可调/overlap=SKIP/worker 幂等自愈）+ `broker.invoke` **出网门** + `DiscoveryProviderRegistry.seed(ownerDb)` **owner 连接种子** + `pickBestByName`/`normForMatch` **匹配核心** + `scoring.ts` **队列覆盖优先级** + `lead.service.decide` 的 `STORAGE_RIGHTS_NOT_GRANTED` **硬拦范式**。

**不复用 `monitored_source`/`source_entity` 表**：语义混淆（发现到的公司线索 vs 筛查参考的被制裁实体同表），且**风险**——一个 bug 可能让被制裁实体泄进 discovery/lead 路由。故**专用表**，物理隔离。

---

## 4. 落地触点（grounded；file:锚点来自代码勘查）

### 4.1 Schema（3 表 + 1 迁移）

| 表 | RLS | 说明 |
|---|---|---|
| `sanctions_source`（平台级，无 RLS，`GRANT SELECT app_user`） | 否 | 名单注册：`key`@unique(`ofac_sdn`/`ofac_consolidated`/`eu_fsf`)、`url`、`format`、`license`、**`status` DISABLED/ENABLED**(kill-switch)、`publishDate`、`recordCount`、`lastRefreshedAt`、`lastFetchStatus`、`config` Json。镜像 `data_provider`(schema L342) + `monitored_source` 审计列。 |
| `sanctions_entity`（平台级，无 RLS，`GRANT SELECT app_user`） | 否 | **只落 Entity**：`sourceId`、`externalId`(OFAC uid/EU logicalId)、`primaryName`、`normalizedName`(normForMatch，`@@index`)、`country`、`programs` Json、`aliases` Json(`[{name,normalizedName,quality}]`)、`listVersion`(=publishDate ISO)、`rawFeatures` Json(仅绿：地址国别/机构 ID，**无 person PII**)、`firstSeenAt/lastSeenAt/withdrawnAt`、`contentHash`。`@@unique([sourceId, externalId])`。 |
| `sanctions_screening_result`（**租户级，RLS**） | 是 | `workspaceId`、`canonicalCompanyId`、`screenedName`、**`status`** clear/potential_match、`matches` Json(`[{sourceKey,externalId,listVersion,matchedName,aliasQuality,score,entityCountry}]`)、`topScore`、**`reviewState`** open/cleared_false_positive/confirmed_true_hit、`reviewedBy`、`reviewNote`、`screenedAt`、`listVersions` Json。`@@index([workspaceId,canonicalCompanyId])`、`@@index([workspaceId,reviewState])`。镜像 `field_evidence`(schema L747) RLS + `withWorkspace`。 |

> 平台表避 RLS = 迁移里 `GRANT SELECT ... TO app_user` 无 policy（镜像 `20260706191721_canonical_taxonomy` 迁移 L43-44）；owner 连接写（`worker.ts` L46 `ownerDb`）。租户表 `ENABLE+FORCE RLS ... USING(workspace_id=current_workspace_id())`（镜像 `20260706033625_rls_and_app_role`）。

### 4.2 代码触点（~14 处）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `sanctions/adapters/ofac-xml.ts`（新） | `parseOfacSdn(xml)`/`parseOfacConsolidated(xml)`：流式过滤 `sdnType=Entity` → `{externalId, primaryName, country, programs, aliases:[{name,quality}], listVersion}`。**drop Individual/Vessel/Aircraft**（Phase 1 只 Entity；Vessel/Aircraft=资产非公司，Phase 1.5 评估）。用成熟流式 XML 库（`sax`/`fast-xml-parser`，free-first）。 |
| 2 | `sanctions/adapters/eu-fsf-xml.ts`（新） | `parseEuFsf(xml)`：FSF schema，只留 entity subject（drop person），映射同上。token 在 URL（config）。 |
| 3 | `tools/source-tools.ts` | 新 L0 工具 `sanctions.download`：`sourcePolicy:'required'`，`personalData:true`（原始含个人，摄取层结构剔），`allowedPurpose:['sanctions_screening']`，**内建 `User-Agent`**（OFAC 403 gotcha）。加入 `registerSourceTools`。新 `SanctionsDownloadInput/Output` 类型。 |
| 4 | `sanctions/sanctions-refresh.service.ts`（新） | `refreshSource(sourceKey)`（镜像 `AcquisitionService.acquire` L33）：`broker.invoke('sanctions.download',{url,ua},{workspaceId:PLATFORM_WORKSPACE,purpose:'sanctions_screening'})` → parse → `sanctions_entity` upsert(contentHash diff、absence→withdrawnAt) → `sanctions_source` 审计更新。owner 连接写。fail-safe：单源失败不阻断其余。 |
| 5 | `sanctions/sanctions-screening.service.ts`（新） | 内存索引（init + refresh 后重建，从 `sanctions_entity` 读全量建 normalizedName→entities 映射）+ `screen(name,country): ScreenResult`。匹配见 §4.3。`OnModuleInit` 建索引。 |
| 6 | `sanctions/sanctions.module.ts`（新） | NestJS 模块，导出 `SanctionsScreeningService`，供 `LeadModule` 注入。 |
| 7 | `lead/scoring.ts` | `ScoreLeadOpts` 加 `sanctionsHold?: boolean`；队列逻辑（L187-202）**最高覆盖优先级**：`sanctionsHold → queue='sanctions_hold'`（压过 exclude/authoritative/阈值，镜像 EXCLUSION 优先）。`LeadScoreResult.queue` 联合类型加 `'sanctions_hold'`（String，migration-free）。 |
| 8 | `lead/lead.service.ts` `qualify`/评分路径 | 评分前对公司 `screen()`→命中写 `sanctions_screening_result(potential_match)` + 传 `sanctionsHold:true` 进 `scoreLead`。fit-judge/backlog sweep 两路径共享（`fit-judge.ts` 同款抽出）。 |
| 9 | `lead/lead.service.ts` `decide` | `accept` 时（快照前，镜像 `STORAGE_RIGHTS_NOT_GRANTED` L171-189）读该公司最新 `sanctions_screening_result`：`reviewState=open` 的 potential_match/confirmed_true_hit → **throw `SANCTIONS_HOLD_UNRESOLVED`**（绝不建快照）。 |
| 10 | `lead/lead-qualified-snapshot.ts` | 快照加合规结论 `sanctions_screening: {status:'clear'|'not_screened', screened_at, lists:[], list_versions:[]}`（清白才 accept 到此）。**追加非破坏字段**，`snapshot_version` 仍 1（同 demand_proof 先例 L14-17）。⚠️ 契约先报 B/A（product-scope §6）。 |
| 11 | `lead/lead.service.ts` `queueSummary` + controller | `queueSummary`(L225) 联合加 `sanctions_hold`；新增 `POST /leads/:id/sanctions-review`（复核裁决：cleared_false_positive→回落六维队列重评+已清抑制 / confirmed_true_hit→留 hold）。B 读端点套统一信封。 |
| 12 | `temporal/understanding.constants.ts` + `ensure-schedules.ts` | 新 `SANCTIONS_REFRESH_SCHEDULE_ID`/`WORKFLOW` 常量对 + `SPECS` 一条（`everyEnv:'SANCTIONS_REFRESH_EVERY'`，`everyDefault:'24h'`，overlap=SKIP）。`sanctions-refresh.{workflow,activities}.ts`（新，`proxyActivities` + `createSanctionsRefreshActivities` 挂 `worker.ts`）。worker 启动幂等自愈（镜像现 4 Schedule）。 |
| 13 | `sanctions/sanctions.registry.ts`（新）或 `provider.registry.ts` seed | `sanctions_source` 三行 seed（`update:{}` 不覆盖 ops 手改，**status DISABLED**，见 §6）；`source_policy` 三域(`sanctionslistservice.ofac.treas.gov`/`webgate.ec.europa.eu`)：`sourceType='sanctions_list'`、`personalData:true`、`allowedPurpose:['sanctions_screening']`、notes=公共领域/CC-BY + 「只公开端点不爬 UI」+ 「Individual 摄取层剔除」。owner 连接 seed（`worker.ts`/`outbox-relay` onModuleInit）。 |
| 14 | `tools/tool-contract.ts` purpose 词表 | 加 `'sanctions_screening'` purpose（现有 discovery/enrichment/intent 之外）。 |

> **测试（TDD，CI 纯单测）**：parser（Entity-only 过滤/别名强弱/drop Individual/EU entity-only）· 内存索引匹配（精确归一/token 召回/弱别名不originate/国别背离降分/多候选全返）· scoring `sanctions_hold` 覆盖优先级 · decide 硬拦（open hit→throw）· 复核状态机（cleared→回落+抑制）· refresh diff（contentHash/absence）· snapshot 合规字段。
> **真测** `scripts/verify-sanctions-screening.mts`（真库、真 OFAC 拉取、无 sandbox、`app_user` `is_superuser` guard）：真拉 SDN→只落 Entity(证零 Individual)→对已知条目名筛出命中+对清白公司筛 clear→`sanctions_hold` 队列→decide 硬拦→复核清白回落→幂等→`source_policy` SUSPENDED→refresh fail-closed 零落库。

### 4.3 匹配算法（召回优先，复用 `name-match.ts`）

- **归一**：复用 `normForMatch`（剥法人形式词 + NFC + alias-aware，`name-match.ts` L17）。
- **候选**：**精确归一名匹配**（最强）**或** token 相似度 `nameScore`（L28）**≥ 召回阈值**（env `SANCTIONS_MATCH_THRESHOLD` 默认 **0.70**，业界起点；高置信 ≥0.85）→ **返回所有超阈候选**（非仅最佳——多个疑似都要人审，与 `pickBestByName` 取唯一最佳相反）。
- **别名**：筛 `primaryName` + **强别名**；🔴 **弱别名（`quality=weak`）绝不 originate 命中**（OFAC FAQ 124 明确不要求按弱别名筛）——只用于**升高**已有命中置信。
- **国别佐证**：公司 country 与制裁实体 country 一致 → 升分；背离 → 降分（**但不自动清**，公司可迁址）。仍超阈 → 进人审。
- Phase 1 **token-based（复用已有）**；Jaro-Winkler（OFAC 自家工具用，抓短编辑距离 typo）作 §7 Phase 1.5 增强。

---

## 5. 合规红线

- 🔴 **OpenSanctions 聚合数据 = CC-BY-NC = 商用硬阻断**（需付费 license，三档 quote-only）。**绝不摄入其聚合数据**。其**代码**（yente/nomenklatura MIT）可借逻辑。→ **直连官方源自建 feed**（OFAC 公共领域 17 USC §105 / EU CC-BY 待核 / UK OGL v3.0），既合规又省钱。
- 🔴 **具名个人默认隔离（ADR-010 永久红线）**：Phase 1 摄取层**结构性 drop 全部 `Individual`**（实测 7505 条），`sanctions_entity` **只存实体事实**，`rawFeatures` 白名单只留绿字段（地址国别/机构 ID），**无 person PII 入库、不写 Trace/日志/Prompt**。个人筛查（Phase 2）即便做，也**瞬时比对不物化**，只留「命中判定 + 名单条目 ref + 名单版本」审计件（研究 Part D 姿势）。
- **筛查合法依据**：GDPR **6(1)(c) 法律义务 / 6(1)(f) 正当利益**（制裁/AML 法要求筛查，公认合法处理）。`DataRightsService` 记 LIA（若判需要）；筛查主体=公司（非个人）→ 个人数据面最小。
- **许可署名**：`sanctions_source.license` + `field_evidence.license` 存来源许可（OFAC=公共领域署名非义务 / EU=CC-BY 若证实则署名 / UK=OGL 署名）。`resolveEvidenceLicense`(evidence-license.ts) 复用。
- **访问纪律**：只经官方公开端点（token 文件/下载 API），**绝不爬 portal UI、绝不碰敏感端点**。`source_policy` 显性登记，SUSPENDED = broker 单点全链停抓（kill-switch）。OFAC 请求**必带 User-Agent**。
- **不自动裁决红线**：命中**绝不自动定罪/拉黑/删除**——只进 `sanctions_hold` 隔离队列 + 人工复核。误报误伤合规公司，故**人在环**。命中留**可审计证据**（名单/条目/版本/分数/匹配名+别名+quality/时刻/复核人）。

---

## 6. 关键决策 + 拍板值（用户 2026-07-14 AskUserQuestion 已认可）

| 决策 | 拍板 | 理由 |
|---|---|---|
| **筛查对象范围** | **仅公司/实体** | 直击核心风险「别把被制裁公司推给客户」；个人数据面最小；一周量级。个人+股权穿透=Phase 2。 |
| **名单集合** | **OFAC(SDN+Consolidated) + EU FSF** | 覆盖美+欧两大主源；3 parser 最紧凑。UK FCDO + UN = Phase 1.5（免费、UK 许可干净）。 |
| **命中处置 + 拦截点** | **第 5 队列 `sanctions_hold`（migration-free String）+ 审计件 + `decide(accept)` 硬拦** | 可见（隔离队列）+ 可审计（审计件）+ 不可绕（decide 硬 re-check 绝不交付）。非评分维度（制裁是硬停非低分）。 |
| **复筛节奏** | **qualify 时筛 + decide 硬 re-check + 名单每日刷新** | 覆盖「今天干净下周被列」：新 lead 每次经门，名单每日新鲜。存量已交付线索 delta 复筛 + `SanctionsStatusChanged` 事件 = Phase 1.5。 |
| **上线开关 + 未启用行为** | **种子 DISABLED，真测绿翻 ENABLED；未启用时快照标 `not_screened`、门不拦** | 镜像 SAM/patents「未测不路由」；不断管线（诚实报 not_screened）。Phase 1 无 person PII → 翻 ENABLED **免 LIA/DPIA**（同 SAM/openFDA 档）。启用后=硬门（hit→block）。 |
| 匹配召回阈值 | `SANCTIONS_MATCH_THRESHOLD` 默认 **0.70**（高置信 0.85），env 可调 | 业界召回优先起点；宁多报人审。 |
| 刷新周期 | `SANCTIONS_REFRESH_EVERY` 默认 **24h**，env 可调 | OFAC 日更；名单无 delta → 每日全量流式过滤。 |

---

## 7. 主动提出（没问但联想到的）

1. **⚠️ 未启用时「fail-open」的诚实姿势 = 需运营纪律**：种子 DISABLED 时门不拦（快照 `not_screened`），是为不断管线。但**这意味着上线到翻 ENABLED 之间，交付的包未经制裁筛查**。→ 建议：**R1 发送上线前必须翻 ENABLED**（类比「删除编排先于发送」时序门）；快照 `not_screened` 应在 B/A 侧显性告警，SaaS 不得对 `not_screened` 的包做对外触达。← **想确认这条时序门是否要写死。**
2. **OFAC 50% 规则的 Phase 1 盲区**：公司本身未上名单、但其**受制裁个人所有者持股 ≥50%** 时，公司**亦被视为受阻断**（即便不在名单）。Phase 1 companies-only **抓不到**此类。→ 文档化为**已知限制**，Phase 2（个人 + GLEIF 母子关系穿透）补。**不宜静默**（合规上是真缺口）。← **请确认接受 Phase 1 此限制。**
3. **匹配可解释性 + 复核工效**：隔离队列的人审需要**为什么命中**（匹配名/别名/分数/名单/项目/国别对比）一屏可见，否则复核变负担、误报疲劳。→ `sanctions_screening_result.matches` 存足够解释字段；复核端点返结构化对比。建议 R1 前端「隔离队列」页专门设计（非通用 lead 卡）。
4. **Jaro-Winkler 增强（Phase 1.5）**：Phase 1 token-based（复用 `name-match`）对**词序/多词**实体名够用，但对**短编辑距离 typo**（如 "Gazprom" vs "Gasprom"）弱。JW 是 OFAC 自家工具算法。→ Phase 1.5 加 JW 作第二 scorer（~30 行手写或 `natural` 库），与 token 取 max。
5. **音译/非拉丁名**（Phase 1.5+）：制裁对象含俄/阿/中文实体，`normForMatch` 只 NFC 折音符，不做 Cyrillic/Arabic→Latin 音译。→ Phase 1 覆盖拉丁化名（名单多提供拉丁转写主名）；ICU 音译作后续。文档化。
6. **名单版本审计 + backtest**：每次筛查记 `listVersions`（publishDate），使「为何当时判 clear」可复算/可审计（监管抽查刚需）。已在 schema。
7. **UK 源已迁移（2026-01-28）**：Phase 1.5 接 UK 时用 **FCDO UK Sanctions List**（gov.uk 静态 URL）**非旧 OFSI**（已冻结）；UN URL 我实测 404、研究说 302→签名 blob，**实现期需重探**。
8. **误报抑制的存量交互**：`cleared_false_positive` 后，未来对**同一 (公司, 名单版本)** 应抑制不复发命中（避免复核疲劳）；但名单**新版本**出现同名新条目时应重新命中（不能永久白名单一个名字）。→ 抑制键 = (canonicalCompanyId, sourceKey, externalId)，非按名字。已在设计考量。

---

## 8. 落地步骤（TDD，功能默认 DISABLED）

0. **真探复核**（承 §2）：实现第一步重确认 OFAC keyless+UA 仍通、EU token 仍效、EU 许可核实（5 分钟）。
1. **Schema**：3 表 + 迁移（平台表 `GRANT SELECT`、租户表 RLS）。`db generate`。
2. **adapters** `ofac-xml.ts`/`eu-fsf-xml.ts`（流式 Entity-only 解析）。RED→GREEN 单测（**drop Individual 是重点断言**）。
3. **工具 + 出网门**：`source-tools.ts` `sanctions.download`（UA 内建）、`tool-contract.ts` purpose、`source_policy` seed。
4. **刷新层** `sanctions-refresh.service.ts`（镜像 acquire diff）。单测（contentHash/absence/fail-safe）。
5. **筛查层** `sanctions-screening.service.ts`（内存索引 + 召回匹配）+ `sanctions.module.ts`。单测（精确/token/弱别名不originate/国别/多候选，是核心断言）。
6. **qualify 接线**：`scoring.ts` `sanctions_hold` 覆盖 + `lead.service` 评分侧 screen + 写审计件。单测。
7. **decide 硬拦** + 快照合规字段 + 复核端点 + `queueSummary`。单测（open hit→throw、cleared→回落+抑制）。
8. **编排** `sanctions-refresh.{workflow,activities}` + Schedule 常量/SPECS + `provider.registry`/`sanctions.registry` seed（DISABLED）。
9. **本地必绿**：`db generate` → `api build`(tsc) → `api test`(vitest)。
10. **真测** `verify-sanctions-screening.mts`（真库真 OFAC、无 sandbox、`app_user` guard）。
11. **对抗复审**（drop Individual/召回阈值/弱别名/decide 不可绕/幂等/SUSPENDED fail-closed/无 person PII 残留）→ 处置 → PR 到 main（默认 DISABLED，PR 提醒 ops 真测绿翻 ENABLED；快照契约先报 B/A）。

---

## 9. 与既有线的关系

- 是 qualify 的**第五门**（六维评分 + 四门 fit-judge 之侧），ADR-010「（待拍板）制裁名单筛查作 qualify 第五门」的落地。
- 复用管线**零新 SourceClass**（专用 `sanctions/` 域），仅 1 迁移（3 表）+ ~14 触点，与 intent 投影管线**解耦**（制裁非信号）。
- 强化封版风险护栏「数据权利违规数（恒 0）」+「0 未授权动作」的合规姿势。
- 后续：**Phase 1.5**（UK FCDO + UN 源 · Jaro-Winkler · 存量 delta 复筛 + `SanctionsStatusChanged` 事件 · 隔离队列前端）· **Phase 2**（个人决策人筛查 + OFAC 50% 股权穿透，复用 GLEIF 母子关系）。

---

## 10. 实测记录（实现后填，2026-XX-XX，真库真 OFAC，无 sandbox）

_（TDD + 真测 + 对抗复审完成后追加：各段实测结果、质量数据、翻 ENABLED 条件。）_
