# AI 获客阶段 2A：服务端 roles→scopes TDD 记录

> 文档 ID：`DOC-IMPL-ACQ-AUTHZ-001`
>
> 初始基线：`origin/main@bd36d62bdb78837a10b7ce56a5e745a2590fc43a`（#374 runtime source merge）。
>
> 范围：外部 token 的 `roles[]` 归一化、服务端 role→scope policy、controller 最小权限、OpenAPI scope 合同、JWKS rotation contract 与 DevTokenVerifier admission。
>
> 边界：本文只记录 source/deterministic evidence；没有真实 SaaS token、live JWKS、部署、服务重启、数据库/RLS E2E、RuntimeEvidence、Release Bundle 或 pilot 授权。真实试点继续 `NO-GO`。

## 用户旅程与安全保证

1. SaaS token 只提供签名后的 `sub`、`workspace_id` 与 `roles[]`；客户端自报的 `scope`/`scp` 永远不进入授权上下文。
2. 服务端只承认九个闭合 scope；未知 role 映射为空权限，已知 role 仍可贡献其受控权限；pilot/production 缺显式 role map 时启动失败。
3. 每个现有 bearer controller 都必须先运行 `AuthGuard`，再运行 `ScopesGuard`；缺 scope 元数据、缺认证上下文或缺任一 required scope 都 fail-closed。
4. PII-bearing 读取额外要求 `personal-data:read`；Suppression/DataRights 使用 `compliance:manage`；事件 ACK 使用独立 `acquisition:event:ack`；身份 review scope 不替代制裁合规裁决。
5. OpenAPI 的每个 bearer operation 都必须携带非空、闭合的 `x-required-scopes`；health probes 保持公开，未来新增非公开 controller 若遗漏双 guard 或 scope decorator，结构测试失败。
6. JWKS 合同覆盖 issuer、audience、subject、workspace、roles、`exp`、`nbf`、`kid` 与 old/new key overlap；半配置 JWKS 不得回退到 dev token。
7. DevTokenVerifier 仅允许显式 `APP_ENVIRONMENT=development`、显式 `AUTH_ALLOW_DEV_TOKENS=true` 与 loopback `API_BIND_HOST` 同时成立；test/pilot/production 和非 loopback 永远拒绝。
8. bearer token 最大 16 KiB；subject 必须是有界无控制字符字符串，workspace 必须是 UUID；自定义 claim 名、clock tolerance 与 audience 在 verifier 构造阶段 fail-closed。

## RED → GREEN 检查点

| 周期 | RED checkpoint 与预期失败 | GREEN checkpoint 与结果 |
| --- | --- | --- |
| 1 | `34a6a719`：scope policy、guard 与 OpenAPI 合同引用尚不存在，聚焦测试按预期 RED | `44580ef4`：九 scope policy、双 guard、controller/OpenAPI 接线与 token claim 归一化完成；8 files / 45 tests、API build、显式 dev OpenAPI export 通过 |
| 2 | `b58de0f0`：现有 protected controller 尚未统一执行 AuthGuard→ScopesGuard | `44580ef4`：13 个现有 protected controller 的运行时 metadata 合同转绿；health 与 preview 保持显式 public boundary |
| 3 | `8a01d9c2`：7 个 verifier admission 合同全部因选择器不可注入且 dev stub 默认放行而失败 | `44580ef4`：development + opt-in + loopback 为唯一 dev stub 路径；半配置 JWKS、test、production 与非 loopback 均 fail-closed |
| 4 | `2093481a`：OpenAPI 精确报告制裁裁决误用 identity scope，Suppression 写入误用 quality-label scope | `92a3a76e`：制裁裁决改为 review + compliance，Suppression 改为 compliance-only；build→export→17/17 topology/contract tests 通过 |
| 5 | `a159dbf5` + `94161465`：detached RED 重放 4 files / 13 failed，暴露超长 token、非 UUID workspace、unsafe claim name/clock 与 audience 可缺失 | `9347ec5c`：16 KiB/UUID/claim/clock/audience 门全部关闭，外部 JWT 错误统一脱敏；4 files / 29 tests、API build、lint 0 error |
| 6 | `5c403cb8`：未知 role=`toString` 命中 Object prototype 并抛 500；workspace/roles claim 可与 `sub` 或彼此重名，2 files / 4 failed | `6d49d7d5`：role lookup 使用 own-property，标准 JWT claim 与 workspace/roles namespace 保持独立；2 files / 26 tests、API build、lint 0 error |

## 关键合同与实现位置

