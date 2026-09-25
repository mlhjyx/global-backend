# 治理减负 PR-C 工作区证据

> 生命周期：`REFERENCE_ONLY`
> 依据：2026-09-25 对本工作区候选文件的静态引用、生命周期和机器路径约束检查；本记录不代表 CI、运行、发布或用户验收通过。

## 范围与方法

仅执行候选孤立脚本删除、历史文档归档及必要引用修正。未执行 Git、Node、pnpm、提交或网络动作；分支和 writer 状态由 Claude Code 复核。本次不改机器合同与 CODEOWNERS；唯一改动的 npm 入口是随审批簇一并删除的 `approval-readback:test`。

先用 `rg` 枚举候选并查看 workflow、包入口、CODEOWNERS 与机器合同，再用 Python 遍历仓库文件（包括隐藏和忽略文件，排除 `node_modules`、`.git` 及不跟随的符号链接），对完整文件名和去掉最后一个扩展名的基名做大小写敏感字面子串搜索。文本扫描覆盖根目录与各 workspace 的 package.json、全部 workflows、scripts、apps、packages、docs、infra、Dockerfile 和 CODEOWNERS；共扫描 2781 个 UTF-8 文本文件。二进制另做拟删除脚本基名字节检查，Word XML/关系条目解包后检查，均未发现拟删除脚本引用。无须也未输出这些二进制文件的正文。

命中按“文件中的行”去重计数（文件名与基名同一行不重复计数），统计取修改前快照，不计本证据新增的审计文字。自引用与本次实际一并删除文件之间的引用单列；任何来自最终保留文件的命中都阻止删除，包括文档中的历史命令。先计算候选删除集合，再反复移出被集合外文件引用的候选，直到稳定；不会把后来决定保留的文件引用误当作可忽略的互相引用。基名子串命中可能较保守，不据此扩大删除。

检查结果：删除 **31** 个 API verify 脚本；审批/readback 簇经 Claude Code 复核后整组删除（见下节，含 45 个脚本、`scripts/fixtures/approval-readback/` 与 npm 入口 `approval-readback:test`）；归档 **19** 个文件（3 个 Word、16 个 CLOSED 计划）；修正 **12** 个已有文档的引用，另新增归档说明与本证据。

## 删除清单

“外部 0”指排除自身及本次实际删除集合后的命中行数。每项均未发现 npm/CI 接线、机器合同或 CODEOWNERS 路径引用。

