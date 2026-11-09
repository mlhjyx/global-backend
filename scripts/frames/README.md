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
company_registry 类，data_provider 默认 DISABLED）。**注意**：现行 governed-lineage 契约要求逐记录
durable 回执，本地查询无法满足，因此它目前恒被路由闸门排除（计划期 `SOURCE_LINEAGE_UNAVAILABLE`）——
执行面等 `docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md` 的设计获批。

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
