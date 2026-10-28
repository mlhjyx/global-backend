/**
 * 接口门户（/api/portal）首页的接入说明。
 *
 * 契约由代码生成，这段文字也随代码走：改这里 = 改门户首页。
 * 详细的调用顺序与业务约束在 packages/contracts/INTEGRATION.md，这里只放
 * 「不看代码也能把第一个请求发出去」所需的全部约定。
 */
export const PORTAL_INTRO_MARKDOWN = `## 这是什么

本页由服务自身生成：接口列表、参数与响应结构都来自正在运行的这个版本，接口变了这里同步变，不存在文档滞后的情况。每个端点都可以点开直接发请求（先点右上角 **Authorize** 填 token）。

需要更完整的调用顺序与业务约束，看仓库里的 \`packages/contracts/INTEGRATION.md\`；需要把整套接口导入 Postman / Apifox / Bruno，导入 \`/api/docs-json\` 即可。

## 地址

| 环境 | Base URL |
| --- | --- |
| 开发（xin） | \`http://100.68.31.20:3000/api/v1\` |

同源部署，路径里带版本号 \`/api/v1\`。

## 认证

每个请求都要带 \`Authorization: Bearer <JWT>\`。

- JWT 由 **GrowthOS（SaaS 平台）签发**，本后端只验签，不接受任何未签名令牌；开发环境同样由本地 GrowthOS 身份源签发。
- 开发环境取 token（token 约 5 分钟有效，过期重取）：

\`\`\`bash
ssh xin@100.68.31.20 /global/local-config/bin/api-token
\`\`\`

- token 里带 \`sub\`（用户）、\`workspace_id\`（租户）、\`roles\`。**所有业务数据按 workspace 隔离（数据库 RLS 强制），前端不需要也不应该传租户参数**；跨租户的资源按「不存在」处理，返回 404。
- 角色映射到 scope，缺 scope 时返回 403 \`SCOPE_REQUIRED\`，\`details.required\` 会告诉你缺哪个：

| 角色 | 可用 scope |
| --- | --- |
| \`TENANT_OWNER\` | acquisition 全读写 + review + 事件确认 + export + personal-data 读 + compliance 管理 |
| \`ADMIN\` | 同上，但没有 compliance 管理 |
| \`MEMBER\` | 仅 \`acquisition:read\` / \`acquisition:write\` |

## 响应信封

- 单资源：\`{ "data": ... }\`
- 分页列表：\`{ "data": [...], "page": { "next_cursor": "…", "has_more": true } }\`，请求用 \`?limit=&cursor=\`；\`next_cursor\` 为 \`null\` 表示到底。**是游标分页，不是 offset 分页**。
- 例外：\`/health*\` 探针不套信封。

## 错误

非 2xx 一律是同一个形状：

\`\`\`json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": { } } }
\`\`\`

常见 code：\`TOKEN_MISSING\` / \`TOKEN_INVALID\` / \`SCOPE_REQUIRED\` / \`VALIDATION_ERROR\` / \`NOT_FOUND\` / \`INVALID_STATE\` / \`VERSION_CONFLICT\` / \`SUPPRESSED\`。\`code\` 稳定可判断，\`message\` 只供人读，不要拿它做逻辑。

## 幂等与并发

- **只有 OpenAPI 里显式声明了 \`idempotency-key\` 请求头的端点才支持幂等**（如 \`POST /companies\`、Site Builder 的 intake/builds）。别把这条推广到所有 POST。
- 可编辑对象带 \`version\`；PATCH 可传 \`expectedVersion\`，不一致返回 409 \`VERSION_CONFLICT\`，重读后再提交。

## 异步

理解、发现、评分这类长任务返回 **202**，建站构建返回 **201** 并带 buildId——都是异步的，前端轮询对应的状态端点，不要同步等待：

| 动作 | 发起 | 轮询 |
| --- | --- | --- |
| 理解官网 | \`POST /companies\` | \`GET /companies/{id}/completeness\` |
| 执行发现 | \`POST /query-plans/{id}/execute\` | \`GET /discovery-runs/{id}\` |
| 建站 | \`POST /site-builder/sites/{id}/builds\` | \`GET /site-builder/builds/{id}\` |

## 主链路（获客闭环）

1. \`POST /companies\` 提交官网，返回 202，理解异步进行
2. \`GET /companies/{id}/completeness\` 看进度；\`GET /companies/{id}/offerings\` 看抽出的产品
3. \`GET /companies/{id}/claims\` → \`POST /claims/{id}/approve\` 审批事实
4. \`POST /companies/{id}/confirm\` 人工确认，企业转 ACTIVE
5. \`POST /companies/{id}/icps\` 建 ICP → \`POST /icps/{id}/activate\`
6. \`POST /icps/{id}/query-plans\` 生成查询计划 → \`POST /query-plans/{id}/confirm\` → \`POST /query-plans/{id}/execute\`
7. \`GET /discovery-runs/{id}\` 轮询发现进度；\`GET /canonical-companies\` 看规范化后的公司
8. \`POST /canonical-companies/{id}/discover-contacts\`、\`POST /canonical-companies/{id}/guess-emails\`、\`POST /contact-points/{id}/verify\` 补决策人
9. \`POST /icps/{id}/qualify\` 评分 → \`GET /leads\` / \`GET /leads/{id}/package\` 取交付包
10. \`POST /leads/{id}/accept\` 或 \`/reject\` 回执；\`GET /reports/weekly\` 周报

## 分域

| 域 | 一句话 |
| --- | --- |
| Companies | 企业画像：提交官网、看完整度、审批事实后人工确认 |
| Claims | 企业事实与来源：审批/驳回/撤销，冲突裁决 |
| ICP | 理想客户画像：规则、回溯测试、查询计划 |
| Discovery | 查询计划执行、规范化公司、联系人补全、抑制名单、数据源 |
| Leads | 评分产出与交付：交付包、接受/拒绝、制裁复核 |
| Reports | 周报与反馈 |
| Events | 事件投递账本与确认回执 |
| Compliance | 数据主体删除请求（Art.17） |
| SiteBuilder | 独立站：intake、资料、素材、构建、预览 |
| ExecutionBudget | 平台内部执行预算包络（服务间调用） |
| PlatformAuthority | 平台权威通道：技术报价、目标查询、撤销（服务间调用） |
| System | 健康探针与身份（\`/whoami\`） |

> **ExecutionBudget / PlatformAuthority** 两组是 GrowthOS 与服务间调用的机器通道，用的是另一套固定用途的服务身份，普通前端不要调用。`;