| 保证 | 代码/机器合同 | 测试 |
| --- | --- | --- |
| scope 枚举、role policy、未知 role 零权限、输入上限 | `apps/api/src/auth/scopes.ts` | `apps/api/src/auth/scopes.spec.ts` |
| token 后生成不可变 roles/scopes context | `apps/api/src/auth/auth.guard.ts` | `apps/api/src/auth/auth.guard.spec.ts` |
| all-required scope、缺 metadata/context fail-closed | `apps/api/src/auth/scopes.guard.ts` | `apps/api/src/auth/scopes.guard.spec.ts` |
| controller 双 guard 与新增 controller fail-close | protected controllers | `apps/api/src/auth/controller-authz.spec.ts` |
| operation-level scope 机器合同 | `packages/contracts/openapi/openapi.json` | `apps/api/src/auth/authz-openapi.spec.ts` |
| JWKS claim 与 rotation | `apps/api/src/auth/jwks-token-verifier.ts` | `apps/api/src/auth/jwks-token-verifier.spec.ts` |
| token/identity/claim-name/clock 输入边界 | `apps/api/src/auth/token-claims.ts` | dev/JWKS/AuthGuard verifier specs |
| dev verifier 三重 admission | `apps/api/src/auth/auth.module.ts` | `apps/api/src/auth/auth.module.spec.ts` |

## 配置与运维边界

- 外部 token 继续只携带 `roles[]`；`AUTH_ROLE_SCOPE_MAP_JSON` 是服务端受控 JSON 对象，值只能引用九个闭合 scope。pilot/production 必填，development/test 可使用代码内固定映射。
- `AUTH_JWKS_URI`、`AUTH_ISSUER` 与 `AUTH_AUDIENCE` 必须同时配置；controlled runtime 还由 runtime admission 要求 canonical HTTPS identity configuration。
- CI 的 create-only OpenAPI export 显式使用 development、loopback 与 dev-token opt-in；这只是构建期 schema 生成，不是部署身份边界。
- `ScopesGuard` 与 RLS 分工不变：scope 控制同一 workspace 内最小权限，签名 token 的 workspace 与 DB RLS 控制租户隔离。真实跨 workspace 负例仍须 PostgreSQL/JWKS E2E。

## 本地验证矩阵

| 验证 | 结果 | 证明边界 |
| --- | --- | --- |
| authz 聚焦行为合同 | 8 files / 60 tests PASS | role policy、双 guard、Dev/JWKS verifier、controller/OpenAPI 合同 |
| authz 关键模块 coverage | 6 test files / 43 tests PASS；statements 96.47%、branches 93.93%、functions 96%、lines 97.51% | 仅本切片关键 auth 模块，不冒充 `apps/api/src` 全局覆盖率 |
| 全 API Vitest | 293 files PASS；4479 passed / 2 skipped | 现有 API 单元/组件回归未退化；不等同 PostgreSQL/Temporal/live JWKS E2E |
| API build + code-first OpenAPI export | PASS；59 paths / 67 operations | 新源码可编译，显式 dev admission 下可确定性生成合同 |
| API ESLint | 0 error；7 条主线既有 warning | 本切片无 lint error；既有 warning 未顺带改写 |
| contracts Spectral | 0 error；15 条既有 operation-tag warning | scope extension 未破坏合同 lint；warning 债务仍在 |
| `pnpm docs:verify` | governance 51/51，docs PASS；0 error / 1 个既有 table warning | 权威入口、治理图与文档链接未退化 |
| code-intelligence scan/check | clean evidence commit `773bda86…`：968 files、8701 nodes、19985 edges、0 error、5 warnings；deterministic check PASS | source + evidence document tree 的静态关系辅助；最终 PR head 仍须另行 readback，不替代 runtime evidence |

仓库目前没有把 `apps/api/src` 全局 lines/statements/functions/branches 80% 变成真实 Vitest threshold/required context；本轮只证明 authz 关键模块四项均高于 80%。全局覆盖率门是计划中的独立 CI 治理债务，不能用本表局部结果声称关闭。

## 未关闭风险与后续门

- 当前 Suppression DELETE 仍是既有物理删除语义；本切片只收紧调用权限，后续合规 PR 必须改成 append-only release/correction decision。
- DataRights DENY 审计、`APP_DATABASE_URL` 非 owner/non-BYPASSRLS admission、统一 PII writer/plaintext backfill、Art.14/LIA/retention 仍未关闭。
- `acquisition:label:write` 为后续 `lead-quality-labels` 回流保留；本切片没有新增质量标签 API、存储、QGO 主状态或 SaaS consumer。
- 项目 AGENTS 的 Codex supplement 声称 TDD/security skills 位于仓库 `.agents/skills/`，当前 checkout 实际没有这些入口；本轮使用了全局安装的同名技能。该文档/安装面漂移留给治理切片统一修复，不在 authz PR 中创建环境相关 symlink。
- 独立 correctness/security review、hosted exact-head checks 与合并结果必须在最终 head 上另行记录；任何本地绿色都不能升级真实试点状态。
