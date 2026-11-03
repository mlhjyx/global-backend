---
date: 2026-11-04
pr:
title: Restore customer-side periodic sweeps with an API-side scheduler (R7-A)
---

- 起因：平台迁移（2026-10-31）后客户侧周期任务全部停摆——`ensurePlatformSchedules` 在 src 无调用方，机器身份也没有 ScheduleService 权限（设计 §6.4 实查）。
- 改动：新增 `SweepSchedulerService`（API 进程内）：每 `SWEEP_SCHEDULER_TICK`（默认 1m）为 6 个客户侧 sweep（backlog / external-intent / raw 保留期清理 / site-release 维护 / KB 恢复 / 建站费用对账）按周期桶启动工作流——workflowId=`<schedule>-<period>` + REJECT_DUPLICATE 去重防叠跑，启动时先补跑一次；`SWEEP_SCHEDULER_ENABLED=off` 可关闭。只使用机器身份被允许的 StartWorkflowExecution；4 个平台 schedule 保持 paused（产品负责人单独决定）。
- 测试：周期桶 id/跨周期换桶/已启动忽略/单条失败不影响其余/开关关闭/绝不调度平台 schedule 共 7 条单测；API build 通过。
- 未做：R7-B（扩展平台 Temporal 机器策略并重发镜像）。
