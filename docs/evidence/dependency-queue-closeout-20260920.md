# 依赖队列、根同步与历史处置证据

> 2026-09-20 源码、验证与处置记录。本文不生成 RuntimeEvidence，也不预设自身未来 commit/merge 或根 checkout 状态；最终候选身份由 PR 和批末回读绑定。

## 范围

执行用户批准的依赖顺序 #532 → #528 → #530 → #531 → #533。源码、受保护合入、临时测试、retained runtime、Release、UAT 与 Pilot/GA 分开判定。现有业务 owner 保留 R4、#538 与 Program C 施工面；本批没有部署、保留数据库迁移、凭据变更或真实 provider/model/付费调用。

## 最终候选与来源

| 原 PR | 冻结目标 | 最终 successor/head | merge | 来源与关闭状态 |
| --- | --- | --- | --- | --- |
| #532 | Redocly2.53.2 | #539 / `5014a1c5b002b790311d93c9cd53f313e721d49c` | `0e8112e426b360a83e1ead823e92e2a1ada09f37` | 原始 `12f0b7e4fb31b1c2ffdcaf7e6ade029ef4a1eb66`；原 PR CLOSED，原分支恢复并回读 |
| #528 | Langfuse5.11.1 | #540 / `205b61972a83a9fde9c8cc164e9bd0b2b4307336` | `6213baf2715f0680f05024bee0994e8593403433` | 最初 `49c92b91dabe588bf2f0443d34dbe781e9178598`；bot 重建后的 `b12e877dcb45ce8d9445d369fa96a22e3b575a05` 原分支已恢复；最初 head 另有完整 recovery bundle |
| #530 | S3 client/presigner3.1134.0 | #541 / `60e9af404ba3b830966170e35654ad7d4b523376` | `1aaa1a779bbf716f301e5f08c7f3d0ad37eeaacc` | 最初 `3ae4871463618a0f13d501d4e00ca53d710e0e0f`，接受的新目标来源 `78aef721158c59ea121fb4dd6fa818173a80858d`；原 PR CLOSED，最新原始 head `39bf41b98056d7466a40cd11b8bde7b63d34e123` 的分支已恢复并回读 |
| #531 | Anthropic4.0.56 / OpenAI4.0.69 / ai7.0.105 | #543 / `e498c3917e4eb5f8f043654472c61cd9bb233715` | `03e8ada02010052bf4220e1063d2c5c987bf1f8a` | 最初 `eb2a38587ab7ce5dd0ee3e817d515bfd15fdc1bf`，接受的新目标来源 `891898ccf444f411f01cbef059581732bc40d912`；原 PR CLOSED，最新原始 head `9f7f2bfd4e6c30855710549f50c1a2797495bf7d` 的分支已恢复；批末再次回读 |
| #533 | Node22 types22.20.3、ESLint10.10.0、globals17.12.0、Nx23.2.1、Prettier3.9.7、tsx4.23.13、typescript-eslint8.70.0 | 分支 `codex/deps-dev-tooling-20260920`；文档加入前源码冻结 `d6aa4fc6e8723a41aba36566ebee70606e58baf7`，与已审 `58f4971f42a04b8c5c544da1203d5c18c8c03081` tree 相同；含文档的最终 head 由该 successor PR 绑定 | 本文件不预设未来 merge SHA；从原 [#533](https://github.com/mlhjyx/global-backend/pull/533) 的 successor 记录及批末回读取得 | 最初 `56308a82626bdc70e99b930fc9b8ef93e8804a1b`；七项直接目标维持；原 PR 仅在本候选最终门通过并合入后关闭，最新原始 head 与分支恢复结果记录于批末回执 |

## 验证范围与限制

- D1：39 项 focused 与220项 governance；contracts build/lint/bundle/docs/gen。实际旧/新 CLI bundle JSON 相同，显式生成 TypeScript 的 SHA-256 均为 `54986ccf3ba70d0fbd37253af5a9402838f2fe5fa21249358c8df64fddb45ddf`，不能只靠 ignored 文件的 Git diff 声称相同。最终 hosted full job 40m8s PASS。
- D2：10 项 telemetry/config；实际 SDK 经生产 telemetry factory 向隔离 loopback 导出一次3408-byte请求，disabled 无请求，所测 prompt/output/raw workspace/execution canary 未出现在 body。不是任意字段隐私证明，也不是外部 collector 采用。最终 hosted full job 38m23s PASS。
- D3：新3.1134.0重跑79项 unit、9项真实 MinIO，包括最大对象、不可变复用、损坏拒绝、version/encryption/lifecycle、角色隔离与精确版本删除。镜像 digest 固定，容器无宿主端口/保留卷、使用隔离 namespace，receipt 确认自有容器清理。这不构成真实 presigned PUT/GET HTTP 消费端回归。
- D4：新版本重跑8个 spec /120项，实际 SDK 与 loopback fixtures 覆盖 Responses/Chat/Messages、结构化输出、usage、bounded error、abort、无自动重试及结算身份；没有真实模型或费用。
- D5：恢复10个未变父包的无关降级，并补全相应 base package/snapshot；冻结安装会拒绝缺失闭包。保留的共享 esbuild/yaml/types peer 更新有生产传递影响，不能称为 dev-only。API lint0errors/14warnings、API/Graph/test-support builds、57项Graph tests、Nx discovery、格式及最终上游更新后检查通过。
- 各组均完成相应 frozen official-registry install、docs/governance、API或contracts build、source policy、JS production audit、格式与 ContractGraph；同一最终树的独立审查和 hosted CI 分开绑定。现有 docs1项 warning、Graph9项 warning 与 contract18项 tag warning 按范围保留。
- Copy active binding、`STALE_HOLD / NOT_AUTHORIZED / BLOCKED`、安全 overrides 和既有 libc/deprecation 元数据保持；只根据实际最终树重算派生指纹，不晋级运行证据。

