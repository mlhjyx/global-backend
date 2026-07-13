# 专利发明人缓存 · Codex PR #93 复审 7 findings 收口（fast-follow）

> 2026-07-14 · 分支 `fix/patent-cache-codex-p93` · 基于 main `f828f19`（PR #93 合并后）
> 处置 PR #93「专利发明人 postgres scoped 缓存（scale-safe #89）」合并**之后**收到的 7 条 Codex inline 复审意见。
> 🔴 全程功能保持默认关闭：`data_provider.google_patents` seed=**DISABLED** + `PATENT_SOURCE_MODE=off`（翻 ENABLED 须用户先签 LIA/DPIA）。

## 背景不变式

缓存把「逐公司 BigQuery 全表扫」塌缩成「每刷新周期 1 次共享大扫落 postgres」。发明人 = 🔴 具名个人（GDPR）→ 缓存把 lawful-basis 门**前**的 PII 静态化多一存储面，故：

- **不变式 A（kill-switch）**：`data_provider.google_patents` = DISABLED ⇒ **绝不物化任何发明人 PII**。
- **不变式 B（Art.17 持久）**：擦除一个发明人后，后续任何刷新**绝不**把同一人的 PII 再拉回缓存。
- **不变式 C（数据最小化）**：只缓存与**已排队公司身份**对齐的发明人，且每 (assignee,country) ≤ 25（对齐 provider 读侧上限）、TTL ≤ 180d。

## 7 findings 与修法

| # | 级别 | 问题 | 修法 | 回归 |
|---|---|---|---|---|
| **P1-1** | HIGH 合规 | `enqueuePatentLookupsForRun`（fit=match 无条件 enqueue）+ 刷新只查 §8.8 `source_policy(bigquery.googleapis.com)`（seed=APPROVED 恒过），**不查 kill-switch** → DISABLED + SA/PII key 环境周更 Schedule 仍扫 BQ 落 PII（破坏不变式 A） | **enqueue 与 refresh 都加 kill-switch 门**：`data_provider.google_patents !== ENABLED` 时，enqueue 直接 `{candidates:0,enqueued:0}`；refresh 在**保留期清理之后、扫 BQ 之前**返回 `status:DISABLED`（清理仍跑=GDPR 存储限制不受影响）。§8.8 门（用途/robots）与本门（provider 运行开关）**正交** | 单测 refresh DISABLED 不扫 + enqueue DISABLED 短路；真库 A 段 scanner.calls=0 |
| **P1-2** | HIGH 最小化 | `buildRefreshQuery` 的 `LIKE ANY(anchor)` 子串匹配（宽锚 `%APPLE%`）+ step7 无条件 upsert 全部扫描行 → 广谱采集无关 assignee（Pineapple/Applegate）发明人 PII | upsert 前按**已排队身份**过滤：`normForMatch(scanRow.assigneeName) ∈ 本轮 processed 队列的 assigneeNorm 集`。与 provider 读侧 ≥0.9 strict align 同向（法人形变体 AG/Aktiengesellschaft 同归一名仍保留） | 单测宽锚溜进的 Pineapple/Applegate 不落；真库 C 段 codexunrelated=0 |
| **P2-3** | MED 合规 | `ttlDaysFromEnv` 对 `PATENT_CACHE_TTL_DAYS>180` 直接采纳 → 超 180d 硬上限 | 正值也 `Math.min(v,180)`（运维可设更短=更强隐私，绝不超顶） | 单测 env=365→180d；真库 D 段 expiresAt=180.0d |
| **P2-4** | MED 新鲜度 | 无 BQ creds 时 `searchInventorsForAnchorsWithStats` 返 `{rows:[]}` no-op（非抛错）→ 刷新把队列全标 `EMPTY`+180d nextRefresh；enqueue 只更 lastRequestedAt 不复位 status → creds 修好前冷冻数月 | `RefreshScanResult.scanned` 标：no-client/no-anchor → `scanned:false`；刷新 `scanned===false` → `SKIPPED_NOSCAN`，队列**留 PENDING**（区分「扫了零命中」EMPTY vs「没扫」PENDING） | 单测 scanned:false→SKIPPED_NOSCAN 留 PENDING；真库 E 段 |
| **P2-5** | HIGH Art.17 | 擦除只删当前缓存行（一次性）；周更刷新不查任何禁扫集 → 同 assignee 再从 BQ 拉回被擦除人 upsert（破坏不变式 B） | 新平台表 `patent_inventor_tombstone`（无 RLS，只存不可逆盲键 `inventor_name_key`，🔴 无明文）。`eraseSubject` 先写墓碑（over-suppress 变体集同 delete，即便当前无缓存行也挡未来）→ 刷新 upsert 前按盲键查墓碑跳过。盲键规范一致：`inventorBlindKey`（存储/刷新）形恒 ∈ `inventorErasureKeys`（擦除）变体集 | 单测墓碑命中不重物化；真库 B 段（含 app_user INSERT GRANT 证明） |
| **P2-6** | MED 最小化 | `buildRefreshQuery` 无 per-assignee 上限 → 多产 assignee（Siemens/Philips）五年数千发明人全存，provider 只暴露 ≤25 | 落库前每 (assigneeNorm,country) cap 到 `MAX_INVENTORS_PER_ASSIGNEE=25`（镜像 provider）；确定性排序保幂等 | 单测 35→25；真库 C 段 codexfilter=25 |
| **P2-7** | MED 健壮 | 扫描成功后 `encryptPii`/upsert 抛错逃出 scan-only try/catch → audit 卡 `RUNNING` + Temporal 重试整活动**重扫 BQ** 烧配额 | 双管：①扫描前 preflight `piiKeyConfigured()`（key 缺→直接 FAILED 不扫）；②写阶段包 try/catch → 失败标 audit `FAILED`（不逃逸、不重扫） | 单测 preflight key 缺不扫 + upsert 抛错→FAILED 不卡 RUNNING |

