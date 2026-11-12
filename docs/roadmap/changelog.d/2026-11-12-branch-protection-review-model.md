---
date: 2026-11-12
title: Declare the self-review-with-required-checks branch protection model
---

- 起因：2026-11-12 审计 P1-1 发现 `required-contexts.json` 声明「1 approval + 强制 CODEOWNERS」，但线上 `protect-main` 实际是 0 approval / 不强制 CODEOWNERS / admin bypass；声明与实际不一致。尝试把线上改成 1 review 会让单人自审流程必须 `--admin`（绕过全部检查），反而更差。
- 改动：
  - `required-contexts.json` 的 `external_ruleset_requirements` 改为 `review_model: SELF_REVIEW_WITH_REQUIRED_CHECKS`、`required_approving_reviews: 0`、`require_code_owner_review: false`；对话解决、禁止强推/删除等保护不变。
  - `governance-ci-contracts.mjs` 要求该模型必须精确为 0 review / 不强制 CODEOWNERS，其他保护缺一仍失败；新增负向测试：声明 1 review 的「非自审模型」被拒。
- 测试：`pnpm governance:verify`（含 502 个治理测试）；`docs:verify`；CI 必需检查。
- 未做：不改线上 ruleset 的 admin bypass（DEC-AIDEV-004 的单人自审合并依赖它）；未来若增加第二审查人，应同时改模型与 ruleset。
