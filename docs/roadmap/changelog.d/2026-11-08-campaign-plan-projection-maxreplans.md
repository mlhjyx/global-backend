---
date: 2026-11-08
title: Widen the campaign-plan durable projection bound to maxReplans {0,1,2}
---

- 起因：M2.2 把 CampaignPlan v0 的 decisionPolicy.maxReplans 放宽到 {0,1,2}（gain-saas #84），但引擎 durable 投影（campaign-plan/v1）仍钉 min=max=0、enum [0]——maxReplans≥1 的计划被投影门整体拒绝为 ModelDurableResultProjectionError，decline→replan→NEEDS_HUMAN 联调因此 FAILED（2026-11-08 金丝雀实证：同分钟 maxReplans=0 的 6 条 golden 调用全 OK）。
- 改动：model-result-projections.ts 的 maxReplans 约束放宽为 numberSchema(0,2) + enum [0,1,2]；bounds spec 同步 maximum:2。
- 测试：durable-results 投影两套件 138 过（15 跳过）；真机验证随下一班镜像的 decline 联调重跑。
- 未做：不改投影其余字段与投影门语义；旧计划（maxReplans=0）向后兼容不受影响。