## 刷新编排新流程（`refreshPatentCache`）

```
保留期清理（恒先跑，GDPR 存储限制不受 kill-switch 影响）
 → 【P1-1】kill-switch：DISABLED → status:DISABLED 返回（不扫、不物化）
 → 队列空 → SKIPPED_EMPTY
 → §8.8 用途门 → DENIED
 → 【P2-7】preflight piiKeyConfigured → 缺 → FAILED（不扫）
 → audit RUNNING → 一次扫（try/catch → FAILED）
 → 【P2-4】scanned:false → SKIPPED_NOSCAN（队列留 PENDING）
 → 三重收窄：【P1-2】按排队身份过滤 → 【P2-5】去墓碑 → 【P2-6】cap 25
 → 【P2-7】写阶段 try/catch upsert（失败 → FAILED，不重扫）
 → 队列状态机 CACHED/EMPTY → audit OK
```

## 迁移与部署

- 迁移 `20260714070000_patent_inventor_tombstone`（平台表 + `GRANT SELECT,INSERT,UPDATE,DELETE … TO app_user`，镜像 patent_inventor_cache）。
- **共享 dev DB 安全应用**：`prisma db execute --file` + `prisma migrate resolve --applied`（绝不 `migrate dev`/reset，防丢他会话工作）。
- 部署无新增 backfill（墓碑随擦除自然累积；既有缓存行按 TTL/窗口自然清理）。

## 验证

- 单测：`patent-inventor-cache.spec.ts`（+8 refresh 复审测）、`discovery.activities.spec.ts`（+2 enqueue kill-switch）、`bigquery-patents.spec.ts`（scanned 断言）。全量 979 测绿。
- 真库（零 BQ，mock scanner）：`scripts/verify-patent-cache-codex-p93.mts` 五段全绿（A P1-1 / B P2-5 GRANT+skip / C P1-2+P2-6 / D P2-3 / E P2-4），末尾复位 google_patents=DISABLED。
