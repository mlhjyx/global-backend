# 工作流、策略、模型与观测候选 Capability Cards

> 文档 ID：`OSS-FE-007`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 边界：业务状态在我方 Postgres；策略、工作流、网关和观测后端都不得成为产品主真值

## `ADP-FE-022` Temporal

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 支撑可恢复长任务、取消、重试和补偿；不存业务终态、不替代 Outbox/DB 状态 |
| 当前等价与证据 | 代码锁定 Temporal TS SDK `1.20.3`；本机 CLI `1.8.0`、Server `1.31.2`、UI `2.50.1`，systemd dev 服务运行 |
| 主决策 | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| License / 权利 | Temporal Server MIT；Cloud、UI、依赖和支持服务另按对应条款 |
| Adapter / SoR | WorkflowClient/activities 边界；Workflow 只编排，业务状态/预算/幂等/Outbox 在我方 DB |
| Security / 数据 | history 禁 PII/secret/大 payload；namespace/task queue、mTLS、Worker 身份、visibility、retention、backup 和管理面 |
| Test / Release Gate | history replay、patch/versioning、activity idempotency、cancel/timeout/retry、worker outage、queue isolation、DR/backup 和升级回滚 |
| Owner / Exit | `OWN-PLATFORM`；短任务可由 DB queue/受控 runner 接管，长任务替换需迁移/排空 history、冻结新启动并保留业务状态对账 |

## `ADP-FE-023` OPA

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选复杂确定性策略求值；不成为 Workspace/Role/Entitlement/DataRights 的事实源 |
| 当前等价与证据 | 未采用；当前服务内 deterministic guard/policy 已存在，尚未证明策略规模需要外部引擎 |
| 主决策 | `DEFER / POLICY_SCALE_TRIGGER` |
| License / 权利 | Apache-2.0；bundle 分发、托管控制面和周边产品另审 |
| Adapter / SoR | `PolicyEngine(input, policyVersion) -> allow/deny/mask/reasons`；事实输入和决策日志留我方，OPA 无写权限 |
| Security / 数据 | policy bundle 签名、stale/不可用 fail-closed、输入最小化、sidecar/remote 延迟、越权规则、审计和回滚 |
| Test / Release Gate | 只有跨服务策略爆炸或热更新需求被证明才重开；golden policy、property/fuzz、stale bundle、故障和决策一致性 |
| Owner / Exit | `OWN-SECURITY`；保留规则源和决策 Contract，切回内置引擎，旧 bundle 可审计；平台/隐私 Owner 参与输入合同验收 |

## `ADP-FE-024` new-api

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 统一文本、图片和 embedding 上游；不成为 task route、Evidence、预算或业务状态真值 |
| 当前等价与证据 | 开发环境已采用，运行镜像 ID 已记；Compose 仍是 `calciumion/new-api:latest`，当前应用有薄 ModelGateway/路由/成本账 |
| 主决策 | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| License / 权利 | AGPL-3.0；上游模型、API、区域、训练/缓存和内容条款各自独立 |
| Adapter / SoR | 应用只经 `ModelGateway`/OpenAI-compatible endpoint；task route/evidence/cost/kill switch 保持我方真值 |
| Security / 数据 | 默认凭据、管理面、token scope/轮换、供应商 key、模型数据出境、Prompt/Trace PII、配额、日志和供应链 |
| Test / Release Gate | pin digest/SBOM、备份/恢复、能力探测、requested/reported/resolved model、429/5xx、usage/cost、fallback、升级/回滚、AGPL 义务 |
| Owner / Exit | `OWN-AI-PLATFORM`；LiteLLM/其他网关可替换，只改 gateway config/adapter；导出渠道/模型映射，轮换全部 key |

## `ADP-FE-025` LiteLLM

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | new-api 的 contingency 候选；不允许两套网关同时成为路由、预算或日志真值 |
| 当前等价与证据 | 未采用；当前 new-api + ModelGateway 已运行 |
| 主决策 | `DEFER / CONTINGENCY_BAKEOFF` |
| License / 权利 | 根仓非企业部分 MIT，enterprise 目录/功能另许可；托管服务另有条款 |
| Adapter / SoR | 必须通过现有 `ModelGateway`，禁止业务直接用其 SDK/路由 DB；我方 task route/EvidenceRef/ledger 不迁移 |
| Security / 数据 | proxy auth、key vault、日志/Prompt/PII、预算/租户隔离、admin UI、provider 兼容和企业功能边界 |
| Test / Release Gate | 仅 new-api 达不到 SLO/合规/运维时比较；同 task probes、transport、usage/cost、fallback、trace、吞吐、恢复和迁移 |
| Owner / Exit | `OWN-AI-PLATFORM`；与 new-api 单主切换，配置导入后 shadow/rollback，撤销旧网关 token，不长期双写 |

## `ADP-FE-026` Langfuse

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选模型 trace、prompt/eval 观测；不成为 prompt route、EvidenceRef、批准或真实成本真值 |
| 当前等价与证据 | 未采用；已有 AI trace、Evidence v2、model routing evidence 和 cost ledger 子集 |
| 主决策 | `DEFER / OBSERVABILITY_BAKEOFF` |
| License / 权利 | 非 `ee/` 等目录为 MIT，企业目录另许可；云服务、保留和区域另行评审 |
| Adapter / SoR | `AiTelemetrySink` 写前脱敏；只接不可逆/最小 trace ref，prompt/route/eval truth 留 Git/DB/Evidence Bundle |
| Security / 数据 | Prompt/response PII/secret、跨租户、数据出境、retention/DSR、RBAC/SSO、成本、二次采样和管理面 |
| Test / Release Gate | 先证明现有观测缺口；脱敏、tenant isolation、采样、丢数/重试、删除、成本、离线恢复、prompt/version 双真值对抗 |
| Owner / Exit | `OWN-AI-PLATFORM`；sink 可关闭/替换，权威 evidence 不依赖 Langfuse，导出后删除副本；隐私 Owner 独立验脱敏/删除 |

## 组合决定

Temporal 与 new-api 继续作为开发环境单一主路并优先硬化；OPA、LiteLLM、Langfuse 只有在明确规模/SLO/观测缺口出现后进入同类 Bake-off。禁止为了“平台完整”提前部署第二工作流、第二策略或第二模型真值。
