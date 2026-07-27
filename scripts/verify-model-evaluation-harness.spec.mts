import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BRAND_PROFILE_TASK } from "../apps/api/src/site-builder/agents/brand-profile";
import {
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from "../apps/api/src/site-builder/eval/brand-profile-eval";
import {
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

test("a missing harness id fails documentation verification", async () => {
  const documents = await currentDocuments();
  documents["docs/status/current.md"] = documents[
    "docs/status/current.md"
  ].replace(
    "site-builder-model-evaluation-harness/2026-07-27-v1",
    "missing-harness-id",
  );
  assert.throws(
    () => verifyModelEvaluationHarness(documents),
    /docs\/status\/current\.md must reference the current evaluation harness id/,
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
