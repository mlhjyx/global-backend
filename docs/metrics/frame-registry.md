# frame registry v1（19 法域矩阵）

> 文档 ID：`METRICS-FRAME-REGISTRY-001`
> 版本：`v1.0`（2026-11-09）
> 生命周期：`DRAFT`（尚无任何 frame 快照接入；PR-11/PR-12 之前全部 DRAFT）
> 状态：`DRAFT`
> 机器真值：`docs/metrics/frames/frame-registry.v1.json`；校验器 `scripts/metrics/frame-registry.mjs`（`node scripts/metrics/frame-registry.mjs`）
> 依据：ch01 §3.3（分母定义、frame 登记字段、19 法域总表与逐国登记）；本页是矩阵视图，逐国细节（限流、坑、许可原文）见 ch01 §3.3.3，接入前必须重核官网与法务。

**frame 的定义（ch01 §3.3.1）**：一份「可枚举的实体名单 + 明确的纳入/排除规则 + 快照时间 + 许可」。没有这些，名单只是数据，不是分母。`canonical_company` 不是 frame；frame 是市场的分母候选，用于召回抽样（`company_recall_vs_frame`）与 capture-recapture。

## 1. 19 法域主矩阵

> 优先级：1 = 第 1–3 周接入；2 = 第 4–6 周；3 = 观察。规模为 ch01 检索口径（2026-11），引用前重核。

| # | 法域 | frame_key | 主 frame | 获取方式 | 许可 | 更新 | 规模/备注 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | GB | `uk-companies-house-basic` | Companies House BasicCompanyData + PSC + officers | 免费批量 CSV + REST API | OGL v3（表述不一致，法务复核） | 月度 | 2025-03-31 登记 5,427,787 / 有效 4,872,293；55 列无网站/邮箱 | 1 |
| 2 | FR | `fr-sirene-inpi` | INSEE Sirene + INPI RNE + annuaire-entreprises | 免费批量 + API | Licence Ouverte 2.0 | 月度/日更 | SIREN/SIRET 硬键；含 dirigeants；`diffusionCommerciale=false` 必须尊重 | 1 |
| 3 | DE | `de-offeneregister` | OffeneRegister（历史）+ Unternehmensregister（mass download 待核） | 免费下载 | CC BY 4.0 | 不定期 | >500 万家（2017–2019 快照）；无官方结构化检索 API | 1 |
| 4 | IT | `it-registro-imprese-hvd` | Registro Imprese / InfoCamere HVD | API + 分块下载 | HVD 开放许可（EU 2023/138） | 不定期 | 约 600 万经济主体；REA 号做键；完整登记簿收费 | 2 |
| 5 | ES | `es-borme` | BORME（BOE 开放数据 API） | 逐日 XML | BOE 开放数据 | 日更 | 2009 至今事件流，无 bulk；需重建公司时间线 | 2 |
| 6 | NL | `nl-kvk` | KVK Handelsregister API | 付费 API | KVK API 协议 | 实时 | €6.40/月 + €0.02/查询（采购前核官网；本波不采购） | 2 |
| 7 | BE | `be-kbo-open-data` | KBO/BCE Open Data | 注册后 ZIP | KBO Open Data 许可 | 月度 | 仅 active、仅当前值；个人数据不得直接营销 | 2 |
| 8 | CH | `ch-zefix-uid` | Zefix + UID Register + opendata.swiss | API（禁 bulk） | 开放政府数据（须署名） | 日更 | Zefix 仅单条查询；全量靠 opendata.swiss 核心数据 | 2 |
| 9 | NO | `no-enhetsregisteret` | Brønnøysund Enhetsregisteret | 免费 API + 每日 bulk | NLOD 2.0 | 每日 | 约 117 万主体 + 87 万子单位；change feed 回溯 2018 | 1 |
| 10 | FI | `fi-prh` | PRH Open Data / YTJ | 免费 API | CC BY 4.0 | 每日 | 不含个体户/邮箱/电话；iXBRL 财报约 5% | 2 |
| 11 | CZ | `cz-ares-res` | ARES REST + ČSÚ RES | API（全量走 RES） | 开放数据（须署名） | 实时/日更 | ARES 无 bulk（1,000 结果上限）；捷克语变格需归一 | 2 |
| 12 | US-FED | `us-fed-sam-edgar` | SAM.gov Entity + SEC EDGAR + FMCSA/NPPES | API（key/配额） | 美国政府公开数据 | 实时/每日 | SAM 约 889,932 实体（镜像口径）；EDGAR 仅申报主体 | 1 |
| 13 | US-CO | `us-co-business-entities` | Colorado Business Entities（Socrata `4ykn-tg5h`） | 免费 CSV/JSON | CO 开放数据 | 日更 | 1M+ 记录；首批 4 个免费州 CO/CT/AK/OH 之一 | 1 |
| 14 | CA | `ca-federal-corporations` | Corporations Canada Federal Corporations | 每日 CSV + 免 key API | OGL Canada 2.0 | 每日 | 仅联邦注册；批量不含董事姓名 | 1 |
| 15 | JP | `jp-houjin-bangou` | NTA 法人番号（全件 + 差分） | 免费批量 CSV/XML | 公共データ利用規約 1.0 | 月度 + 日次差分 | 2025-12 末指定 5,820,130 / 公表 5,729,508；无行业/规模 | 1 |
| 16 | BR | `br-cnpj` | Receita Federal CNPJ | 免费月度 ZIP | 开放数据（条款待核） | 月度 | 约 2,420 万活跃企业（2025 Q2）；~8 GB 压缩 / 29 GB 解压 | 1 |
| 17 | MX | `mx-denue` | INEGI DENUE | API + 批量 | INEGI 开放数据 | 年度 | 2026-05 版 6,138,075 establishments；94% 微企 | 2 |
| 18 | AU | `au-abn-bulk` | ABR ABN Bulk + ABN Lookup | 免费批量 XML + SOAP | CC BY 3.0 AU | 每周 | 约 1,170 万 ABN（2015 口径，现量待核） | 1 |
| 19 | NZ | `nz-nzbn` | NZBN API + Companies Office Bulk | API + 申请式 bulk | 定制 Bulk Data 协议（非 CC） | 月度 + 实时 | 申请审批有周期；IP 归 Crown，可被暂停/终止 | 1 |

