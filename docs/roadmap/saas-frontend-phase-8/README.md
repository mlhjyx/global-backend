# Phase 8 防漂移与文档项目收口

> 文档 ID：`GATE-FE-P8-000`
> 层级：`L3 / Phase evidence`
> 状态：`FROZEN_EVIDENCE` / `APPROVED_AT_GATE_8`
> 授权：产品负责人于 2026-07-20 通过 Gate 7，批准 `DEC-FE-P7-001..012` 与 `ADP-FE-001..031` 当前采用决定，只授权 Phase 8 文档治理与最终收口
> 批准结果：Gate 8 已按推荐语句有条件通过；文档计划收口为 `GOVERNANCE_BASELINE_COMPLETE_WITH_BLOCKERS`，不包含产品/OSS 实现、历史文件移动、push、PR 或合并
> 事实 Owner：`OWN-DOC-GOV`

## 1. Phase 8 解决的问题

Phase 1–7 已建立来源审计、产品/IA、治理 Registry、全局前端规范、Site Capability Pack、全产品域地图和 OSS 采用组合。Phase 8 把这些静态文档变成可持续运行的治理系统：机器能拦截结构/链接/状态/Registry/Release 漂移，人能按角色完成任务，真实发布能追到实现、证据、运营与学习。

## 2. 交付物

- [自动校验与例外治理](../../governance/docs-verification.md) + `pnpm docs:verify` + CI 门；
- [历史 banner / 归档处置建议](history-disposition-proposal.md)；
- [按角色阅读任务与可用性验收](reading-route-acceptance.md)；
- [Release Bundle 与学习治理](../../governance/release-and-learning-governance.md)；
- [Release Bundle 模板](../../templates/release-bundle-template.md)与[学习模板](../../templates/release-learning-template.md)；
- [Release Bundle 索引](../../releases/README.md)；
- [Phase 8 机器验证报告](verification-report.md)；
- [Gate 8 评审包](gate-8-review.md)。

## 3. 本阶段不做

- 不实现 SaaS 前端、Site 功能、Adapter、Puck、UI 库或任何 `ADP-FE-*` 候选；
- 不改 Schema、OpenAPI、产品 API、依赖版本、镜像、Compose、systemd 或生产配置；
- 不采购、建账号、接受条款、上传数据或开启生产流量；
- 不移动、删除或重写 Word、Site v3.1/v3.2、Phase 1–7 冻结证据；
- 不把作者自查冒充新人/产品/设计/前端/后端/QA/运营独立人工验收；
- 不创建虚假的 Release Bundle、测试结果、用户反馈或生产学习记录。

## 4. Gate 7 授权原文

> Gate 7 通过，按 DEC-FE-P7-001..012 批准 OSS/外部能力采用组合、准入门、Adapter/SoR 边界与退出计划；接受 ADP-FE-001..031 的当前决定，接受 8 项现用能力仅为 INTEGRATE / *_HARDEN、其余候选按触发条件保持 ADAPT/LEARN/DEFER/AVOID，并在保留 BLK-FE-001..007、GAP-FE-P6-001..012 与全部未关闭许可、安全、Owner、生产和退出门的前提下授权 Phase 8。

该批准把 Phase 7 决定升级为 current governance，但没有升级任何候选的实现/生产状态。

## 5. 验收口径

Gate 8 分开记录：

1. `MACHINE_PASS`：当前树的结构、ID、状态、链接、Registry 引用、历史 banner、Release schema 和敏感模式检查通过；
2. `AUTHOR_ROUTE_DRY_RUN`：作者按每条角色任务找到事实源并记录路径；
3. `INDEPENDENT_HUMAN_ACCEPTANCE`：真实责任角色独立执行任务并签发 finding；
4. `RELEASE_TRACEABILITY`：只有真实发布出现后才用真实 Bundle 验证，当前无发布则为 `NOT_APPLICABLE_NO_USER_RELEASE`，不能写 PASS。

机器通过不自动满足人工门。由于 `BLK-FE-006` 的实际 QA/运营/安全责任人未指派，Gate 8 评审必须明确接受或要求补做独立人工验收，不能隐去该缺口。

产品负责人已于 2026-07-20 明确接受该分层：作者 dry-run 保留，独立人工继续 `NOT_RUN / BLK-FE-006`，并成为首个真实设计/实现/Release 的前置门。本 Phase 包自此冻结；后续执行记录只增量写入 current 阅读任务，不重写本包。
