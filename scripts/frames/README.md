# scripts/frames — registry frame 装载、查询与召回审计（ch03 P2）

> 生命周期：`GUIDE`
> 依据：GainOS v3.0 第 3 章（召回与枚举）；实现与设计说明见 `apps/api/src/registry/`
> 与各 PR 描述。真实注册库接入（T3-04 起）、MinIO/Temporal（T3-03 完整版）、Splink
> （T3-16）、Tier A 人工裁决界面（T3-20）都不在本目录的范围内。

## 目录约定

- `frames/<frameKey>.json` — 帧定义 + 列映射（`registry-frame/v1`，`parseFrameConfig` 校验）；
  `frames/catalog.json` 是帧目录——`frames/` 下每个配置必须登记（`frame-catalog.spec` 强制），
  并声明 fixture 路径与期望装载行数/编号体系。
- `fixtures/` — 装载、查询与审计的样例输入（Companies House 风格 CSV、GLEIF 风格 JSON、
  FR Sirene 风格 `;` 分隔 CSV、US SAM 风格嵌套 JSON、召回审计的 frame/pool/基线/裁决导出），
  全部为虚构数据。
- `import-frame.mts` — CSV/JSON frame 装载 CLI（tsx 运行，owner 连接写平台表）。
- `query-preview.mts` — `registry_frame` 查询契约预览（只读，验证 ICP→过滤条件→候选记录）。
- `recall-audit.mjs` — 召回审计 CLI（Node ≥22.18 原生 type-strip 直接运行，无需构建）。
- `recall-frame-export.mts` — 审计输入之一：把 frame 的 PARSED 快照冻结实体导出为
  `recall-audit.mjs --frame` 输入（含可复算 sha256）。
- `recall-pool-export.mts` — 审计输入之二：把一个 run 的物化产出池导出为
  `recall-audit.mjs --pool` 输入（注册号键来自 `registry_frame` 提供者的 `scheme:number`）。

## 装载

```bash
# 先离线核对映射（不连库、不出网）
pnpm exec tsx scripts/frames/import-frame.mts \
  --frame scripts/frames/frames/gb-companies-house.json \
  --file scripts/frames/fixtures/gb-companies-house.sample.csv \
  --dry-run

# 真正装载（DATABASE_URL 缺省时读 packages/db/.env 的 owner 连接；平台表 app_user 只读）
pnpm exec tsx scripts/frames/import-frame.mts \
  --frame scripts/frames/frames/fr-sirene.json \
  --file scripts/frames/fixtures/fr-sirene.sample.csv

# 装载后跑硬键 + 名称 trigram 链接提案（写 registry_entity_link，软键只落 PROPOSED）
pnpm exec tsx scripts/frames/import-frame.mts ... --propose-links
```

幂等：同一文件（sha256 相同）且 parserVersion 相同直接复用既有 PARSED 快照；实体按
`(scheme, reg_number)` upsert；事件按 `(scheme, reg_number, snapshot_id, change_type)` 唯一键跳过。
PAUSED/ARCHIVED 帧拒绝装载（kill switch）。

## 查询预览（registry_frame 契约）

```bash
pnpm exec tsx scripts/frames/query-preview.mts \
  --country FR --nace 28 --band 10-49,50-249 --limit 20
```

只读；输出 `rationale`（写入计划回执的口径串）、校验后的 filters 与 `ProviderCompanyRecord[]`
（externalId=`scheme:regNumber`、员工带中位数、`attributes.registry` provenance、licence）。
过滤口径见 `apps/api/src/registry/query.ts`：未知 filter 拒绝、country ISO2 必填、只查
`withdrawn_at IS NULL` 且 last_snapshot 仍为 PARSED 的实体、排序固定 `scheme, reg_number`。

行业口径（T3-05 子集）：装载时国家派生行业码（NAF rev2 `28.13Z`、无点号 `2813`）统一归一到
NACE 类目形态 `28.13`，码体系写 `naceVersion`（如 `NAF-rev2`）；查询侧 `--nace 2813` 与
`--nace 28.13` 等价，`industry` 自由词（中/英/德）与 taxonomy 的 ISIC 码经
`apps/api/src/registry/industry-map.ts` 的交叉表确定性映射到 NACE 前缀。
源特有属性经 `mapping.fields.attributes` 采集（≤10 项），例如 FR 的 `diffusionCommerciale`
（`false` = 当事人反对商业推介）会随候选记录流到 `attributes.registry.sourceAttributes`，
由下游触达过滤（P4 抑制联动）消费——查询层不做隐式过滤。

`registry_frame` 同时注册为 discovery provider（`apps/api/src/discovery/providers/registry-frame.provider.ts`，
company_registry 类，data_provider 默认 DISABLED）。A 方案（local_query 血缘变体）已获批并实现：
`REGISTRY_FRAME_PROVIDER=on` 时适配器声明受治理血缘，并按 §3.12.3 之外的 local_query 约定构造
**确定性回执**（producer `registry.query`，operationId 由 runId+queryDigest 派生，resultDigest 为归一
候选集的规范哈希、可从 `registry_entity` 重算；usage 恒 0 / `not_incurred`）。默认 off = 不声明血缘、
计划期计 `SOURCE_LINEAGE_UNAVAILABLE`（测试钉死）；关掉开关即回滚。data_provider 是第二道开关。
实现说明见 `docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md`。

