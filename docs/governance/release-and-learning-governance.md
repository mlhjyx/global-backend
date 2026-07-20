# Release Bundle 与发布后学习治理

> 文档 ID：`GOV-FE-009`
> 层级：`L1 / Normative governance`
> 状态：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_8`
> 事实 Owner：`OWN-QA-EVIDENCE`
> 学习责任帽：`OWN-PRODUCT`
> 最后核验：2026-07-20
> 批准边界：schema、责任与回写规则已批准；当前真实 Release Bundle 仍为 0

本文把 [Release Bundle 语义](../frontend/12-analytics-testing-and-release-evidence.md#7-release-bundle-schema)落成可复制、可校验、可回写的交付合同。它不创建真实发布，也不替代部署系统、artifact store、监控或真实责任人的签字。

## 1. 何时创建

只有某项变更实际对用户、管理员或运营人员生效时，才在 `docs/releases/<release-id>.md` 创建一个 Bundle。以下情况不能创建真实 Bundle 或写成 `DEPLOYED`：

- 文档、PRD、线框、Capability Pack 或 Gate 获批；
- 测试文件存在、CI 绿或开发机单次探针成功；
- 代码已合并但没有目标环境部署/流量证据；
- 开发预览、内部 resolver 或 renderer artifact 被误当公网 Publish；
- 外部候选只完成 `LEARN/DEFER/ADAPT` Card。

多仓发布使用一个 Release ID，并在 Source 中逐仓记录 commit、artifact、migration/config 和兼容窗口。一个 Bundle 不能用模糊分支名代替不可变提交。

## 2. 生命周期

```text
DRAFT
→ READY_FOR_RELEASE_REVIEW
→ APPROVED_FOR_RELEASE
→ DEPLOYED
→ OBSERVING
→ CLOSED | ROLLED_BACK | SUPERSEDED
```

- `DRAFT` 允许显式 blocker，但必需元数据不能是占位符后进入 `docs/releases/`。
- `APPROVED_FOR_RELEASE` 需要相应责任帽真实签字；AI、作者自评或“专家已审”不能代签。
- `DEPLOYED` 需要环境、时间、artifact/commit、执行者、health 和 rollback readiness 证据。
- `CLOSED` 需要学习窗口已结束并完成回写；没有数据时写 `INSUFFICIENT_DATA`，不能伪造成功。

## 3. Bundle 必需内容

| Section | 必需回答 |
|---|---|
| Identity | 谁、何时、在哪个环境、用什么方式发布什么 Release |
| Scope | 哪些 Capability/Page/Scenario/Decision/Object/Contract/Design/Copy 发生变化 |
| Promise | 用户看见什么、明确不做什么、entitlement 与已知限制是什么 |
| Source | 规范/设计版本、实现提交、artifact digest、migration/config/flag |
| Evidence | suite/command、环境、提交、时间、结果、gap、签发 Owner |
| Operations | canary、health、alert、SLO、runbook、支持入口、kill switch、人工兜底 |
| Data | event/metric/consent/retention/baseline/anti-metric 与数据 Owner |
| Rollback and exit | 兼容窗口、在途任务、数据逆向、外部能力退出和实际演练 |
| Guides | 用户、管理员、运营、变更通知和已知限制入口 |
| Approval | 每顶责任帽 reviewer、scope、finding、resolution、时间 |
| Learning | 观察窗口、问题、结论、后续决定和 Registry 回写 |

机器只检查元数据与章节存在；内容真实性由 Release/证据/安全/运营责任人承担。

## 4. 证据强度

每条证据都应记录：Evidence ID、声明、环境、commit/artifact、运行时间、命令或 suite、实际结果、known gaps、签发 Owner 和脱敏 artifact 地址。证据等级不得倒推：

```text
TEST_ANCHOR < TEST_RUN < REAL_SERVICE_RUN < RELEASE_ENV_RUN < PRODUCTION_OBSERVATION
```

低等级可以支持设计或开发判断，不能替代更高等级的发布声明。真实服务成功不等于生产部署；生产 telemetry 没有 eligibility、去重和隐私合同也不能证明业务结果。

## 5. 发布前责任帽

| 责任帽 | 最小签发范围 |
|---|---|
| `OWN-PRODUCT` | Promise、非目标、entitlement、成功/停止条件 |
| `OWN-DESIGN` | 关键状态、内容、响应式、a11y 设计偏差 |
| `OWN-SAAS-FE` / 实现 Owner | 实现提交、兼容、flag、客户端恢复 |
| 契约/数据 Owner | API/event/schema/migration/SoR/保留 |
| `OWN-QA-EVIDENCE` | 场景覆盖、测试运行、证据缺口和独立性 |
| `OWN-OPS` | 发布步骤、监控、告警、人工兜底、回滚演练 |
| 安全/隐私/商业责任帽 | authz、数据权利、License、成本/套餐和风险接受 |

同一人可以兼任多顶帽子，但 Bundle 必须分行记录 scope。高风险权限、公开 Claim、Publish、发送、删除和跨 Workspace 场景不能只有实现作者验收。

## 6. 学习回写

每个 Release 在预定窗口至少审查：核心结果、反指标、失败/恢复、客服与人工介入、权限拒绝、成本、性能、a11y、数据质量、locale/segment 差异和外部供应链变化。

学习结论只允许：`VALIDATED / HYPOTHESIS / REJECTED / INSUFFICIENT_DATA`。每条结论必须带观察、证据、局限、Decision Owner 和下一动作，并按影响回写：

| 发现类型 | 必须回写 |
|---|---|
| 产品承诺/范围改变 | Capability Registry + Decision/Conflict + Guide |
| 页面/流程问题 | Page/Scenario/Design Asset/Copy + 测试 |
| 合同/状态问题 | OpenAPI/event/ADR + integration guide + recovery |
| 运营/恢复问题 | runbook、alert、人工兜底、已知限制 |
| 指标/隐私问题 | event/metric contract、retention、dashboard、anti-metric |
| OSS/供应链问题 | `ADP-FE-*` Card、version/license/security/exit Gate |

学习记录不得直接覆盖冻结 Gate 或历史证据；新决定引用旧 provenance 并说明 supersession。

## 7. 文件与敏感数据

- Bundle 索引见 [`docs/releases/`](../releases/README.md)，模板见[Release Bundle 模板](../templates/release-bundle-template.md)。
- 单次学习记录使用[发布学习模板](../templates/release-learning-template.md)，存入 `docs/releases/learning/<learning-id>.md` 并由 Bundle 的 Learning 区索引；顶层 `docs/releases/*.md` 只放真实 Bundle。
- 客户正文、Prompt、个人信息、Secret、完整日志和未脱敏截图不进入 Git；只记录受控 artifact 引用和最小摘要。
- Release/学习文件不能删除来“清零”失败；后续 Bundle 或 Decision 使用 `SUPERSEDED/ROLLED_BACK` 保留因果链。

## 8. 当前事实

截至 2026-07-20，本仓没有可被该治理定义认定的 SaaS 前端用户发布，也没有真实 Release Bundle。`docs/releases/` 只有索引；Phase 8 交付模板与校验门，不把 Site 开发预览、后端实现、文档 Gate 或 OSS Card 冒充发布。
