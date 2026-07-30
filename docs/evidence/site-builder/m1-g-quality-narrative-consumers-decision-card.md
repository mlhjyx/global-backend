# M1-g QA/SEO non-authoritative consumer card

Date: 2026-07-30
Status: `ZERO_COST_CONSUMER_READY_FOR_REVIEW`
Model dispatch authorization: `NOT_AUTHORIZED`

本卡对应退役治理后的独立消费者基础 PR。它把
`site_builder.qa_summarize` 与 `site_builder.seo_review` 接到 P4
确定性质量结果之后，但不授权模型调用、不改变质量结论或运行路由。

模型生成调用数：**0**

模型费用：**$0.00**

## 已实现边界

- 新增私有 `QualityNarrativeSetV1`，绑定 candidate、DesignBrief、
  artifact set、DesignEvaluation、round 与稳定 finding ID。
- `qa_summarize` 只消费 contract、a11y、Lighthouse、genericness、网络/
  素材与视觉完整性等既有确定性 finding。
- `seo_review` 只消费八类 SEO rule finding，以及由对应私有
  `seo_report` 投影出的布尔/计数检查；不把 URL 或原始报告正文发给模型。
- 模型输出是 closed shape：只能使用输入中给定的 finding ID、
  `groupId` 和 `explanationId`。服务端拒绝自由文本、新 finding、严重级别、
  pass/fail、分数、repair、建议和 URL。
- 私有 evidence 使用固定对象键和 immutable create-only 写入；Activity
  ACK 丢失后先校验 identity、内容与对象哈希，再复用 winner，不再次调用。
- P4 的 DesignEvaluation v2、`qualityPasses`、repair catalog、ReleaseManifest
  和 P5 发布资格不读取叙事结果，因此模型不能改变质量门。

## 失败与费用语义

| 条件 | 行为 |
| --- | --- |
| finding slice 为空 | `empty_findings`，不进入 executor |
| consumer/付费闸不可用 | 明示 `consumer_unavailable` / `paid_gate_denied` |
| 既有 RESERVED/UNKNOWN/unknown-cost spend | 不向消费者提供 executor，不发起后续付费调用 |
| 模型失败或 closed output 无效 | 明示 `model_failed` / `output_invalid` |
| 结算 unknown | 当前任务 `settlement_unknown`，后续任务 `prior_settlement_unknown`，停止后续付费调用 |
| narrative/私有对象持久化失败 | 省略非权威 sidecar，保留确定性质量结果，不触发整条 BuildRun 补偿 |
| Activity 取消 | 等待已发付费请求完成结算后终止；不写确定性“成功”checkpoint |

消费者级非取消失败生成服务器确定的 rule summary；它只归组并解释原
finding，不改变 finding、severity、证据引用或 repair option。若连私有
sidecar 本身都无法安全校验或写入，则省略 sidecar，不反向改变确定性结果。
unknown settlement 继续由 durable ledger 冻结后续付费调用；task lease
释放失败也不能覆盖原始 unknown-settlement 错误。

## 本 PR 明确不做

- 不修改七个 task 的 active route，不移除历史 provenance，不晋级模型。
- 不调用真实模型，不读取或改写 new-api channel/token/price。
- 不新增 REST API、OpenAPI 语义、数据库表/迁移或公开响应字段。
- 不创建六任务 suite、真实 evidence、promotion、runtime token 或
  runtime attestation。
- 不声明 M1-g、MODEL-2、30+ 系统集、生产部署或 M2-PUBLISH 完成。

## 下一授权门

本 PR 通过审查并获得单独合并授权后，才从合并提交创建
`design_spec` 的 fixed-commit、create-only canonical suite 准备 PR。
该准备 PR 仍为零模型调用。真实 `design_spec` evidence 前必须另展示以
OpenOx 公共价格为唯一金额依据的精确费用卡，并取得单独费用授权。
