# Global 增长后端 · 前端接入说明

> 本文档给 SaaS 平台前端/服务端开发者。REST 契约以 `openapi/openapi.json`（code-first 导出）为准。
>
> **统一接口门户（推荐前端入口）**：`http://<host>:3000/api/portal` —— 自托管 Scalar，一个地址浏览 + 在线调试全部端点。
> 另有 Swagger UI `http://<host>:3000/api/docs`（内部调试）。契约由 `--export-openapi` 从代码生成，代码即事实源。

## 1. 基础约定

| 项 | 约定 |
|---|---|
| Base URL | `http://<host>:3000/api/v1` |
| 认证 | `Authorization: Bearer <token>` —— token 由 **SaaS 平台侧签发**，本后端只校验并解出 `sub`（用户）、`workspace_id`（租户）、`roles`。开发环境用 base64url(JSON) 即可：`base64url({"sub":"u1","workspace_id":"<uuid>","roles":["admin"]})` |
| 租户 | 一切数据按 `workspace_id` 隔离（数据库 RLS 强制），前端无需传租户参数 |
| 错误模型 | 所有非 2xx 都是 `{ "error": { "code", "message", "details?" } }`；常见 code：`VALIDATION_ERROR`、`NOT_FOUND`、`INVALID_STATE`、`VERSION_CONFLICT`、`NO_APPROVED_CLAIMS`、`SUPPRESSED` |
| 分页 | 游标式：`?limit=&cursor=` → `{ data, page: { nextCursor, hasMore } }` |
| 幂等 | 创建类 POST 支持 `Idempotency-Key` 头（如 `POST /companies`），同 key 重放返回首次结果 |
| 乐观锁 | 可编辑对象带 `version`；PATCH 可传 `expectedVersion`，冲突返回 409 `VERSION_CONFLICT` |
| 异步 | 长任务（理解/发现/评分）返回 `202`，前端轮询对应状态端点（见下） |

## 2. 获客主线 · 端到端调用顺序

### 阶段 0：企业理解（Understand）
1. `POST /companies { website, name? }` → 202，后台自动：多页抓取 → 抽取事实/产品/画像/公开联系方式
2. 轮询 `GET /companies/:id` —— `status`: `DRAFT → ENRICHING → REVIEW → ACTIVE`
3. `GET /companies/:id/claims?status=NEEDS_REVIEW` → 人工审批 `POST /claims/:id/approve|reject`
   - 每条 Claim 带 `evidence[]`（来源页 URL + 原文片段 + 置信度）——**事实可溯源**
   - 审批满 3 条自动 `ACTIVE`；或 `POST /companies/:id/confirm` 显式确认
4. 辅助视图：`GET /companies/:id/completeness`、`/offerings`、`/conflicts`（知识冲突裁决 `POST /conflicts/:id/resolve`）
5. 手工补充事实：`POST /companies/:id/claims`；纠错撤销：`POST /claims/:id/revoke`

### 阶段 1：ICP（Target）
1. `POST /companies/:id/icps` → AI 生成 ICP（`HYPOTHESIS`）：属性/痛点/触发信号/排除 + 买家委员会 + **机器可评估规则 rules**
2. 人工修订：`PATCH /icps/:id`；规则增删改：`POST /icps/:id/rules`、`PATCH|DELETE /icp-rules/:ruleId`
3. 回测：`POST /icps/:id/backtests { samples: [{name, attributes, expected}] }` → 命中率指标（→ `VALIDATING`）
4. 激活：`POST /icps/:id/activate`（旧 ACTIVE 自动 `SUPERSEDED`）

### 阶段 2：发现（Discover）
1. `POST /icps/:id/query-plans` → AI 生成多源查询计划（`DRAFT`）
2. 人工确认：`POST /query-plans/:id/confirm`（→ `READY`）
3. 执行：`POST /query-plans/:id/execute` → 202 `{runId}`；轮询 `GET /discovery-runs/:runId`（`RUNNING → DONE|PARTIAL`，stats 含每源计数）
4. 结果：`GET /canonical-companies`（`?status=NEW|ENRICHED|SUPPRESSED`）；详情含**字段级 Evidence**（每个字段值来自哪个源、什么许可）
   - 过了 fit 门的高价值公司自动做**多源富集**（互补并跑，均 CC0 直连数据）：
     - `attributes.gleif.*` —— 法律身份：`lei`/`legal_name`/`legal_form`/`entity_status`/`parent_name`/`ultimate_parent_name`（母子集团关系，识别目标是否某集团子公司）
     - `attributes.wikidata.*` —— 商业事实：`industries`/`products`/`employees`/`inception_year`/`parent_name`/`subsidiary_count`/`lei`/`isin`/`stock_exchange`/`headquarters`/`website`
     - 每字段带 `field_evidence`（`license=public`，`provider_key` 标来源，含 GLEIF/Wikidata 记录 URL）；两源的 `lei` 可交叉验证
5. 高价值企业按需补联系人：`POST /canonical-companies/:id/discover-contacts`；邮箱验证：`POST /contact-points/:id/verify`
6. 禁联名单：`POST|GET|DELETE /suppressions`（domain/email/company_name；即时生效）

### 阶段 3：验证评分（Qualify）
1. `POST /icps/:id/qualify` → 202，后台确定性六维评分（Fit/Role/Intent/DataQuality/Reachability/Engagement）
2. 队列视图：`GET /icps/:id/lead-queues` → `{recommended, needs_review, rejected, suppressed}`
3. 列表：`GET /leads?icpId=&queue=`（按总分排序，含公司摘要）；详情 `GET /leads/:id` 带**逐规则评分依据**
4. 人工裁决：`POST /leads/:id/accept`（→ `QUALIFIED`，发 `LeadQualified` 事件——交给 Campaign 的出口）/ `POST /leads/:id/reject { reason }`

## 3. 事件（服务端集成用）

领域事件经 Transactional Outbox 发布，信封结构见 `events/envelope.schema.json`。关键事件：
`CompanyProfileCreated`、`ClaimApproved`、`ClaimRevoked`、`ClaimExpired`、`KnowledgeConflictDetected`、
`ICPActivated`、`DiscoveryRunRequested/Completed`、`QualifyRequested`、`LeadsScored`、`LeadQualified`。

## 4. 数据真实性说明（前端展示建议）

- **Claim = 事实**：永远带来源 URL + 原文片段，建议 UI 提供「查看原文」
- **ICP = 推断**（`HYPOTHESIS`）：建议 UI 标注「AI 生成，待回测/确认」
- **sandbox 数据**：`license=sandbox`、域名 `*.sandbox.example.com` 的记录是合成数据（真源接入前），UI 必须可区分
- 联系方式发送前必须 `VALID`（邮箱验证状态在 `contactPoints[].status`）
