# API 契约草案 v1（草稿，待用户确认）

> 给 SaaS 前端开发者**先行动工**的接口对齐稿（注册引导页/建站工作台）；正式契约照旧 code-first OpenAPI **JSON** 生成后以 Scalar 门户为准（ADR-009）。基于 [02 §3](02-architecture.md) 展开到请求/响应级。
>
> Reviewed against `12` v3.2（2026-07-16 DOC-12 回写）；#125 已完成 truth-sync，#126 已完成 intake R0 contract closeout。SiteSpec 当前仍为 `1.0.0` type-only。

**里程碑标记**（每节标注，便于前端排优先级）：🟢 **M0 as-built**（端点已落地，形状以代码为准，但下列 ⚠️ 项须按目标契约对齐）· 🎯 **M1**（M1-a 构建契约 / M1-c 媒体地基 / M1-d 精装修，工作台目标）· **M2**（询盘、域名、Release 发布）· **M3**（店铺导入、媒体作业扩展、有站诊断）。

> **as-built vs target**：本稿同时标注已落地与目标态；当前接入一律以 code-first OpenAPI 为准。intake R0 合同已落地；R2-A3/R3 等目标形状只有代码落地、重导 OpenAPI 并通过契约门后才生效。

## 0. 通用约定

- Base：`/api/v1/site-builder`；鉴权：`Authorization: Bearer <SaaS token>`（JWKS 验签 → workspace，RLS 隔离）。下文端点均相对此 Base。
- **契约生成**：正式契约 code-first OpenAPI **JSON**（ADR-009 唯一 REST 真值），本稿是先行对齐稿，字段以生成的 Scalar 门户为准。
- 响应信封（与后端既有收口④定稿一致，ADR-009；M0 实现即此形状）：单资源 `{ "data": … }`；列表 `{ "data": [...], "page": { "next_cursor", "has_more" } }`；错误 `{ "error": { "code", "message", "details"? } }`。协议键 snake_case，资源字段 camelCase。
- **HTTP 状态**：401 未认证 / 403 越权 / 404 不存在 / 409 冲突（构建进行中、Asset 被引用、body 基版本落后）/ 412 前置条件失败（`If-Match` 不匹配）/ 422 校验失败或发布门拒绝 / 428 缺少必要写前置条件 / 429 配额或限流。业务分支一律读 `error.code`（唯一稳定键，见 **§13 统一错误码表**）；`message` 仅供展示、可变。
- **幂等**：as-built 的 `POST intake` 与 `POST /sites/{id}/builds` 已在 OpenAPI 声明 `Idempotency-Key`；intake 同键同请求重放首次结果、同键异请求返回 `IDEMPOTENCY_KEY_REUSED`。`POST /sites/{id}/releases`/`publish` 尚未实现。客户端不得从通用约定推断未在 OpenAPI 声明的端点已幂等。
- **乐观并发**：可变资源（Spec、Profile、Release 草稿）写操作携带版本判据——`If-Match: <ETag>` 头 或 请求体 `baseVersionId`；不匹配返回 **409/412**，**绝不 last-write-wins**（见 §6）。
- 时间一律 ISO 8601 UTC。

## 1. 注册引导（intake）〔🟢 M0 / R0-contract 已落地〕

```
POST /intake        ← 建议 SaaS 服务端代理转发（注册时用户尚无 token，见 §12 对齐项）
hdr : Idempotency-Key: <uuid>                          // 重放同键返回第一次 {siteId,buildId,status}
req : { "company": {"nameZh": "…", "nameEn": "…"?}, "industry": "<taxonomyId>",
        "products": ["pump", …](1-5), "targetMarkets": ["DE","US"],
        "hasWebsite": false, "websiteUrl": null,      // 仅作背景知识喂品牌定位，【不分叉流程/栏目】
        "businessEmail": "a@b.com" }
resp: { "siteId": "st_…", "buildId": "bld_…",         // 注册即【无条件】触发 demo v0（不论 hasWebsite）
        "status": "generating_demo" }                 // 【无 mode 分叉字段】
```

- **幂等（§3.2 回写）**：请求带 `Idempotency-Key`；同键重放返回第一次的 `{siteId,buildId,status}`，不重复建站/重复触发 demo。
- **无 `mode` 分叉**：`hasWebsite`/`websiteUrl` 仅作品牌理解背景，注册**无条件**建 `Site + demo_v0 BuildRun`；诊断是 M3 capability、不是注册入口分叉（ADR-013 边界、§3.2 口径、ADR-017 禁虚构身份）。

