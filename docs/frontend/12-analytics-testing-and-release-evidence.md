# 分析、测试与发布证据规范

> 文档 ID：`FE-GLOBAL-013`
> 层级：`L2 / Normative target`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> 内容 Owner：`OWN-QA-EVIDENCE`
> 数据/隐私 Owner：`OWN-DATA-PRIVACY`
> 关联：`DEC-FE-P2-008`、`MET-SITE-001..014`、`ANTI-FE-001..010`

## 1. 原则

- 埋点用于验证用户结果、风险和学习，不证明因果或替代业务对象。
- 客户端记录交互意图，服务端/Workflow 记录业务接受与终态；结果指标优先服务端。
- 测试文件存在、CI 绿、截图或 AI 自评都不能单独证明用户可用或生产发布。
- 每个 Release 的声明强度与环境、场景、证据 Owner 和可回滚性相称。
- Managed/运营代操作与 Self-service 分开；`unknown/partial/degraded/skipped` 不并入成功。

## 2. Analytics event contract

正式事件 schema 未建立前不引入 SDK。目标 envelope：

| 字段 | 规则 |
|---|---|
| `event_id/event_name/schema_version` | 稳定、去重、可演进；名称描述事实/动作 |
| `occurred_at/received_at` | 服务端时间优先；区分迟到/离线客户端 |
| `workspace_id` | 内部 ID，权限/隔离仍生效 |
| `actor_id_hash/role_snapshot` | 最小化；角色来自服务端有效快照 |
| `capability_id/page_id/scenario_id` | 关联 Registry；不以 URL 字符串替代 |
| `object_type/object_id/object_version` | 稳定对象，不写正文/PII |
| `source` | client/server/workflow/edge，定义唯一计数 source |
| `result/error_class` | success/partial/degraded/failed/cancelled/denied/unknown |
| `correlation_id/idempotency_key_hash` | 连接流程和去重；不记录原值若敏感 |
| `entitlement/capability_version` | 解释 eligibility，不暴露商业敏感细节 |
| `locale/timezone/device_class` | 仅为体验分层，遵守隐私最小化 |

事件属性需 schema、Owner、目的、保留、合法依据、采样、去重、敏感等级和删除策略。Prompt、文档正文、Claim、联系人、询盘、邮箱、电话、Secret、完整 URL query 不进入产品分析。

## 3. 指标与反指标

Gate 2 已批准平台方向 `MET-FE-001..008`、首个 Site 纵切候选 `MET-SITE-001..014` 和 `ANTI-FE-001..010`；目标值、分母、active Workspace、基线和 Data Owner 仍未批准。

每项正式指标必须登记：业务问题、formula、eligibility、numerator/denominator、dedupe、window、source event/object、late data、segmentation、privacy threshold、Owner、target/guardrail、anti-metric、dashboard 和 decision cadence。

Publish/Inquiry 的 `MET-SITE-020..034` 只有相应能力、隐私和生产证据落地后才启用。页面数、Build success、AI 调用、Token、原始 Lead 或停留时间不能单独成为成功 KPI。

## 4. 标准场景与 Fixture

[场景目录](../governance/scenario-catalog.md)是 Scenario/Fixture ID 真值。可执行 Fixture manifest 至少记录：

- schema/version、生成/seed/reset/cleanup 命令和预期 hash；
- 合成数据声明、PII/License/rights、时钟/locale/timezone/预算/错误注入；
- 适用 Capability/Page/Object/Contract 和预期结果；
- deterministic/frozen model/tool response 与真实服务测试分开；
- 运行环境、隔离、并行性和失败后清理。

`CATALOG_ONLY` 不可在测试中假设文件存在。生产数据、客户文件、竞品截图、Readdy 或未知权利资产不得直接进入 Fixture。

## 5. 测试层级

