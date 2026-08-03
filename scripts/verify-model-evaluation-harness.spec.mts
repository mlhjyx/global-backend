import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BRAND_PROFILE_TASK } from "../apps/api/src/site-builder/agents/brand-profile";
import { DESIGN_SPEC_TASK } from "../apps/api/src/site-builder/design/design-brief-producer";
import {
  QA_SUMMARIZE_TASK,
  SEO_REVIEW_TASK,
} from "../apps/api/src/site-builder/quality/quality-narrative";
import {
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from "../apps/api/src/site-builder/eval/brand-profile-eval";
import {
  DESIGN_SPEC_EVAL_FIXTURES,
  prepareDesignSpecEvalFixture,
} from "../apps/api/src/site-builder/eval/design-spec-eval";
import {
  QUALITY_NARRATIVE_EVAL_FIXTURES,
  prepareQualityNarrativeEvalFixture,
} from "../apps/api/src/site-builder/eval/quality-narrative-eval";
import { DESIGN_SPEC_EVALUATION_MANIFEST_PREP_ID } from "../apps/api/src/site-builder/eval/design-spec-evaluation-manifest-prep";
import {
  SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "../apps/api/src/site-builder/eval/model-evaluation-harness";
import {
  sha256CanonicalJson,
  sha256Text,
} from "../apps/api/src/site-builder/eval/eval-provenance";
import {
  MODEL_EVALUATION_HARNESS_DOCUMENTS,
  verifyModelEvaluationHarness,
} from "./verify-model-evaluation-harness.mts";

async function currentDocuments(): Promise<
  Record<(typeof MODEL_EVALUATION_HARNESS_DOCUMENTS)[number], string>
> {
  return Object.fromEntries(
    await Promise.all(
      MODEL_EVALUATION_HARNESS_DOCUMENTS.map(async (path) => [
        path,
        await readFile(path, "utf8"),
      ]),
    ),
  ) as Record<(typeof MODEL_EVALUATION_HARNESS_DOCUMENTS)[number], string>;
}

test("task plans and authoritative documents bind the current harness", async () => {
  const documents = await currentDocuments();
  assert.doesNotThrow(() => verifyModelEvaluationHarness(documents));
});

test("the canonical suite pins the committed fixture and prompt fingerprints", async () => {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const suite = plan.evaluationSuite;
  assert.ok(suite);
  assert.deepEqual(
    suite.fixtureFingerprints.map((entry) => entry.fixtureId),
    suite.fixtureIds,
  );
  assert.deepEqual(
    suite.sourceBundleFiles
      .filter((entry) => entry.role === "candidate_baseline")
      .map((entry) => entry.path),
    [
      "apps/api/src/site-builder/agents/model-candidate-baseline.ts",
      "apps/api/src/site-builder/agents/model-candidate-baseline.json",
    ],
  );
  assert.ok(
    suite.sourceBundleFiles.some(
      (entry) =>
        entry.role === "claim_fact_key" &&
        entry.path === "apps/api/src/site-builder/claim-fact-key.ts",
    ),
    "BrandProfile evaluation source bundle must pin the claim fact-key logic",
  );
  assert.equal(
    suite.adapterId,
    "site-builder.brand-profile-evaluation-adapter/v2",
  );
  assert.equal(
    suite.sourceBundleContractId,
    "brand-profile-evaluation-source-bundle/v7",
  );
  assert.ok(
    suite.sourceBundleFiles.every(
      (entry) =>
        !entry.path.includes("/dist/") &&
        !entry.path.startsWith("/") &&
        !entry.path.split("/").includes(".."),
    ),
    "fixed-commit source bundle must contain only tracked source paths",
  );
  assert.ok(
    suite.sourceBundleFiles.some(
      (entry) =>
        entry.role === "evaluation_executor" &&
        entry.path ===
          "apps/api/src/site-builder/eval/model-evaluation-executor.ts",
    ),
    "BrandProfile evaluation source bundle must pin the protocol executor",
  );
  assert.ok(
    suite.sourceBundleFiles.some(
      (entry) =>
        entry.role === "evaluation_cost_safety" &&
        entry.path ===
          "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts",
    ),
    "BrandProfile evaluation source bundle must pin cost safety",
  );
  assert.ok(
    suite.sourceBundleFiles.some(
      (entry) =>
        entry.role === "evidence_preparation" &&
        entry.path ===
          "apps/api/src/site-builder/eval/model-evaluation-evidence-prep.ts",
    ),
    "BrandProfile evaluation source bundle must pin evidence preparation",
  );
  for (const fingerprint of suite.fixtureFingerprints) {
    const fixture = JSON.parse(
      await readFile(
        `apps/api/test/fixtures/golden-companies/brand-profile/${fingerprint.fixtureId}.json`,
        "utf8",
      ),
    ) as BrandProfileEvalFixture;
    const prepared = prepareBrandProfileEvalFixture(fixture);
    assert.equal(
      sha256CanonicalJson(fixture),
      fingerprint.fixtureSha256,
      `${fingerprint.fixtureId} fixture fingerprint drifted`,
    );
    assert.equal(
      sha256Text(BRAND_PROFILE_TASK.buildPrompt(prepared.input)),
      fingerprint.promptSha256,
      `${fingerprint.fixtureId} prompt fingerprint drifted`,
    );
    const evaluationCase = buildCanonicalModelEvaluationCase(
      plan,
      fingerprint.fixtureId,
    );
    assert.deepEqual(evaluationCase.payload.fixture, fixture);
    assert.deepEqual(evaluationCase.payload.taskInput, prepared.input);
    assert.equal(
      evaluationCase.payload.prompt,
      BRAND_PROFILE_TASK.buildPrompt(prepared.input),
    );
    assert.equal(
      evaluationCase.contract.sourceBundleSha256,
      sha256CanonicalJson(evaluationCase.payload.sourceFiles),
      `${fingerprint.fixtureId} dispatched source bundle is not hash-bound`,
    );
    assert.equal(
      evaluationCase.payload.sourceFiles.length,
      suite.sourceBundleFiles.length,
    );
  }
});

test("the design_spec suite pins all six sparse/rich catalog pairs", () => {
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const suite = plan.evaluationSuite;
  assert.ok(suite);
  assert.equal(suite.fixtureIds.length, 12);
  assert.equal(suite.repeats, 2);
  assert.equal(DESIGN_SPEC_EVAL_FIXTURES.length, 12);
  assert.equal(
    DESIGN_SPEC_EVAL_FIXTURES.filter(({ mode }) => mode === "sparse").length,
    6,
  );
  assert.equal(
    DESIGN_SPEC_EVAL_FIXTURES.filter(({ mode }) => mode === "rich").length,
    6,
  );
  for (const fingerprint of suite.fixtureFingerprints) {
    const fixture = DESIGN_SPEC_EVAL_FIXTURES.find(
      ({ fixtureId }) => fixtureId === fingerprint.fixtureId,
    );
    assert.ok(fixture);
    const prepared = prepareDesignSpecEvalFixture(fixture);
    assert.equal(
      sha256CanonicalJson(fixture),
      fingerprint.fixtureSha256,
      `${fingerprint.fixtureId} fixture fingerprint drifted`,
    );
    assert.equal(
      sha256Text(DESIGN_SPEC_TASK.buildPrompt(prepared.input)),
      fingerprint.promptSha256,
      `${fingerprint.fixtureId} prompt fingerprint drifted`,
    );
    const evaluationCase = buildCanonicalModelEvaluationCase(
      plan,
      fingerprint.fixtureId,
    );
    assert.deepEqual(evaluationCase.payload.fixture, fixture);
    assert.deepEqual(evaluationCase.payload.taskInput, prepared.input);
    assert.equal(
      evaluationCase.payload.prompt,
      DESIGN_SPEC_TASK.buildPrompt(prepared.input),
    );
  }
});

test("QA and SEO suites pin closed quality-narrative fixtures and prompts", () => {
  for (const taskId of [
    "site_builder.qa_summarize",
    "site_builder.seo_review",
  ] as const) {
    const plan = buildTaskEvaluationPlan(taskId);
    const suite = plan.evaluationSuite;
    assert.ok(suite);
    assert.equal(suite.fixtureIds.length, 2);
    assert.equal(suite.repeats, 2);
    assert.deepEqual(suite.legacyComparatorAliases, []);
    assert.equal(
      suite.sourceBundleContractId,
      "quality-narrative-evaluation-source-bundle/v1",
    );
    for (const fingerprint of suite.fixtureFingerprints) {
      const fixture = QUALITY_NARRATIVE_EVAL_FIXTURES.find(
        (entry) => entry.fixtureId === fingerprint.fixtureId,
      );
      assert.ok(fixture);
      assert.equal(fixture.taskId, taskId);
      const prepared = prepareQualityNarrativeEvalFixture(fixture);
      const task =
        taskId === "site_builder.qa_summarize"
          ? QA_SUMMARIZE_TASK
          : SEO_REVIEW_TASK;
      assert.equal(
        sha256CanonicalJson(fixture),
        fingerprint.fixtureSha256,
        `${fingerprint.fixtureId} fixture fingerprint drifted`,
      );
      assert.equal(
        sha256Text(task.buildPrompt(prepared.input)),
        fingerprint.promptSha256,
        `${fingerprint.fixtureId} prompt fingerprint drifted`,
      );
      const evaluationCase = buildCanonicalModelEvaluationCase(
        plan,
        fingerprint.fixtureId,
      );
      assert.deepEqual(evaluationCase.payload.fixture, fixture);
      assert.deepEqual(evaluationCase.payload.taskInput, prepared.input);
      assert.equal(
        evaluationCase.payload.prompt,
        task.buildPrompt(prepared.input),
      );
    }
  }
});

test("a missing harness id fails documentation verification", async () => {
  const documents = await currentDocuments();
  for (const path of MODEL_EVALUATION_HARNESS_DOCUMENTS) {
    if (path === "docs/site-builder/model-evaluation-harness.md") continue;
    documents[path] = documents[path].replaceAll(
      SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
      "missing-harness-id",
    );
  }
  assert.throws(
    () => verifyModelEvaluationHarness(documents),
    /AGENTS\.md must reference the current evaluation harness id/,
  );
});

test("a missing candidate baseline id fails documentation verification", async () => {
  const documents = await currentDocuments();
  documents["docs/site-builder/08-eval-testing.md"] = documents[
    "docs/site-builder/08-eval-testing.md"
  ].replaceAll(
    "site-builder-model-candidate-baseline/2026-07-27-v1",
    "missing-candidate-baseline-id",
  );
  assert.throws(
    () => verifyModelEvaluationHarness(documents),
    /08-eval-testing\.md must reference the current candidate baseline id/,
  );
});

test("a missing cost safety id fails documentation verification", async () => {
  const documents = await currentDocuments();
  documents["docs/architecture/current.md"] = documents[
    "docs/architecture/current.md"
  ].replaceAll(
    "site-builder-model-evaluation-cost-safety/2026-07-30-v2",
    "missing-cost-safety-id",
  );
  assert.throws(
    () => verifyModelEvaluationHarness(documents),
    /architecture\/current\.md must reference the current evaluation cost safety id/,
  );
});

test("a missing design_spec manifest prep id fails documentation verification", async () => {
  const documents = await currentDocuments();
  documents["docs/roadmap/release-plan.md"] = documents[
    "docs/roadmap/release-plan.md"
  ].replaceAll(
    DESIGN_SPEC_EVALUATION_MANIFEST_PREP_ID,
    "missing-design-spec-manifest-prep-id",
  );
  assert.throws(
    () => verifyModelEvaluationHarness(documents),
    /release-plan\.md must reference the current design_spec manifest prep id/,
  );
});

test("a hand-edited task envelope fails the generated baseline mirror", async () => {
  const documents = await currentDocuments();
  documents["docs/site-builder/model-evaluation-harness.md"] = documents[
    "docs/site-builder/model-evaluation-harness.md"
  ].replace("| 3000 | 90s |", "| 3000 | 91s |");
  assert.throws(
    () => verifyModelEvaluationHarness(documents),
    /must exactly match the generated harness baseline/,
  );
});
