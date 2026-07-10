> 【2026-07-10】**REST 契约唯一真值 = code-first 导出的 `openapi/openapi.json`**（NestJS decorators 生成）。本目录旧 `openapi.yaml`（3 paths）已过时，且下方脚本仍读取旧 YAML——收口④（见 docs/roadmap/release-plan.md）将删除旧 YAML 并把 lint/docs/mock/gen 切到 JSON；在此之前**勿以 YAML 或本 README 的 contract-first 描述为准**。

# @global/contracts — 前后端接口契约（唯一事实源）

前端与后端**都以本包为准**对接。后端照契约实现，前端照契约（+ Mock）开发。任何接口/事件变更先改这里，CI 做兼容性检查（ADR-017）。

## 结构

```
packages/contracts/
  openapi/            REST 契约（OpenAPI 3.1），按 PRD 11.12 API 分组拆文件
    _shared/          共享组件：错误、分页、鉴权、通用 schema（Money/Evidence/Id）
    company.yaml      /companies /knowledge
    icp.yaml          /icps /accounts /contacts /leads
    ...
  events/             事件契约（AsyncAPI + JSON Schema）
    envelope.schema.json   事件信封（PRD 11.10）
    payloads/         各 event_type 的 payload schema
  src/                生成给 TS 消费方的类型与常量
```

## 前端怎么用（四件套）

| 交付 | 用途 | 命令（就绪后） |
|---|---|---|
| **Swagger UI** | 在线浏览/调试全部接口 | `pnpm contracts:docs` |
| **Mock 服务** | 对着契约返回假数据，前端不等后端即可开发 | `pnpm contracts:mock` → `http://localhost:4010` |
| **生成 TS 类型/客户端** | 前端 `import` 类型、按接口调用 | `pnpm contracts:gen` |
| **版本 + 变更日志** | 稳定对接、破坏性变更提前预警 | CI 自动 |

## 约定（所有接口通用）

- **Base path / 版本**：`/api/v1`。破坏性变更升 `v2`，旧版并存过渡。
- **鉴权**：`Authorization: Bearer <token>`。token 由**外部 SaaS 平台签发**（身份系统不在我方）；我方后端只**校验并解出** workspace 与角色（不做登录/用户管理），据此定位租户(RLS)与权限。前端对接方式不变。
- **分页**：游标分页 `?limit=&cursor=`，响应含 `{ data, page: { next_cursor, has_more } }`。
- **ID**：`uuid`。**时间**：UTC ISO-8601（如 `2026-07-06T03:00:00Z`）。**金额**：`{ "currency": "USD", "amount": "1234.56" }`（PRD 11.14 存币种+值）。
- **幂等**：所有写副作用接口支持 `Idempotency-Key` 头（PRD 11.16）。
- **并发**：可变资源带 `version`；更新用 `If-Match`，冲突返回 `409 VERSION_CONFLICT` + 当前版本。

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

## 变更策略

语义化版本；破坏性变更（删字段、改类型、改必填）必须升主版本并提供迁移说明。契约改动在 CI 跑 `spectral`（lint）+ `oasdiff`（breaking check），不通过不合并。
