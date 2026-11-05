---
date: 2026-11-05
pr: 816
title: Land the writer fixed-identity verifier change that #815 missed
---

- 起因：#815 声称「引擎侧验证 writer 固定身份令牌」，但实际合并的只有 changelog 片段——两次源码编辑误落在根 checkout 的绝对路径上（worktree 流程失误），代码从未进入分支，镜像中的验证器仍是旧形状；平台令牌因此继续在引擎侧被拒（`PLATFORM_MACHINE_TOKEN_UNAVAILABLE`），真机验收当场发现。
- 改动：与本应随 #815 合并的内容一致——`machine-token-verifier` 对 `temporal-platform-client` 档案接受固定身份形状（`typ` 必须 `JWT`、禁止 `profile` 声明、`permissions` 精确等于 `["platform-automation:write"]`），其余档案逐字节不变；`machine-token-verifier.spec.ts` 增加三态用例（固定身份接受 / 旧形状拒绝 / 带 profile 拒绝）。
- 测试：新用例红→绿（旧代码下必失败）；`machine-token-verifier` 套件全过；`gctl check --fast` 通过。教训：worktree 施工时必须写 worktree 内路径，代码改动与片段必须同分支自检（`git status` 应同时出现源码与片段）。
- 未做：#815 的片段保持原样（历史记录不改）；不改平台授权器与 gain-saas（#66 已合）。