> ✅ **as-built（#126）**：Swagger/OpenAPI、DTO 与实现已统一为 `{siteId,buildId,status:"generating_demo"}`；正式客户端必须复用同一 `Idempotency-Key` 进行安全重试。无 key 仅保留兼容，不承诺 Temporal ACK-loss 下的安全重放；若 start 已成功而 DB ACK 持久化失败，Site/run 会保留，客户端须先查询 workspace 站点状态，不得把 502 等同于 workflow 未启动。

demo v0 完成后 `GET /sites/{id}` 的 `status=ready` 且 `previewUrl` 就绪（前端轮询或订阅事件 §11）。

**引导流程与状态 = 前端全权（本仓不管）**：as-built 的预览链接来自 `GET /sites/{id}`（站点 ready/published 时返回 `previewUrl`）；当前 `GET /builds/{id}` 只返回 run 状态字段，`previewUrl` 是 R3 目标，不能当现有字段。build 状态、资料缺口 `gaps`（`GET /sites/{id}/kb/status`，§4）、向导保存 `PATCH /sites/{id}/profile`（§2）等既有端点由前端组合；**后端不为引导新增编排/状态端点**。

## 2. 站点与建站向导〔🟢 M0 as-built〕

```
GET  /sites                → [{ id, name, status, previewUrl, publishedUrl?, activeVersion }]
GET  /sites/{id}           → 详情（含 style、locales、quota 用量摘要；
                             previewReleaseId/url、publishedReleaseId/url、latestBuildId — §8.4 回写）
PATCH /sites/{id}/profile  → 向导分步保存，分组可跳过（乐观并发：带 If-Match / baseVersionId）：
  { "baseVersionId": "<uuid>"?, "companyProfile": {...}|null?, "trustAssets": {...}|null?,
    "onlineAssets": {...}|null?, "brand": {...}|null?, "contact": {...}|null? }
GET  /sites/{id}/profile
```

**R2-A3 Profile 合同**：GET/PATCH 成功均返回完整五组加 `versionId`，并带强校验器 `ETag: "profile:<versionId>"` 与 `Cache-Control: private, no-cache`。PATCH 必须至少提交一个组，并至少携带 `If-Match` 或 `baseVersionId`；两者同时存在时必须相同。`If-Match` 只接受本 API 生成的单个、带引号强 ETag，拒绝 `W/`、`*`、裸值和列表。缺判据返回 `428 PRECONDITION_REQUIRED`；body 判据落后返回 `409 SPEC_VERSION_CONFLICT`；header 判据落后（含两判据相同）返回 `412 SPEC_VERSION_CONFLICT`。失败方必须 re-GET、合并意图后重试，后端不自动重放成隐式 last-write-wins。

历史 M0 曾允许任意组内 JSON。GET 在返回前对存量值执行同一严格 schema；不合格时 fail-closed 为 `409 PROFILE_MIGRATION_REQUIRED`，仅返回无值的 `path/group/action=REPLACE_INVALID_GROUP` 诊断和当前 ETag，不把旧 JSON 冒充 200 响应，也不自动猜映射或静默删字段。当前 Ubuntu 开发库没有非空 Profile；未来任何环境升级前仍须先审计并显式替换不合格组。

五组均为 `additionalProperties:false` 的有界 schema；未知顶层/嵌套字段、非法关系/数量/字符串/URL/Asset 引用返回 `422 PROFILE_VALIDATION_FAILED`。请求与合并后的完整 Profile 均不超过 64 KiB；组上限分别为 company 8 / trust 24 / online 12 / brand 8 / contact 8 KiB。URL 只存规范化 `http/https`，PATCH 不做 DNS/HTTP、抓取、模型、Temporal 或 build；真正消费 URL 时仍须重新过 SSRF/redirect/pinning 门。`contact` 继续禁止进入 KB、embedding、Brand Prompt 与 Trace；其余自由文本在进入 Brand Prompt/证据语料前递归遮蔽 ASCII、SMTPUTF8、IDN/punycode 邮箱与电话号码。Profile 使用独立 UUID CAS token，不复用 `updatedAt`、`SiteVersion` 或活动发布指针。

