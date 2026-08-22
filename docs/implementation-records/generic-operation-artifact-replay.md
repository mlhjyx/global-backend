# 通用操作 Artifact 耐久重放实现记录

> 文档 ID：`DOC-IMPL-GENERIC-OPERATION-ARTIFACT-REPLAY-001`  
> 生命周期：`IMPLEMENTATION_RECORD`  
> 适用范围：Execution Budget / Artifact Replay Program 的 Artifact Tasks 1–8；仅记录 additive、pre-cutover 的源码与本地验证状态  
> 设计权威：[Execution Budget Authority 与大型结果耐久重放设计](../architecture/execution-budget-authority-artifact-replay-design.md)  
> 实施计划：[Generic Operation Artifact Replay Implementation Plan](../superpowers/plans/2026-08-21-generic-operation-artifacts.md)

## 1. 裁决与严格边界

在隔离 worktree `/global/backend/.codex/worktrees/production-parity` 的 `codex/production-parity` 分支上，Artifact Tasks 1–7 的源码和 additive migration 已进入本记录的审查基线 `a06eb7f4f29d8b9dd0ed47f52a1d86d60a13379b`。它为受管大型 Tool 结果提供固定键、流式写入、不可变对象合同、小 reference、manifest、expected facts、`RESULT_UNKNOWN` 恢复与 deployment-owned storage readiness 的实现基础。

这不是产品切换或运行时完成声明。当前结论为：

- **源码/静态合同：IMPLEMENTED / PRE-CUTOVER。** 大型结果的目标实现存在于该 commit；每个 artifact-producing tool 必须有唯一 durable result strategy，reference 中不含 body 或 object key。
- **真实 PostgreSQL FORCE RLS：RESULT_UNKNOWN（本次记录）。** 当前 shell 未配置 `DATABASE_URL`/`APP_DATABASE_URL`；可见 `global-postgres` 是其他 worktree 的保留环境。本次没有对它创建临时数据库、role 或迁移，也没有把源码/历史测试冒充为 fresh database evidence。
- **真实 MinIO：RESULT_UNKNOWN（本次记录）。** 当前可见 `global-minio` 同样是其他 worktree 的保留环境。Task 7 测试只接受单独配置的 disposable endpoint、随机 bucket 与三种独立 principal；本次没有写 bucket、lifecycle、versioning、encryption、IAM 或 readiness object 到保留实例。
- **产品 caller/ACK/cutover：NOT_PERFORMED。** 仍需要 Domain ACK subproject 和 Plan 5 的原子切换；不得由本页推导所有 ToolBroker 入口、Authority admission、API/Worker/Temporal polling 已完成切换。
- **运行、发布与用户可用：UNPROVEN。** 没有 retained migration、OCI image readback、deployment、service restart、production RuntimeEvidence、Release Bundle、external Control Plane authority/JWKS、provider wire、真实费用或用户可用性证据。

## 2. 精确 provenance

| 项目 | 值 |
| --- | --- |
| worktree | `/global/backend/.codex/worktrees/production-parity` |
| branch | `codex/production-parity` |
| Task 8 开始时 HEAD | `a06eb7f4f29d8b9dd0ed47f52a1d86d60a13379b` |
| HEAD subject | `feat(runtime): validate operation artifact storage` |
| 状态 | clean；本记录写入前 ContractGraph scan 的 evidence 亦为 `dirty=false` |
| ContractGraph source hash | `6e7f67e1043e8f55d1b4ff0e70330732c0126bd0b40afcad7d1227bfc6f93144` |

与 Artifact Tasks 1–7 相关的提交 provenance（含为同一合同补的 RED/fix）如下；它们说明代码演进，不替代本页的状态裁决：

