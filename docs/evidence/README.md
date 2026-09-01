# Evidence index and freshness rules

> 文档 ID：`EVIDENCE-INDEX-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：本目录 tracked artifacts、`docs/governance/runtime-evidence.schema.json` 与 `scripts/governance-verify.mjs`

本页是证据导航，不是第二份 current 状态。原始 artifact 保持追加式/不可改写；当前能力、路由、运行健康和发布状态仍分别由权威文档、机器合同、fresh RuntimeEvidence 与 Release Bundle 决定。

## 1. 分类

| 位置                               | 分类                                                                                    | 可证明                                                                            | 不可证明                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`model-routing/`](model-routing/) | `HISTORICAL / FROZEN_EVIDENCE`                                                          | 对应提交和评测合同下的候选、失败、诊断与 route-decision provenance                | 当前模型目录、余额、settlement、运行路由、生产健康或新提交可晋级 |
| [`site-builder/`](site-builder/)   | `HISTORICAL / FROZEN_EVIDENCE`，其中显式 successor readback 由对应 RuntimeEvidence 限定 | M1-f/M1-g 历史 provenance；2026-09-01 development runtime readback 的脱敏详细事实 | 超出 RuntimeEvidence 窗口的当前性、Pilot/GA、模型质量或公开发布  |
| `runtime/`（仅在有记录时创建）     | `CURRENT` 或 `HISTORICAL`                                                               | 由单条 schema-valid 记录的 commit、environment、窗口、kind、result 与 digest 限定 | 超出 `valid_until` 的状态，或其他 commit/environment 的状态      |

现有 model-routing 和 Site Builder 文件不会因被索引而升级为 current。判断当前运行证据只运行：

```bash
pnpm governance:verify
```

## 2. RuntimeEvidence 规则

RuntimeEvidence 文件必须位于 `docs/evidence/runtime/`、使用 [RuntimeEvidence v1 schema](../governance/runtime-evidence.schema.json)，有效窗口不得超过 24 小时，并至少绑定：

- 完整 Git commit 与明确 environment；
- `verified_at`、`valid_until` 与 `evidence_kind`；
- 闭合的 `PASS | FAIL | UNKNOWN` result；
- `sha256:` artifact digest；若声明仓内 artifact path，路径必须是仓库内无
  `..` 的普通文件、不得是符号链接且最大 10 MiB，验证器才会有界读取并重算摘要。

时间到达 `valid_until` 后，记录自动成为 `HISTORICAL`：保留 provenance，但不能满足 `PILOT`/`GA` 门。TEST_ANCHOR、旧真机日志、手工日期和“命令曾通过”的叙述都不能替代这张记录。

## 3. Release 与决策边界

真实发布记录不放在本目录，而放在 `docs/releases/<release-id>.release.json`。当前已有追加式 development-only `CANDIDATE` 与 successor RuntimeEvidence；其 external provenance、独立 reviewer 与 Pilot/GA 用户授权均未成立，因此不能晋级。

Release Bundle 必须分别引用：

1. 受信机器 check；
2. 独立 reviewer provenance；
3. 产品负责人签署的用户授权；
4. 与实际 merge method 相符的提交/parent provenance；
5. 仍在有效期内的 PASS RuntimeEvidence。

其中 `traceability_bindings` 必须逐链记录 `chain_id`、`capability_id` 和该链实际消费的 `evidence_ids`；只有 capability 名称相同、但 chain 或 evidence set 不同的 Bundle 不能授权晋级。

Bundle 内的 provenance 枚举、actor、SHA、时间和 URL 都是 documentary declaration。它们只有在一个可信、独立的外部 readback verifier 真实读回对象，核对仓库/PR/head/actor/result，并产出身份绑定 receipt 后才能作为 promotion provenance。当前没有这个 verifier，所以 `external_provenance` 必须保持 `EXTERNAL_UNVERIFIED / NONE / NONE`，所有 `PILOT/GA` 都 fail closed。伪造 `VERIFIED`、攻击者 URL、PR 正文、机器人建议或一个共享 URL 都不能充当这些门。

## 4. 历史入口迁移

2026-08-07 治理瘦身把 `AGENTS.md` 和 `docs/status/current.md` 中的日期化 Site Builder、模型评测、开发真测与 provider 叙述迁出日常入口。迁移没有改写或删除本目录 artifact；完整迁移前文字可从 Git 对象 `35145699db63fc8aef2350a0ca331fef9724f617:AGENTS.md` 与同提交的 `docs/status/current.md` 恢复。后续 successor 只在 [追加式 changelog](../roadmap/changelog.md) 记录，不复制原始 evidence 内容。

## 5. 常用索引

- Production Parity development readback：[详细脱敏 receipt](site-builder/production-parity-development-runtime-readback-20260901.json)、[确定性产品路径 RuntimeEvidence](runtime/site-builder-deterministic-product-path-development-20260901.json)、[UNKNOWN containment RuntimeEvidence](runtime/site-builder-unknown-settlement-containment-development-20260901.json)与 [development CANDIDATE Release Bundle](../releases/site-builder-production-parity-development-20260901.release.json)。确定性 Intake/Release 通过；真实模型调用只证明 `UNKNOWN` containment 与 request-bound reconciliation，不证明有效模型输出、质量、Pilot 或 GA。
- Platform writer exact-runtime successor：[详细脱敏 receipt](site-builder/production-parity-platform-writer-runtime-readback-20260901.json)、[新 digest deterministic RuntimeEvidence](runtime/site-builder-deterministic-product-path-platform-writer-development-20260901.json)、[UNKNOWN persistence RuntimeEvidence](runtime/site-builder-unknown-containment-platform-writer-development-20260901.json)与 [successor development CANDIDATE](../releases/site-builder-production-parity-platform-writer-development-20260901.release.json)。它证明 API/Worker/Relay exact identity、platform writer admission 和新 digest 零模型 Intake；Platform authority 仍 missing，历史 generative output 仍 UNKNOWN。
- BrandProfile 最终历史证据说明：[`model1-brand-profile-20260719-v20/README.md`](model-routing/model1-brand-profile-20260719-v20/README.md)
- design_spec manifest 准备决策卡：[`m1-g-design-spec-evaluation-manifest-prep-decision-card.md`](site-builder/m1-g-design-spec-evaluation-manifest-prep-decision-card.md)
- M1-g 阶段收口基线：[`m1-g-stage-closeout-baseline.json`](site-builder/m1-g-stage-closeout-baseline.json)
- 文本评测历史 evidence：[`m1-g-text-evaluation-real-evidence-v1.json`](site-builder/m1-g-text-evaluation-real-evidence-v1.json)
- Copy Sonnet recovery v15 当前 create-only 交付：[manifest](site-builder/m1-g-copy-sonnet-recovery-manifest-v15.json)、[runtime binding](site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v15.json)与[当前 source eligibility receipt](site-builder/copy-runtime-eligibility.json)。receipt 只判定当前源码相对 v15 binding 是 `CURRENT` 或 `STALE_HOLD`；两者均保持 `NOT_AUTHORIZED`、pilot blocked、0 wire/0 cost，不构成 capability、质量、晋级或生产路由证据。v14 及更早 artifact 是不可改写历史。
- Copy Sonnet 2026-08-12 native capability：[evidence](site-builder/m1-g-copy-sonnet-native-capability-2026-08-12.json)。用户授权的 Sonnet Messages 单个 factual fixture 用 2 条 wire（首调 contract reject、一次 repair validated）完成；purpose-specific token 已禁用。该记录已完成 Git review，且仅证明该 fixture 的 native gateway capability，不构成全量 quality、模型晋级或生产 route adoption 证据。
- Copy Sonnet 2026-08-12 native quality：[evidence](site-builder/m1-g-copy-sonnet-native-quality-2026-08-12.json) 已由 [quality Git-review acceptance](site-builder/m1-g-copy-sonnet-native-quality-git-review-acceptance-2026-08-12.json) 绑定 #396 merge commit、[promotion Git-review acceptance](site-builder/m1-g-copy-sonnet-native-promotion-git-review-acceptance-2026-08-12.json) 绑定 #397 merge，及 [route Git-review acceptance](site-builder/m1-g-copy-sonnet-native-route-adoption-git-review-acceptance-2026-08-12.json) 绑定 #398 merge。Sonnet Messages 的六个 production fixtures × 两次共 12/12 accepted outputs 通过生产硬门；矩阵共 13 条物理 wire（包含一条 structured-output failure 与同执行键的唯一 bounded recovery），另有 1 条先前诊断 wire 独立审计、未进入矩阵或评分。独立盲审四项均值均不低于 3，所有 purpose-specific token 已禁用，且不提交原始 prompt/output/token/request ID。现役代码 route 为 Sonnet Messages/medium/no-fallback；部署或新的 RuntimeEvidence 不由这些 Git evidence 产生。
- 上述 Copy Sonnet native capability 的 Git-review acceptance：[acceptance](site-builder/m1-g-copy-sonnet-native-capability-git-review-acceptance-2026-08-12.json)。它绑定 #394 merge commit、required checks 与原 artifact 的 file/canonical digest；不重写原始运行证据，也不扩展为全量质量、模型晋级或生产 route adoption。
- Copy Sonnet recovery v17 零调用停止记录：[stopped evidence](site-builder/m1-g-copy-sonnet-recovery-v17-zero-call-preflight-stopped-evidence.json)。它只证明 #381 后的 public pricing source transport 在 token 创建前 fail closed，以及脱敏的零调用/readback 事实；不证明 source 当前恢复、credential、模型 capability、质量、promotion 或 production route adoption。
- Copy Sonnet recovery v18 零调用停止记录：[stopped evidence](site-builder/m1-g-copy-sonnet-recovery-v18-zero-call-preflight-stopped-evidence.json)。它只证明 #385 后获授权的单次 preflight 在 token 创建前因 ToolBroker 无法连接 OpenOx public pricing source 而 fail closed，且 route #20、v16 #24 与 v17 #25 的脱敏 readback 处于 disabled；它不产生 v18 token、成功 artifact、模型请求、模型 wire 或模型费用，也不证明 capability、质量、promotion 或 production route adoption。
- Copy Sonnet recovery v19 零调用停止记录：[stopped evidence](site-builder/m1-g-copy-sonnet-recovery-v19-zero-call-preflight-stopped-evidence.json)。它只证明 #387 后的单次 preflight 已通过 ToolBroker 读取 OpenOx 价格，但在 post-create New API readback 发生控制面不可用；token #26 已由 cleanup 禁用，route #20、v16 #24 与 v17 #25 仍 disabled，且无成功 artifact、模型请求、模型 wire 或模型费用。它不证明 capability、质量、promotion 或 production route adoption。
- Copy Sonnet recovery v13 历史 create-only 交付：[实施/TDD 记录](../implementation-records/copy-sonnet-recovery-v13-create-only-tdd.md)、[manifest](site-builder/m1-g-copy-sonnet-recovery-manifest-v13.json)与 [runtime binding](site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v13.json)；tracked artifact 不回写后续私有 stopped run，且不能作为 v14 authorization 或执行输入。
