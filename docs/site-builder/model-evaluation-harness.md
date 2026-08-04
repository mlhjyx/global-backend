# Site Builder 旧模型评测 Harness（已退役）

> 状态：`RETIRED`
> 退役日期：2026-08-04

M1 的一次性 fixed-commit、fee-card、native runner、授权账本与结算实现已从可执行源码中删除。它们为已结束的 M1 诊断执行服务，不再是后续评测或生产调用的机器合同。

保留的内容只有：

- 不触发模型调用的纯 fixture、suite adapter 与 validator；
- [M1 最终诊断产物](../evidence/site-builder/m1-g-text-evaluation-real-evidence-v1.json)，其分类固定为 `diagnostic_only`、`promotionEligible=false`；
- [M1-g 确定性收口基线](../evidence/site-builder/m1-g-stage-closeout-baseline.json)。

后续模型评测必须使用统一 Model Execution Runtime 的同一 task contract、context、capability negotiation、validation、settlement 与 tracing 生命周期。旧 manifest、费用卡或诊断产物都不能授权调用、候选晋级或生产路由变更。

`design_spec`、`assemble`、`assembly_fix`、`qa_summarize` 与 `seo_review` 已归入确定性任务，不再建立模型评测矩阵。后续只为真正的生成式任务维护评测：当前是 `brand_profile` 与 `copy`。