| 任务/合同 | commits |
| --- | --- |
| Task 1：closed reference、type 与 digest key | `280496396c9923cf373bb24623035b8aa46b6c18`，`1745d09a6e2febfd39b48c393a068eb02d797a79` |
| Task 2：immutable manifest / shared content migration | `a56c60ba759abe0140b883804fa36f420f8305bf`，`9cac77df6952312e1386da03e5ca1aa74ec45790` |
| Task 3：bounded streaming S3 store | `8f340eae03cf1b918d7cdab141220d6bcaa851a3`，`a00db16a37cd349c13e96d24c23d2e0328c8983c` |
| Task 4：`RESULT_UNKNOWN` write/recovery | `0a2ab38cea81f0b1838335481ca6cf7affecd44c`，`1b1b1a2d42673e0752128e5b125df05e4ec558f3`，`7e5187b385286b35c73b2609d5b303fe6002fd23` |
| Task 5：bounded materializer registry / trusted expected facts | `b167a2e26dc3365ef8d350a1e3c8cffc5c6f8ec4`，`4f02f4cd29345564f81fc209924fff857e4e62b0`，`a0be7655d5ed5b7f2bb68767731eca6ec6811755` |
| Task 6：Tool durable-result strategy / byte contract | `b1de0277`，`5c66986a` |
| Task 7：MinIO lifecycle, IAM, readiness / exact-image composition | `a06eb7f4f29d8b9dd0ed47f52a1d86d60a13379b` |

## 3. Tasks 1–6：不可变 artifact 与重放合同

### 3.1 小 reference、manifest 与 key

- 唯一公开 result reference schema 是 `generic-operation-artifact-ref/v1`，字段为 `artifactId`、`operationId`、`resultSchema`、`sha256`、canonical decimal `sizeBytes`、`mediaType`、`expiresAt`。它拒绝 extra fields，**不**携带 object key、body、headers、credentials、prompt、token 或 provider raw body。
- 内部 manifest schema 是 `generic-operation-artifact/v1`，额外绑定 `scopeKind`、workspace（platform 为 null）、authority、operation、privacy、source digest、创建/过期时刻与内部 object key。
- final key 严格由 digest 派生：`generic-operation-results/v1/sha256/<first-two-hex>/<64-lowercase-hex>`；staging key 只能由生成的 artifact UUID 派生：`generic-operation-results/v1/staging/<uuid>`。调用方不能选 key。
- 三个 privacy class 仅为 `PUBLIC_ORGANIZATION`、`CONFIDENTIAL_TENANT`、`PERSONAL_DATA`；`sizeBytes` 是不带前导零、最大 signed-64-bit 的 decimal string。

### 3.2 数据库与 expected facts

以下 seven forward migrations 是 artifact contract 的同一序列，均为 additive provenance；不得改写已应用 migration receipt/checksum：

1. `20260821100000_generic_operation_artifact`
2. `20260821110000_generic_operation_artifact_shared_content`
3. `20260821115000_generic_operation_artifact_result_unknown_enum`
4. `20260821120000_generic_operation_artifact_result_unknown`
5. `20260822000000_generic_operation_artifact_atomic_recovery`
6. `20260822010000_generic_operation_artifact_expected_facts`
7. `20260822011000_generic_operation_artifact_expected_facts_validate`

`GenericOperationArtifact` 的 per-operation manifest 绑定 scope、authority、operation、schema、digest、size、media type、privacy、source digest 与 expiry。`GenericOperationArtifactObject` 以 digest/key/size/media type/privacy 固定 shared physical-object metadata；不同 operation/authority 可以引用同一物理 digest，但互相冲突的 size、media type 或 privacy 必须拒绝。数据库 surface 继续以 FORCE RLS、scope/authority/operation relation 和窄 SECURITY DEFINER function 为边界；本记录不把它升级为 fresh RLS runtime proof。

expected facts 也是 closed shape，随 manifest 保存而不是由 replay caller 或 provider body 回填：

| result schema | allowed non-body facts |
| --- | --- |
| `http-get/v1` | `status`、`ok`、sanitized URL、bounded blocked code |
| `crawl4ai-fetch/v1` | sanitized URL、24-hex content hash |
| `crawl4ai-render/v1` | sanitized URL、`blocked` boolean |
| `sanctions-download/v1` | 无额外 expected facts；严格 XML materializer 自身处理 |

### 3.3 write / recovery / materialize

物理执行后的唯一顺序为：**stage → promote → inspect/readback → append manifest → settle small artifact reference → best-effort staging delete**。流式 writer 一边 hash、一边按 strategy `maxBytes` 限制；超限不截断、不再物理重试。对象的 key、digest、size、media type、result schema 与 privacy tag/metadata 必须相互一致。