## 3. 素材（Asset）〔🟢 M0 端点 + ✅ R2-A1 状态机 · 🎯 M1-c：process/select-variant〕

上传三步：`presign → PUT 直传 → commit`（内容寻址，canonical key 由 content hash 决定，copy 幂等）。

**R2-A1/A4 as-built**：commit 先 CAS 进入 `committing`（递增 attempt + UUID fencing token + lease），再做事务外 HEAD/hash/copy；完成/失败回写必须匹配 fence。瞬时失败进入 `failed_retryable` 并保留 staging；同内容预检或最终部分唯一索引 P2002 均收敛为 `duplicate` + 409。canonical DB 真值与 staging cleanup intent 同事务提交；不再立即 best-effort 删除 staging，而由 Temporal 等待原 presigned PUT 失效后执行，防旧 URL 晚到 PUT 复活孤儿。

```
POST /sites/{id}/assets/presign  { "kind":"product_image", "filename":"a.jpg", "size":123, "mime":"image/jpeg" }
  → { "assetId":"ast_…", "uploadUrl":"<presigned>", "expiresAt":"…" }        // 422=类型/大小拒绝
POST /assets/{assetId}/commit → { "assetId", "processingStatus":"queued|ready" } // 魔数/大小/去重 → 归位；doc 类进 KB 队列
GET  /sites/{id}/assets?kind=&page= → [{ id, kind, processingStatus, thumbUrl(签名短效), usedIn:[sectionId] }]
GET  /assets/{assetId}         → 单资产详情（含 variants 列表，M1-c 后）
POST /assets/{assetId}/process       // 🎯 M1-c：确定性 Sharp 管线（方向/sRGB/剥 EXIF-GPS/多尺寸/AVIF+WebP+fallback）
POST /assets/{assetId}/select-variant { "variantId":"…" }  // 🎯 M1-c：从已生成 AssetVariant 选定供 SiteSpec 引用
DELETE /assets/{assetId}       // 引用检查见下（409 ASSET_IN_USE + usages）
```

**删除引用语义**（§8.5 回写，失败码 §13 `ASSET_IN_USE`）：删除被 **draft / preview / published** SiteSpec 引用的 Asset → **409** + `details.usages`（引用位置清单；替换流程须**先改 spec 再删**）；未被引用的对象**软删除（tombstone）**，底层对象存储由**异步清扫器**回收——不在删除事务内做存储 IO（跨系统一致性）。

**MF-0 媒体地基（薄版，ADR-018 · §0.1 回写）**：M1-c **前**只落 `AssetVariant` 表 + 上述**删除守卫**（`SiteSpecAssetReferenceScanner`）；`MediaJob`/`AssetUsage` 待真实消费者（生成式图片/视频）出现再补建，不提前预建（YAGNI）。M1-c 图片处理是**纯确定性 Sharp**，**不塞生成式图片或设计 Agent**。

> ⚠️ **as-built 现状**：DELETE 已改为 tombstone，并把 canonical cleanup intent 以 `blockedUntil=site_spec_asset_reference_scanner` 持久 parked；不会在事务内/当前阶段删除 canonical。与正在 `committing/processing` 的 worker 竞争时 DELETE 以 CAS 返回 `409 ASSET_BUSY`。R2-A4 已接通 staging-only 的 Outbox→Temporal cleanup、严格 provenance、重试/告警与 guarded redrive；409+usages 守卫及 canonical 删除仍是 MF-0-thin 目标。`process`/`select-variant`/`GET /assets/{id}` 为 M1-c 目标端点。

### 3.1 媒体作业（Media Job）〔🎯 M3 目标〕

生成式图片/视频出现后才启用；**不把 provider 侧 job 直接暴露给客户端**，只暴露平台 MediaJob 句柄（§8.5 回写）：

```
GET  /media-jobs/{id}      → { status, kind, progress, outputs?:[assetId], error? }
POST /media-jobs/{id}/cancel
```

M3 再增 `storyboard` / `shot` 级操作（视频分镜），随媒体完成门落地。

## 4. 知识库与资料缺口〔🟢 M0 as-built〕

```
GET /sites/{id}/kb/status → { "documents": 5, "chunks": 182,
  "gaps": [{ "field":"certifications", "hintKey":"…" }] }   // brandProfile 产出的"待补资料"，工作台提示用
```

