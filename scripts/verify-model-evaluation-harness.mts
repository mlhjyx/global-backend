import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
} from "../apps/api/src/site-builder/agents/model-candidate-baseline";
import {
  getSiteBuilderTaskRouteBinding,
  SITE_BUILDER_TASK_IDS,
} from "../apps/api/src/site-builder/agents/task-route-bindings";
import {
  SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
  buildAllTaskEvaluationPlans,
} from "../apps/api/src/site-builder/eval/model-evaluation-harness";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MODEL_EVALUATION_HARNESS_REFERENCE_DOCUMENTS = Object.freeze([
  "AGENTS.md",
  "docs/status/current.md",
  "docs/roadmap/release-plan.md",
  "docs/architecture/current.md",
  "docs/site-builder/08-eval-testing.md",
] as const);
export const MODEL_EVALUATION_HARNESS_BASELINE_DOCUMENT =
  "docs/site-builder/model-evaluation-harness.md" as const;
export const MODEL_EVALUATION_HARNESS_DOCUMENTS = Object.freeze([
  ...MODEL_EVALUATION_HARNESS_REFERENCE_DOCUMENTS,
  MODEL_EVALUATION_HARNESS_BASELINE_DOCUMENT,
] as const);

type HarnessDocumentPath = (typeof MODEL_EVALUATION_HARNESS_DOCUMENTS)[number];

function code(value: string | number): string {
  return `\`${value}\``;
}

function seconds(milliseconds: number): string {
  return `${milliseconds / 1000}s`;
}