已合入的四组分别通过精确 head 的独立审查与 hosted CI：

- #539：`5014a1c5b002b790311d93c9cd53f313e721d49c`，[CI](https://github.com/mlhjyx/global-backend/actions/runs/35488668906)。
- #540：`205b61972a83a9fde9c8cc164e9bd0b2b4307336`，[CI](https://github.com/mlhjyx/global-backend/actions/runs/35490480132)。
- #541：`60e9af404ba3b830966170e35654ad7d4b523376`，[CI](https://github.com/mlhjyx/global-backend/actions/runs/35492446915)，full job37m10s。
- #543：`e498c3917e4eb5f8f043654472c61cd9bb233715`，[CI](https://github.com/mlhjyx/global-backend/actions/runs/35494470918)，full job39m8s。

最后工具链加文档候选仍须在最终 head 完成独立源码/文档审查与完整 hosted CI，才可受保护合入；其状态由该 PR 的实际 checks、审查回执及 merge 回读确立，不由本文声明授予。原始命令、结果、工作区、branch/full SHA、限制及后续真实完成状态记录于 `/var/tmp/backend-dependency-queue-20260920/progress.md` 和批末机器清单。

## 根 main

根 checkout 的实际同步状态由 `/var/tmp/backend-dependency-queue-20260920/final-root-sync.json` 与最终 status/ContractGraph 回读确立。本文只记录执行协议和回执位置，不从候选内容或合入推断 apply 已执行。

根同步只使用 `node scripts/governance-main-worktree-sync.mjs status` 与 `apply`，不 reset、stash、clean 或覆盖未提交/ignored/untracked 现场。其他 owner 已协调不运行并发 root 扫描或同步。最终 ContractGraph 按 root 当前 head 重新回读。

## 历史分支和 worktree

216 个原结构候选逐项回读时 head 未变、工作区干净；195 个有 ignored 材料，21 个没有 ignored 条目。全部保留 UNKNOWN owner / 未取得删除授权。已用独立 bare repository 恢复全部216个 commit/tree；归档固定 main `0e8112e426b360a83e1ead823e92e2a1ada09f37`，53,739,848 bytes，SHA-256 `85125b3671498d49de08cdd447b04638eb04bffd9070c2791bc43aa8cb0dbacc`。这只证明 committed history 可恢复，不覆盖 ignored 材料、owner release 或删除权限。

最终精确 inventory 与逐项处置见本任务 artifacts：`/var/tmp/backend-dependency-queue-20260920/`。原始基线计划与419项 worktree、504项 branch 清单位于 `/var/tmp/backend-final-failure-20260913/`；这些数字是原观察快照，最终数量和逐项理由以 `final-all-dispositions-summary.json` / `final-all-dispositions.json` 的实际回读为准；不将原快照数字冒充批末计数。

## 剩余门与历史更正

Owner 交付来源分别保留：R4 消息 `PARITY-LOCAL-CLOSEOUT-20260920-17`（任务 `01a00ab2-0341-7443-adf1-04d9dfd6b0ff`）、身份消息 `PR538-STATUS-FREEZE-20260920-14`（任务 `01a099b1-110e-7fe3-8d7a-16804edf408f`）、Program C 消息 `STATUS-FINAL-PROGRAM-C-REPLY-20260920-20`（任务 `01a04c76-cdff-7951-a338-e39dc1f5c17d`）。对应任务 artifacts 为 `owner-report-17-readback.json`、`owner-identity-status-freeze.json`、`owner-source-prepublication.json` 与 `program-c-lifecycle-readback.json`。

本任务独立执行了对应 worktree 的 `git rev-parse HEAD` / `git status --porcelain`，并对 Program C 的 full-schema、real-session、lifecycle 主报告做 SHA-256 和 testsuite header 回读，零 failure/error/skip 与 receipt 匹配。完整46项迁移只适用于空库，owner 报告的13/22项测试属于各自源码与局部 HTTP 作用域；不与旧257项证明相加成全项目 fresh PASS，也不声称本任务重跑了其他 owner 的测试。

剩余 R4/producer/receiver/revocation/lease、#538 admission、Program C 产品接纳、RuntimeEvidence、Release、UAT 与 Pilot/GA 以[当前状态](../status/current.md)为唯一当前入口。本批不以新增的局部成功替代这些门。

#494/#495 的实际 GitHub 历史是分别 MERGED，随后 #497 完成 harness 收口；不是最初计划的“关闭为 superseded”。#407 与#479 CLOSED并保留 provenance，#407 不等于全量语义接纳。原始状态页和旧运行观察的 Git provenance 与 evidence links 保留，不把2026-09-12的health/readiness写作本轮当前运行。

JS production audit 的 `PASS_CLEAR / 0 advisories` 与所有依赖告警、Go 安全性、baseline freshness 分开。完整 npm audit 观察仍有12项漏洞（2high/10moderate），GitHub告警也包含原生Go OTel低危；后者已交 native owner 按其范围处理。对未变工具链源码冻结 `58f4971f42a04b8c5c544da1203d5c18c8c03081` 的实际 freshness CLI 返回 exit1、`AUDIT_INVALID_HOLD / BASELINE_SOURCE_LOCK_MISMATCH`，不是 PASS。独立 Draft #542（已观察 head `4aeb2d5aff7f2df8fe03ad9c936e2d71b3d4d5de`）绑定旧 main `1aaa1a779bbf716f301e5f08c7f3d0ad37eeaacc`，仍须确认 owner 并对最终 lock重新审计，不能放宽零漏洞政策或原有效期。该待处理门明确保留，不用源合入推导发布可用。
