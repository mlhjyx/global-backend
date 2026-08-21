# Execution Budget Authority 与大型结果耐久重放设计

> 文档 ID：`DOC-ARCH-EXECUTION-BUDGET-ARTIFACT-001`  
> 生命周期：`APPROVED_DESIGN`  
> 实现状态：`NOT_AS_BUILT`  
> 上位决策：[ADR-024](../adr/registry.md) 单一产品运行路径与 SaaS 预算授权  
> 适用范围：非 Site Builder 的 Workspace AI/Tool 请求、平台 Schedule、通用 ToolBroker/ModelGateway 结果恢复  
> 不构成：部署授权、真实费用授权、RuntimeEvidence、Release Bundle 或当前生产能力声明

## 1. 目标与不变量

本设计补齐 ADR-024 尚未覆盖完整的两条产品执行链：

1. 非 Site Builder 的模型/工具请求必须先获得外部权威签发的费用授权，Backend 不能以环境变量、默认金额或调用方传入的 cap 自行签发费用权限。
2. 物理调用成功后的有效结果必须可以跨 Activity retry、Worker 重启和多副本恢复；大型结果不得塞入预算账本 JSONB，也不得因为无法恢复而重新发送物理请求。

以下不变量同时适用于 development、pilot 和 production：

- 同一业务代码、JWS/claims、数据库 guard、artifact manifest、重放、ACK、错误码和 readiness。
- 环境差异只允许 issuer/JWKS、secret reference、endpoint、数据、额度值、资源和部署拓扑。
- 没有权威授权时零账户、零 operation、零 Provider wire。
- 没有有效输出或物理调用/ACK 状态未知时保留完整 reservation，绝不自动发送第二次物理请求。
- 有效输出但精确费用暂缺时按 reservation 上界结算，结果仍可重放，费用异步 reconciliation。
- 测试 Stub/Fake/Sandbox 不能签发产品 authority、不能进入 managed composition，也不能生成正式 artifact。
- Backend 不成为 subscription、Credits 或 Billing 的最终账务 SoR。

## 2. 非目标

- 不改变 Site Builder 已有 `SiteBuildBudgetGrant` HTTP 合同；它可以在后续迁移到共享 verifier/authority 基座，但不得因本设计回退。
- 不把 prompt、模型原始响应、Authorization header、API key 或无限制 provider body 写进预算账本。
- 不为每个 Provider 建一套独立对象键、重放状态机或 ACK 表。
- 不使用 PostgreSQL 大 TOAST 行保存网页、XML、浏览器或 renderer 大结果。
- 不允许环境名选择不同的授权、artifact 或重放实现。

## 3. 统一费用权威

### 3.1 两类授权主体

所有通用执行预算归一为不可变的 `ExecutionBudgetAuthority`，来源只能是：

| authority kind | 适用请求 | 签发/更新主体 |
| --- | --- | --- |
| `WORKSPACE_GRANT` | 用户触发的 ICP、Understanding、Discovery、邮箱验证等 | SaaS Control Plane 短期签名 Grant |
| `PLATFORM_GRANT` | Sanctions、Acquisition、Intent watch 等平台 Schedule | Control Plane/运营控制面签名的可续期 campaign/schedule Grant |

这是按费用责任主体区分，不是按 environment 区分。三种产品环境都运行同一 verifier 和持久化逻辑。

### 3.2 Workspace Grant HTTP 合同

需要真实付费模型/工具的 Workspace HTTP mutation 统一携带：

```http
X-Execution-Budget-Grant: <compact JWS>
```

protected header：

```json
{
  "alg": "RS256 | ES256 | EdDSA",
  "kid": "<bounded-key-id>",
  "typ": "execution-budget-grant+jwt"
}
```

payload v1：

```json
{
  "schema_version": "execution-budget-grant/v1",
  "iss": "<saas-issuer>",
  "aud": "global-backend:execution-budget",
  "jti": "<uuid>",
  "iat": 1786800000,
  "nbf": 1786800000,
  "exp": 1786800300,
  "authority_kind": "WORKSPACE_GRANT",
  "purpose": "icp.design | icp.query_plan | understanding.run | discovery.run | contact.verify",
  "workspace_id": "<uuid>",
  "subject_type": "company | icp | discovery_run | contact_point",
  "subject_id": "<bounded-id>",
  "request_sha256": "<64-lowercase-hex>",
  "currency": "USD",
  "unit": "microusd",
  "cap_microusd": "5000000"
}
```