| 删除文件 | 搜索关键字（文件名；基名） | 命中行数 | 结论 |
| --- | --- | --- | --- |
| `apps/api/scripts/verify-ats-hiring.mts` | `verify-ats-hiring.mts`；`verify-ats-hiring` | 外部 0；自身 4；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-backfill-blinded-merge.mts` | `verify-backfill-blinded-merge.mts`；`verify-backfill-blinded-merge` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-backlog-cursor.mts` | `verify-backlog-cursor.mts`；`verify-backlog-cursor` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-blind-dedupe.mts` | `verify-blind-dedupe.mts`；`verify-blind-dedupe` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-digital-footprint.mts` | `verify-digital-footprint.mts`；`verify-digital-footprint` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-email-gate.mts` | `verify-email-gate.mts`；`verify-email-gate` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-intent-scoring.mts` | `verify-intent-scoring.mts`；`verify-intent-scoring` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-lead-handoff-suppression-race.mts` | `verify-lead-handoff-suppression-race.mts`；`verify-lead-handoff-suppression-race` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-pii-smoke.mts` | `verify-pii-smoke.mts`；`verify-pii-smoke` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-asset-r2.mts` | `verify-site-builder-asset-r2.mts`；`verify-site-builder-asset-r2` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-cleanup-r2.mts` | `verify-site-builder-cleanup-r2.mts`；`verify-site-builder-cleanup-r2` | 外部 0；自身 0；一并删除文件 1 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-egress.mts` | `verify-site-builder-egress.mts`；`verify-site-builder-egress` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-intake-idempotency.mts` | `verify-site-builder-intake-idempotency.mts`；`verify-site-builder-intake-idempotency` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-kb-r2.mts` | `verify-site-builder-kb-r2.mts`；`verify-site-builder-kb-r2` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-m0.mts` | `verify-site-builder-m0.mts`；`verify-site-builder-m0` | 外部 0；自身 2；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-m1a.mts` | `verify-site-builder-m1a.mts`；`verify-site-builder-m1a` | 外部 0；自身 3；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-m1b.mts` | `verify-site-builder-m1b.mts`；`verify-site-builder-m1b` | 外部 0；自身 3；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-mf0-a.mts` | `verify-site-builder-mf0-a.mts`；`verify-site-builder-mf0-a` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-mf0-b-cleanup.mts` | `verify-site-builder-mf0-b-cleanup.mts`；`verify-site-builder-mf0-b-cleanup` | 外部 0；自身 0；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-mf0-b-reconcile.mts` | `verify-site-builder-mf0-b-reconcile.mts`；`verify-site-builder-mf0-b-reconcile` | 外部 0；自身 0；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-mf0-b.mts` | `verify-site-builder-mf0-b.mts`；`verify-site-builder-mf0-b` | 外部 0；自身 0；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-profile-r2.mts` | `verify-site-builder-profile-r2.mts`；`verify-site-builder-profile-r2` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-r3-a.mts` | `verify-site-builder-r3-a.mts`；`verify-site-builder-r3-a` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-r3-b1.mts` | `verify-site-builder-r3-b1.mts`；`verify-site-builder-r3-b1` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-r3-b2-temporal.mts` | `verify-site-builder-r3-b2-temporal.mts`；`verify-site-builder-r3-b2-temporal` | 外部 0；自身 0；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-r3-b2.mts` | `verify-site-builder-r3-b2.mts`；`verify-site-builder-r3-b2` | 外部 0；自身 0；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-r4-a2.mts` | `verify-site-builder-r4-a2.mts`；`verify-site-builder-r4-a2` | 外部 0；自身 2；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-r4-b-min.mts` | `verify-site-builder-r4-b-min.mts`；`verify-site-builder-r4-b-min` | 外部 0；自身 0；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-renderer-sandbox.mts` | `verify-site-builder-renderer-sandbox.mts`；`verify-site-builder-renderer-sandbox` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-site-builder-temporal-idempotency.mts` | `verify-site-builder-temporal-idempotency.mts`；`verify-site-builder-temporal-idempotency` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |
| `apps/api/scripts/verify-structured-harvest.mts` | `verify-structured-harvest.mts`；`verify-structured-harvest` | 外部 0；自身 1；一并删除文件 0 | 删除：无保留方引用 |

## 归档与引用修正

表中引用文件采用改动后路径；“内部出链”指被归档文档自身指向未移动文件的相对链接调整。同目录共同移动的相对链接仍有效，无须改写；路径文字和 JSON 示例中的仓库相对路径亦同步修正。

| 原路径 | 新路径 | 修正的引用文件 |
| --- | --- | --- |
| `docs/superpowers/plans/2026-08-21-execution-authority-clock-readiness-correction.md` | `docs/archive/superpowers/plans/2026-08-21-execution-authority-clock-readiness-correction.md` | 无须修正的入链；原同目录相对引用随文件共同移动 |
| `docs/superpowers/plans/2026-08-21-execution-authority-cutover-verification.md` | `docs/archive/superpowers/plans/2026-08-21-execution-authority-cutover-verification.md` | `docs/implementation-records/execution-budget-authority-contract.md`；`docs/implementation-records/execution-budget-authority-cutover-task6.md` |
| `docs/superpowers/plans/2026-08-21-execution-budget-artifact-replay-program.md` | `docs/archive/superpowers/plans/2026-08-21-execution-budget-artifact-replay-program.md` | 无须修正的入链；原同目录相对引用随文件共同移动 |
| `docs/superpowers/plans/2026-08-21-execution-budget-authority.md` | `docs/archive/superpowers/plans/2026-08-21-execution-budget-authority.md` | 无须修正的入链；原同目录相对引用随文件共同移动 |
| `docs/superpowers/plans/2026-08-21-generic-operation-artifacts.md` | `docs/archive/superpowers/plans/2026-08-21-generic-operation-artifacts.md` | `docs/implementation-records/generic-operation-artifact-replay.md` |
| `docs/superpowers/plans/2026-08-21-generic-operation-domain-ack.md` | `docs/archive/superpowers/plans/2026-08-21-generic-operation-domain-ack.md` | 无须修正的入链；原同目录相对引用随文件共同移动 |
| `docs/superpowers/plans/2026-08-21-typed-projection-registry.md` | `docs/archive/superpowers/plans/2026-08-21-typed-projection-registry.md` | 无须修正的入链；原同目录相对引用随文件共同移动 |
| `docs/superpowers/plans/2026-08-29-global-product-program-phase0.md` | `docs/archive/superpowers/plans/2026-08-29-global-product-program-phase0.md` | `docs/adr/registry.md`；`docs/governance/conflict-register.md` |
| `docs/superpowers/plans/2026-08-30-discovery-governed-lineage-g3.md` | `docs/archive/superpowers/plans/2026-08-30-discovery-governed-lineage-g3.md` | `docs/archive/superpowers/plans/2026-08-30-discovery-governed-lineage-g3.md`（内部出链） |
| `docs/superpowers/plans/2026-08-30-discovery-lineage-g2-foundation.md` | `docs/archive/superpowers/plans/2026-08-30-discovery-lineage-g2-foundation.md` | `docs/archive/superpowers/plans/2026-08-30-discovery-lineage-g2-foundation.md`（内部出链） |
| `docs/superpowers/plans/2026-08-30-governed-subject-relation-foundation.md` | `docs/archive/superpowers/plans/2026-08-30-governed-subject-relation-foundation.md` | `docs/archive/superpowers/plans/2026-08-30-governed-subject-relation-foundation.md`（内部出链） |
| `docs/superpowers/plans/2026-08-30-trusted-approval-readback-local-foundation.md` | `docs/archive/superpowers/plans/2026-08-30-trusted-approval-readback-local-foundation.md` | `docs/superpowers/plans/2026-08-30-trusted-approval-readback-hosted-bootstrap.md` |
| `docs/superpowers/plans/2026-08-31-trusted-approval-current-head-review-remediation.md` | `docs/archive/superpowers/plans/2026-08-31-trusted-approval-current-head-review-remediation.md` | `docs/archive/superpowers/plans/2026-08-31-trusted-approval-current-head-review-remediation.md` |
| `docs/superpowers/plans/2026-08-31-trusted-approval-readback-review-remediation.md` | `docs/archive/superpowers/plans/2026-08-31-trusted-approval-readback-review-remediation.md` | `docs/archive/superpowers/plans/2026-08-31-trusted-approval-readback-review-remediation.md` |
| `docs/superpowers/plans/2026-08-31-trusted-approval-round3-remediation.md` | `docs/archive/superpowers/plans/2026-08-31-trusted-approval-round3-remediation.md` | `docs/archive/superpowers/plans/2026-09-01-approval-current-main-clock-closeout.md` |
| `docs/superpowers/plans/2026-09-01-approval-current-main-clock-closeout.md` | `docs/archive/superpowers/plans/2026-09-01-approval-current-main-clock-closeout.md` | `docs/archive/superpowers/plans/2026-09-01-approval-current-main-clock-closeout.md` |
| `docs/出海企业AI全球客户开发与增长执行平台_产品总体PRD_v3.0_完整评审稿.docx` | `docs/archive/出海企业AI全球客户开发与增长执行平台_产品总体PRD_v3.0_完整评审稿.docx` | 无须修正的入链；原同目录相对引用随文件共同移动 |
| `docs/出海企业AI全球客户开发与增长执行平台_产品总纲与产品手册_v3.0_完整评审稿.docx` | `docs/archive/出海企业AI全球客户开发与增长执行平台_产品总纲与产品手册_v3.0_完整评审稿.docx` | 无须修正的入链；原同目录相对引用随文件共同移动 |
| `docs/出海企业AI增长平台_总产品手册与PRD_v2.0_完整产品母本.docx` | `docs/archive/出海企业AI增长平台_总产品手册与PRD_v2.0_完整产品母本.docx` | 无须修正的入链；原同目录相对引用随文件共同移动 |

### 改动的引用文件总表

- `docs/adr/registry.md`
- `docs/governance/conflict-register.md`
- `docs/implementation-records/execution-budget-authority-contract.md`
- `docs/implementation-records/execution-budget-authority-cutover-task6.md`
- `docs/implementation-records/generic-operation-artifact-replay.md`
- `docs/archive/superpowers/plans/2026-08-30-discovery-governed-lineage-g3.md`
- `docs/archive/superpowers/plans/2026-08-30-discovery-lineage-g2-foundation.md`
- `docs/archive/superpowers/plans/2026-08-30-governed-subject-relation-foundation.md`
- `docs/superpowers/plans/2026-08-30-trusted-approval-readback-hosted-bootstrap.md`
- `docs/archive/superpowers/plans/2026-08-31-trusted-approval-current-head-review-remediation.md`
- `docs/archive/superpowers/plans/2026-08-31-trusted-approval-readback-review-remediation.md`
- `docs/archive/superpowers/plans/2026-09-01-approval-current-main-clock-closeout.md`

## 保留且原因

### 审批/readback 簇（Claude Code 复核后整组删除）

Codex 起草时按「拿不准就保留」保留了整组 `scripts/governance-approval-*`、`scripts/governance-github-readback-*`。Claude Code 复核后判定它是一个只在内部互相引用、从不运行的封闭簇，整组删除：

- **CI 与门禁不运行**：`.github/workflows/` 对这些脚本名以及 `approval-readback:test` 的命中都是 0；`pnpm governance:verify`、`pnpm docs:verify`、`gctl check` 都不调用它们。
- **簇外无代码依赖**：簇外的代码引用只有 `packages/code-intelligence` 治理提取器。它读取的是 `docs/governance/trusted-approval-readback.schema.json` 等 schema，不导入任何脚本，这些 schema 保留不动。
- **`approval-readback:test` 只服务本簇**：它列出的全是簇内 spec；唯一检查它的 `scripts/governance-approval-test-entry.spec.mjs` 也在簇内，一并删除。
- **CODEOWNERS 只有通配规则**（`/scripts/governance-*.mjs`），没有逐个路径绑定，删除不影响规则本身。
- **其余命中都是历史文档**：已归档或 SUPERSEDED 的计划、`docs/governance/trusted-approval-readback-spec.md` 中的命令示例。它们记录的是当时的实施，Git provenance 保留，不改写历史正文。
- **依据**：用户 2026-09-23 已批准「删除孤立代码（approval/readback 脚本簇）」。删除后 `pnpm governance:verify`、`pnpm docs:verify` 通过；`package.json` 改动后按规程重签 Copy fixed-source 指纹（`HASH_ONLY`，状态不变）。

### 其他 verify 候选（保留）

以下 `apps/api/scripts` 候选在 CI、代码或现行文档中仍有引用，按「零引用才删」保留。只被 changelog 或设计文档作为历史命令提及的也保留，不扩大本次删除范围。

| 保留文件 | 搜索关键字（文件名；基名） | 保留原因与引用例证 |
| --- | --- | --- |
| `apps/api/scripts/verify-app-database-principal.mts` | `verify-app-database-principal.mts`；`verify-app-database-principal` | 存在保留方引用：`.github/workflows/ci.yml:290`；`scripts/governance-ci-topology.spec.mjs:574` |
| `apps/api/scripts/verify-broker-closure.mts` | `verify-broker-closure.mts`；`verify-broker-closure` | 存在保留方引用：`docs/roadmap/changelog.md:473` |
| `apps/api/scripts/verify-candidate-assessment-fit.mts` | `verify-candidate-assessment-fit.mts`；`verify-candidate-assessment-fit` | 存在保留方引用：`docs/roadmap/changelog.md:432` |
| `apps/api/scripts/verify-companies-house.mts` | `verify-companies-house.mts`；`verify-companies-house` | 存在保留方引用：`docs/roadmap/changelog.md:508`；`docs/roadmap/decision-maker-p1-companies-house-design.md:82` |
| `apps/api/scripts/verify-contact-decline-honor.mts` | `verify-contact-decline-honor.mts`；`verify-contact-decline-honor` | 存在保留方引用：`docs/roadmap/changelog.md:539` |
| `apps/api/scripts/verify-cross-source-identity.mts` | `verify-cross-source-identity.mts`；`verify-cross-source-identity` | 存在保留方引用：`docs/roadmap/changelog.md:485`；`docs/roadmap/decision-maker-cross-source-identity-design.md:89` |
| `apps/api/scripts/verify-data-rights.mts` | `verify-data-rights.mts`；`verify-data-rights` | 存在保留方引用：`docs/implementation-records/storage-compliance-spec.md:140` |
| `apps/api/scripts/verify-deletion-orchestration.mts` | `verify-deletion-orchestration.mts`；`verify-deletion-orchestration` | 存在保留方引用：`docs/implementation-records/storage-compliance-spec.md:140`；`docs/roadmap/changelog.md:522` |
| `apps/api/scripts/verify-deletion-race-hardening.mts` | `verify-deletion-race-hardening.mts`；`verify-deletion-race-hardening` | 存在保留方引用：`docs/implementation-records/deletion-art17-residual-window.md:69` |
| `apps/api/scripts/verify-e2e-acquisition-funnel.mts` | `verify-e2e-acquisition-funnel.mts`；`verify-e2e-acquisition-funnel` | 存在保留方引用：`docs/status/pilot-readiness-gap-report.md:12` |
| `apps/api/scripts/verify-email-guess-backlog.mts` | `verify-email-guess-backlog.mts`；`verify-email-guess-backlog` | 存在保留方引用：`docs/roadmap/changelog.md:455`；`docs/roadmap/decision-maker-p0.4-mainchain-wiring-design.md:65` |
| `apps/api/scripts/verify-email-guess-persist.mts` | `verify-email-guess-persist.mts`；`verify-email-guess-persist` | 存在保留方引用：`docs/roadmap/decision-maker-multi-source-spec.md:90` |
| `apps/api/scripts/verify-email-guess.mts` | `verify-email-guess.mts`；`verify-email-guess` | 存在保留方引用：`docs/roadmap/changelog.md:455`；`docs/roadmap/decision-maker-multi-source-spec.md:89` |
| `apps/api/scripts/verify-email.mts` | `verify-email.mts`；`verify-email` | 存在保留方引用：`docs/roadmap/changelog.md:455`；`docs/roadmap/decision-maker-multi-source-spec.md:89` |
| `apps/api/scripts/verify-envelope.mts` | `verify-envelope.mts`；`verify-envelope` | 存在保留方引用：`docs/roadmap/changelog.md:464` |
| `apps/api/scripts/verify-external-intent-sweep.mts` | `verify-external-intent-sweep.mts`；`verify-external-intent-sweep` | 存在保留方引用：`docs/roadmap/changelog.md:364` |
| `apps/api/scripts/verify-google-patents-cache.mts` | `verify-google-patents-cache.mts`；`verify-google-patents-cache` | 存在保留方引用：`docs/roadmap/decision-maker-p1-patent-cache-design.md:38` |
| `apps/api/scripts/verify-google-patents.mts` | `verify-google-patents.mts`；`verify-google-patents` | 存在保留方引用：`apps/api/src/discovery/provider.registry.ts:363`；`docs/roadmap/decision-maker-p1-google-patents-inventor-design.md:7` |
| `apps/api/scripts/verify-icp-to-cpv.mts` | `verify-icp-to-cpv.mts`；`verify-icp-to-cpv` | 存在保留方引用：`docs/roadmap/changelog.md:342` |
| `apps/api/scripts/verify-icp-to-fda.mts` | `verify-icp-to-fda.mts`；`verify-icp-to-fda` | 存在保留方引用：`docs/roadmap/changelog.md:354` |
| `apps/api/scripts/verify-inpi-rne.mts` | `verify-inpi-rne.mts`；`verify-inpi-rne` | 存在保留方引用：`docs/roadmap/decision-maker-multi-source-spec.md:88`；`docs/roadmap/decision-maker-p1-inpi-rne-dirigeant-design.md:113` |
| `apps/api/scripts/verify-intent-loop.mts` | `verify-intent-loop.mts`；`verify-intent-loop` | 存在保留方引用：`docs/implementation-records/openfda-provider-spec.md:247`；`docs/implementation-records/ted-provider-spec.md:319` |
| `apps/api/scripts/verify-intent.mts` | `verify-intent.mts`；`verify-intent` | 存在保留方引用：`docs/implementation-records/openfda-provider-spec.md:247`；`docs/implementation-records/ted-provider-spec.md:319` |
| `apps/api/scripts/verify-openfda-510k-intent.mts` | `verify-openfda-510k-intent.mts`；`verify-openfda-510k-intent` | 存在保留方引用：`apps/api/src/intent/openfda-intent-projection.spec.ts:7`；`docs/roadmap/changelog.md:355` |
| `apps/api/scripts/verify-openfda-discovery.mts` | `verify-openfda-discovery.mts`；`verify-openfda-discovery` | 存在保留方引用：`docs/roadmap/changelog.md:353`；`apps/api/scripts/verify-icp-to-fda.mts:77` |
| `apps/api/scripts/verify-outbox-delivery.mts` | `verify-outbox-delivery.mts`；`verify-outbox-delivery` | 存在保留方引用：`docs/roadmap/changelog.md:443` |
| `apps/api/scripts/verify-patent-cache-codex-p93.mts` | `verify-patent-cache-codex-p93.mts`；`verify-patent-cache-codex-p93` | 存在保留方引用：`docs/implementation-records/patent-cache-codex-p93-fixes.md:54` |
| `apps/api/scripts/verify-runtime-lease-prisma-compatibility.mts` | `verify-runtime-lease-prisma-compatibility.mts`；`verify-runtime-lease-prisma-compatibility` | 存在保留方引用：`.github/workflows/ci.yml:288`；`scripts/governance-ci-topology.spec.mjs:572` |
| `apps/api/scripts/verify-sam-sources-sought.mts` | `verify-sam-sources-sought.mts`；`verify-sam-sources-sought` | 存在保留方引用：`docs/roadmap/sam-sources-sought-p4-design.md:84` |
| `apps/api/scripts/verify-sanctions-screening.mts` | `verify-sanctions-screening.mts`；`verify-sanctions-screening` | 存在保留方引用：`docs/roadmap/sanctions-screening-design.md:105` |
| `apps/api/scripts/verify-signal-first.mts` | `verify-signal-first.mts`；`verify-signal-first` | 存在保留方引用：`docs/roadmap/changelog.md:497` |
| `apps/api/scripts/verify-site-builder-m1.mts` | `verify-site-builder-m1.mts`；`verify-site-builder-m1` | 存在保留方引用：`apps/api/package.json:17`；`apps/site-builder-eval-runner/src/catalog.ts:89` |
| `apps/api/scripts/verify-site-builder-m1c.mts` | `verify-site-builder-m1c.mts`；`verify-site-builder-m1c` | 存在保留方引用：`docs/site-builder/09-m1-implementation-design.md:150`；`apps/api/scripts/verify-site-builder-m1.mts:477` |
| `apps/api/scripts/verify-site-builder-m1d.mts` | `verify-site-builder-m1d.mts`；`verify-site-builder-m1d` | 存在保留方引用：`docs/implementation-records/site-builder-m1d-copy.md:53`；`apps/api/scripts/verify-site-builder-m1.mts:483` |
| `apps/api/scripts/verify-site-builder-m1eb.mts` | `verify-site-builder-m1eb.mts`；`verify-site-builder-m1eb` | 存在保留方引用：`apps/api/scripts/verify-site-builder-m1.mts:527` |
| `apps/api/scripts/verify-site-builder-m1f-replay.mts` | `verify-site-builder-m1f-replay.mts`；`verify-site-builder-m1f-replay` | 存在保留方引用：`docs/evidence/site-builder/m1-f-temporal-verification-20260724.json:118` |
| `apps/api/scripts/verify-site-builder-m1f-temporal.mts` | `verify-site-builder-m1f-temporal.mts`；`verify-site-builder-m1f-temporal` | 存在保留方引用：`docs/evidence/site-builder/m1-f-temporal-verification-20260724.json:119`；`apps/api/scripts/verify-site-builder-m1.mts:489` |
| `apps/api/scripts/verify-site-builder-r4-a1.mts` | `verify-site-builder-r4-a1.mts`；`verify-site-builder-r4-a1` | 存在保留方引用：`apps/api/src/site-builder/evidence-migration-integrity.spec.ts:32` |
| `apps/api/scripts/verify-ted-discovery.mts` | `verify-ted-discovery.mts`；`verify-ted-discovery` | 存在保留方引用：`docs/roadmap/changelog.md:342` |
| `apps/api/scripts/verify-ted-intent.mts` | `verify-ted-intent.mts`；`verify-ted-intent` | 存在保留方引用：`docs/roadmap/changelog.md:343` |

### 未移动的历史文档与计划

| 文件 | 保留原因 |
| --- | --- |
| `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.1.md` | 被机器路径钉住：`docs/governance/docs-verification-policy.json:73,179`；保留原路径，不修改机器合同 |
| `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md` | 被机器路径钉住：`docs/governance/docs-verification-policy.json:74,183`；保留原路径，不修改机器合同 |
| `docs/superpowers/plans/2026-08-29-discovery-query-lineage-foundation.md` | 被机器路径钉住：`scripts/governance-contracts.spec.mjs:260`；保留原路径，不修改机器合同 |
| `docs/superpowers/plans/2026-08-30-discovery-lineage-g0-closeout.md` | 被机器路径钉住：`scripts/governance-contracts.spec.mjs:279`；保留原路径，不修改机器合同 |
| `docs/superpowers/plans/2026-08-30-discovery-company-materialization-ctx.md` | 头部生命周期为 `SUPERSEDED`，不在本次 CLOSED 归档范围 |
| `docs/superpowers/plans/2026-08-30-program-c-adr-trusted-acceptance.md` | 头部生命周期为 `SUPERSEDED`，不在本次 CLOSED 归档范围 |
| `docs/superpowers/plans/2026-08-30-trusted-approval-readback-hosted-bootstrap.md` | 头部生命周期为 `REFERENCE_ONLY`，不在本次 CLOSED 归档范围 |
| `docs/superpowers/plans/2026-09-13-platform-revocation-recovery-approved-spec.md` | 头部生命周期为 `APPROVED`，不在本次 CLOSED 归档范围 |
| `docs/superpowers/plans/2026-09-13-platform-revocation-recovery-implementation.md` | 头部生命周期为 `APPROVED`，不在本次 CLOSED 归档范围 |
| `docs/superpowers/plans/2026-09-19-platform-machine-runtime-approved-spec.md` | 头部生命周期为 `APPROVED`，不在本次 CLOSED 归档范围 |

## Claude Code 复核与验证边界

- 核对当前分支、writer、工作区原有差异与本次文件清单；本任务按明确约束未运行 `worktree:inventory` 或 Git。
- 运行仓库要求的 `pnpm governance:verify`、`pnpm docs:verify` 与适用的 ContractGraph/安全检查，特别检查归档目录的链接扫描、生命周期和历史 provenance 约束；本任务未运行这些命令，不声称它们已通过。
- 复核删除集合没有动态构造脚本名或未显式列名的外部调用；零引用结论限于当前仓库静态文本，不证明仓外无人使用。
- 审批组与 `approval-readback:test`：已复核，按上节理由整组删除。
- 确认两份 Site Builder 文档、两份测试钉住的 CLOSED 计划仍在原处，机器 JSON 与 CODEOWNERS 未改动。
- 确认 3 个 Word 仅移动且字节一致，16 个计划的历史内容与生命周期未重写；引用变更仅涉及目的地或相对目录层级。
- 本证据保留旧路径作为来源字段，不是待修复链接；不要为消除旧路径搜索命中而改写审计来源。

## 已完成的静态检查

以下由 Python 直接读取工作区文件完成，未执行项目测试：

- 31 个删除目标均已不存在；所有保留候选和 4 个被机器路径钉住的文档仍在原路径。
- 19 个归档目标均已存在、原路径均已移走；其中 13 个文件字节完全不变（包含全部 3 个 Word），其余 6 个计划仅修正引用；16 个计划头部仍为 `CLOSED`。
- 12 个已有文档发生引用修正；逐项文本差异复核没有引入其他内容修改。
- 对归档 Markdown、引用修改文档和归档 README 检查了 74 个本地 Markdown 链接，目标文件均存在；其中 12 处改写的 Markdown 链接仍指向映射后的同一对象，fragment 保持不变。未独立验证所有历史 fragment，留给 `docs:verify`。
- 排除本证据新增审计文字后，保留文本中对已删除脚本基名的命中为 0。
- 排除本证据与归档 README 的“原路径”来源字段后，保留文本中对 19 个旧完整路径的命中为 0。

上述检查不替代项目治理、文档、ContractGraph、安全或 CI 校验；提交由 Claude Code 完成。