## 2. 跨法域聚合层（不是 frame，只做硬键与交叉验证）

| 源 | 用途 | 规模/许可 | 注意 |
| --- | --- | --- | --- |
| GLEIF LEI Golden Copy | 跨源硬键、集团归属 | 约 293 万活跃 LEI（2025 Q4）；CC0 1.0；每日三次 | 不覆盖中小企业 |
| EU VIES | VAT 有效性校验 | 27 国 + XI；免 key | HTTP 200 ≠ valid（看 `userError`/`actionSucceed`）；`MS_UNAVAILABLE` ≠ invalid |
| Wikidata P856 | 官网域名候选 | 社区维护 | 只作候选，必须回源验证 |

## 3. 登记与接入规则（机器校验已覆盖部分）

1. **准入条件**：`status=ACTIVE` 必须同时具备 `licenseId` 与 `licenseUrl`（校验器 `ACTIVE_WITHOUT_LICENSE`）；`frame_key` 全局唯一；`sourceUrl` 必须 https；每个 frame 至少登记一条 `pitfalls`。
2. **快照**：每次拉取写 `frame_snapshot`（source_url、fetched_at、raw_object_uri、row_count、content_hash、parser_version）；原始文件落对象存储 `frame/<frame_key>/<as_of>/raw.*`，DB 只存元数据与实体引用。状态机 `FETCHING → PARSING → VALIDATING → READY | QUARANTINED | FAILED`，只有 READY 进入抽样与 CR。
3. **抽样核验**：每个 frame 首次接入必须做 200 条人工抽样（字段完整率、名称/地址/注册号正确率、状态正确率），低于 95% 不准入。
4. **对账**：接入必须写「与官方统计口径的差异解释」；注册库 ≠ 市场总体（英国 IDBR 约 270 万 enterprises vs BPE 约 550 万 businesses；德国 Kleingewerbe 不在 Handelsregister）。
5. **许可与合规**：逐源登记 license/ToS；FR `diffusionCommerciale=false`、BE「个人数据不得直接营销」、DE/IT 邮件事先同意是硬门；抓取前过 robots/ToS 审查；单源 kill switch（`status=PAUSED`）。
6. **不采购**：NL KVK、IT 完整登记簿、NZ 审批、OpenCorporates 等付费/申请路径在本阶段只登记不执行；任何采购需产品负责人逐次批准。

## 4. 与计划任务卡的对应

- 本页 + JSON + 校验器 = ch01 **PR-10**（frame 注册 schema 与导入器）的 v1 交付：schema/校验/登记就绪；DB 表（`frame_registry`/`frame_snapshot`）与适配器属 PR-11/PR-12。
- 召回口径（T1-002/T1-003）与 CR（T1-001）使用本矩阵选 frame；接入进度以 JSON 的 `status` 为准，不以本页文字为准。

## 5. 变更流程

frame 新增/状态变更 = 改 JSON 并在 PR 中说明来源与许可；校验器必须在 CI/本地通过（`node scripts/metrics/frame-registry.mjs`）。删除 frame 用 `status=RETIRED`，不删行。