验证规则复用 Site Build Grant 的固定语义：非对称算法白名单、必需 `kid`/`typ`、固定 audience、issuer/JWKS 信任根、300 秒最大 TTL、60 秒最大时钟容差、workspace 与 Bearer identity 一致、请求摘要与 subject/purpose 精确绑定、canonical decimal bigint。原始 JWS 不进入日志、trace 或数据库。

### 3.3 Platform Grant 交付合同

平台 Schedule 不从环境变量读取金额，也不持有永不过期的 JWS。Control Plane 通过已登记的 integration event 发送签名命令：

```text
PlatformExecutionBudgetAuthorityUpserted/v1
```

命令包含与 Workspace Grant 相同的签名 claims，额外绑定：

- `authority_kind=PLATFORM_GRANT`
- `purpose=platform.acquisition | platform.intent_watch | platform.sanctions`
- `schedule_id`
- `valid_from` / `valid_until`
- `max_runs`
- `cap_per_run_microusd`
- `campaign_cap_microusd`

Outbox/Relay 只负责传输；Backend 必须验签后才写入 authority。未知 event schema、验签不可用、authority 过期/撤销或 run/campaign cap 耗尽时 Schedule 保持 non-consuming/not-ready，不自动创建预算。

### 3.4 数据模型

新增不可变、FORCE RLS 的 `ExecutionBudgetAuthority`：

- `id`
- `authorityKind`
- `workspaceId`（Platform Grant 为 null）
- `issuer`
- `audience`
- `jti`
- `tokenSha256`
- `schemaVersion`
- `purpose`
- `subjectType`
- `subjectId`
- `requestSha256`
- `scheduleId`
- `currency`
- `unit`
- `capMicrousd`
- `capPerRunMicrousd`
- `maxRuns`
- `runsConsumed`
- `issuedAt`
- `notBefore`
- `expiresAt`
- `consumedAt`
- `revokedAt`

约束：

- `UNIQUE(issuer,jti)`。
- Workspace authority 必须有 workspace/subject/request hash；Platform authority 必须有 schedule/campaign fields。
- app role 只允许 `SELECT/INSERT`，禁止 `UPDATE/DELETE`；撤销通过 append-only `ExecutionBudgetAuthorityRevocation`。
- `ToolBudgetAccount` 新增非空 `authorityId` 和 `authorizedCapMicrousd`。
- `open_tool_budget` 改为接收 `authorityId + accountKey + replayScope`，数据库从 authority 读取 cap；不再接收调用方任意 cap。
- reserve 函数再次验证 authority、scope、purpose、subject、有效期、撤销、run/campaign cap 与账户 generation。

### 3.5 错误合同

```text
EXECUTION_BUDGET_GRANT_REQUIRED
EXECUTION_BUDGET_GRANT_INVALID
EXECUTION_BUDGET_GRANT_EXPIRED
EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH
EXECUTION_BUDGET_GRANT_REUSED
EXECUTION_BUDGET_AUTHORITY_REVOKED
EXECUTION_BUDGET_AUTHORITY_EXHAUSTED
EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE
```

缺失/不可验证 authority 必须发生在业务行、Temporal Workflow 和 Provider wire 创建之前。

## 4. 结果策略

每个受管 Model/Tool 必须在 composition/registry 中声明唯一 `durableResultStrategy`：

```text
typed_projection | artifact_reference | no_physical_call
```

- `typed_projection`：小型、闭合、可安全存入 PostgreSQL 的结构化业务结果。
- `artifact_reference`：网页、XML、浏览器、renderer、文档或其他可能超过 120 KiB 的结果。
- `no_physical_call`：只允许纯确定性/本地行为；若工具可能出网则 registry/governance 直接拒绝。

任何可能出网的 managed Tool/Model 缺少策略时，readiness 与治理检查失败，不能等物理调用成功后才发现不可重放。