export function renderModelEvaluationHarnessBaseline(): string {
  const plans = buildAllTaskEvaluationPlans();
  const rows = plans.map((plan) => {
    const suite = plan.evaluationSuite;
    return `| ${code(plan.taskId)} | ${code(plan.profile)} | ${code(plan.dispatchAdmission)} | ${suite ? code(suite.suiteId) : "—"} | ${plan.candidates.map((candidate) => `${code(candidate.alias)} / ${code(candidate.expectedProtocol)}`).join("<br>")} | ${plan.envelope.maxTokens} | ${seconds(plan.envelope.runtimeDeadlineMs)} | ${seconds(plan.envelope.diagnosticObservationMs)} | ${seconds(plan.envelope.hardStopMs)} | ${plan.envelope.perCallCostCapCents}¢ | ${plan.envelope.reasoningEffort ?? "—"} |`;
  });
  const brandSuite = plans.find(
    (plan) => plan.taskId === "site_builder.brand_profile",
  )?.evaluationSuite;
  assert.ok(brandSuite, "BrandProfile canonical evaluation suite is required");

  return [
    "# Site Builder 模型评测 Harness 基线",
    "",
    `> 机器合同：${code(SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID)}；候选来源：${code(SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID)}。本文件由代码计划生成并由 ${code("pnpm docs:verify")} 精确校验，不得手抄另一个任务矩阵。`,
    "",
    "## 范围",
    "",
    "- 这是离线、未接生产依赖的内存合同；没有真实模型请求、评测 evidence、运行路由或发布行为。",
    "- 7 个 task 都有候选与生产 envelope 计划；只有具备 canonical task contract、fixture set、重复次数和 evaluator 的 task 才允许 dispatch。",
    "- 当前唯一可 dispatch suite 是 BrandProfile；其余 6 个 task fail-closed 为 `blocked_no_evaluation_suite`。媒体、无 task consumer、preview、deferred 与 legacy-only 候选继续由 candidate baseline 阻断。",
    "",
    "## Task 计划",
    "",
    "| task | profile | dispatch | canonical suite | candidate / protocol | max tokens | runtime deadline | diagnostic window | hard stop | per-call cap | reasoning |",
    "|---|---|---|---|---|---:|---:|---:|---:|---:|---|",
    ...rows,
    "",
    "## Canonical suite",
    "",
    `- suite：${code(brandSuite.suiteId)}`,
    `- adapter：${code(brandSuite.adapterId)}`,
    `- task contract：${code(brandSuite.taskContractId)} / prompt ${code(brandSuite.promptVersion)} / route validation ${code(brandSuite.routeValidationVersion)}；dispatch 同时绑定冻结 output schema 与 ${code(`repairTaskOutput=${brandSuite.repairTaskOutput}`)}`,
    `- fixture set：${code(brandSuite.fixtureSetId)}；schema ${code(brandSuite.fixtureSchemaVersion)}；${brandSuite.fixtureIds.length} fixtures × ${brandSuite.repeats} repeats = ${brandSuite.fixtureIds.length * brandSuite.repeats} runs/model`,
    `- fixtures：${brandSuite.fixtureIds.map(code).join("、")}`,
    `- source bundle contract：${code(brandSuite.sourceBundleContractId)}；固定 ${brandSuite.sourceBundleFiles.length} 份仓库内源码/合同文件，路径条目深度冻结且禁止绝对/逃逸路径，同一比较组必须固定为一个 source bundle SHA-256，且每次调用完成后必须重新指纹`,
    "- dispatch payload：fixture、prepared task input、prompt 与 source fingerprints 全部由 canonical case builder 构造、冻结并纳入 case SHA-256；executor 不能替换为未绑定内容。",
    "- capability probe：baseline 标记为 probe-required 的候选只能由 harness-owned campaign 发起 canonical task-shaped probe；probe 与矩阵共享预算，绑定 harness/baseline/task/candidate/protocol/source scope，只有协议、requested/reported/resolved identity、完整输出、schema/生产 PII gate、usage、成本结算和调用后 source re-fingerprint 全部闭合才生成 attestation。run/summary/ranker 只信模块私有 WeakSet、私有 campaign 状态与捕获的原型读取器，裸 observation、duck-typed object、不同预算 campaign 或公开字段 self-hash 均不能解锁。本 PR 仅保证同进程内存信任；后续持久 evidence 必须另建 create-only/signed trust anchor，不能复用 self-hash 冒充验真。",
    `- evaluator：${code(brandSuite.evaluatorVersion)}；rubric SHA-256 ${code(brandSuite.evaluatorRubricSha256)}；harness 内部依次执行 output schema、生产 ${code("validateOutput")} 与 canonical task rubric，不接受 caller 自带 grader。`,
    "",
    "## 闭合结果与排序",
    "",
    "- 结果类：`quality_valid_runtime_on_time`、`quality_valid_runtime_late`、`content_invalid`、`protocol_or_identity_invalid`、`provenance_invalid`、`capability_unavailable`、`diagnostic_window_exhausted`、`budget_stop`。",
    "- 单次 runtime deadline 只把结果标记为 late 并保留质量观察；候选 accepted-artifact P95 超过生产 deadline 时不得 rankable/晋级。hard stop 才中止，使用 monotonic clock 记录实际耗时，异常时钟 fail-closed，且 hard-stop 后观测到的完成不能回写成质量有效。",
    "- 先按 quality → structure → factuality → fixture 内 stability；通过生产 P95 硬门后，再按 accepted-artifact P95 latency → 全部已结算尝试成本/accepted artifact 排序。",
    "- matrix 必须精确等于 suite 的 fixtureIds × repeats；缺失、意外或重复 key 均不可排名；超出 repeats 的尝试在 dispatch 前拒绝；ranker 只接受 plan + raw runs 并在内部重新生成 summary。",
    "",
    "## 预算与 provenance",
    "",
    "- 每次调用先 reserve campaign/per-call 上界；budget guard 使用模块私有 WeakSet 品牌、JavaScript 私有状态与捕获的 reserve/settle 原型方法，duck/Proxy budget 或实例/prototype monkeypatch 都不能绕过。unknown 或 malformed settlement 保留上界并冻结后续 dispatch。`rejected_before_dispatch` 只允许本地 reserve 拒绝路径，probe/matrix 在 executor 进入后声称该 reason 一律归 unknown 并冻结；当前调用超过 per-call cap 时保留质量观察，但标记预算硬失败并不可排名。",
    "- 每个 run 固定保存 expected/actual protocol、requested/reported/resolved model、resolution source、usage source/call count、cost basis，以及 task contract、fixture、prompt、source bundle contract/source bundle、evaluator rubric 和所需 capability-probe attestation。原始 artifact 只有先通过 output schema 与生产 PII/route gate 才可保留；被拒绝输出只留 SHA-256 digest 与拒绝原因，不把 PII/schema-invalid 原文写入 evidence。汇总时重新执行 canonical evaluator，不信任记录中的通过标志。",
    "- 可用性、协议、身份、probe attestation、usage、artifact fingerprint、matrix、生产 P95、预算和成本任一未闭合，都不能生成可晋级排名。",
    "",
  ].join("\n");
}

