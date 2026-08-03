# M1-g `design_spec` v5 公开价格卡决策记录

生成时间：2026-08-03T19:25:08.607Z

## 已固定的输入

- 固定源码：`origin/main@377f8a3ae983bad0e4ae43f767a4bc59d8f7d0a9`
- manifest：`m1-g-design-spec-evaluation-manifest-v5.json`，摘要 `bcc0ac261f56a5c950e11483a3dc28f33ed678c626891367a45b6c1f56429dc4`
- 评测矩阵：73 executions、最多 146 wire calls、三个精确 alias/protocol、一次 `gpt-5.5` capability probe
- 价格来源：OpenOx 公开目录 `https://openox.tech/api/public/pricing-catalog`；响应摘要 `6c27972ffba3ca5f799c6ac293e6783d1455df624ab9f62252828863df7e43de`

## 机械上限（原币，不换汇）

| alias | protocol | 最大 wire calls | 原币上限 |
| --- | --- | ---: | ---: |
| `gpt-5.6-terra` | `openai-responses` | 48 | CNY 3.128784 |
| `gpt-5.5` | `openai-responses` | 50 | CNY 8.147875 |
| `claude-sonnet-5` | `anthropic-messages` | 48 | USD 3.45842784 |
| 合计 | — | 146 | CNY 11.276659 + USD 3.45842784 |

这只是最大 token-envelope 的公开价格计算，不是预计消费、账单或费用授权；`expectedCost=not_known_before_usage`，并保留 2920 cents 的独立机械安全上限，不能把 cents 与原币混用。

## 本次实际效果

- 只读取一次公开价格目录，未读 `.env`、余额、凭据或 new-api 价格。
- 模型 wire calls 为 0，实际模型费用为 CNY 0 / USD 0，`dispatchAuthorization=NOT_AUTHORIZED`。
- 不改变模型 route、promotion、runtime fallback、API、数据库、Temporal、媒体或部署。

## 后续门与停止条件

费用卡仅把 v5 从“等待公开价格”推进到 `READY_FOR_CREDENTIAL_ATTESTATION`。真实执行仍必须在任何模型请求前分别闭合：purpose-specific 有限凭据、精确 alias/protocol allowlist、可验证余额/限额、known settlement、固定 source 未漂移，以及针对该任务的明确费用授权。任一项缺失即停止，不能用本卡代替。