## 5. 构建（精装修）〔🟢 M0：POST/GET/cancel · 🎯 M1-a：R3 契约补强〕

```
POST /sites/{id}/builds  { "scope":"site|page|section", "targetId"?,
                           "options": { "stylePreset"?, "pages"?: [...], "locales"?: ["en","de"] } }
  → { "buildId":"bld_…", "status":"queued" }     // 409=已有 run(BUILD_IN_PROGRESS)；429=当日配额(QUOTA_EXCEEDED)
  // Idempotency-Key 头：重放返回第一次 buildId（§0）
GET  /builds/{id} → { buildId, siteId, kind, status, phase:"P2_assets", progress:0.42,
                      previewUrl?, targetReleaseId?, degraded?, warnings?:[…],
                      steps:[{ name, status, attempt, startedAt, finishedAt, error? }],
                      costSummary:{…}, error, startedAt, finishedAt }   // GET 只读，绝不启动模型/构建/修复/外部调用
GET  /builds/{id}/events   // SSE：phase/progress/step/finished/failed（前端也可轮询上一条）；🎯 事件流后置
POST /builds/{id}/cancel   // DB 先封发布 + Temporal best-effort cancel + 清本 run staging；终态 409
```

**参数契约（§8.4 回写）**：`GET /builds/{id}` 须返回 `siteId`、`previewUrl`、`targetReleaseId`、`degraded`、`warnings` 与 `steps` 的时序/attempt/error，供工作台真实进度与降级展示。

> ⚠️ **as-built 待对齐（R3，`12` §24.2/§24.6/§26 回写；M1-d 前修；依赖已合并 DQ-1，不重做 SiteSpec）**——现 `builds.controller.ts` 与 `CreateBuildDto`/`BuildsService` 有下列缺陷，以本稿目标契约为准：
>
> - **R3-1 `targetId`**：现被强制 `@IsUUID()`，但 SiteSpec `pageId`/block id 是**字符串**且无对应 UUID 表 → page/section 局部重建实际不可用。改为**有界标识符**，与 SiteSpec pageId/block id 契约一致（未命中→404 / `UNKNOWN_COMPONENT`）。
> - **R3-2 `options`**：现仅 `@IsObject()`、无嵌套白名单。改为明确 DTO——`stylePreset` 命中目录、`pages` 为已存在 pageId、`locales` 去重 BCP-47 且有上限；无效 scope 不得进工作流/日志。
> - **R3-3 `Idempotency-Key`**：现无长度/格式约束、存于 JSON，且**失败重试也计当日配额**。改为**限长限字符**（后续可升为显式列 + 唯一索引），失败重试**不计**配额。
> - **run trace / 进度**：launcher 回写 Temporal `firstExecutionRunId`/`workflowId`，`WorkflowExecutionAlreadyStarted` 对同 buildRunId **视为幂等成功**（不误标 failed）；每个 activity 完成后**增量**写 `phase/progress/step/cost`（非仅终点一次，R3-5）。

## 6. Spec 编辑与版本（人工微调，免跑管线）〔🎯 M1〕

```
GET   /sites/{id}/spec?locale=en&materialized=true   // 物化视图（文本内联）——直接喂 Puck 编辑器；响应带 versionId + ETag
PATCH /sites/{id}/spec  { "locale":"en", "baseVersionId":"ver_…", "patch": [ <JSON-Patch> ] }
      // 或用 If-Match: <ETag> 头；文本改动写回 CopyBundle[locale]，结构改动写回结构
      // 校验失败 422 带定位（UNKNOWN_COMPONENT / MISSING_COPY_KEY 见 §13）
      // 基版本落后 → 409 SPEC_VERSION_CONFLICT（If-Match 语义下为 412）
GET   /sites/{id}/versions → [{ id, createdAt, source:"build|manual", buildId? }]
POST  /sites/{id}/versions/{vid}/rollback
```

**乐观并发（§8.5 回写）**：PATCH 必带 `baseVersionId` 或 `If-Match`；服务端比对当前物化版本，冲突返回 **409 `SPEC_VERSION_CONFLICT`**（`If-Match` 语义下为 **412**），客户端须 re-GET 合并后重试——**绝不 last-write-wins**。人工锁定的 Copy 只能被建议、不被增量 build 覆盖（09 / ADR-014）。

