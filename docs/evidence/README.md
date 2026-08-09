# Evidence index and freshness rules

> 文档 ID：`EVIDENCE-INDEX-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：本目录 tracked artifacts、`docs/governance/runtime-evidence.schema.json` 与 `scripts/governance-verify.mjs`

本页是证据导航，不是第二份 current 状态。原始 artifact 保持追加式/不可改写；当前能力、路由、运行健康和发布状态仍分别由权威文档、机器合同、fresh RuntimeEvidence 与 Release Bundle 决定。

## 1. 分类

| 位置                               | 分类                           | 可证明                                                                            | 不可证明                                                         |
| ---------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`model-routing/`](model-routing/) | `HISTORICAL / FROZEN_EVIDENCE` | 对应提交和评测合同下的候选、失败、诊断与 route-decision provenance                | 当前模型目录、余额、settlement、运行路由、生产健康或新提交可晋级 |
| [`site-builder/`](site-builder/)   | `HISTORICAL / FROZEN_EVIDENCE` | M1-f/M1-g 的 manifest、fee card、decision card、stopped run 与历史执行 provenance | 当前授权、当前 runtime、自动 promotion、生产部署或可合并         |
| `runtime/`（仅在有记录时创建）     | `CURRENT` 或 `HISTORICAL`      | 由单条 schema-valid 记录的 commit、environment、窗口、kind、result 与 digest 限定 | 超出 `valid_until` 的状态，或其他 commit/environment 的状态      |

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

真实发布记录不放在本目录，而放在 `docs/releases/<release-id>.release.json`，并由生成器产出同名 Markdown。当前目录没有 RuntimeEvidence，`docs/releases/` 也不存在；因此当前没有可晋级的 release。

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

- BrandProfile 最终历史证据说明：[`model1-brand-profile-20260719-v20/README.md`](model-routing/model1-brand-profile-20260719-v20/README.md)
- design_spec manifest 准备决策卡：[`m1-g-design-spec-evaluation-manifest-prep-decision-card.md`](site-builder/m1-g-design-spec-evaluation-manifest-prep-decision-card.md)
- M1-g 阶段收口基线：[`m1-g-stage-closeout-baseline.json`](site-builder/m1-g-stage-closeout-baseline.json)
- 文本评测历史 evidence：[`m1-g-text-evaluation-real-evidence-v1.json`](site-builder/m1-g-text-evaluation-real-evidence-v1.json)
- Copy Sonnet recovery v15 当前 create-only 交付：[manifest](site-builder/m1-g-copy-sonnet-recovery-manifest-v15.json)、[runtime binding](site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v15.json)与[当前 source eligibility receipt](site-builder/copy-runtime-eligibility.json)。receipt 只判定当前源码相对 v15 binding 是 `CURRENT` 或 `STALE_HOLD`；两者均保持 `NOT_AUTHORIZED`、pilot blocked、0 wire/0 cost，不构成 capability、质量、晋级或生产路由证据。v14 及更早 artifact 是不可改写历史。
- Copy Sonnet recovery v13 历史 create-only 交付：[实施/TDD 记录](../implementation-records/copy-sonnet-recovery-v13-create-only-tdd.md)、[manifest](site-builder/m1-g-copy-sonnet-recovery-manifest-v13.json)与 [runtime binding](site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v13.json)；tracked artifact 不回写后续私有 stopped run，且不能作为 v14 authorization 或执行输入。
