# 独立站用户交互路径与服务端接口

> 文档 ID：`FE-SITE-API-001`  
> 文档性质：前后端接入说明  
> 生命周期：`ACTIVE_INPUT`  
> 核验基线：`origin/main@95c312650400046240e37f3ae330329c2fb27ebd`  
> 核验日期：2026-07-23  
> 覆盖范围：首次建 Demo、精装修、资料与素材、事实审核、构建恢复、开发预览，以及已经规划但尚不能运行的后续路径

## 1. 先说清楚这份文档的边界

本文按用户在前端实际完成一件事的顺序组织接口，不按后端 Controller 文件组织。

接口和建议分为四类：

| 标记 | 含义 |
|---|---|
| `已实现` | 当前代码已有公开管理接口，并已进入仓库 OpenAPI |
| `已实现·非 OpenAPI` | 当前代码可访问，但有意从公开管理 OpenAPI 隐藏，例如开发预览 |
| `已有通用接口·暂不可直接接入` | 接口存在，但缺少 Site 级关联、权限或影响合同，当前独立站前端不能据此宣称交互闭环 |
| `接口缺口` | 当前代码没有；其中会进一步注明“规划已提出”或“本文新增建议” |

本文不会把建议路径写成已经存在的 URL。建议 URL 仅用于让前后端讨论时有共同指代，正式实现仍须经过 API 设计、权限、OpenAPI 和兼容性评审。

## 2. 事实来源和优先级

发生冲突时按下列顺序判断：

1. 当前 Controller、DTO、服务代码；
2. 当前生成的 OpenAPI；
3. Site Builder 当前状态和实施文档；
4. 已批准的前端目标规格。

当前机器接口文档：

