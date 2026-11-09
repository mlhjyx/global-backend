---
date: 2026-11-09
title: Add the offline domain review queue contract — task classification, business-day SLA, state machine and SLA metrics (ch03 T3-15 subset)
---

- 起因：ch03 §3.12.5 要求域名判定的人工复核队列（入队条件、3 工作日 SLA、吞吐与推翻率等质量指标），而 `company_domain_resolution`/`domain_review_task` 落库与运营台属执行面；本波先交付可离线测试的纯契约，供执行面/在线 PR 直接接线。
- 改动：`apps/api/src/registry/domain/domain-review.ts`：
  - `buildReviewTasksFromVerification`：AMBIGUOUS 按信号分类（多注册号→`multi_candidates`(70)、同名冲突→`name_collision`(80)、其余→`low_confidence`(50)），VERIFIED 按可注入抽样率（默认 5%）进 `audit_sample`(30)；REJECTED 不入队；SLA `dueAt` = 3 个工作日（`addBusinessDays` 只跳周末，报告需注明口径）。
  - 状态机：OPEN → APPROVED / REJECTED / NOT_FOUND（证据不足）/ EXPIRED；终态重复裁决抛 `REVIEW_TASK_NOT_OPEN`；`expireOverdueTasks` 超期只置 EXPIRED 并留 `SLA_TIMEOUT`，**不自动改判**（§3.8.2）。
  - `summarizeReviewSla`：积压、SLA 达成率（EXPIRED 视为未达成）、平均裁决耗时、按 reason 的开/决分布、最久等待；`decisionToResolutionUpdate` 映射 `company_domain_resolution` 行草案（批准即 VERIFIED+selected）。
- 测试：`domain-review.spec` 覆盖工作日算术（周五+3→周三、周六+1→周一）、信号分类与优先级、可注入抽样（确定性）、非法抽样率、状态机守卫、SLA 超期不改判、SLA 统计（1/3 达成、平均 72h、最久积压 24h）、裁决→行草案映射；domain 组 41/41、registry 全组 154 项全绿；build/lint 通过。
- 未做：`domain_review_task`/`company_domain_resolution` 表与落库、运营台页面与 BFF 联调（执行面/在线 T3-15 完整版）、节假日日历与 assignee 负载均衡；不碰 Copy 文件、无迁移、未发车。
