# 待办3 · 专利发明人缓存（Google Patents #89 的 scale-safe 生产启用）

> 状态：**进行中**（分支 `feat/patent-inventor-cache`）。地基已提交 `5b3e7a9`；其余步骤见 §进度。
> 目的：让 #89（BigQuery Google Patents 发明人源）能开进生产 contact 漏斗而**每查零 BQ 字节、零额外 GCP 设置**。
> 方案由 3 方案 judge-panel workflow 选定（postgres_scoped_cache 合成方案，total 37）。

## 核心机制

「一次共享大扫（Job User 只读，结果拉回 Postgres）→ 逐公司发现时只读 Postgres 小表（零 BQ 字节）」——把现状「N 次全表扫」塌缩成「每刷新周期 1 次扫」。用户**零额外 GCP 设置**（现有 Job User key 就够，不建 dataset、不加角色）。

## 8 道护栏如何保全（一条不丢）

1. **高置信对齐**（≥0.9/margin≥0.1）：provider `pickBestByName` 零改；缓存存 `assigneeNameRaw` 逐字供精判。
2. **独家申请人**：刷新 SQL `ARRAY_LENGTH(assignee_harmonized)=1` 下推，合著根本不入缓存。
3. **国别门 + T1 跨境防误并**：🔴 缓存存 `assigneeCountry` 进唯一键（DE"Acme"/US"Acme" 天然两行）+ **读侧按 (assigneeNorm, assigneeCountry) 双键分组**重建合成 PatentRecord（每组=一条，携各自单国别）+ provider 逐专利 `countryConflicts` 过。**绝不能只按 assigneeNorm 分组**，否则 DE/US 同名读侧被并、provider 国别门失去分流依据 → T1 静默失效。
4. **近5年 recency**：刷新 SQL `publication_date BETWEEN` 下推 + `windowFromYear/ToYear` 存表 + 刷新滚动裁旧行。
5. **cap 25**：provider `MAX_INVENTORS` + `normalizePersonName` 去重，零改。
6. **数据最小化（仅 name）**：刷新 SQL 只 `SELECT i.name`；缓存单列 `inventorName`，🔴 **pii-crypto 列级加密落盘**（`assigneeCountry` 是公司字段非发明人 PII）。
7. **CC BY 4.0 署名**：provider 从 `GOOGLE_PATENTS_LICENSE` 常量注入 `field_evidence.license`（零改）；缓存 `license` 列仅派生溯源。
8. **§8.8 用途门 fail-closed**：🔴 **刷新侧自守**——刷新扫 BQ 前重校 `source_policy(bigquery.googleapis.com)` `reviewStatus≠SUSPENDED` 且 `allowedPurpose` 含 discovery，否则 audit DENIED 不扫（读侧查 postgres 无外部 egress，天然不需 §8.8）。

## 🔴 ENABLE 前置合规（非工程可自决，用户拍板）

缓存把「对齐/lawful-basis 门**之前**」的 scoped inventor 姓名（PII）存于静态——比现状「仅对齐+LIA 后落各租户 canonical_contact」多一个存储面（已 scoped 到我方 target 公司、非全球，最小化）。翻 ENABLED 前须：**用户签 LIA/DPIA**（本仓 seed 保持 DISABLED + `PATENT_SOURCE_MODE=off` 直到签署）。工程侧已做的缓解：inventorName 列级加密 + TTL 清理 + 接 Art.17 擦除 + source_policy 溯源。

## 落地进度（10 步）