- 生成物：[packages/contracts/openapi/openapi.json](../../../../packages/contracts/openapi/openapi.json#L2940)。
- 运行时门户：`GET /api/portal`，挂载位置见 [apps/api/src/main.ts](../../../../apps/api/src/main.ts#L60)。
- Swagger 调试页：`GET /api/docs`；生成逻辑见 [apps/api/src/main.ts](../../../../apps/api/src/main.ts#L13)。
- 开发预览故意不进 OpenAPI，见 [site-preview.controller.ts](../../../../apps/api/src/site-builder/site-preview.controller.ts#L7)。
- 当前前端纵切与后置能力边界见 [Capability Pack](README.md) 第 69 行和 [用户旅程](journeys-and-page-spec.md) 第 32 行。

## 3. 所有已登录接口共同遵守的规则

### 3.1 地址、认证和租户

- API 前缀：`/api/v1`。版本和前缀配置见 [main.ts](../../../../apps/api/src/main.ts#L42)。
- 除开发预览外，本文件中的现有接口都要求：`Authorization: Bearer <SaaS token>`。
- token 由 SaaS 平台签发；后端从中取得 `userId`、`workspaceId` 和 `roles`，见 [request-context.ts](../../../../apps/api/src/auth/request-context.ts#L1)。
- 当前 Site Builder Controller 只校验登录和 workspace 隔离，没有按 `roles` 区分运营、资料协作者或审批人。前端不能把客户端按钮隐藏当成服务端授权。
- 缺少 Bearer token 时返回 `401`，稳定错误码为 `TOKEN_MISSING`，见 [auth.guard.ts](../../../../apps/api/src/auth/auth.guard.ts#L14)。

### 3.2 成功与错误信封

单对象和命令成功响应：

```json
{ "data": { } }
```

当前 Site Builder 列表也是有界数组，不带分页：

```json
{ "data": [] }
```

错误响应：

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "面向调用方的说明",
    "details": {}
  }
}
```

信封的代码定义见 [envelope.ts](../../../../apps/api/src/common/envelope.ts#L1)。前端必须先按 `error.code` 分流，不能只按 HTTP 状态显示文案；同一个 `409` 可能代表并发任务、版本冲突、幂等键误用或素材仍被引用。

### 3.3 前端请求的共同原则

- 创建 Demo 和精装修 Build 时，应在用户第一次确认提交时生成稳定的 `idempotency-key`。超时、断网或 `502` 导致结果不明时复用原 key 和原请求体。
- Profile 写入必须先读取最新 `ETag`，冲突时重新读取、比较和提交；不得静默覆盖。
- Build、素材处理和知识库处理的真实状态在服务端。页面计时器只能决定何时轮询，不能自行推导“已完成”。
- 写操作完成后，只能以服务端响应和重新读取到的对象状态为准，不对创建、删除、批准、取消、发布做乐观终态。

## 4. 交互路径总览

| 路径 | 用户结果 | 当前可用程度 | 主要接口 |
|---|---|---|---|
| J01 进入独立站管理 | 找到已有站点或进入首次建站 | 可用 | Site list/detail |
| J02 首次建 Demo | 提交最少资料并得到 Demo 构建任务 | 可用 | Intake、Build status、Site detail |
| J03 Demo 失败后恢复 | 保留原站点并重新生成 Demo | 部分可用 | Site detail、Intake；缺按站点找 Build |
| J04 打开和分享开发预览 | 查看当前激活的完整静态产物 | 可用但访问政策缺失 | Site detail、hidden preview |
| J05 补充企业资料 | 分组保存五组建站档案 | 可用 | Profile get/patch |
| J06 上传和管理素材 | 上传、处理、查看、删除素材 | 部分可用 | presign、对象 PUT、commit、list、delete |
| J07 查看知识库是否够用 | 看已处理文档、块数和资料缺口 | 可用但只有汇总 | KB status |
| J08 审核站点使用的事实 | 决定哪些事实允许进入文案 | 当前阻塞 | 通用 Claim API 存在，Site 合同缺失 |
| J09 建精装修站 | 配置并启动整站精装修 | 可用 | Build create/get/cancel、Site detail、Preview |
| J10 局部重建页面或区块 | 只重建指定范围 | 后端能执行，前端缺目标发现接口 | Build create/get |
| J11 构建观察、取消与恢复 | 跨刷新理解进度并安全处理失败 | 部分可用 | Build get/cancel；缺 Build list/current |
| J12 编辑、版本、发布、域名、询盘、分析 | 从开发预览走向正式独立站运营 | 尚不可运行 | 只有规划，公共接口未实现 |

---

## 5. J01：用户进入独立站管理

### 5.1 列出当前 workspace 的站点

**状态：`已实现`**

- 请求：`GET /api/v1/site-builder/sites`
- operationId：`SitesController_list_v1`
- OpenAPI：[openapi.json L3099](../../../../packages/contracts/openapi/openapi.json#L3099)
- 实现：[sites.controller.ts L75](../../../../apps/api/src/site-builder/sites.controller.ts#L75)
- 前端请求时机：进入站点管理首页、切换 workspace 后、创建 Demo 成功后重新确认站点、后台刷新站点状态时。
- 请求参数：除 Bearer token 外无参数。

响应 `data[]` 中每一项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | UUID | Site 的稳定 ID，后续 Profile、素材和 Build 接口都使用它 |
| `name` | string | 站点显示名；首次创建时来自英文公司名，否则来自中文名 |
| `slug` | string | 开发预览路径使用的 slug；不是正式域名 |
| `mode` | `builder \| diagnosis` | 站点模式；当前首次建站写入 `builder` |
| `status` | `draft \| building \| ready \| published \| setup_failed` | Site 汇总状态；`published` 只是历史枚举存在，不能据此宣称正式发布能力已完成 |
| `stylePreset` | string 或 `null` | 当前样式预设；现行构建支持两种值，见 J09 |
| `locales` | string[] | 站点内容语言集合；OpenAPI 当前把它声明成数组，但 DTO 类型仍为 `unknown` |
| `activeVersionId` | UUID 或 `null` | 当前激活预览版本；不是用户可见的版本管理接口 |
| `previewUrl` | string 或 `null` | 当前 active READY Release 可访问时返回开发预览地址 |
| `createdAt` | ISO date-time | 创建时间 |
| `updatedAt` | ISO date-time | 最近更新时间 |

字段来源见 [site.dto.ts](../../../../apps/api/src/site-builder/dto/site.dto.ts#L4)。列表无分页，因为 v1 目前限制每个 workspace 一个站点；前端仍不应依赖数组永远只有一项。

### 5.2 读取站点详情

**状态：`已实现`**

- 请求：`GET /api/v1/site-builder/sites/{id}`
- operationId：`SitesController_get_v1`
- OpenAPI：[openapi.json L3137](../../../../packages/contracts/openapi/openapi.json#L3137)
- 实现：[sites.controller.ts L83](../../../../apps/api/src/site-builder/sites.controller.ts#L83)
- 前端请求时机：进入站点概览、从 Build 或素材深链返回、构建成功后确认 `activeVersionId/previewUrl`、预览打开前重新确认当前指针。

请求参数：

| 位置 | 参数 | 类型 | 说明 |
|---|---|---|---|
| path | `id` | UUID | Site ID |

响应与站点列表单项完全相同。当前 OpenAPI没有显式列出 `400/404`，但代码会对非法 UUID 返回 `400`，对当前 workspace 不可见的 Site 返回 `404`。

### 5.3 当前断点：站点概览不是一个完整读模型

站点概览还需要“当前 Demo/精装修任务、资料完整度、素材处理、KB 缺口、下一步允许动作”。目前前端只能并行请求 Site、Profile、Asset、KB；离开页面后无法按 Site 找回 Build ID。

**接口缺口·规划已经要求长任务可恢复，本文给出具体建议：**

`GET /api/v1/site-builder/sites/{siteId}/builds?status=active&limit=20&cursor=...`

最小响应应包含：`buildId/siteId/kind/status/phase/progress/startedAt/finishedAt/updatedAt/previewVersionId/cancelable` 和稳定分页。若 v1 只提供一个活动任务，也可先实现 `GET .../builds/current`，但仍需为历史任务保留后续扩展路径。

---

## 6. J02：首次提交资料并建立 Demo 站

### 6.1 创建站点并启动 Demo

**状态：`已实现`**

- 请求：`POST /api/v1/site-builder/intake`
- operationId：`IntakeController_create_v1`
- OpenAPI：[openapi.json L2940](../../../../packages/contracts/openapi/openapi.json#L2940)
- 实现：[intake.controller.ts L48](../../../../apps/api/src/site-builder/intake.controller.ts#L48)
- 请求 DTO：[intake.dto.ts L18](../../../../apps/api/src/site-builder/dto/intake.dto.ts#L18)
- 前端请求时机：用户完成首次建站表单并确认创建时。不要在字段自动保存、页面加载或按钮 hover 时调用。

Header：

| 参数 | 必填 | 规则 | 前端用途 |
|---|---|---|---|
| `Authorization` | 是 | Bearer token | 身份和 workspace |
| `idempotency-key` | 代码允许省略，前端应视为必填 | 1–128 位，只允许字母、数字、`.`、`_`、`:`、`-` | 防止双击、超时重试和 ACK 丢失造成重复建站 |

请求 JSON：

| 字段 | 类型与限制 | 说明 |
|---|---|---|
| `company.nameZh` | string，1–200 | 公司中文名，必填 |
| `company.nameEn` | string，1–200，可省略或 `null` | 公司英文名；当前代码不会自动完成 M1 中所说的人工确认流程 |
| `industry` | string，1–120 | 行业 taxonomy ID，例如 `isic-2813`；当前接口不提供 taxonomy 选择数据 |
| `products` | string[]，1–5 项；每项 1–120 | 主营产品关键词 |
| `targetMarkets` | string[]，至少 1 项；每项为大写两位国家码 | 目标市场，例如 `DE`、`US` |
| `hasWebsite` | boolean | 现有海外站背景信息；不会改变 Demo 流程 |
| `websiteUrl` | HTTP/HTTPS URL，可省略或 `null` | 当 `hasWebsite=true` 时业务上必填 |
| `businessEmail` | email | 业务邮箱；不会进入 KB/模型提示，当前也没有询盘 receiver |

示例：

```json
{
  "company": {
    "nameZh": "示例精密制造有限公司",
    "nameEn": "Example Precision Manufacturing"
  },
  "industry": "isic-2813",
  "products": ["industrial pumps", "precision valves"],
  "targetMarkets": ["DE", "US"],
  "hasWebsite": true,
  "websiteUrl": "https://example.com",
  "businessEmail": "sales@example.com"
}
```

成功：`201`

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.siteId` | UUID | 新建或原地恢复的 Site ID |
| `data.buildId` | UUID | 本次 `demo_v0` BuildRun ID；前端必须立即持久到当前路由/任务状态中 |
| `data.status` | 固定 `generating_demo` | 只表示 Demo 工作流已确认进入编排，不表示 Demo 已完成 |

稳定错误：

| HTTP | `error.code` | 前端处理 |
|---|---|---|
| 400 | `INVALID_IDEMPOTENCY_KEY` | 修正客户端 key 生成逻辑；不要让用户手填 |
| 400 | `VALIDATION_ERROR` | 映射到字段；`hasWebsite=true` 但无 URL 也进入此类 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一个 key 被用于不同请求；停止自动重试并上报客户端状态错误 |
| 409 | `SITE_LIMIT_REACHED` | workspace 已有非失败站点或已有活动 Build；先读取现有 Site/Build |
| 409 | `SITE_COMPANY_PROFILE_LINK_REQUIRED` | 代码可能返回但当前 OpenAPI漏列；需要受控修复，不能由前端猜测 company 关联 |
| 502 | `DEMO_LAUNCH_UNAVAILABLE` | 结果可能已被接受；保持“正在确认”，使用同一 key、同一 body 重放 |

### 6.2 观察 Demo 构建

首次出现，下面完整说明 Build 查询接口；J09/J11 再使用时只补充差异。

**状态：`已实现`**

- 请求：`GET /api/v1/site-builder/builds/{id}`
- operationId：`BuildsController_get_v1`
- OpenAPI：[openapi.json L6573](../../../../packages/contracts/openapi/openapi.json#L6573)
- 实现：[builds.controller.ts L332](../../../../apps/api/src/site-builder/builds.controller.ts#L332)
- 前端请求时机：Intake 返回 `buildId` 后立即请求；随后 visibility-aware 轮询；页面重新获得焦点或网络恢复时立即重新验证；终态停止轮询。

请求参数：

| 位置 | 参数 | 类型 | 说明 |
|---|---|---|---|
| path | `id` | UUID | Intake 或 Build create 返回的 `buildId` |

成功响应：

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.buildId` | UUID | Build ID |
| `data.kind` | string | 当前实际值包括 `demo_v0`、`refurbish` |
| `data.status` | string | 当前实际主状态为 `queued/running/succeeded/failed/cancelled` |
| `data.phase` | string 或 `null` | 当前 phase：`P1_understanding/P2_assets/P3_assembly/P5_publish`；前端应映射为业务文案，不直接展示内部名 |
| `data.progress` | number | 服务端进度；当前 DTO 未在 OpenAPI声明 0–1 边界，前端要容忍并限制显示范围 |
| `data.steps` | array 或 `null` | 构建步骤；详见下表 |
| `data.costSummary` | object 或 `null` | 终态成本摘要；Demo 或尚未结算时可能为空 |
| `data.error` | `"build failed"` 或 `null` | 只给泛化错误，不暴露 provider/网络诊断 |
| `data.startedAt` | ISO date-time 或 `null` | 开始时间 |
| `data.finishedAt` | ISO date-time 或 `null` | 终态时间 |

`steps[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | `kb_ingest/brand_profile/image_pipeline/copy/assemble_build/quality_loop` |
| `status` | string | `queued/running/done/degraded/failed/skipped/aborted` |
| `attempt` | integer，可省略 | 当前展示采用的最新尝试次数 |
| `progress` | number，可省略，0–1 | 单步骤进度 |
| `degraded` | boolean，可省略 | 步骤是否降级完成 |
| `itemCount` | integer，可省略 | 聚合了多少处理项 |
| `startedAt/finishedAt` | date-time 或 `null`，可省略 | 步骤时间 |
| `errorCode` | string 或 `null`，可省略 | 稳定步骤错误码 |
| `error` | string 或 `null`，可省略 | 兼容旧 history；不要假定一定存在 |

`costSummary` 固定 `schemaVersion=site-builder-cost-summary/v1`：

| 分组 | 字段 | 说明 |
|---|---|---|
| 根 | `currency=USD`、`unit=microusd` | 所有金额单位为百万分之一美元，不是美分 |
| `budget` | `capMicrousd/reservedMicrousd/chargedMicrousd/remainingMicrousd` | 预算上限、预留、已扣和余额 |
| `budget` | `paidCallsEnabled/disabledReason/exhaustedAt` | 是否仍可付费调用及关闭原因 |
| `totals` | `reportedCostMicrousd` | provider 明确报告的费用 |
| `totals` | `calculatedCostMicrousd` | 根据冻结价格和真实 usage 计算的费用 |
| `totals` | `estimatedCostMicrousd` | 估算费用，不能显示成实际支出 |
| `totals` | `unknownOperations` | 结果/费用无法确认的操作数 |
| `usage` | `inputTokens/outputTokens/modelCalls/toolCalls` | 使用量 |
| `operations` | `succeeded/failed/unknown/released` | 付费操作的结算分类 |

错误：非法 UUID 返回 `400`；当前 workspace 看不到 Build 返回 `404`。

### 6.3 Demo 完成后的收敛请求

当 Build 变为 `succeeded` 时，前端不能仅凭 Build 状态打开预览。应重新调用 J01.2 的 Site detail，直到 `activeVersionId` 和 `previewUrl` 同时非空，再开放“查看 Demo”。这一规则来自当前发布流程：Build 成功与 active READY 指针是两个需要共同确认的事实。

### 6.4 当前断点：Demo Build 无法在丢失 buildId 后找回

Site list/detail 不返回当前或最近 `buildId`，也没有 Build list。刷新浏览器时若前端没有可靠路由状态，只能看到 Site 为 `building`，无法恢复任务详情。这由 J01.3 建议的按 Site 查询 Build 接口解决。

---

## 7. J03：Demo 失败后原地恢复

### 7.1 判断是否进入可重试状态

前端重新读取 Site detail：当 `status=setup_failed` 时，当前代码允许复用同一个 Site 创建新的 `demo_v0` run。失败 Site 不会因为异步失败被直接删除。

### 7.2 重新提交 Intake

复用 J02.1 的 `POST /site-builder/intake`，但幂等语义必须区分：

- 原来的 `idempotency-key` 永远重放原 `siteId/buildId`，用于确认原请求，不会创建新 run。
- 用户明确选择“重新生成 Demo”时，应生成一个新的 key，并提交完整的 Intake body。
- 新请求会复用 `setup_failed` Site 并创建新的 BuildRun，见 [intake.service.ts L230](../../../../apps/api/src/site-builder/intake.service.ts#L230)。

### 7.3 当前断点

- Site API 不返回原 Intake 内容，失败恢复页面无法可靠预填首次表单。
- 没有专用 `retry-demo` 命令；复用 Intake 要求前端保留或重新收集整份输入。
- OpenAPI 未列出 `SITE_COMPANY_PROFILE_LINK_REQUIRED`。

**接口缺口·本文新增建议：**

1. 在受权限保护的 Site detail 或单独 `GET /sites/{id}/intake` 返回可编辑的原 Intake；`businessEmail` 要遵循敏感字段权限和脱敏规则。
2. 若产品不希望用户重填，增加 `POST /sites/{id}/demo-retries`，请求带 `idempotency-key` 和可选修订字段，响应仍返回新的 `buildId`。服务端必须只允许 `setup_failed`，并保留旧失败 run。

---

## 8. J04：打开和分享开发预览

### 8.1 获取预览地址

复用 J01.2 `GET /site-builder/sites/{id}`。只有 `previewUrl` 非空时前端才显示入口。

### 8.2 打开预览 HTML 和静态资源

**状态：`已实现·非 OpenAPI`**

- HTML：`GET /preview/{slug}`
- 静态资源：`GET /preview/{slug}/{assetPath...}`
- 实现：[site-preview.controller.ts L29](../../../../apps/api/src/site-builder/site-preview.controller.ts#L29)
- 前端请求时机：用户点击“打开开发预览”；不应由管理页批量预取整站资源。
- 认证：当前没有 AuthGuard，拿到 URL 的访问者可以直接访问。
- 响应：不是 JSON 信封，而是 HTML、CSS、图片、字体等字节流。
- 响应头：`Cache-Control: public, no-cache`、`Content-Type`、`ETag`、`X-Content-Type-Options: nosniff`，见 [site-preview.controller.ts L17](../../../../apps/api/src/site-builder/site-preview.controller.ts#L17)。

请求参数：

| 位置 | 参数 | 说明 |
|---|---|---|
| path | `slug` | Site 的预览 slug |
| path | `assetPath` | Release manifest 内的资源相对路径；前端管理面不应自行拼接内部对象 key |

### 8.3 当前边界和接口缺口

当前 preview 是开发预览，不是正式发布，也不是有安全保证的分享链接。尚无合同说明访问期限、撤销分享、访问名单、审阅者身份、访问审计或防索引政策。

**接口缺口·规划已指出访问控制/TTL/分享政策缺失，建议先明确二选一：**

- 若预览定位为 workspace 私有：预览 resolver 应校验短时预览 token 或 SaaS session，并提供 `POST /sites/{id}/preview-sessions`。
- 若定位为可分享链接：提供创建、查询、撤销 share link 的接口，响应至少含 `url/expiresAt/revokedAt/accessMode`，并记录审计。

在合同确定前，前端文案只能写“开发预览地址”，不能写“安全分享”。

---

## 9. J05：补充和修改企业资料

### 9.1 读取五组 Profile

**状态：`已实现`**

- 请求：`GET /api/v1/site-builder/sites/{id}/profile`
- operationId：`SitesController_getProfile_v1`
- OpenAPI：[openapi.json L3181](../../../../packages/contracts/openapi/openapi.json#L3181)
- 实现：[sites.controller.ts L94](../../../../apps/api/src/site-builder/sites.controller.ts#L94)
- 字段合同：[profile-contract.ts L78](../../../../apps/api/src/site-builder/profile-contract.ts#L78)
- 前端请求时机：进入资料向导、切换 Site、保存冲突后重新获取、发起精装修前核对资料。

请求参数：path `id` 为 Site UUID。

响应头：

| Header | 说明 |
|---|---|
| `ETag` | 强校验器，格式为 `"profile:<versionId>"`；PATCH 时放入 `If-Match` |
| `Cache-Control` | 固定 `private, no-cache`；可以保留 UI 数据，但每次使用前要向服务端重新验证 |

响应 `data` 的 `versionId` 必有，其余五组按是否已经填写出现。每组都是封闭对象，不能携带合同外字段。

### 9.2 五组字段

#### `companyProfile`

| 字段 | 类型与限制 | 说明 |
|---|---|---|
| `foundedYear` | integer，1800 至当前年份 | 成立年份 |
| `employeeCountRange.min/max` | integer，0–10,000,000；min 不得大于 max | 员工规模范围 |
| `businessType` | `manufacturer/trading_company/manufacturer_and_trader` | 企业业务类型 |
| `city` | string，最多 120 | 城市 |
| `annualExportRevenue.currency` | 三位大写货币码，必填于该对象 | 出口收入币种 |
| `annualExportRevenue.min/max` | number，≥0；min 不得大于 max | 年出口收入范围 |
| `exportMarkets` | 最多 30 个大写两位国家码 | 出口市场 |
| `capacityDescription` | string，最多 500 | 产能说明 |
| `productionLines` | 最多 20 项；每项最多 120 | 生产线 |
| `moq` | string，最多 120 | 最小起订量说明 |
| `leadTime` | string，最多 120 | 交期说明 |

#### `trustAssets`

| 字段 | 类型与限制 | 说明 |
|---|---|---|
| `certifications[]` | 最多 20 | 认证；每项 `name` 必填，最多关联 5 个 `certificateAssetIds` |
| `patents[]` | 最多 50 | 每项可含 `title/number/jurisdiction`，title 或 number 至少一个 |
| `customerCases[]` | 最多 20 | 可含展示名、行业、国家、500 字摘要、匿名标记和最多 10 个素材 ID；展示名/行业/摘要至少一个 |
| `exhibitions[]` | 最多 30 | `name/year` 必填，可含国家；年份 1900 至下一年 |

#### `onlineAssets`

| 字段 | 类型与限制 | 说明 |
|---|---|---|
| `storefronts[]` | 最多 10 | `platform` 为 `alibaba/made_in_china/global_sources/other`；`url/importAuthorized` 必填 |
| `socialProfiles[]` | 最多 20 | `platform` 为 `linkedin/facebook/youtube/other`；URL 必填 |
| `googleBusinessProfiles[]` | 最多 5 个 HTTP/HTTPS URL | Google Business 页面 |

#### `brand`

| 字段 | 类型与限制 | 说明 |
|---|---|---|
| `logoAssetId` | UUID | 必须引用同 workspace、同 Site、ready 且 kind=logo 的素材 |
| `colors` | 最多 5 个 `#RRGGBB` | 品牌色 |
| `referenceSites` | 最多 3 个 HTTP/HTTPS URL | 参考站 |
| `slogan` | string，最多 240 | 品牌口号 |

#### `contact`

| 字段 | 类型与限制 | 说明 |
|---|---|---|
| `publicEmails` | 最多 10 个 email | 可公开联系邮箱 |
| `whatsappNumbers` | 最多 5 个 E.164 号码 | WhatsApp 联系方式 |
| `phoneNumbers` | 最多 10 个 E.164 号码 | 电话 |
| `inquiryRecipientEmails` | 最多 10 个 email | 未来询盘接收人；当前 receiver 未实现 |
| `displaySocialLinks[]` | 最多 20 | `platform/url` 必填，`label` 最多 80 |

Profile 总大小最多 64 KiB，各组还有 8–24 KiB 的单组上限，见 [profile-contract.ts L13](../../../../apps/api/src/site-builder/profile-contract.ts#L13)。

### 9.3 分组保存 Profile

**状态：`已实现`**

- 请求：`PATCH /api/v1/site-builder/sites/{id}/profile`
- operationId：`SitesController_patchProfile_v1`
- OpenAPI：与 GET 同一路径，[openapi.json L3181](../../../../packages/contracts/openapi/openapi.json#L3181)
- 实现：[sites.controller.ts L120](../../../../apps/api/src/site-builder/sites.controller.ts#L120)
- 前端请求时机：用户明确保存当前组；可以一次保存多组。不得每个输入字符都发请求。

并发判据至少提供一个：

| 位置 | 参数 | 说明 |
|---|---|---|
| header | `If-Match: "profile:<versionId>"` | 推荐；由最近一次 GET/PATCH 响应的 ETag 原样回传 |
| body | `baseVersionId` | 可替代 If-Match；两者同时给出时必须一致 |

Body 至少包含五组之一。某组对象表示“完整替换该组”，不是字段级 merge；某组传 `null` 表示清空该组。未出现在 body 的组保持不变。

成功返回完整最新 Profile、新 `versionId`、新 `ETag`。前端应以服务端返回值替换本地 canonical cache。

错误：

| HTTP | code/原因 | 前端处理 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | If-Match 格式错误、header/body 版本矛盾等 |
| 404 | Site 不可见 | 回到安全入口，不推测对象存在 |
| 409 | `SPEC_VERSION_CONFLICT` | body 版本过期；保留本地编辑，重新 GET、比较后重放 |
| 409 | `PROFILE_MIGRATION_REQUIRED` | 历史 Profile 不符合新 schema；按 `details.group/path/action` 引导显式替换无效组 |
| 412 | `SPEC_VERSION_CONFLICT` | If-Match 过期；处理同上 |
| 422 | `PROFILE_VALIDATION_FAILED` | 字段、数量、URL、重复、范围、大小或素材引用不合格 |
| 428 | `PRECONDITION_REQUIRED` | 客户端漏传版本判据 |

---

## 10. J06：上传、查看和删除素材

一份文件从选择到可用于建站，必须经过三段：申请上传 → 浏览器直传 → 确认入库。对象 PUT 成功不等于素材 ready。

### 10.1 申请直传 URL

**状态：`已实现`**

- 请求：`POST /api/v1/site-builder/sites/{id}/assets/presign`
- operationId：`AssetsController_presign_v1`
- OpenAPI：[openapi.json L5048](../../../../packages/contracts/openapi/openapi.json#L5048)
- 实现：[assets.controller.ts L201](../../../../apps/api/src/site-builder/assets.controller.ts#L201)
- 前端请求时机：用户选中文件，客户端完成文件名、字节数、MIME 和类型的即时检查之后；每个文件一次。

Body：

| 字段 | 类型与限制 | 说明 |
|---|---|---|
| `kind` | enum | `logo/product_image/factory_image/cert/doc/video` |
| `filename` | string，1–255 | 原始文件名，只用于显示和解析，不作为对象身份 |
| `size` | integer，≥1 | 浏览器读取的文件字节数 |
| `mime` | string，1–120 | 文件 MIME；必须在 kind 对应白名单中 |

当前 kind、MIME 和上限：

| kind | MIME | 最大文件 |
|---|---|---|
| `logo/product_image/factory_image` | JPEG、PNG、WebP | 20 MiB |
| `cert` | JPEG、PNG、WebP、PDF | 50 MiB |
| `doc` | PDF、DOCX、PPTX、XLSX、text/plain、text/markdown | 50 MiB |
| `video` | MP4 | 500 MiB |

事实来源：[object-key.ts L10](../../../../apps/api/src/site-builder/object-key.ts#L10)。

成功 `201`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.assetId` | UUID | 本次素材稳定 ID；后两步和恢复都必须复用 |
| `data.uploadUrl` | URL | 15 分钟有效的对象存储 PUT 地址；不得写入日志、分析事件或长期存储 |
| `data.expiresAt` | date-time | URL 到期时间；上传开始前应检查剩余时间 |

错误：`400` 请求格式；`404` Site 不可见；`422 ASSET_VALIDATION_FAILED` kind/MIME/大小不合格；`502 ASSET_STORAGE_UNAVAILABLE` 无法签发 URL。

### 10.2 浏览器直传文件

**状态：对象存储请求，`不属于本仓 OpenAPI`**

- 请求：`PUT {uploadUrl}`
- 请求时机：presign 成功后立即执行；可显示浏览器上传进度和允许用户中止。
- Header：`Content-Type` 必须与 presign 请求中的 `mime` 一致，因为签名包含 Content-Type，见 [storage.service.ts L136](../../../../apps/api/src/site-builder/storage.service.ts#L136)。
- Body：原始文件字节流，不用 multipart/form-data。
- 认证：不要附加 SaaS Bearer token；授权已经包含在短时 URL 中。
- 成功：对象存储通常返回 `200`，响应体不作为业务成功依据。

失败处理：

- URL 过期、网络中断或用户中止：当前接口没有为同一 Asset 重新签名的命令。重新调用 presign 会创建新 Asset ID。
- PUT 结果不明：可先对原 `assetId` 调 commit；若返回 `ASSET_UPLOAD_INCOMPLETE`，再决定重新上传。

**接口缺口·本文新增建议：** presign 响应增加 `method` 和 `requiredHeaders`，并提供 `POST /site-builder/assets/{assetId}/presign` 为仍处于 `pending_upload/expired` 的同一 Asset 续签。这样前端不必复制服务端签名细节，也不会因 URL 过期制造多条废弃 Asset。

### 10.3 确认入库和启动处理

**状态：`已实现`**

- 请求：`POST /api/v1/site-builder/assets/{id}/commit`
- operationId：`AssetsController_commit_v1`
- OpenAPI：[openapi.json L5282](../../../../packages/contracts/openapi/openapi.json#L5282)
- 实现：[assets.controller.ts L235](../../../../apps/api/src/site-builder/assets.controller.ts#L235)
- 前端请求时机：PUT 成功后立即调用；响应超时可对同一 `assetId` 重放。
- Body：无。

成功 `201`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.assetId` | UUID | 原 Asset ID |
| `data.processingStatus` | `queued \| ready` | `doc` 会进入 KB 队列；图片、证书、视频通过校验后通常直接 ready |

服务端在 commit 中检查实际对象是否存在、大小、文件魔数、声明 MIME、内容哈希和重复内容。错误：

| HTTP | code | 含义与处理 |
|---|---|---|
| 409 | `ASSET_UPLOAD_INCOMPLETE` | PUT 尚未完成或对象不存在；不要创建新业务对象，先确认上传 |
| 409 | `ASSET_DUPLICATE` | 内容与现有素材重复；当前错误没有在 OpenAPI保证返回已有 Asset ID |
| 409 | `ASSET_BUSY` | 同内容对象正在清理/处理，稍后对同一 ID 重试 |
| 409 | `ASSET_STATE_CONFLICT` | 状态已被其他请求推进；转为读取列表确认真实状态 |
| 422 | `ASSET_VALIDATION_FAILED` | 大小或内容类型不匹配；该文件不能按原声明继续 |
| 502 | `ASSET_STORAGE_UNAVAILABLE` | 存储临时不可用，对同一 ID 重试 |
| 503 | `ASSET_COMMIT_UNAVAILABLE` | 持久化临时不可用，对同一 ID 重试 |

### 10.4 列出素材并轮询处理状态

**状态：`已实现`**

- 请求：`GET /api/v1/site-builder/sites/{id}/assets?kind={kind}`
- operationId：`AssetsController_list_v1`
- OpenAPI：[openapi.json L5596](../../../../packages/contracts/openapi/openapi.json#L5596)
- 实现：[assets.controller.ts L294](../../../../apps/api/src/site-builder/assets.controller.ts#L294)
- 前端请求时机：进入素材中心；commit 后按 Site 轮询；页面回到前台或用户手动刷新时重新验证。

参数：path `id` 为 Site UUID；query `kind` 可选，枚举与 presign 相同。

响应项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | UUID | Asset ID |
| `kind` | enum | 素材类别 |
| `filename` | string | 显示名 |
| `mime` | string | 声明且已校验的 MIME |
| `sizeBytes` | integer | 声明字节数 |
| `processingStatus` | string | 当前未在 OpenAPI封闭枚举；代码状态包括 `pending_upload/committing/queued/processing/ready/rejected/duplicate/failed_retryable/failed_terminal` |
| `contentHash` | string 或 `null` | commit 完成后的内容哈希；不要展示给普通用户 |
| `processingErrorCode` | string 或 `null` | 稳定处理错误码 |
| `error` | string 或 `null` | 泛化错误说明，不含内部依赖诊断 |
| `createdAt` | date-time | 创建时间 |

错误：非法 Site UUID 为 `400`；不可见为 `404`；未知 kind 为 `422`。

### 10.5 当前断点：素材中心不能展示内容

素材列表不返回缩略图、下载地址、宽高、时长、处理更新时间或单个 Asset 查询接口。前端只能显示文件名和状态，无法完成规划中的缩略图、详情和按 ID 恢复。

**接口缺口·本文新增建议：**

1. `GET /site-builder/assets/{assetId}`：返回单个素材状态、元数据、可用变体和 `allowedActions`。
2. `POST /site-builder/assets/{assetId}/read-url` 或受保护的内容 resolver：返回短时预览/下载 URL、到期时间和内容处置策略。
3. 对 `ASSET_DUPLICATE` 返回稳定 `details.existingAssetId`，否则前端无法实现“打开已有素材”。

### 10.6 删除素材

**状态：`已实现`**

- 请求：`DELETE /api/v1/site-builder/assets/{id}`
- operationId：`AssetsController_remove_v1`
- OpenAPI：[openapi.json L5794](../../../../packages/contracts/openapi/openapi.json#L5794)
- 实现：[assets.controller.ts L335](../../../../apps/api/src/site-builder/assets.controller.ts#L335)
- 前端请求时机：用户在素材详情明确确认删除时；不要批量乐观移除。
- 成功：`204`，无响应体。数据库先写 tombstone，文件由异步清理回收。

冲突 `409 ASSET_IN_USE` 的 `error.details.usages[]` 可能包含：

| 字段 | 说明 |
|---|---|
| `source` | `profile/site_spec/claim_evidence` |
| `siteVersionId` | 引用来自 SiteSpec 时可能出现 |
| `page` | 页面标识 |
| `component` | 组件标识 |
| `fieldPath` | 引用字段路径 |

若 `409` 表示 commit、KB 或 Variant worker 正持有素材，details 不保证完整引用列表。前端保留该素材并提示稍后重试。

**接口缺口·规划已经指出：** 当前只有“尝试删除后得到有界 usages 样本”，没有独立、完整的删除影响查询。建议增加 `GET /assets/{id}/usages`，明确 `complete/truncated/nextCursor` 和解除引用所需动作；在此之前不能提供“一键解除全部引用”。

---

## 11. J07：查看知识库是否已经可用

### 11.1 获取 KB 汇总

**状态：`已实现`**

- 请求：`GET /api/v1/site-builder/sites/{id}/kb/status`
- operationId：`KbController_status_v1`
- OpenAPI：[openapi.json L5998](../../../../packages/contracts/openapi/openapi.json#L5998)
- 实现：[kb.controller.ts L17](../../../../apps/api/src/site-builder/kb.controller.ts#L17)
- 前端请求时机：进入 KB 状态页；doc commit 后轮询；精装修前核对 gaps；Build 完成后刷新 gaps。
- 参数：path `id` 为 Site UUID。

响应：

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.documents` | integer，≥0 | 当前 Site 的 KbDocument 数量；包括不同处理状态，不能单独解释成“全部 ready” |
| `data.chunks` | integer，≥0 | 文档已落库的 chunk 总数 |
| `data.gaps[]` | array | 最新 BrandProfile 提出的待补资料；还没构建过时固定为空数组 |
| `gaps[].field` | string | 缺口字段 |
| `gaps[].reason` | string | 为什么资料不足 |
| `gaps[].hint` | string | 建议补充什么 |

错误：`400 VALIDATION_ERROR`；`404 NOT_FOUND`。

### 11.2 当前边界

该接口没有文档级列表、失败文档、重试时间、最新更新时间或 overall state。`documents>0` 和 `chunks>0` 都不能证明知识库全部完成。

**接口缺口·当前前端规划明确禁止虚构文档级管理，本文新增建议：** 若产品需要让用户修复单文档，应新增 `GET /sites/{id}/kb/documents` 和针对失败文档的受控 retry 命令；响应至少包含 `documentId/assetId/title/status/chunkCount/errorCode/retryAt/updatedAt/allowedActions`。在此之前，前端只能把用户带回素材中心。

---

## 12. J08：审核能进入站点文案的事实

### 12.1 为什么当前不能把通用 Claim API 直接接到 Site 页面

代码已经有企业级 Claim/Evidence/Conflict 接口，但当前独立站合同有三处断点：

1. `SiteDto` 不返回 `companyProfileId`，前端无法从 Site 稳定取得 `companyId`。
2. 通用接口没有 Site 影响范围、当前/未来 Release 影响、Site allowed-actions。
3. Controller 只校验登录，没有审批角色的服务端门。

因此以下接口应作为后端事实盘点，不是当前 Site 自助审核完成证明。该限制已经写入 [Capability Pack](README.md) 第 71–77 行和 [用户旅程](journeys-and-page-spec.md) 第 67–72 行。

### 12.2 列出企业 Claim

**状态：`已有通用接口·暂不可直接接入`**

- 请求：`GET /api/v1/companies/{companyId}/claims?status={status}`
- operationId：`ClaimController_list_v1`
- OpenAPI：[openapi.json L455](../../../../packages/contracts/openapi/openapi.json#L455)
- 实现：[claim.controller.ts L50](../../../../apps/api/src/claim/claim.controller.ts#L50)
- 前端请求时机：未来 Site 级 review contract 返回 company 关联和允许动作后，进入事实审核页或筛选待审事实时。

参数：path `companyId` 为 UUID；query `status` 可选。代码没有对 query 做 enum 校验，前端只能使用已知值：`INGESTED/EXTRACTED/NEEDS_REVIEW/APPROVED/EXPIRED/REVOKED`。

每个 `ClaimDto`：

| 字段 | 说明 |
|---|---|
| `id/companyId` | Claim 和企业 UUID |
| `type` | 事实类型，例如 certification |
| `factKey` | 机器投影事实的规范键；手工/历史事实可能为 null |
| `statement` | 事实表述 |
| `status` | Claim 生命周期状态 |
| `confidence` | 置信度或 null；不能代替人工批准 |
| `version` | 乐观锁版本；当前写接口却没有接收它，这是合同缺口 |
| `evidence[]` | `sourceUrl/snippet/confidence` |
| `createdAt` | 创建时间 |

### 12.3 手工录入事实

**状态：`已有通用接口·暂不可直接接入`**

- 请求：`POST /api/v1/companies/{companyId}/claims`
- operationId：`ClaimController_createManual_v1`
- OpenAPI：同一路径 [openapi.json L455](../../../../packages/contracts/openapi/openapi.json#L455)
- 实现：[claim.controller.ts L85](../../../../apps/api/src/claim/claim.controller.ts#L85)

Body：`type` 最多 50 字；`statement` 最多 2000 字；`evidence` 可选、最多 2000 字。成功 `201` 返回 ClaimDto，初始 `status=NEEDS_REVIEW`、`confidence=1`。人工录入不等于已批准。

### 12.4 批准、驳回和撤销 Claim

**状态：`已有通用接口·暂不可直接接入`**

| 操作 | 请求 | operationId | OpenAPI | 前置状态 | 成功结果 |
|---|---|---|---|---|---|
| 批准 | `POST /claims/{claimId}/approve` | `ClaimController_approve_v1` | [L562](../../../../packages/contracts/openapi/openapi.json#L562) | `NEEDS_REVIEW` | `APPROVED`，version+1，记录审核人/时间并发事件 |
| 驳回 | `POST /claims/{claimId}/reject` | `ClaimController_reject_v1` | [L606](../../../../packages/contracts/openapi/openapi.json#L606) | `NEEDS_REVIEW` | `REVOKED`，version+1 |
| 撤销 | `POST /claims/{claimId}/revoke` | `ClaimController_revoke_v1` | [L650](../../../../packages/contracts/openapi/openapi.json#L650) | `APPROVED` | `REVOKED`，version+1并发撤销事件 |

三者都无 body。`404 NOT_FOUND` 表示不可见；`409 INVALID_STATE` 表示状态已变化；并发时可能返回 `VERSION_CONFLICT`。批准机器投影事实还可能返回 `CLAIM_BRIDGE_REQUIRED`。这些错误未在当前 OpenAPI逐项声明。

服务层支持 `expectedVersion`，Controller 没有暴露该参数，见 [claim.service.ts L45](../../../../apps/api/src/claim/claim.service.ts#L45)。这意味着前端即使显示了 version，也不能在提交时明确声明自己审核的是哪个版本。

### 12.5 查看和裁决冲突

**状态：`已有通用接口·暂不可直接接入`**

- 列表：`GET /api/v1/companies/{companyId}/conflicts?status=OPEN`
  - operationId：`ClaimController_listConflicts_v1`
  - OpenAPI：[openapi.json L694](../../../../packages/contracts/openapi/openapi.json#L694)
- 裁决：`POST /api/v1/conflicts/{conflictId}/resolve`
  - body：`{ "keep": "a" }` 或 `{ "keep": "b" }`
  - operationId：`ClaimController_resolveConflict_v1`
  - OpenAPI：[openapi.json L751](../../../../packages/contracts/openapi/openapi.json#L751)

列表代码返回冲突记录及 `claimA/claimB` 摘要；但 OpenAPI 只声明 `additionalProperties: true`，没有稳定字段合同。数据库现有字段包括 `id/companyId/claimAId/claimBId/claimType/status/resolvedBy/resolution/createdAt/resolvedAt`，见 [schema.prisma L301](../../../../packages/db/prisma/schema.prisma#L301)。裁决成功保留一条、撤销另一条；并发或身份不匹配返回 `409`。

### 12.6 Site 事实审核真正需要的接口

**接口缺口·规划明确要求 Site 级 review/impact/allowed-actions，建议：**

1. `GET /site-builder/sites/{siteId}/claims?status=&impact=&cursor=`  
   返回 Claim、Evidence、Site bridge、受影响 locale/page/component、是否进入 active preview、`allowedActions`、版本和分页。
2. `POST /site-builder/sites/{siteId}/claims/{claimId}/decisions`  
   请求必须含 `decision=approve|reject|revoke`、`expectedVersion`、必要说明和幂等键；服务端按角色、workspace、Site bridge 和当前影响重判。
3. `GET /site-builder/sites/{siteId}/claim-conflicts` 与版本化 resolve 命令。
4. Claim 撤销后对 active preview 的影响评估/维护任务接口，不能只阻止下一次 Build。

这些 URL 是建议，不是现有规划中已经冻结的路由。

---

## 13. J09：建立精装修站

### 13.1 发起整站精装修

**状态：`已实现`**

- 请求：`POST /api/v1/site-builder/sites/{id}/builds`
- operationId：`BuildsController_create_v1`
- OpenAPI：[openapi.json L6145](../../../../packages/contracts/openapi/openapi.json#L6145)
- 实现：[builds.controller.ts L225](../../../../apps/api/src/site-builder/builds.controller.ts#L225)
- 业务约束：[build-request-contract.ts L75](../../../../apps/api/src/site-builder/build-request-contract.ts#L75)
- 前端请求时机：用户完成构建范围、样式和语言选择，看到资料/事实门结果后明确确认生成时。

Header：`idempotency-key` 规则与 Intake 相同；前端应视为必填。

Path：`id` 为 Site UUID。

Body：

| 字段 | 规则 | 说明 |
|---|---|---|
| `scope` | 必填：`site/page/section` | 构建范围 |
| `targetId` | page/section 必填；site 禁止 | active SiteSpec 中的 page/block ID |
| `options.stylePreset` | `modern-industrial/precision-light` | 只能用于完整整站构建；不能与 `pages` 同用 |
| `options.locales` | 当前只允许 `["en"]` 或 `["en","de-DE"]` | 必须以 `en` 开头；不能只生成德语 |
| `options.pages` | 1–32 个不重复 Page ID | 只允许 `scope=site`；表示在权威构建中选择页面范围 |

完整整站示例：

```json
{
  "scope": "site",
  "options": {
    "stylePreset": "precision-light",
    "locales": ["en", "de-DE"]
  }
}
```

成功 `201`：

```json
{
  "data": {
    "buildId": "<uuid>",
    "status": "queued"
  }
}
```

错误：

| HTTP | code | 前端处理 |
|---|---|---|
| 400 | `VALIDATION_ERROR/INVALID_IDEMPOTENCY_KEY` | 修正字段或客户端 key |
| 404 | `NOT_FOUND/BUILD_TARGET_NOT_FOUND` | Site 或局部目标不存在；刷新 active 结构 |
| 409 | `BUILD_IN_PROGRESS` | `details.buildId` 存在时跳转现有任务；当前 OpenAPI只把 details 声明为自由对象 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同 key 请求内容不一致，停止重试 |
| 422 | `BUILD_OPTION_UNAVAILABLE` | 选项组合未实现，例如局部构建改 style |
| 422 | `BUILD_TARGET_AMBIGUOUS` | section ID 在多处出现，不能猜目标 |
| 422 | `BUILD_ACTIVE_SPEC_INVALID` | 当前 active SiteSpec 不可安全读取，保留旧预览并进入恢复 |
| 429 | `QUOTA_EXCEEDED` | `details.remaining` 为剩余次数；当前默认每站每日 10 次、按 UTC 日计算 |
| 502 | `BUILD_LAUNCH_UNAVAILABLE` | ACK 不明；用同一 key、同一 body 重放 |

### 13.2 观察精装修进度

复用 J02.2 `GET /site-builder/builds/{buildId}`。精装修会使用完整 steps 和 cost summary。前端必须分别展示：

- `degraded`：结果可用但有明确缺失；
- `skipped`：步骤未执行，例如 M1-f quality loop 未接线时，不能显示成质量通过；
- `unknownOperations>0`：费用或 provider ACK 不明，不能归入实际成本；
- 新 Build 失败不改变旧 `previewUrl` 仍可用的事实。

### 13.3 成功后打开精装修预览

Build `succeeded` 后重新 GET Site，确认 `activeVersionId/previewUrl` 已更新，再按 J04 打开。前端不需要、也不应直接读取 SiteRelease 或对象存储 key。

---

## 14. J10：局部重建页面或区块

### 14.1 后端已经接受的请求

复用 J09.1：

- 单页：`{ "scope": "page", "targetId": "products" }`
- 单区块：`{ "scope": "section", "targetId": "hero-main" }`
- 多页面权威构建：`{ "scope": "site", "options": { "pages": ["home", "products"] } }`

局部请求会验证 target 是否存在于当前 active SiteSpec，并把 base version 固定进 BuildRun。局部构建不能改 `stylePreset`。

### 14.2 当前前端为什么仍不能安全开放这个入口

当前 Site detail 不返回 page/section ID，也没有 active SiteSpec 或只读站点结构接口。用户只能手写 targetId，而前端规格明确禁止自由 target picker，见 [实施蓝图](../../implementation/independent-site-management-blueprint.md) 第 140–144 行。

**接口缺口·为现有后端能力补齐前端入口，本文新增建议：**

`GET /api/v1/site-builder/sites/{siteId}/structure`

最小响应：

```json
{
  "data": {
    "siteId": "uuid",
    "versionId": "uuid",
    "specVersion": "1.0.0",
    "locales": ["en", "de-DE"],
    "pages": [
      {
        "id": "home",
        "label": "Home",
        "sections": [
          { "id": "hero-main", "component": "HeroBanner", "label": "Hero" }
        ]
      }
    ],
    "allowedBuildScopes": ["site", "page", "section"]
  }
}
```

响应必须绑定 `versionId`。创建局部 Build 时还应允许提交 `expectedBaseVersionId`；否则用户选择目标后 active version 变化，只能依赖服务端报 target 错误，无法准确解释并发变化。

---

## 15. J11：构建观察、取消和失败恢复

### 15.1 取消精装修 Build

**状态：`已实现`**

- 请求：`POST /api/v1/site-builder/builds/{id}/cancel`
- operationId：`BuildsController_cancel_v1`
- OpenAPI：[openapi.json L6719](../../../../packages/contracts/openapi/openapi.json#L6719)
- 实现：[builds.controller.ts L365](../../../../apps/api/src/site-builder/builds.controller.ts#L365)
- 前端请求时机：用户在 Build 详情明确确认取消后。请求发出后进入“取消确认中”，仍不能启动同 Site 新 Build。
- Body：无。

成功 `200`：`data.buildId` 和 `data.status=cancelled`。

错误：

| HTTP | code | 处理 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Build UUID 非法 |
| 404 | `NOT_FOUND` | 当前 workspace 不可见 |
| 409 | `BUILD_NOT_CANCELLABLE` | `demo_v0` 不允许通过此接口取消，或类型不可取消 |
| 409 | `BUILD_ALREADY_TERMINAL` | 已成功/失败/取消；重新 GET 并显示真实终态 |
| 502 | `BUILD_CANCEL_UNAVAILABLE` | Temporal 未确认；任务仍 active，保持 cancelling 并用同一 buildId 重试/轮询 |

### 15.2 失败恢复

当前没有 `retry build` 接口。对终态 `failed/cancelled`，用户修正 Profile、Asset、KB 或构建选项后，重新调用 J09 create，生成新的 BuildRun。旧失败 run 保留，不被覆盖。

### 15.3 当前 Build 读合同缺失的字段

Build 详情当前不返回：

- `siteId`，深链无法独立恢复所属 Site；
- `createdAt/updatedAt/lastHeartbeatAt`，无法判断任务是否 stale；
- `resultVersionId/previewUrl`，需要额外 GET Site 且无法明确结果对应哪个版本；
- `cancelable/allowedActions`，前端只能根据 kind/status 猜按钮；
- `scope/options/baseVersionId`，无法向用户复述这次构建到底改了什么；
- 稳定的失败分类、用户可执行的修复动作和 correlation ID。

**接口缺口·规划要求长任务可恢复，本文新增建议：** 优先对 `BuildStatusResponseDto` 增加上述字段，并实现 J01.3 的 Build list/current。字段应是 additive，但必须同步 OpenAPI、前端 runtime validation 和状态映射。

### 15.4 SSE 不是现有接口

当前进度只支持 polling；Controller 已明确 SSE 后置，见 [builds.controller.ts L332](../../../../apps/api/src/site-builder/builds.controller.ts#L332)。前端第一版应做带退避、页面可见性感知、终态停止的轮询。若未来新增 SSE，事件只能提示“需要刷新 snapshot”，不能替代 GET Build 的 canonical 状态。

---

## 16. J12：规划中的后续用户路径及所需接口

本节只列规划文档已经明确的用户结果，以及要让这些页面真正运行至少需要什么接口。当前一个都不能当成已实现。页面状态依据 [用户旅程](journeys-and-page-spec.md) 第 146–163 行。建议路由只是讨论稿。

### 16.1 结构编辑器 `PAGE-FE-045`

**规划状态：`APPROVED_NOT_BUILT`**

需要的最小接口：

1. 读取版本化、经过 runtime validator 的 SiteSpec/结构；
2. 以 `If-Match/expectedVersionId` 提交受限 PatchPlan，而不是任意 JSON；
3. 服务端返回字段级校验、未知组件、引用影响和新草稿版本；
4. 预览修改只能创建候选版本，不能原地覆盖 active Release。

建议讨论路由：`GET /sites/{id}/draft-spec`、`POST /sites/{id}/patch-plans`、`POST /patch-plans/{id}/apply`。当前 SiteSpec 只有共享类型和部分组件运行时门，不能直接据此开放编辑器。

### 16.2 内容和多语言编辑器 `PAGE-FE-046`

**规划状态：`APPROVED_NOT_BUILT`**

至少需要：CopyBundle/Site locale 的读取、按 slot 和 locale 写入、Claim refs、字符预算、富文本白名单、翻译状态、版本并发、变更影响和重新构建命令。当前没有 CopyBundle 公共 API，不能把数据库表直接映射给前端。

### 16.3 风格与主题 `PAGE-FE-047`

**规划状态：`APPROVED_NOT_BUILT`**

当前 Build 只接受两个 `stylePreset` 字符串。M1-e-B 计划提供六个 Family、DesignBrief 和受控组装，但还没有用户选择接口。真正入口至少需要：可用 Family/变体目录、版本/digest、预览图、适用约束、当前选择、变更影响和提交并发合同。

不得从空 DesignCatalog 或 renderer 内部 preset 推导用户可选模板市场。

### 16.4 版本历史与对比 `PAGE-FE-048`

**规划状态：`TARGET_NOT_RUNNABLE`**

内部存在不可变 SiteRelease 和 active pointer，但没有公共 list/detail/diff/activate API。至少需要：

- `GET /sites/{id}/releases?cursor=`：版本、来源 Build、状态、locale、摘要、是否 active、可保留期限；
- `GET /sites/{id}/releases/{releaseId}`：manifest 摘要、质量/事实/素材快照、完整性和 allowed actions；
- `GET /sites/{id}/release-diffs?from=&to=`：结构、内容、事实、素材和语言差异；
- 激活只能走带授权、预检和审计的命令，不能把内部 `activeVersionId` 暴露成普通 PATCH。

### 16.5 发布前检查 `PAGE-FE-049`

**规划状态：`TARGET_NOT_RUNNABLE`**

需要服务端生成不可变或有版本的 `PublishReview`：目标 Release、Claim/Asset/locale/form/legal/domain/quality gates、阻塞项、warning、证据时间、审批者、allowed actions。前端不能自行并行拼十几个接口后宣布“可发布”。

### 16.6 正式发布和回滚 `PAGE-FE-050`

**规划状态：`TARGET_NOT_RUNNABLE`**

至少需要：发布授权 challenge、幂等 publish command、发布任务 snapshot、健康检查、当前 live pointer、失败保留旧站、审计，以及从已验证健康 Release 回滚的命令。规划入口见 [09-m1-implementation-design.md](../../../site-builder/09-m1-implementation-design.md) 第 295 行。

Preview URL、`Site.status=published` 枚举和内部 active pointer 都不能替代这些接口。

### 16.7 域名与 SSL `PAGE-FE-051`

**规划状态：`TARGET_NOT_RUNNABLE`**

至少需要 Domain/Certificate 对象和命令：添加域名、返回 DNS challenge、验证 ownership、观察 DNS/证书状态、激活/停用、续期和故障状态。响应必须区分用户可修复 DNS、平台故障、证书签发等待和安全阻断。

### 16.8 站点设置 `PAGE-FE-052`

**规划状态：`APPROVED_NOT_BUILT`**

需要站点名称、默认 locale、支持 locale、预览分享、危险动作、保留和 allowed-actions 的读取/写入合同。当前 Site 没有 PATCH/DELETE 接口，前端不能通过重新 Intake 或直接 Build 选项冒充设置保存。

### 16.9 询盘设置与站点询盘 `PAGE-FE-053/054`

**规划状态：`TARGET_NOT_RUNNABLE`**

当前 `InquiryForm` 是 `disabled_until_m2`，没有 receiver、落库或投递。M2 规划要求 consent、anti-abuse 和 outbox。至少需要：

- 管理面读取/保存表单字段、同意文本、接收路由和防滥用配置；
- 公开站提交接口，带 Release/page/component/locale/UTM/referrer/consent；
- 幂等、查重、速率限制、附件政策和稳定错误；
- 管理面 Inquiry list/detail/status；
- 投递 SaaS Conversation 的 ACK、失败恢复、保留/删除和 DSR。

在这些合同完成前，前端和静态站都不能显示“提交成功”。

### 16.10 分析与诊断 `PAGE-FE-055/056`

**规划状态：Analytics 不可运行；Diagnosis 延后 M3+**

分析需要事件 schema、合法目的、consent/opt-out、bot 处理、时区、保留期和聚合读模型；诊断需要抓取授权、Finding 合同、证据、严重度和修复动作。当前没有可接入接口，也不应先装第三方 analytics SDK 再补合规。

---

## 17. 前端开工前应由后端优先补齐的接口

这不是按后端开发难度排序，而是按“缺少后，现有用户路径是否能闭环”排序。

| 优先级 | 缺口 | 影响路径 | 建议 |
|---|---|---|---|
| P0 | Site 维度的 Build list/current | Demo/精装修刷新后无法恢复任务 | 增加 Site→Build 查询，并在 Build DTO 返回 siteId/updatedAt/allowedActions |
| P0 | Site allowed-actions/角色合同 | 所有写操作只有客户端猜权限 | 服务端返回版本化 allowed actions；写入时仍重判 |
| P0 | Site 级 Claim review/impact | 精装修前事实审核不能自助闭环 | 增加 Site Claim 聚合、版本化决定和影响合同 |
| P1 | Site structure/current spec summary | page/section Build 有 API 但前端没有 target ID | 提供只读结构和 expectedBaseVersionId |
| P1 | 单 Asset 查询、读 URL、续签 | 素材无法预览，刷新/过期恢复差 | 增加 Asset detail/read-url/represign，presign 返回 requiredHeaders |
| P1 | Build 结果和恢复字段 | 无法解释 stale、结果版本和允许动作 | 扩充 BuildStatusResponseDto |
| P1 | Intake 失败恢复读合同 | setup_failed 需要重填整份 Intake | 提供受控 Intake read 或 retry-demo 命令 |
| P2 | 完整 Asset usages | 只能删除时得到有界样本 | 增加分页 usage/impact 查询 |
| P2 | 文档级 KB 状态 | 用户无法定位哪份文档失败 | 仅在产品确认要开放自助修复时新增 |
| P2 | Preview 分享策略 | URL 当前公开且无 TTL/撤销合同 | 明确私有 session 或可撤销 share link |

## 18. 当前接口索引

### 18.1 Site Builder 的 13 个公开管理 operation

| operationId | 方法和路径 | 首次详述 |
|---|---|---|
| `IntakeController_create_v1` | POST `/site-builder/intake` | J02.1 |
| `SitesController_list_v1` | GET `/site-builder/sites` | J01.1 |
| `SitesController_get_v1` | GET `/site-builder/sites/{id}` | J01.2 |
| `SitesController_getProfile_v1` | GET `/site-builder/sites/{id}/profile` | J05.1 |
| `SitesController_patchProfile_v1` | PATCH `/site-builder/sites/{id}/profile` | J05.3 |
| `AssetsController_presign_v1` | POST `/site-builder/sites/{id}/assets/presign` | J06.1 |
| `AssetsController_commit_v1` | POST `/site-builder/assets/{id}/commit` | J06.3 |
| `AssetsController_list_v1` | GET `/site-builder/sites/{id}/assets` | J06.4 |
| `AssetsController_remove_v1` | DELETE `/site-builder/assets/{id}` | J06.6 |
| `KbController_status_v1` | GET `/site-builder/sites/{id}/kb/status` | J07.1 |
| `BuildsController_create_v1` | POST `/site-builder/sites/{id}/builds` | J09.1 |
| `BuildsController_get_v1` | GET `/site-builder/builds/{id}` | J02.2 |
| `BuildsController_cancel_v1` | POST `/site-builder/builds/{id}/cancel` | J11.1 |

### 18.2 非 OpenAPI 和跨边界请求

| 请求 | 用途 | 边界 |
|---|---|---|
| PUT `{uploadUrl}` | 浏览器直传素材 | 对象存储签名请求，不带 SaaS token |
| GET `/preview/{slug}[/{assetPath}]` | 开发预览及静态资源 | 当前公开可访问，故意不进管理 OpenAPI |

### 18.3 通用 Claim operation

| operationId | 方法和路径 |
|---|---|
| `ClaimController_list_v1` | GET `/companies/{companyId}/claims` |
| `ClaimController_createManual_v1` | POST `/companies/{companyId}/claims` |
| `ClaimController_approve_v1` | POST `/claims/{claimId}/approve` |
| `ClaimController_reject_v1` | POST `/claims/{claimId}/reject` |
| `ClaimController_revoke_v1` | POST `/claims/{claimId}/revoke` |
| `ClaimController_listConflicts_v1` | GET `/companies/{companyId}/conflicts` |
| `ClaimController_resolveConflict_v1` | POST `/conflicts/{conflictId}/resolve` |

这些接口只有在 J08 的 Site 关联、服务端角色、影响和并发合同补齐后，才能成为独立站前端的可操作路径。

## 19. 前后端联调验收清单

1. 客户端从当前 OpenAPI生成或验证 client，不手抄路径和 DTO。
2. Intake/Build 在超时和 `502` 下复用同一 idempotency key，测试不会重复创建。
3. Profile 覆盖 GET→ETag→PATCH→新 ETag，以及 409/412 冲突保留本地修改。
4. 素材覆盖 presign→PUT→commit→list 的每个中间状态、URL 到期、ACK 不明、重复、拒绝和 retryable。
5. Build 覆盖刷新恢复、active conflict、quota、degraded、skipped、unknown cost、取消 ACK 不明和旧预览保留。
6. Build 成功后必须重新读 Site，不能仅凭 `succeeded` 打开新预览。
7. Preview 明示“开发预览”，不显示正式域名、已上线或询盘成功暗示。
8. Claim 在 Site 合同补齐前保持阻塞，不能用客户端角色或自动批准绕过。
9. 对 OpenAPI未封闭的 string 状态保留 unknown 分支；未知状态不显示成成功。
10. 每次接口变更同时更新 Controller/DTO、生成 OpenAPI、消费者验证、场景和本文行号引用。
