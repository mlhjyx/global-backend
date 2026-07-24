<!-- 标题用 Conventional Commits：feat(scope): … / fix / docs / refactor / test / chore -->

## 概述
<!-- 一句话：这个 PR 做了什么、把哪条能力线推进到哪 -->

## 改动分组
<!-- 按主题分组，每组一句话说清「做了什么 + 为什么」 -->
-

## 文档与阶段回写

- 本次事实基线：`origin/main@<sha>`
- 是否触发“阶段完成回写清单”：是 / 否；原因：
- 若触发：已核对状态页、路线图、架构、产品边界、ADR 注记、专题合同页与历史入口；更新项 / 不适用原因：

## 测试 / 验证
- [ ] `pnpm --filter @global/api build` 绿（nest build = tsc 全量类型检查）
- [ ] `pnpm --filter @global/api test` 绿（vitest）
- [ ] **真实数据实测**（provider/采集/富集类改动必填；无 sandbox，见 AGENTS.md §5）—— 附命令与结果：
- [ ] CI 绿

## 非技术合并决策卡

> 进入合并候选时由 Codex 完成。本卡是业务解释和审查证据，**不是合并授权**；审查代理只能给建议，不能代替产品负责人或本任务的明确合并授权。

- 关联业务结果、Capability / Scenario / Page / Object：
- 用户会实际得到什么：
- 明确没有改变什么：
- 成功、失败与恢复路径：
- 数据、权限、迁移、外部合同或生产影响：无 / 有（说明）：
- 技术门：`PASS / HOLD / UNKNOWN`；证据（commit、命令、CI）：
- 独立审查代理：`RECOMMEND_MERGE / RECOMMEND_HOLD / NEED_USER_DECISION`；结论：
- 最大剩余风险、未知项与回退方式：
- 产品负责人授权：`AWAITING_PRODUCT_OWNER`（或本任务已明确授权的精确语句）：
- Codex 建议：`MERGE / HOLD / NEED_USER_DECISION`

## 合规（涉数据源 / 联系人 / 抓取时必填）
<!-- 数据分级 🟢公司事实(可商用) / 🟡职能邮箱(ePrivacy) / 🔴人名·联系人(默认隔离+LIA)；
     免费访问路径或绕付费手段；robots/ToS；「法定公开≠可自由再分发」 -->
-

## 待续 / 已知风险
-

- [ ] Codex 实际参与了本 PR 的开发/复核（仅在真实发生时勾选，不伪造 provenance）