## 域名校验（离线骨架，T3-13）

`apps/api/src/registry/domain/domain-verifier.ts`：给定候选域名 + 已采集的法律页文本，
按 ch03 §3.12.3 做确定性评分（注册号精确 +55 / VAT 精确且 VIES 通过 +35 / 邮编+城市 +20 /
名称相似 ≥0.85 +15、≥0.70 +8 / 域名 token +5；VERIFIED ≥90、AMBIGUOUS 55–89、<55 或负证据
REJECTED）。复用 `parseImpressum`（DE，含法院比对）、内置 FR SIREN/RCS、GB CRN、IT REA（含省）、
ES NIF/CIF、NL KVK、BE KBO、CH UID 抽取（§3.12.9 锚点矩阵）；`VatValidator` 是
VIES 的离线接口（fixture 实现），真实 REST 属执行面。多候选编排：≥2 个候选 ≥55 分 →
全部 AMBIGUOUS（同名冲突），唯一 VERIFIED 才选中；产物可映射为
`company_domain_resolution` 行草案（`toDomainResolutionDrafts`）。本骨架不抓取、不落库。

## 搜索路由与 P856（离线契约，T3-11/T3-12）

`apps/api/src/registry/domain/search-router.ts`：多搜索 provider 的两种调用形态——域名解析强制的
`searchAll`（各 provider 独立成败、URL 去重并集、`degradedFrom` 记录失败路、延迟预算按单路失败计）
与成本优先的 `searchPreferred`（按序回退）；成本按 provider 的 `costPerQueryUsd` 汇总为
`UsageLedgerDraft`（purpose=`DISCOVERY_DOMAIN_RESOLVE`，写账本属执行面）；`ProviderHealthTracker`
实现 §3.14.3 阈值（连续 20 次失败/超 4 天无成功→告警；7 天内 30 次失败→自动停用、路由跳过）。
真实 Brave/Serper/Mojeek HTTP 与密钥属在线部分。

`domain-resolver` 增 `wikidata_p856` 路（rank 2，标签相似 ≥0.85 才采用、最多查 3 个实体），
与 search/CT/CC 并集排序，单路失败隔离。

## 人工复核队列（离线契约，T3-15）

`apps/api/src/registry/domain/domain-review.ts`：AMBIGUOUS（或抽样 5% 的 VERIFIED）→ 复核任务：
reason 按信号分 `multi_candidates`（集团门户多注册号）/ `name_collision`（同名冲突）/
`low_confidence` / `audit_sample`；SLA 3 个工作日（只跳周末，v0 无节假日日历）；状态机
OPEN → APPROVED / REJECTED / NOT_FOUND（证据不足）/ EXPIRED（超期只告警**不自动改判**），
终态不可重复裁决；`summarizeReviewSla` 给出积压/SLA 达成率/平均裁决耗时/按原因分布；
`decisionToResolutionUpdate` 映射回 `company_domain_resolution` 行草案。抽样器可注入，结果可复算。
落库、运营台 API 与 BFF 联调属执行面/在线部分。

## 召回审计

审计的第一段是「冻结 frame → 抽样输入」（T3-20 骨架）：

```bash
# 从库里导出某 frame 最近一次 PARSED 快照的冻结实体集（内容哈希 + snapshotId 可复算）
pnpm exec tsx scripts/frames/recall-frame-export.mts --frame fr_sirene --out /tmp/fr-frame.json
```

导出形状 `recall-frame-export/v1`（`{manifest, entities}`，`entities` 即 `--frame` 输入）。
产物池（run 侧）导出等 `registry_frame` 执行面（local_query 血缘获批）后接线；当前可用
手工/导出文件作为 `--pool`。

```bash
node scripts/frames/recall-audit.mjs \
  --frame scripts/frames/fixtures/recall-frame.sample.json \
  --pool  scripts/frames/fixtures/recall-pool.sample.json \
  --period 2026-11 --sample 384 --seed 2026-11 \
  [--baseline scripts/frames/fixtures/recall-baseline.sample.json] \
  [--verdicts scripts/frames/fixtures/recall-verdicts.sample.json] \
  --out /tmp/recall-audit
```

输出固定模板 Markdown + JSON（Wilson 95% CI）。口径：分母来自 frame（外部注册库），
「找到」按注册号键（scheme + regNumber）精确匹配。`--baseline`（上一期本 CLI 报告 JSON）
给出逐层环比，|Δ|≥5pp 标 ⚠；`--verdicts`（`[{scheme, regNumber, missReason}]`）给出
miss 归因 Top-5 与未归因计数。名称/域名模糊匹配与裁决界面留给 T3-20。
