# @global/contracts — 前后端接口契约（code-first 单一真值）

前端与后端**都以本包为准**对接。**REST 契约唯一真值 = [`openapi/openapi.json`](openapi/openapi.json)**——由后端实现的 NestJS 装饰器生成（`node apps/api/dist/main.js --export-openapi`），**代码即事实源**；本目录不手写 REST 契约。事件契约（`events/`）仍是手写 JSON Schema（事件先于实现定形）。

接口/事件变更 = 改代码装饰器 → 重导出 → CI 校验（drift + lint + 破坏性变更拦截，见下）。

## 结构

```
packages/contracts/
  openapi/openapi.json     REST 契约（生成物，勿手改；CI 校验与代码一致）
  events/                  事件契约（手写，PRD 11.10/11.11）
    envelope.schema.json     事件信封
    payloads/                各 event_type 的 payload schema（lead-qualified.v1 等）
    WEBHOOK.md               webhook 推送验签契约（HMAC）
  src/generated/api.ts     从 openapi.json 生成的 TS 类型（pnpm contracts:gen）
```

## 前端怎么用（四件套）

| 交付 | 用途 | 命令 |
|---|---|---|
| **接口门户** | 在线浏览/调试全部接口 | 运行中 API 的 `/api/portal`（Scalar）或 `/api/docs`（Swagger UI）；离线版 `pnpm contracts:docs` |
| **Mock 服务** | 对着契约返回假数据，前端不等后端即可开发 | `pnpm contracts:mock` → `http://localhost:4010` |
| **生成 TS 类型** | 前端 `import` 类型、按接口调用 | `pnpm contracts:gen` |
| **版本 + 破坏性变更预警** | 稳定对接 | CI 自动（spectral lint + oasdiff breaking） |

## 约定（所有接口通用）

- **Base path / 版本**：`/api/v1`。破坏性变更升 `v2`，旧版并存过渡。
- **鉴权**：`Authorization: Bearer <token>`。token 由**外部 SaaS 平台签发**（身份系统不在我方）；我方后端只**校验并解出** workspace 与角色（不做登录/用户管理），据此定位租户(RLS)与权限。前端对接方式不变。
- **统一响应信封**（2026-07-10 定稿，收口④）：
  - 单资源/命令结果：`{ "data": <resource> }`
  - 列表（游标分页 `?limit=&cursor=`）：`{ "data": [...], "page": { "next_cursor": "...", "has_more": true } }`（`next_cursor: null` = 到底）
  - 无分页小集合：`{ "data": [...] }`（无 `page` 键）
  - 错误：`{ "error": { "code", "message", "details?" } }`（见下）
  - 协议键（`data`/`page`/`error` 及 `page` 内键）snake_case；资源字段 camelCase（DTO 层）。事件 envelope 字段全 snake_case（PRD 11.10）。
  - 例外：`/health*` 不套信封（基础设施探针）。
- **ID**：`uuid`。**时间**：UTC ISO-8601（如 `2026-07-06T03:00:00Z`）。**金额**：`{ "currency": "USD", "amount": "1234.56" }`（PRD 11.14 存币种+值）。
- **幂等**：写副作用接口支持 `Idempotency-Key` 头（PRD 11.16）。
- **并发**：可变资源带 `version`，冲突返回 `409 CONFLICT`/`VERSION_CONFLICT` + 当前版本。

## 错误模型（PRD 11.15）

统一响应体：`{ "error": { "code": "MACHINE_CODE", "message": "...", "details": {} } }`。机器码稳定、前端据此分支处理：

| HTTP | code 示例 | 含义 / 前端动作 |
|---|---|---|
| 400 | `INVALID_SCHEMA` | 字段校验失败 → 提示修正 |
| 401 | `TOKEN_EXPIRED` | 重新鉴权 |
| 403 | `ACTION_DENIED` | 策略拒绝 → 申请权限/改范围 |
| 402 | `BUDGET_EXCEEDED` | 预算不足 → 增预算/缩范围 |
| 409 | `VERSION_CONFLICT` | 版本冲突 → 合并/新建 Revision |
| 422 | `AUTHORIZATION_REQUIRED` | 需审批 → 走审批流 |
| 423 | `LICENSE_RESTRICTED` | 数据权利限制 → 换来源 |
| 503 | `PROVIDER_UNAVAILABLE` | 供应商暂不可用 → 稍后/替代 |

## 变更策略与 CI 门

- 契约由 CI 三道门守（`.github/workflows/ci.yml` contracts job）：
  1. **drift**：重导出后 `git diff --exit-code openapi/openapi.json`——提交的契约必须与代码一致（改了装饰器忘了重导出 → CI 红）。
  2. **lint**：`spectral lint`（规则 `.spectral.yaml`），error 级即失败。
  3. **breaking**：`oasdiff` 对比 PR base 分支的契约，破坏性变更（删字段/改类型/改必填）默认拦截；确需破坏（升主版本+迁移说明）给 PR 打 `breaking-change-approved` label 放行。
- 🔴 **header 参数大小写陷阱**：HTTP header 名大小写不敏感，`oasdiff` 亦归一。若同一操作出现两个仅大小写不同的 header 参数（如 `@Headers('idempotency-key')` 推断的 `idempotency-key` + `@ApiHeader({ name: 'Idempotency-Key' })` 显式声明的 `Idempotency-Key`），`oasdiff` 会把契约**与其自身**误判为破坏性变更，令所有「未改契约」的 PR 无端翻红。修法：`@ApiHeader` 的 `name` 必须与 `@Headers('…')` 推断名**精确一致（含大小写）**，二者才合并成单参数。`apps/api/src/common/openapi-header-params.spec.ts` 单测守此不变式。
- 本地重导出：`pnpm --filter @global/api build && node apps/api/dist/main.js --export-openapi`（无需 DB/Temporal，假 `DATABASE_URL` 即可）。
