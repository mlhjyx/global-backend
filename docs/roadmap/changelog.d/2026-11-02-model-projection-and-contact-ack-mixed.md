---
date: 2026-11-02
title: Close the two recorded fail-closed residuals of the contact projection fix
---

- 起因：#734 修复工具侧投影拒绝后，审查记录的两个 fail-closed 残留：①model 侧投影拒绝仍留 RESERVED + control 错误（重试后该次调用按 remnant 永久跳过）；②联系人同一适配器在同次重试里新增回执（如进程级熔断在两次 attempt 间清零后补抓）仍抛 `DOMAIN_ACK_MIXED_REPLAY_STATE`。
- 改动：
  - **model 侧**（`router-model-gateway`，受保护文件已重钉 sha256）：与工具侧同款——有效 provider 输出但无法表示进 durable 契约时，按 provider 上报成本结算（无 durable result），并抛类型化非控制错误 `MODEL_DURABLE_RESULT_PROJECTION_REJECTED`（自身字段只含 code/name/message，分类器可机器判定为非 control）；调用方按普通失败处理（fit 计 unjudged、抽取跳源），同 key 重放读回已结算无结果行并按 remnant 吸收。
  - **联系人回执**：批量确认助手新增可选参数 `onMixed: 'reject' | 'apply'`（默认仍 reject，signals 等调用方行为不变）；联系人持久化传入 `'apply'`——persist 按身份 upsert/合并、可安全重放，混合态按 APPLIED 执行一次，不再把整条 run 打成失败。
  - 审查补强：`settledModelFailureReason` / `settledModelUpstreamFailureReason` 识别该错误——发现侧 provider 以零回执跳过该域（不再以 lineage 回执不匹配的 control 错误打死查询），ICP/query-plan/draft 的 HTTP 面给出 502 `MODEL_UPSTREAM_UNUSABLE` 合约；taxonomy 归一失败仍计入 `taxonomyFallback` 统计；修正 `@Injectable()` 误挂到错误类上的修饰器位置。
- 测试：model 网关投影拒绝的结算与非控制分类断言、两个失败分类器的新用例、domain-ack 混合 apply 用例、联系人 stage 与回执消费者全组；全量单测见 PR。
- 部署：无迁移；随下一班车上线。
- 未做：混合 apply 会为已持久化的联系人重复写 `field_evidence`（罕见路径，后续可加去重）；domain-ack 的分区变体未加 `onMixed`（当前无调用方需要）。