## 7. 风格（秒级，不跑管线）〔🎯 M1〕

```
GET /style-presets → [{ key:"modern-industrial", nameKey, thumbUrl }]
PUT /sites/{id}/style  { "preset":"…", "tokenOverrides": {"colors.primary":"#0E5FA8"}? }
      // 对比度不达 AA → 422
```

## 8. 询盘（M2）

```
PUT /sites/{id}/inquiry-settings  { "fields":[…], "inboxEmails":[…], "whatsapp"?, "autoReply"? }
GET /sites/{id}/inquiries?page=   → 列表 + CSV 导出参数 format=csv
```

## 9. 发布、Release 与域名（M2）〔🎯 M2〕

**Release = 不可变发布单元**（内容寻址、可回放、可回滚；ADR-013）。发布 = 创建 Release → 过发布门 → 切指针，**不覆盖旧产物**。

```
POST /sites/{id}/releases            { "fromVersionId":"ver_…" } → { releaseId, status:"draft" }   // 支持 Idempotency-Key
GET  /sites/{id}/releases            → [{ id, status, riskLevel?, createdAt, publishedAt? }]
GET  /releases/{id}                  → 详情（ReleaseManifest 引用/hash、DecisionTrace 引用、findings）
POST /releases/{id}/request-review   → 触发 PublishReview（06 §1 L3 人工门；返回 riskLevel/status）
POST /releases/{id}/publish          → 200 已发布 { publishedUrl } / 202 审核中（PUBLISH_REVIEW_REQUIRED）
                                       / 422 发布门拒绝（RELEASE_NOT_PUBLISHABLE，带原因分级）
POST /releases/{id}/rollback         → 指针切回上一 published Release
POST /releases/{id}/take-down        → 运行期下架（切指针到 taken_down 页；保审计/通知/appeal，06 §8.3）
```

**域名**（自定义域发布前置：`DOMAIN_NOT_VERIFIED`）：

```
POST /sites/{id}/domains  { "domain":"www.acmepump.com" } → { "cnameTarget":"edge.<平台域>", "status":"pending_dns" }
GET  /sites/{id}/domains  → [{ domain, status: pending_dns|verifying|active|error, boundAt? }]
```

> 兼容别名：早期 `POST /sites/{id}/publish` / `unpublish` 保留为 Release `publish` / `rollback` 的便捷别名，语义等价（内部先建 Release 再切指针）。

## 10. 店铺导入（M3）

```
POST /sites/{id}/import/storefront  { "url":"https://xx.en.alibaba.com/…", "consent": true }
  → { "jobId":"imp_…" }
GET  /import/jobs/{id} → { status, "preview": { company:{…}, products:[{…选择清单}] } }
POST /import/jobs/{id}/confirm  { "productIds":[…] }   // 确认后才入库
```

## 11. 事件推送（本后端 → SaaS，服务器间）

outbox 事件：`SiteDemoReady / SiteBuildProgress / SiteBuildFailed / SitePublished / DomainBound / InquiryReceived`；随 §9 Release 生命周期补 `SiteReleasePublished / PublishReviewDecided / SiteTakenDown`（🎯 M2）。
投递形式待对齐（§12 #1）：webhook（我们推）或 SaaS 轮询事件游标接口（我们已有 outbox 基建，两者都低成本）。

## 12. 待对齐/拍板（与 SaaS 前端）

1. **事件通道形式**：webhook vs 轮询游标——建议 webhook + 签名头，失败重试退避。
2. **intake 调用方式**：建议 **SaaS 服务端代理转发**（注册时用户尚无 token，server-to-server 走服务凭证；避免前端直调的 CORS/凭证复杂度）。
3. 询盘导出格式（CSV 字段清单）——M2 前定。

---

## 13. 统一错误码表（`error.code`）

> 业务分支一律读 `error.code`（稳定键）；`message` 仅供展示、可变；`details` 携带定位/清单（如 `usages`、字段路径、`remaining`）。HTTP 状态见 §0。各码呼应 [03](03-agents.md) 校验/证据门与 ADR 失败语义。M1 起最小集合即下 14 码（`12` §8.6 回写），随消费者上线逐步实现。