| 层 | 主要证明 | 必须避免 |
|---|---|---|
| pure/unit | mapper、validator、state reducer、copy/permission helper | 用大量 snapshot 掩盖语义 |
| contract | OpenAPI/event/error/unknown enum/version/client-server compatibility | 只测 200 happy path |
| component | variants、keyboard/focus、async/error/a11y、i18n | 只截默认视觉 |
| integration | auth/Workspace/cache/forms/upload/task reconciliation | 用 Mock 绕过关键 boundary |
| browser E2E | 用户 Journey、深链、跨页/刷新/多标签、失败恢复 | 只跑“能打开页面” |
| visual | token/theme/density/responsive/critical states | 未受控来源截图、像素差即结论 |
| accessibility | automatic + keyboard + screen reader + zoom/reflow | 只报 Lighthouse 总分 |
| performance | lab budgets + field percentile + data/locale/device | 只测开发机/空页面 |
| security/privacy | authz、tenant isolation、XSS/CSRF/upload、redaction、analytics | 前端隐藏按钮当控制 |
| real service | 声明涉及真实模型/provider/storage/workflow 时的有界验证 | sandbox 成功冒充生产 |
| release/ops | deploy、flag、monitor、alert、rollback、SOP | CI 绿即发布完成 |

风险高的权限、Claim、发布、发送、删除、数据退出和跨 Workspace 场景需要独立 reviewer/证据 Owner；生成者不能是唯一验收人。

## 6. Gate 的最小场景覆盖

任何用户可见 Capability 至少覆盖：

1. 正常完成和首次空态；
2. 会话过期、无 Workspace、无读权、无动作权、无 entitlement、未配置；
3. loading/refreshing/stale/offline；
4. validation、ACK 不明、幂等重放、并发/ETag 冲突；
5. partial/degraded/retryable/terminal/timeout/cancel/late result；
6. 旧结果保留和人工兜底；
7. 键盘/读屏/zoom/reflow/长文本/RTL/locale；
8. 预算/quota/cost unknown；
9. analytics 去重、隐私和反指标；
10. feature flag off、rollback 和跨版本兼容。

模块从该集合选择适用项并说明不适用理由，不能删除全局失败类别。

## 7. Release Bundle schema

下表是 Release Bundle 的唯一当前 schema。仓库目前没有真实用户发布，因此真实 Bundle 数为 0；不创建空索引、占位模板或虚假 Bundle。发生首次用户发布时，按本节建立真实、可核验的发布记录：

| Section | 内容 |
|---|---|
| Identity | Release ID、环境、时间、Owner、change type、部署/回滚方式 |
| Scope | Capability/Page/Scenario/Decision/Object/Contract/Design Asset/Copy IDs |
| Promise | 用户可见新增/变更、明确非目标、已知限制和 entitlement |
| Source | 规范版本、设计 source/version、implementation commit、migration/config（如有） |
| Evidence | CI、contract、E2E、real service、security/privacy、a11y、performance、visual，含实际结果/日期 |
| Operations | flags、canary、health、alerts、SLO、runbook、support/correlation、人工兜底、kill switch |
| Data | events/metrics、consent、retention、dashboard、baseline 和 anti-metrics |
| Rollback/exit | 可逆范围、数据兼容、旧版本、第三方退出和恢复验证 |
| Guides | user/admin/operator/change notice/known limitations |
| Approval | 各责任帽子的真实 reviewer、scope、findings、resolution；AI 不代签 |
| Learning | observation window、owner、decision date、follow-up/conflict/register updates |

证据引用不可只写“全部通过”；至少有 command/suite、environment、commit/artifact、时间、result、known gaps 和签发 Owner。敏感日志使用受控存储和脱敏索引。

## 8. 渐进发布与回滚

- feature flag、capability manifest 和 entitlement 语义分开；关闭 flag 不等于撤销产品批准。
- 内部 → Alpha → Design Partner Pilot → 更广范围需明确 eligibility、成功/停止条件和数据边界。
- canary 同时观察错误、权限拒绝、恢复、成本、a11y/performance 与业务反指标，不只看 5xx。
- 回滚必须考虑客户端/服务端版本兼容、在途任务、数据 migration、cache、事件重放和用户已创建对象。
- 无法安全回滚的变更在发布前说明 forward-fix/kill switch/人工兜底。

## 9. 发布后学习

每个 Release 在预定窗口审查：核心结果、anti-metric、失败/恢复、支持工单、性能/a11y、数据质量、成本、不同 segment/locale 和人工介入。结论标 `VALIDATED/HYPOTHESIS/REJECTED/INSUFFICIENT_DATA`，并回写 Capability/Decision/Conflict/Guide；不以一次 dashboard 截图或单个客户故事关闭假设。

## 10. 当前 blocker

`BLK-FE-005/006` 未关闭：事件/隐私/保留/Data Owner 和 QA/运营/安全实际 assignee 缺失；正式前端环境也不存在。因此 Gate 4 可批准规则，但不能批准 tracking SDK、指标目标或任何 Release 为已完成。
