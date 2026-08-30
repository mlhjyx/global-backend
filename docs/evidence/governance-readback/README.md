# Trusted Approval readback evidence boundary

> 文档 ID：`EVIDENCE-GOVERNANCE-READBACK-001`
> 生命周期：`CURRENT_BOUNDARY`
> 状态：`LOCAL_DETERMINISTIC_ONLY / EXTERNAL_UNOBSERVED`

本目录只说明 Trusted Approval 本地确定性合同与证据边界，不存放或暗示真实审批结果。当前 ContractGraph 从固定、受限的治理合同路径提取以下静态关系：

```text
OWN-PRODUCT / OWN-DATA-PRIVACY -> decision_approval_for -> ADR-026 / ADR-027
OWN-QA-EVIDENCE -> qa_evidence_review_for -> ADR-026 / ADR-027
OWN-SECURITY -> security_review_for -> ADR-026 / ADR-027
LEGAL-REVIEW -> legal_input_for -> ADR-026 only
MERGE-AUTHORIZER -> merge_authorization_for -> ADR-026 / ADR-027
decision subject -> verified_by -> receipt contract
receipt contract -> attested_by -> independent verifier workflow contract
receipt contract -> authorizes_provenance_for -> ADR/Release consumer contract
```

这些节点和边统一标记为 `STATIC_CONTRACT`、`hostedReadback=EXTERNAL_UNOBSERVED`、`runtimeEvidence=false`、`acceptance=false`。它们只表示合同允许或要求的关系，不表示某个 actor 已审批、某份 receipt 已产生、某个 hosted workflow 已运行，或某个 consumer 已接受 provenance。

## 当前事实

| 门                                                                                 | 当前状态                   |
| ---------------------------------------------------------------------------------- | -------------------------- |
| 本地 schema/parser/validator 与 fixture 检查                                       | `LOCAL_DETERMINISTIC_ONLY` |
| Product / Privacy / QA / Security / Legal / Merge-Authorizer 机器 actor assignment | `UNASSIGNED / HOLD`        |
| 实际 Trusted Approval receipt bytes                                                | `NONE`                     |
| 实际独立 hosted verifier readback                                                  | `EXTERNAL_UNOBSERVED`      |
| RuntimeEvidence                                                                    | `NONE`                     |
| ADR-026 / ADR-027 接受                                                             | `HOLD`                     |
| Release Bundle 接受                                                                | `NONE / NOT AUTHORIZED`    |
| Pilot / GA                                                                         | `NOT AUTHORIZED`           |

Task 6 的 injected offline attestation fixture 即使返回 synthetic PASS，也只证明本地 seam 的确定性；extractor 不遍历 fixture、receipt payload、个人数据或本目录下的任意 payload。当前 `approval-authorities/v1` 只有 `initial-unassigned` 闭合 registry 能进入静态图；它不能完整表达 trusted readback 所需的 node identity、effective interval、scope、assignment evidence 与 ACTIVE lifecycle，因此任何 `ASSIGNED`/partial authority 输入都 fail closed，而不是输出一份不完整的 assignment。actor ID/login 永不写入 ContractGraph。

四份承重 schema 在 strict duplicate-key JSON parse 后必须匹配当前完整 canonical contract digest；`$defs`、`required`、`additionalProperties`、`const`、`enum` 或其他任一字段漂移都会产生零 approval projection。固定输入还使用 `O_NOFOLLOW | O_NONBLOCK`、普通文件检查、64 KiB + 1 有界读取与 fatal UTF-8。

## 本地确定性测试

`packages/code-intelligence/src/extractors/governance-approval-extractor.spec.ts` 是必须提交并由 package glob 执行的 focused spec。它验证 11 条精确 role/decision/slot 关系、所有静态信任属性、Task 6 synthetic payload 隔离，以及以下零投影反例：ASSIGNED 缺 actor identity、空 verifier、receipt required 漂移、attestation closed-shape 漂移、ADR enum 漂移、Release closed-shape 漂移、duplicate key、fatal UTF-8、symlink、directory、oversize、missing 与 FIFO。每个反例同时证明既有 Markdown governance graph 继续被提取。

## 真实证据准入

只有后续独立、受信的 hosted readback 在授权范围内真实回读 receipt raw bytes、evidence manifest、verifier identity 与生命周期状态，并由相应 consumer 按机器合同重新验证后，才可能形成实际 provenance。届时应追加不可变、schema-valid 的证据 artifact；不得修改本页文字或 ContractGraph 静态边来代替该 readback，也不得把 `HOLD` 解释成 acceptance。