## 5. Typed Projection

每个 schema 必须有专属 runtime validator/projector/restorer：

- closed object，拒绝未知字段。
- 所有字符串有 `maxLength`。
- 所有数组有 `maxItems`。
- 所有数字规定整数/decimal-string/范围。
- 嵌套对象 closed；禁止开放 `attributes: Record<string,unknown>` 直接进入 projection。
- projector 只复制恢复 domain write 所需的最小字段。
- validator 在 Provider wire 前验证预期 schema 边界，在结果返回后再次验证实际输出。
- 完整 envelope 小于应用层 120 KiB，并证明 PostgreSQL JSONB 表示小于 128 KiB。

首批 typed projection：

- ICP design/query-plan
- Understanding claims/profile/offerings
- Taxonomy code result
- TED/OpenFDA/SAM 绿事实
- SMTP probe verdict
- Fit judgment

模型原始 prompt、reasoning、原始 response body 和未受控 evidence 原文不进入 projection。

## 6. 大结果 Artifact Reference

### 6.1 对象与 manifest

新增 `GenericOperationArtifact` 元数据表；body 存对象存储。对象键固定：

```text
generic-operation-results/v1/sha256/<digest[0:2]>/<digest>
```

manifest v1：

```json
{
  "schemaVersion": "generic-operation-artifact/v1",
  "artifactId": "<uuid>",
  "scopeKind": "workspace | platform",
  "workspaceId": "<uuid|null>",
  "operationId": "<uuid>",
  "resultSchema": "sanctions-download/v1",
  "objectKey": "generic-operation-results/v1/sha256/ab/ab...",
  "sha256": "<64-lowercase-hex>",
  "sizeBytes": "1234567",
  "mediaType": "application/xml",
  "privacyClass": "PUBLIC_ORGANIZATION | CONFIDENTIAL_TENANT | PERSONAL_DATA",
  "sourceDigest": "<optional-provider-receipt-digest>",
  "createdAt": "2026-08-21T00:00:00.000Z",
  "expiresAt": "2026-08-22T00:00:00.000Z"
}
```

表约束：

- `UNIQUE(scope,operationId)` 保证一个受管 operation 只能追加一个 byte-exact
  manifest；不同 authority/operation 可以引用同一个内容对象，不能用 digest
  唯一性把合法引用误判为 replay。
- 物理对象元数据单独规范化为全局 `GenericOperationArtifactObject`：以
  `sha256` 为主键，并由复合外键固定 `objectKey + sizeBytes + mediaType +
  privacyClass`。同一 digest 的并发引用先按 digest 串行化，再复用同一对象
  行；任何固有元数据冲突 fail closed。
- `sourceDigest` 是每次 provider/operation 的来源回执，`createdAt/expiresAt`
  是每个 manifest 的 lineage 与读取有效期，允许在引用同一字节对象时不同；
  对象回收必须等所有引用过期，并遵守其中最严格的隐私删除/权利处理链，
  不能由单个 manifest 的过期时间提前删除共享对象。
- object key 必须从 sha256 机械派生。
- size 必须在 provider/schema 固定上限内。
- app role 只允许 append/read，禁止改写/删除 manifest。
- 对象存储必须开启加密、versioning/immutability 兼容策略和 lifecycle；运行副本只 validate/use，不 provision。
- PERSONAL_DATA artifact 使用独立短 TTL、最小读取 role 和删除/权利处理链。

### 6.2 写入协议

物理调用成功后：

1. 结果以有界 stream 写 staging object，同时计算 sha256 和字节数。
2. 超 provider/schema 上限立即终止，operation 保持不可二调状态；不得截断后冒充完整结果。
3. staging 完成后以内容摘要 promote/copy 到 immutable content-addressed key。
4. 对最终对象执行 HEAD/readback，验证 size/digest/metadata。
5. 在同一个数据库事务中写 `GenericOperationArtifact` manifest，并用小型 `generic-operation-artifact-ref/v1` projection settle BudgetOperation。
6. 删除 staging object；失败由 lifecycle 清理，不影响已完成 immutable object。

对象存储 ACK 未知时：