对象 ACK / promote ACK 或物理结果状态不确定时，操作进入 `RESULT_UNKNOWN`，保留完整 reservation。恢复只能 probe 已知 digest-derived key：找到且验证完全一致时才 append/settle；不存在或 metadata/digest 不同则为 `GENERIC_OPERATION_ARTIFACT_INVALID`。恢复不得重新调用 producer/provider，也不得打开新 generation。pre-wire policy/rate-limit denial 不能借 `RESULT_UNKNOWN` 掩盖。

startup registry 只接受 exact schema：`sanctions-download/v1`、`http-get/v1`、`crawl4ai-fetch/v1`、`crawl4ai-render/v1`；重复、遗漏、strategy/method mismatch 或超出 materializer 的 max bytes 都 fail closed。首轮 source limits 为：sanctions 33,554,432 bytes、HTTP GET 3,000,000 bytes、Crawl4AI fetch 300,000 bytes、Crawl4AI render 3,000,000 bytes。source tool 的 first-wave strategy 目前均为 `PERSONAL_DATA` 与 86,400-second TTL；storage lifecycle 仍按对象的 privacy tag 执行而非由 environment name 选择另一条实现。

## 4. Task 7：disposable MinIO topology、lifecycle、IAM 与 readiness

Task 7 的真实-store spec 明确不是“连任意开发 MinIO 即可”。启用时必须同时满足：

```text
GENERIC_OPERATION_ARTIFACT_MINIO_TEST=1
GENERIC_OPERATION_ARTIFACT_MINIO_DISPOSABLE=1
GENERIC_OPERATION_ARTIFACT_MINIO_BUCKET=operation-artifacts-t7-<8 lowercase hex>
```

它使用同一 disposable endpoint 上的 root、runtime、PERSONAL_DATA reader 三个独立 S3 principal，且运行时配置在 API/Worker 中是 endpoint/bucket/region/access-key/secret-key reference。bootstrap 是唯一 deployment owner：创建 dedicated bucket、启用 versioning、启用 SSE-S3、导入 lifecycle、创建/绑定最小 IAM policy，并 readback versioning、encryption、lifecycle 和 user policy。应用只验证；readiness 不 provision bucket。

| prefix/tag | lifecycle contract |
| --- | --- |
| `generic-operation-results/v1/staging/` | 1 day、all versions；staging delete marker cleanup |
| `artifact-privacy=PUBLIC_ORGANIZATION` | 30 days、all versions/noncurrent 30 days |
| `artifact-privacy=CONFIDENTIAL_TENANT` | 7 days、all versions/noncurrent 7 days |
| `artifact-privacy=PERSONAL_DATA` | 1 day、all versions/noncurrent 1 day |
| final/readiness delete markers | final delete-marker cleanup；readiness prefix cleanup with 1-day noncurrent rule |

runtime policy 只读 bucket configuration、限制 ListBucketVersions 到 readiness prefix、读取 staging/readiness/final objects、写 staging/readiness/final（final/readiness 要求 `artifact-privacy` tag）、仅删除 staging/readiness、并可 abort multipart；personal reader 仅可读取 tag 为 `PERSONAL_DATA` 的 final objects。它不是 root、不能管理 lifecycle 或 bucket。readiness 使用 reserved prefix 做 bounded **write/read/delete** canary，缺 bucket、lifecycle/versioning/encryption/IAM/object contract 任一不匹配均 not-ready，Worker 必须不 polling。

`generic-operation-artifact.minio.spec.ts` 的 six 个物理-store scenarios 覆盖：两 client 的 maximum-object immutability/reuse、corrupt staging/final metadata drift、lifecycle/versioning/encryption readback、PERSONAL_DATA read-role deny、readiness canary 不创建 missing bucket，以及 MinIO all-version-expiry extension drift fail closed；其中 fresh child process 重新 materialize 证明 restart/worker boundary。**本次 Task 8 未执行这些 six 个 scenarios，结果为 `RESULT_UNKNOWN`，不是 PASS/production evidence。** 这是为了不写入由其他 worktree 管理的 retained `global-minio`；也没有 image pull、provider call 或 retained topology mutation。

## 5. 本次 Task 8 验证记录

