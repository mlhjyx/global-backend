---
date: 2026-11-08
title: Role-ify the qualifier at quickScan with fit.judge traces (M2 step 9b-3)
---

- 起因：M2 步 9b 第 3 步——把 Run 2.0 quickScan 的批量粗判包成「资格判定员」agent 回合：每批判定落 `fit.judge` 轨迹（含被否候选与理由码），技能子集经 S0 resolver 校验（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - `quickJudgeBatch` 回合门：经 agent 注册表解析 `discovery.qualifier`（未注册/停用 → nonRetryable `AGENT_NOT_REGISTERED` / `AGENT_DISABLED`），并按 agent 的技能子集逐个经 S0 resolver 校验；技能不可用（如平台停用）→ 轨迹落 `reason_code` 后原样上抛（fail-closed，不降级不吞判）。
  - 每个批次落一条 `fit.judge` 轨迹：`chosen_option`=批次规模/判定数/verdict 分布；`rejected_candidates`=被否（`VERDICT_MISMATCH`）、被外部处理闸门跳过（`EXTERNAL_PROCESSING_BLOCKED`）、判定失败（`QUICK_JUDGE_FAILED`）的公司引用 id；discriminator=批次 job id 的内容哈希（重放不翻行）。
  - 两个角色共用回合辅助 `agent-round.ts`（解析 + 技能子集校验）；源侦察员侧同步改用它，行为不变。
  - managed worker 把 agent runtime 注入 run2 activities（fast lane 不跑 run2）。
- 零行为变化：轨迹是批次判定后的旁路记录；召回、判定语义、降级路径（逐家/规则兜底）、预算与重试不动；未接线环境保持旧行为。
- 测试：run2 activities 套件新增 3 例（fit.judge 轨迹内容、AGENT_DISABLED fail-closed 零模型调用、技能停用落 SKILL_PLATFORM_DISABLED 后上抛——设计 §8 负向 3）；worker 接线源级守卫；既有用例不回退。
- 未做：golden mini-run 与 E2E-9b 随发车后在部署镜像上执行（需产品负责人的发车指令）；租户 trace 端点与前端时间线在 9b-4。