- operation 进入 `RESULT_UNKNOWN`，完整 reservation 保留。
- 只按预期 digest/object key 恢复事实；不得重新调用 Provider。
- 恢复成功后追加 manifest；恢复失败按任务正式失败。

### 6.3 读取协议

retry 命中 artifact reference 后：

1. 校验 projection/manifest closed schema。
2. 校验 scope、operation、authority、resultSchema、expiry。
3. 下载到每次调用独立的临时目录/stream。
4. 逐字验证 size 和 sha256。
5. 由 resultSchema 专属 materializer 解析成受限业务对象。
6. 任一不匹配返回 `GENERIC_OPERATION_ARTIFACT_INVALID`，不发第二次物理请求。

首批 artifact 工具：

- `sanctions.download`
- `http.get`
- Crawl4AI fetch/render

后续只有在结果上界超过 typed projection 时才扩展 artifact 策略。

## 7. Domain ACK

新增 append-only、FORCE RLS 的 `GenericOperationDomainAck`：

- `workspaceId` / platform scope
- `operationId`
- `authorityId`
- `resultDigest`
- `artifactId`（typed projection 为 null）
- `consumer`
- `domainAggregateType`
- `domainAggregateId`
- `domainRevision`
- `acknowledgedAt`

约束：

- `UNIQUE(operationId,consumer,domainAggregateType,domainAggregateId)`。
- ACK 只能在 domain transaction 已成功后追加；不能先 ACK 后写业务状态。
- 相同 ACK 幂等；不同 digest/revision 返回 conflict。
- app role 不允许 UPDATE/DELETE。
- ACK 不保存 prompt、body、凭据或个人数据。

retry 语义：

- 没有 ACK：恢复 typed projection/artifact，重复执行幂等 domain write，然后追加 ACK。
- 已有 exact ACK：直接返回 domain identity/revision，不重复 materialize 或写入。
- ACK conflict：任务失败并告警，不自动选择任一结果。
- artifact 在 ACK 前过期：`ARTIFACT_EXPIRED_UNACKED`，任务终止且不二调。
- artifact 在 ACK 后过期：domain state 仍为权威；读取 API 不依赖原 artifact。

## 8. 状态与结算

`tool_budget_operation_status` 扩展为：

```text
RESERVED | RESULT_UNKNOWN | SETTLED | RELEASED
```

语义：

- `RESERVED`：调用可能尚未开始，或调用后尚无可验证结果/结算事实；不得新 generation 绕过。
- `RESULT_UNKNOWN`：物理调用已开始，结果/object ACK 状态未知；只允许事实恢复。
- `SETTLED`：有效 typed projection 或 artifact ref 已持久化，费用按 exact/upper bound 结算。
- `RELEASED`：已证明物理调用未开始。

费用和结果状态分离：有效 artifact 但 exact cost 暂缺仍为 `SETTLED + estimated_upper_bound`；没有有效结果或物理状态未知才使用 `RESULT_UNKNOWN`。

## 9. Readiness 与治理

managed readiness 新增：

- Execution Budget JWKS/verifier。
- Workspace/Platform authority capability。
- Platform schedule authority freshness。
- Generic artifact bucket/lifecycle/encryption/read-write-readback。
- 每个 managed Model/Tool 的 durable strategy registry 完整性。
- result schema/materializer registry 完整性。

治理门新增：

- 出网 Tool/Model 没有 durable strategy → fail。
- typed projection 使用开放对象、无字符串/数组上限或可能超过 120 KiB → fail。
- artifact tool 没有 manifest schema、provider byte cap、privacy class、TTL 或 materializer → fail。
- 产品代码直接把 body/prompt/response 存入 ToolBudgetOperation → fail。
- environment 条件选择不同 strategy/validator/ACK 语义 → fail。
- OCI 出现测试 artifact store、fixture body 或 fake authority signer → fail。

## 10. 迁移与切换

实施采用 additive-first、单次产品切换：