export function verifyModelEvaluationHarness(
  documents: Readonly<Record<HarnessDocumentPath, string>>,
): void {
  const plans = buildAllTaskEvaluationPlans();
  assert.deepEqual(
    plans.map((plan) => plan.taskId),
    [...SITE_BUILDER_TASK_IDS],
    "evaluation harness must cover every current Site Builder task in canonical order",
  );
  assert.deepEqual(
    plans
      .filter((plan) => plan.dispatchAdmission === "task_evaluation_ready")
      .map((plan) => plan.taskId),
    ["site_builder.brand_profile"],
    "only tasks with a canonical task/fixture/evaluator suite may dispatch",
  );

  for (const plan of plans) {
    assert.equal(
      plan.candidateBaselineId,
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
      `${plan.taskId} plan must bind the current candidate baseline`,
    );
    const taskPool =
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.taskEvaluationPools.find(
        (entry) => entry.taskId === plan.taskId,
      );
    assert.ok(taskPool, `${plan.taskId} must exist in the machine baseline`);
    const profilePool =
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools.find(
        (entry) => entry.profile === taskPool.profile,
      );
    assert.ok(
      profilePool,
      `${plan.taskId} profile must exist in the machine baseline`,
    );
    assert.deepEqual(
      plan.candidates.map((candidate) => ({
        alias: candidate.alias,
        expectedProtocol: candidate.expectedProtocol,
      })),
      profilePool.candidates.map((candidate) => ({
        alias: candidate.alias,
        expectedProtocol: candidate.expectedProtocol,
      })),
      `${plan.taskId} candidate order and protocol must match the machine baseline`,
    );

    const binding = getSiteBuilderTaskRouteBinding(plan.taskId);
    assert.deepEqual(
      plan.envelope,
      {
        maxTokens: binding.maxTokens,
        runtimeDeadlineMs: binding.timeoutMs,
        diagnosticObservationMs: binding.timeoutMs,
        hardStopMs: binding.timeoutMs * 2,
        perCallCostCapCents: binding.maxCostCents,
        reasoningEffort: binding.reasoningEffort ?? null,
      },
      `${plan.taskId} must derive its production and diagnostic envelope from the task binding`,
    );
  }

  assert.equal(
    documents[MODEL_EVALUATION_HARNESS_BASELINE_DOCUMENT],
    renderModelEvaluationHarnessBaseline(),
    `${MODEL_EVALUATION_HARNESS_BASELINE_DOCUMENT} must exactly match the generated harness baseline`,
  );

  for (const path of MODEL_EVALUATION_HARNESS_REFERENCE_DOCUMENTS) {
    const document = documents[path];
    assert.ok(document, `${path} must be supplied to the harness verifier`);
    assert.match(
      document,
      new RegExp(
        SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID.replaceAll(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        ),
      ),
      `${path} must reference the current evaluation harness id`,
    );
    assert.match(
      document,
      new RegExp(
        SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID.replaceAll(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        ),
      ),
      `${path} must reference the current candidate baseline id`,
    );
  }
}

async function readHarnessDocuments(): Promise<
  Record<HarnessDocumentPath, string>
> {
  return Object.fromEntries(
    await Promise.all(
      MODEL_EVALUATION_HARNESS_DOCUMENTS.map(async (path) => [
        path,
        await readFile(resolve(REPO_ROOT, path), "utf8"),
      ]),
    ),
  ) as Record<HarnessDocumentPath, string>;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyModelEvaluationHarness(await readHarnessDocuments());
  console.log(
    `model evaluation harness PASS — ${SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID}`,
  );
}