- ✅ **Step 1 schema**（`5b3e7a9`）：`patent_inventor_cache`/`patent_lookup_request`/`patent_cache_refresh_audit` 3 表 + 迁移（app_user CRUD GRANT，无 RLS）。
- ✅ **Step 2a adapter 刷新查询**（`5b3e7a9`）：`BigQueryPatentsClient.searchInventorsForAnchors(anchors, window)`——LIKE ANY 单查覆盖全 anchor（一次扫）、护栏②④⑥ 下推。
- ⬜ **Step 2b/3 缓存读客户端 + 测**：`adapters/patent-inventor-cache.ts` 的 `PatentCacheClient.searchPatentsByAssignee(db, name, opts)`——anchor→查 `patent_inventor_cache`（`assigneeNameRaw` contains + `expiresAt>now`）→🔴双键分组重建合成 PatentRecord（decryptPii inventorName）→ 形状与 BigQueryPatentsClient 全等 → provider 零改。golden 测：DE/US 同名产两条独立记录携各自国别 + 缓存路径 vs 直连路径产同一 contacts。
- ⬜ **Step 2c 刷新编排**：同文件 `refreshPatentCache(deps)`——枚举 PENDING/过期队列（无静默截断）→ 空则 SKIPPED_EMPTY → §8.8 自守 → `searchInventorsForAnchors` → 每行 normForMatch + encryptPii + upsert（唯一键 assigneeNorm/country/inventorName）→ purge 过期/出窗 → 队列置 CACHED/EMPTY + nextRefreshAt → 写 audit。owner 连接。
- ⬜ **Step 4 provider 模式切换**：`GooglePatentsInventorProvider` 加注入 `cacheReader`/`enqueue` dep；cache 模式走 cacheReader（读 postgres，无 egress，不经 broker）+ miss 时 enqueue；direct/off 走现 broker.invoke（§8.8）。8 护栏代码不动。⚠️ registry 构造无 prisma 句柄——需给 registry deps 加 prisma（worker.ts:84 / discovery.module.ts:19 处有 prisma 可传；seed-only 构造不需）。
- ⬜ **Step 5 toggle**：env `PATENT_SOURCE_MODE=cache|direct|off`（cache=生产读缓存；direct=逐公司 BQ 仅 verify/调试；off=关）。生产开 = MODE=cache **且** data_provider.google_patents ENABLED（两门都合）。
- ⬜ **Step 6 eager-enqueue**：fit=match 阶段（仿 `registerWatchesForRun`，早于 contact sweep 触达）对有 domain/有效 assignee 公司 enqueue `patent_lookup_request`（PENDING）压冷启动窗；确认 backlog sweep 的 `contactDiscoveryAttemptedAt` stamp 不在预热前移出可达集（或该源豁免该 stamp）。
- ⬜ **Step 7 刷新 Schedule**：第 5 个 Temporal Schedule（`ensure-schedules.ts` SPECS 加一项 + `patentsCacheRefreshWorkflow`+activities，`everyEnv=PATENT_CACHE_REFRESH_MS` 默认周更、overlap=SKIP、worker 启动幂等自愈）。
- ⬜ **Step 8 合规加固**：inventorName 加密（Step 2c 已含）；`patent_inventor_cache` 纳入 `source_policy.retentionDays` 清理 + Art.17 `deletion.activities` 擦除扫描面；补 ADR/`source_policy.notes` 记 LIA 依据。
- ⬜ **Step 9 真库真测** `verify-google-patents-cache.mts`（无 sandbox，§5）：(A) Job User 跑一次刷新落 Postgres（记 bytesScanned）；(B) cache 模式逐公司读=0 BQ 字节且与 direct 产出一致；(C) DE/US 同名 T1 分流；(D) §8.8 SUSPENDED→物化+回读双停；(E) 幂等重跑；(F) 空队列跳过扫描。
- ⬜ **Step 10 灰度启用**（合规拍板后）：`--dry-run` 估真实 bytes 定 cadence → 用户签 LIA/加密确认 → MODE=cache → 手跑刷新预热 → data_provider 翻 ENABLED。

## 未决问题（judge 提出）

- 冷启动时序：eager-enqueue（推荐）vs refresh-project；确保预热早于 `contactDiscoveryAttemptedAt` stamp。
- anchor 集上千时 LIKE ANY 谓词过大 → 切 REGEXP alternation / semi-join，仍守「一次扫」。
- 刷新真实 bytes：先 `--dry-run` 拿真值再定 cadence（4~30 扫/月 稳在 1TB 内）。
- CC BY 4.0 确切 attribution 文案（ENABLE 前核实，与 #89 §3 同）。