1. 新增 Authority、Artifact、DomainAck、Revocation 表与 RLS/权限。
2. 新增 artifact object-store validator、registry 和 materializer，但不接产品调用。
3. Control Plane 先提供 Workspace Grant 签发与 Platform Grant integration event。
4. Backend 验证 authority ingestion/readiness；未获得 authority 时保持不 ready。
5. 为 typed small-result 路径逐个接入 closed schema。
6. 为 sanctions/http/Crawl4AI 接入 artifact reference。
7. 为 domain consumer 接入 ACK。
8. 原子切换 `open_tool_budget`：必须 authorityId，删除 cap 参数和 `$20/$50`/配置 cap 授权语义。
9. 不保留 development/production 旧新开关，不保留无 authority 自动开账。
10. 历史 terminal operation 保持只读；历史 RESERVED/unknown 不伪造 authority 或 result。

迁移只 forward-fix。若 N-1 不兼容新 authority/ACK schema，暂停新工作，不执行破坏性数据库回滚。

## 11. 测试与验收

### 11.1 Authority

- 合法 RS256/ES256/EdDSA；拒绝 none/HS/无 kid/错 typ。
- workspace/purpose/subject/request hash/cap/TTL/issuer/audience 绑定。
- 20 路并发相同 JTI 只创建一个 authority/account/work identity。
- 同 JTI 异请求 conflict；原始 JWS 不进入日志/trace/DB。
- Platform authority 过期、撤销、maxRuns/campaign cap 耗尽时 Schedule 零消费。
- 无 authority 时 DB `open_tool_budget` 直接拒绝。

### 11.2 Typed Projection

- 每个 schema 的最大合法边界可成功 project/restore。
- 超 maxLength/maxItems/未知字段/开放对象/非 canonical 数字被拒绝。
- 完整 envelope 同时通过 TypeScript 与 PostgreSQL 字节上限。
- crash-after-wire/before-domain-write retry 零 Provider wire。

### 11.3 Artifact

- 0 字节、最大合法字节、超限、截断、digest/size/media mismatch。
- staging upload 成功但 promote ACK 丢失。
- immutable object 已存在的幂等恢复。
- object 缺失、损坏、被替换、metadata 漂移、过期。
- Worker A 写 artifact、Worker B materialize；重启和多副本安全。
- PERSONAL_DATA TTL/权限/删除链。

### 11.4 Domain ACK

- domain write 成功、ACK 丢失：retry 读取 domain identity，不二调。
- artifact materialize 后 domain transaction 失败：retry 重放 artifact。
- exact ACK 幂等；异 digest/revision conflict。
- ACK 前 artifact 过期 terminal fail；ACK 后 artifact 过期不影响 domain read。

### 11.5 必跑门

- 单元、集成、Temporal replay、真 PostgreSQL/FORCE RLS、真对象存储 E2E。
- 改动范围 statements/branches 均不低于 80%。
- API/Worker/Contracts/Renderer build。
- OpenAPI/event schema diff。
- governance/docs/ContractGraph。
- OCI actual build、whole-image scan、Worker fail-closed smoke。
- 独立 correctness/security review。
- 当前 head CI 全绿。

## 12. 回滚与运维

- 部署只晋级 exact OCI digest；API/Worker 同 digest。
- 切换前暂停新工作、drain 旧 Worker、确认无 mixed digest queue。
- 回滚到 N-1 仅在 schema 兼容时允许；否则暂停并 forward-fix。
- artifact 存储故障时 readiness 关闭、Worker 不 polling、API 不接相关新工作。
- authority verifier 故障时不消费新 authority，不使用缓存外的过期 Grant。
- 所有 RuntimeEvidence 绑定 commit、image/artifact digest、migration revision、authority issuer、artifact storage capability 和 task queue。

## 13. 分期实施顺序

1. Authority schema/verifier/DB guard 与 Control Plane 合同。
2. Typed projection registry 与 ICP/Understanding/TED/OpenFDA/SAM/SMTP 收口。
3. Artifact store/manifest/materializer 基座。
4. Sanctions artifact replay。
5. HTTP/Crawl4AI artifact replay。
6. Domain ACK 接入所有 consumer。
7. 删除旧 cap 参数、配置授权和无 authority 自动开账。
8. 全仓治理、覆盖率、真基础设施、OCI、fresh review。
9. PR 合并后再执行 retained migration、部署和 RuntimeEvidence。