| `error.code`                   | HTTP                  | 触发 / 语义                                                                                                   | 出处（端点 · 门 / ADR）                                       |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `BUILD_IN_PROGRESS`            | 409                   | 该站已有进行中的 build run，拒绝并发触发                                                                      | §5 `POST /sites/{id}/builds`                                  |
| `BUDGET_EXHAUSTED`             | 429                   | 模型/媒体**付费预算门**耗尽（DB `reserve/settle` + 人工停用开关，R4-B）；与当日次数配额 `QUOTA_EXCEEDED` 区分 | §5 build / agent · ADR-016 成本门                             |
| `ASSET_IN_USE`                 | 409                   | 删除被 draft/preview/published SiteSpec 引用的 Asset；`details.usages` 给引用位置清单                         | §3 `DELETE /assets/{id}` · ADR-018 删除守卫                   |
| `ASSET_QUARANTINED`            | 409                   | 资产被安全扫描隔离（魔数不符/病毒/未过安全门），不可引用或发布                                                | §3 commit/引用/publish · [06](06-security-abuse.md)           |
| `MEDIA_JOB_FAILED`             | 422                   | 生成式媒体作业终态失败（provider job 不直接外露，只回平台 MediaJob 态）                                       | §3.1 media-jobs · 🎯 M3                                       |
| `SPEC_VERSION_CONFLICT`        | 409（`If-Match`→412） | spec/profile 基版本落后，禁 last-write-wins；客户端 re-GET 合并重试                                           | §6 PATCH spec / §2 profile                                    |
| `PRECONDITION_REQUIRED`        | 428                   | Profile PATCH 同时缺少 `If-Match` 与 `baseVersionId`，拒绝无条件写                                            | §2 profile                                                    |
| `PROFILE_VALIDATION_FAILED`    | 422                   | Profile 五组 schema、数量、关系、URL、Asset 引用或 64 KiB 总量不合格                                          | §2 profile                                                    |
| `PROFILE_MIGRATION_REQUIRED`   | 409                   | 历史 Profile 不符合当前严格 schema；不回显旧值，须按诊断显式替换无效组                                        | §2 profile                                                    |
| `UNKNOWN_COMPONENT`            | 422                   | SiteSpec 引用未在**封闭组件库**注册的 type/variant（fail-closed，不静默丢块）                                 | §6 PATCH / §5 build · ADR-015                                 |
| `MISSING_COPY_KEY`             | 422                   | 结构引用的 `textKey` 在 `CopyBundle[locale]` 缺失（i18n 键间接层断链）                                        | §6 PATCH / §5 build · [04](04-sitespec-contract.md) · ADR-014 |
| `UNAPPROVED_CLAIM`             | 422                   | 引用未 **APPROVED** 的 L2 事实（认证/数字/客户/性能承诺），拒绝上站                                           | §5 build / §9 publish · ADR-017 · 03 evidence gate            |
| `PUBLISH_REVIEW_REQUIRED`      | 202（阻断时 409）     | 发布触发 **L3 人工 PublishReview**，通过前不上线                                                              | §9 `POST /releases/{id}/publish` · 06 §1 L3                   |
| `RELEASE_NOT_PUBLISHABLE`      | 422                   | Release 未过发布硬门（L0/L1 结构/链接/安全头/默认 locale 失败/degraded）；`details` 带原因分级                | §9 publish · [08](08-eval-testing.md) 发布门                  |
| `DOMAIN_NOT_VERIFIED`          | 409                   | 发布到自定义域但域名 DNS 未验证（`pending_dns`/`error`）                                                      | §9 domains/publish                                            |
| `MODEL_CAPABILITY_UNAVAILABLE` | 503                   | 路由 ModelProfile 无满足能力约束的可用模型（网关额度耗尽/降级），`deterministicFallback` 亦不可用             | §5 build / agent · ADR-016                                    |
| `ROUTE_POLICY_ROLLBACK`        | 409                   | 模型路由策略 canary 回滚中，拒绝/降级本请求                                                                   | §5 build / agent · ADR-016                                    |

**与 as-built 复用码**：`QUOTA_EXCEEDED`（429）= `builds.service` 当日**构建次数**配额（已落地，`details` 带 `remaining`）；`BUDGET_EXHAUSTED` 是上表**成本预算门**（R4-B 目标），二者并存、语义不同。标准 4xx（401/403/404/412/422/429）仍走 `GlobalHttpExceptionFilter` 归一到同一信封。
