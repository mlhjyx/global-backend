# 待验证台账

> 文档 ID：`DOC-STATUS-PENDING-VERIFICATION-001`
> 生命周期：`CURRENT`
> 最后核验：2026-11-28（按 §1 复查过期规则更新 `PV-001..003` 为 `STALE`，并登记 `a5ef77f6` 候选未验收项 `PV-004..006`）
> 当前事实来源：[当前状态](current.md)、[实现状态矩阵](implementation-matrix.md)、[证据索引](../evidence/README.md)

本页只登记**已合入 main、声称已实现、但还没有验收结论的增量变化**。模块级的设计↔实现全景仍以 [实现状态矩阵](implementation-matrix.md) 为唯一矩阵；本页是它的验收行动队列（变更粒度、短期），两者不重复。

## 1. 规则

- **机器验证 ≠ 验收**：测试通过、CI 全绿、dev 环境跑通只填「已有证据」，不关闭条目。
- **谁验收**：默认产品负责人；design partner 参与时在行内注明。
- **状态词**：`PENDING`（待验）／`PASSED`（已验收）／`FAILED`（验证失败，另开修复）／`STALE`（超过复查日期未处理）。
- 关闭条件按条目核对。RuntimeEvidence PASS 可关闭其明确覆盖的运行证据项。正常用户验收由产品负责人接受对应业务结果。结论写回[当前状态](current.md)或原证据后从本表移除。
- 每周复查一次；复查日期过期的条目改 `STALE` 并提醒。

## 2. 当前条目（2026-11-28 复核；含 2026-11-04 留存条目）

| ID | 变化 | 已有证据 | 缺什么验收（怎么验 / 谁验） | 验收人 | 状态 | 复查日期 |
| --- | --- | --- | --- | --- | --- | --- |
| PV-001 | `email_guess` 按 D3 重开（双闸：interim LIA + smtp_self） | 代码与开关已上线；联系人线 M1–M4 已接进 run | 下一轮带 fit=match 的真实 run 中检查邮箱产出与双闸日志（已超原复查日，待确认处理去向） | 产品负责人 | STALE | 2026-11-11 |
| PV-002 | 2026-11-04 的两条 discovery run（`e98a04e4`、`ab43be81`） | run 已结束为 FAILED（见 discovery_run 计数） | 确认失败归因是否已由后续修复覆盖；决定是否用新 Grant 重跑（已超原复查日） | 产品负责人 | STALE | 2026-11-08 |
| PV-003 | 2026-11-04 文档治理计划（PR-1…PR-5 + 清理） | 本页与 PR 记录；样题实测（2026-11-04）：零先验子代理仅凭文档导航 98 秒定位 `DISCOVERY_QUERY_BATCH=2`（`apps/api/src/temporal/discovery.workflow.ts:69`），自读 7 个文件；术语抽查 20 词通过 | 确认样题结论（时间达标；自读 7 文件略超 ≤5 页目标，其中 1 个用于排除近似项）与机器门观察期结果（已超原复查日） | 产品负责人 | STALE | 2026-11-18 |
| PV-004 | `backend@a5ef77f6`（#1156）合入后 main push CI 失败 | 合入前 PR、main push 与手动镜像发布的独立读回见[当前状态的一页结论](current.md#一页结论) | 固定两次 run 的可比条件排查根因并隔离复验。放行条件单独裁决 | 产品负责人 | PENDING | 2026-12-05 |
| PV-005 | Discovery v3 受理与终态链已入主线（#1141 等），成组切换与客户启用待复验 | `apps/api/src/discovery/discovery.controller.ts` 与 `discovery-v3-admission.ts` 已合入 v3 分支；源码尚未给 API 绑定生产 `DISCOVERY_V3_RUNTIME` provider，SaaS 普通任务仍传 legacy `taskRef`、`QUEUED` 终态投影缺口，且 `discovery-v3-terminal.ts` 仅汇总 `ai_trace` 未覆盖 `discovery_v3_operation` 非模型流水 | 按独立 D2 裁决补齐 API/Worker 装配、成对合同升锁、兼容/回退与成本对账后做隔离端到端验收 | 产品负责人 | PENDING | 2026-12-05 |
| PV-006 | `backend@a5ef77f6` + `gain-saas@ff45fa4` 正常用户端到端验收 | 本机观察及受控证据的范围见[当前状态的一页结论](current.md#一页结论) | 按[发布路线 G6](release-plan.md#stable-g0-g7-definitions)以正常租户角色连续三轮通过关键用户旅程，含受控重启与恢复，由产品负责人接受结果。运行观察和晋级回执分别归 G5、G7 | 产品负责人 | PENDING | 2026-12-05 |

## 3. 与四态的关系

[当前状态](current.md) 的四态（未做 / 可运行 / 已验证 / 已验收）描述**能力整体**；本页只跟踪**尚未完成「已验收」那一跳的增量**。一个能力可以在四态里是「已验证」，同时在本页有一条待验收的增量。