| 检查 | 当前结果 | 证据类别与限制 |
| --- | --- | --- |
| artifact + ToolBroker 聚焦 Vitest coverage | PASS：16 files，15 passed / 1 skipped；238 tests，232 passed / 6 skipped；artifact directory statements **86.95%**、branches **82.89%**、functions 92.48%、lines 89.98% | 本地确定性 unit/contract；6 个 skipped 是未启用的 disposable MinIO spec，不能替代 real store |
| `prisma validate` | PASS（以本地 development URL 仅供 schema env 解析） | schema-only；没有连接/迁移 retained DB 的结论 |
| `pnpm --filter @global/api build` | PASS | 本地 build，不是 OCI image/readback |
| full API test | HOLD：启动后明确出现 **4 个已知 ToolRegistry fixture baseline failures**：`public-web-wire-suppression.spec.ts` 1 个；`paid-execution-gates.spec.ts` 3 个（durable reserve legacy-cents label、cached ToolResult、success-settlement ACK loss） | 不能声称 full suite green；这些 failures 不在本 Task 8 修复范围，需 fixture owner 在独立 task 处理 |
| `pnpm governance:verify` | PASS：118/118 | 本地 governance/contract verification，不是 hosted CI/review/merge |
| `pnpm docs:verify` | PASS | 文档结构/链接合同；不证明 runtime/deploy/release |
| `git diff --check`（写本记录前） | PASS | 文本 whitespace 检查 |
| ContractGraph scan/status | PASS，clean `a06eb7f4…`；10,407 nodes / 23,838 edges / 46 diagnostics、no freshness errors | derived static graph；无 runtime evidence |

ContractGraph 对 `tool-contract.ts`、`tool-broker.ts`、artifact service、`schema.prisma`、managed dependency readiness 与 runtime readiness 的 impact 还列出 ToolRegistry、source/builtin tools、sanctions activity、Worker、health 和多个既有 consumer 为候选影响面。报告明确 `No runtime evidence was evaluated`；因此这些边只能指导后续 source/test review，不能宣称 provider call、database write、Temporal replay 或 deployment 实际发生。

## 6. Copy fixed-source、Authority 与 release 边界

本 Artifact 演进没有 rebase、重写或替换 active Copy binding。当前受控 receipt 的状态仍为：

```text
status=STALE_HOLD
dispatch_authorization=NOT_AUTHORIZED
pilot_eligibility=BLOCKED
required_followup=REBASE_FIXED_SOURCE_BEFORE_DISPATCH
stale_scope=PRODUCTION_PARITY_EXECUTION_BUDGET_AUTHORITY_FOUNDATION
```

因此 Artifact 提交不授权 Copy model dispatch、价格/credential 读取、quality evaluation、promotion、route adoption、pilot 或 RuntimeEvidence。当前 receipt 的 source fingerprint 是 `e7a046d07c0fac7c3725556cb2a94490014877675dc72395ef583102719613fc`；它是 source-drift 状态，不是新 Copy evidence 或可用性声明。

同样，本子项目未完成下列门：

1. Domain ACK plan 的同事务 domain write + append-only ACK、ACK-loss conflict/replay 关闭，以及 valid-output/unknown-cost settlement reconciliation；
2. Authority Plan 5 的所有 product caller/header/schedule 切换、legacy cap/self-open removal、API/Worker admission、external Control Plane issuer/JWKS/command transport；
3. disposable PostgreSQL RLS、MinIO full real-store、fresh worker/restart and OCI exact-image evidence 的可重复 current run；
4. retained migration、drain/swap、deployment/image readback、fresh environment-bound RuntimeEvidence、Release Bundle、independent review、hosted CI、merge authorization、release/pilot/user availability。

没有一个源码、coverage、static graph 或 documentation verifier 可以跨越上述任一门。

## 7. 后续安全运行卡

在获得单独授权且先创建隔离 disposable topology 后，按以下顺序恢复真实 infrastructure evidence：

1. 使用独立 Docker internal network/临时容器与专用 127.0.0.1 relay；确认最终 container/network/relay/bucket/temporary database readback 都不存在，不接触 `global-*` retained resources。
2. 以临时 root/runtime/personal credentials 运行 bootstrap，再只把这些 temporary references 传入 `test:artifact:minio`；不记录 secret/object body。
3. 在单独 temporary PostgreSQL 运行 seven artifact migrations、RLS/ACL/recovery/expected-facts suites，并记录 clean source commit、migration list、test counts 和 cleanup readback。
4. 仅当该 evidence、full relevant suite、OCI contract、Authority/ACK/cutover 与外部授权各自完成，才评估 retained migration、deployment、RuntimeEvidence 或 release；它们不是本记录的隐含下一步。
