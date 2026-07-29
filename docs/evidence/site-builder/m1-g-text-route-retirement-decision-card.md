# M1-g text-route retirement governance card

Date: 2026-07-29
Status: `ZERO_COST_GOVERNANCE_READY_FOR_REVIEW`
Model dispatch authorization: `NOT_AUTHORIZED`

本卡只冻结 M1-g 六个剩余文本任务的退役与回滚治理，不是模型
evidence、promotion、运行时 attestation 或费用授权。

模型生成调用数：**0**

模型费用：**$0.00**

## Create-only report

- 新报告：
  `m1-g-current-route-recovery-retirement-report.json`
- 报告 schema：`site-builder-current-route-recovery-report/2026-07-29-v4`
- 报告 SHA-256：
  `bbbe2ccf44fb37d70b3cd9231dd4cb706edf2b17892a476049a23225ed29f605`
- squash-stable runner source SHA-256：
  `661afd090f7b348a9598a532f6f9b172fbf8ba23a4ae4984a85429bf629e9e28`
- route baseline：
  `e727bb141ad2c8c5fdd4379308ed85cfc7aefb86`
- OpenOx source bundle fixed commit：
  `e91b184741a10b83459a8041e3ecd9701fdf3b5b`

报告仍冻结 7 task / 15 dispatch / 8 active alias，但新 runtime credential
required allowlist 只含 5 个非退役 alias。结果为
`BLOCKED_CURRENT_ROUTE_RECOVERY`，唯一退役 blocker 为
`RETIRED_ALIAS_STILL_ACTIVE`；dispatch 始终 `NOT_AUTHORIZED`。

## 用户路径影响

目标用户路径为 `CAP-SITE-BUILD-001 / SCN-FE-SITE-011 /
PAGE-FE-040`：SaaS 用户提交建站资料后生成预览。当前六个任务仍保留原
active route，避免在没有逐任务 evidence 时静默切流；但 MiniMax/Doubao
已明确进入 `pending_retirement`，后续不再把“恢复旧渠道”当成 M1-g
完成路径。

## 冻结决策

- `minimax-m3`、`doubao-seed-2.0-pro`、
  `doubao-seed-2.0-lite` 只保留历史 currentRoute provenance。
- 恢复报告遇到上述仍活跃 alias 时只输出
  `RETIRED_ALIAS_STILL_ACTIVE`；不要求渠道、OpenOx 价格或 runtime
  credential 覆盖。
- 上述 alias 不得进入新 runtime token、attestation、comparator 或可执行
  rollback。
- Gemini 文本继续 `deferred`，不进入 target、comparator、runtime token
  或价格覆盖；Gemini 图片、视频不在本轮。

## 独立可执行 rollback

| Task            | Rollback target                |
| --------------- | ------------------------------ |
| `brand_profile` | `deepseek-v4-pro` → `glm-5.2`  |
| `copy`          | `deepseek-v4-pro` → `glm-5.2`  |
| `design_spec`   | deterministic `safe-blueprint` |
| `assemble`      | `glm-5.2` → `deepseek-v4-pro`  |
| `assembly_fix`  | `glm-5.2` → `deepseek-v4-pro`  |
| `qa_summarize`  | deterministic `rule-summary`   |
| `seo_review`    | deterministic `rule-summary`   |

历史 currentRoute 与上表 rollback target 是两份不同合同。历史证据不会因
退役而删除，未来 promotion 也不能从历史路由自动推导 rollback。

## 本 PR 边界

- 不改 active route，不安装消费者，不调用真实模型。
- 不读取或提交令牌，不修改 new-api channel/token/price。
- 不新增 REST API、数据库表、迁移、Temporal 命令或 ReleaseManifest。
- 不声明六任务 promotion、M1-g、MODEL-2、生产部署或 M2-PUBLISH 已完成。

## 下一授权门

本治理 PR 通过审查并获得单独合并授权后，下一独立 PR 才接入
`qa_summarize` / `seo_review` 非权威消费者与
`QualityNarrativeSetV1`。随后仍按 `design_spec` → `copy` → `assemble`
→ `assembly_fix` → `qa_summarize` → `seo_review` 的顺序，分别准备
fixed-commit、create-only suite。任何真实模型调用前必须另展示以 OpenOx
公共价格为唯一金额依据的任务费用卡，并取得单独费用授权。
