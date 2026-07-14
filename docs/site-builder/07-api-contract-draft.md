# API 契约草案 v1（草稿，待用户确认）

> 给 SaaS 前端开发者**先行动工**的接口对齐稿（注册引导页/建站工作台）；正式契约照旧 code-first OpenAPI 生成后以 Scalar 门户为准。基于 [02 §3](02-architecture.md) 展开到请求/响应级。

## 0. 通用约定

- Base：`/api/site-builder`；鉴权：`Authorization: Bearer <SaaS token>`（JWKS 验签 → workspace，RLS 隔离）。
- 响应信封（与后端既有收口④定稿一致，M0 实现即此形状）：单资源 `{ "data": … }`；列表 `{ "data": [...], "page": { "next_cursor", "has_more" } }`；错误 `{ "error": { "code", "message", "details"? } }`。协议键 snake_case，资源字段 camelCase。
- 错误码：401 未认证 / 403 越权 / 404 不存在 / 409 冲突（如构建进行中）/ 422 校验失败 / 429 配额或限流（`error.code=QUOTA_EXCEEDED` 带剩余额度信息）。
- 幂等：`POST /builds`、`POST /publish` 支持 `Idempotency-Key` 头。
- 时间一律 ISO 8601 UTC。

## 1. 注册引导（intake）

```
POST /intake        ← 建议 SaaS 服务端代理转发（注册时用户尚无 token，见 §12 对齐项）
req : { "company": {"nameZh": "…", "nameEn": "…"?}, "industry": "<taxonomyId>",
        "products": ["pump", …](1-5), "targetMarkets": ["DE","US"],
        "hasWebsite": false, "websiteUrl": null,      // 仅作背景知识喂品牌定位，【不分叉流程/栏目】
        "businessEmail": "a@b.com" }
resp: { "siteId": "st_…", "buildId": "bld_…",         // 注册即【无条件】触发 demo v0（不论 hasWebsite）
        "status": "generating_demo" }
```
demo v0 完成后 `GET /sites/{id}` 的 `status=ready` 且 `previewUrl` 就绪（前端轮询或订阅事件 §11）。

**引导流程与状态 = 前端全权（本仓不管）**：后端只提供**已有的预览链接**（`GET /sites/{id}` / `GET /builds/{id}` 的 `previewUrl`）——卡片点击凭该链接跳转预览。build 状态、资料缺口 `gaps`（`GET /sites/{id}/kb/status`，§4）、向导保存 `PATCH /sites/{id}/profile`（§2）等**既有端点**前端自取自用；**后端不为引导新增编排/状态端点**。

## 2. 站点与建站向导

```
GET  /sites                → [{ id, name, status, previewUrl, publishedUrl?, activeVersion }]
GET  /sites/{id}           → 详情（含 style、locales、quota 用量摘要）
PATCH /sites/{id}/profile  → 向导分步保存，分组可跳过：
  { "companyProfile": {...}? , "trustAssets": {...}?, "onlineAssets": {...}?, "brand": {...}?, "contact": {...}? }
GET  /sites/{id}/profile
```

## 3. 素材（上传三步：presign → PUT 直传 → commit）

```
POST /sites/{id}/assets/presign  { "kind":"product_image", "filename":"a.jpg", "size":123, "mime":"image/jpeg" }
  → { "assetId":"ast_…", "uploadUrl":"<presigned>", "expiresAt":"…" }        // 422=类型/大小拒绝
POST /assets/{assetId}/commit → { "processingStatus": "queued" }             // 触发图片管线/入 KB
GET  /sites/{id}/assets?kind=&page= → [{ id, kind, processingStatus, thumbUrl(签名短效), usedIn:[sectionId] }]
DELETE /assets/{assetId}       // 被 spec 引用时 409 + 引用位置清单
```

## 4. 知识库与资料缺口

```
GET /sites/{id}/kb/status → { "documents": 5, "chunks": 182,
  "gaps": [{ "field":"certifications", "hintKey":"…" }] }   // brandProfile 产出的"待补资料"，工作台提示用
```

## 5. 构建（精装修）

```
POST /sites/{id}/builds  { "scope":"site|page|section", "targetId"?,
                           "options": { "stylePreset"?, "pages"?: [...], "locales"?: ["en","de"] } }
  → { "buildId":"bld_…", "status":"queued" }     // 409=已有 run；429=配额
GET  /builds/{id} → { "phase":"P2_assets", "progress":0.42, "steps":[…], "costSummary":{…}, "error":null }
GET  /builds/{id}/events   // SSE：phase/progress/step/finished/failed（前端也可轮询上一条）
POST /builds/{id}/cancel
```

## 6. Spec 编辑与版本（人工微调，免跑管线）

```
GET   /sites/{id}/spec?locale=en&materialized=true   // 物化视图（文本内联）——直接喂 Puck 编辑器
PATCH /sites/{id}/spec  { "locale":"en", "patch": [ <JSON-Patch> ] }
      // 文本改动写回 CopyBundle[locale]；结构改动写回结构；校验失败 422 带定位
GET   /sites/{id}/versions → [{ id, createdAt, source:"build|manual", buildId? }]
POST  /sites/{id}/versions/{vid}/rollback
```

## 7. 风格（秒级，不跑管线）

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

## 9. 域名与发布（M2）

```
POST /sites/{id}/domains  { "domain":"www.acmepump.com" } → { "cnameTarget":"edge.<平台域>", "status":"pending_dns" }
GET  /sites/{id}/domains  → [{ domain, status: pending_dns|verifying|active|error, boundAt? }]
POST /sites/{id}/publish  → 200 已发布 { publishedUrl } / 202 审核中（06 §1 L3）/ 422 被发布门拒绝（带原因分级）
POST /sites/{id}/unpublish
```

## 10. 店铺导入（M3）

```
POST /sites/{id}/import/storefront  { "url":"https://xx.en.alibaba.com/…", "consent": true }
  → { "jobId":"imp_…" }
GET  /import/jobs/{id} → { status, "preview": { company:{…}, products:[{…选择清单}] } }
POST /import/jobs/{id}/confirm  { "productIds":[…] }   // 确认后才入库
```

## 11. 事件推送（本后端 → SaaS，服务器间）

outbox 事件：`SiteDemoReady / SiteBuildProgress / SiteBuildFailed / SitePublished / DomainBound / InquiryReceived`。
投递形式待对齐（§12 #1）：webhook（我们推）或 SaaS 轮询事件游标接口（我们已有 outbox 基建，两者都低成本）。

## 12. 待对齐/拍板（与 SaaS 前端）

1. **事件通道形式**：webhook vs 轮询游标——建议 webhook + 签名头，失败重试退避。
2. **intake 调用方式**：建议 **SaaS 服务端代理转发**（注册时用户尚无 token，server-to-server 走服务凭证；避免前端直调的 CORS/凭证复杂度）。
3. 询盘导出格式（CSV 字段清单）——M2 前定。
