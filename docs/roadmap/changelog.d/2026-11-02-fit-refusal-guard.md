---
date: 2026-11-02
title: Keep model refusals in qualify-fit out of the rejected queue
---

- 起因：run `3212f6f3`（生命科学域 ICP）的 4 次 `discovery.qualify_fit` 调用中 3 次被上游模型拒答——HTTP 200、各门填「本服务不支持……生命科学研究……」「不支持以中文提出的请求」等拒绝文案，`verdict` 却填成合法枚举 `mismatch`，schema 校验看不出问题；fit-judge 只校验枚举，3 家候选因此被自动进 `rejected`。同 ICP 上午在 `gemini-4-argon-high` 下判定正常（4 match / 10 weak / 7 mismatch）。
- 改动：`judgeFitCompany` 增加拒答签名检测（`looksLikeModelRefusal`）。命中时按 fail-safe 归一为 `weak` 并写合成的四门说明与原文摘录（「疑似上游内容策略拒答，转人工复核，不自动拒绝」），绝不 `mismatch`；durable receipt 照常透传。不在函数内自动重试：同一请求材料的 durable 预算操作键相同，重放只会拿回同一份拒答或撞 `BudgetOperationReplayError`，真正解法是换不拒答的模型路由。
- 测试：`fit-judge.spec.ts` 新增 3 例——事故原文（拒答）降级为 weak 且保留 receipt/摘录、真实证据型 mismatch 不受影响、合法的 unclear 门不被误判为拒答；原 15 例照旧通过。
- 未做：不改 `discovery.qualify_fit` 的模型路由（共享 runtime，由产品负责人决定）；不改 durable 结果投影（receipt 保留原始拒答，人工可按摘录溯源）；不改 backlog 路径的判定语义（复用同一函数，行为自动一致）。
