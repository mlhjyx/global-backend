import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { assertModelOutputSchemaCompiles } from "../../model-gateway/schema-validate";
import type { VisionReviewImage } from "../../model-gateway/types";
import { preflightVisionReviewInput } from "../../model-gateway/vision-review-input";
import {
  AESTHETIC_DIMENSIONS,
  AESTHETIC_REVIEW_OUTPUT_SCHEMA,
  assertAestheticReviewOutput,
  degradeAestheticScreenshot,
  evaluateAestheticCaseOutput,
  loadAestheticEvalCases,
  type AestheticEvalCase,
  type AestheticReviewOutput,
} from "./aesthetic-review-eval";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validOutput(
  images: readonly VisionReviewImage[],
): AestheticReviewOutput {
  return {
    verdict: "passed",
    overallScore: 90,
    dimensions: Object.fromEntries(
      AESTHETIC_DIMENSIONS.map((dimension) => [dimension, 90]),
    ) as AestheticReviewOutput["dimensions"],
    findings: [
      {
        severity: "minor",
        ruleCode: "AESTHETIC_ORIGINALITY",
        target: {
          locale: "en",
          pageId: images[0].target.pageId,
          breakpoint: images[0].target.breakpoint,
        },
        evidenceRef: { artifactId: images[0].artifactId },
      },
    ],
  };
}

function clone(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

describe("M1-f aesthetic MODEL-1 fixtures", () => {
  it("loads six approved/degraded pairs with three bounded verified PNGs each", async () => {
    const cases = await loadAestheticEvalCases(repositoryRoot);
    expect(cases).toHaveLength(12);
    expect(cases.filter((item) => item.kind === "approved")).toHaveLength(6);
    expect(cases.filter((item) => item.kind === "degraded")).toHaveLength(6);
    expect(new Set(cases.map((item) => item.caseId)).size).toBe(12);

    const artifactIds: string[] = [];
    for (const evalCase of cases) {
      expect(evalCase.images.map((image) => image.target.breakpoint)).toEqual([
        375, 768, 1440,
      ]);
      expect(evalCase.images).toHaveLength(3);
      for (const image of evalCase.images) {
        artifactIds.push(image.artifactId);
        expect(image.materialClass).toBe("model_eval_fixture");
        expect(image.mimeType).toBe("image/png");
        expect(image.workspaceId).toBeUndefined();
        expect(Object.getPrototypeOf(image.bytes)).toBe(Uint8Array.prototype);
        expect(image.bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(digest(image.bytes)).toBe(image.sha256);
        await expect(sharp(image.bytes).metadata()).resolves.toMatchObject({
          format: "png",
          width: image.target.breakpoint,
        });
      }
    }
    expect(new Set(artifactIds).size).toBe(36);
    for (const evalCase of cases) {
      expect(() =>
        preflightVisionReviewInput({
          task: "site_builder.aesthetic_review.eval",
          prompt: evalCase.prompt,
          model: "gemini-3.5-flash",
          schema: AESTHETIC_REVIEW_OUTPUT_SCHEMA,
          images: evalCase.images,
          maxTokens: 2_000,
          maxCostCents: 10,
        }),
      ).not.toThrow();
    }
  });

  it("creates deterministic, dimension-preserving seeded degradations", async () => {
    const cases = await loadAestheticEvalCases(repositoryRoot);
    for (const degraded of cases.filter(
      (
        item,
      ): item is AestheticEvalCase & {
        expectedIssue: NonNullable<AestheticEvalCase["expectedIssue"]>;
      } => item.kind === "degraded" && item.expectedIssue !== null,
    )) {
      const approved = cases.find(
        (item) =>
          item.familyId === degraded.familyId && item.kind === "approved",
      );
      expect(approved).toBeDefined();
      for (let index = 0; index < degraded.images.length; index += 1) {
        const original = approved!.images[index];
        const expected = degraded.images[index];
        const repeated = await degradeAestheticScreenshot(
          original.bytes,
          degraded.expectedIssue,
          original.target.breakpoint,
        );
        expect(digest(repeated)).toBe(expected.sha256);
        const originalMetadata = await sharp(original.bytes).metadata();
        const degradedMetadata = await sharp(repeated).metadata();
        expect(degradedMetadata.width).toBe(originalMetadata.width);
        expect(degradedMetadata.height).toBe(originalMetadata.height);
        if (
          degraded.expectedIssue !== "AESTHETIC_MOBILE_COMPOSITION" ||
          original.target.breakpoint === 375
        ) {
          expect(digest(repeated)).not.toBe(original.sha256);
        }
      }
    }
  });
});

describe("M1-f aesthetic review closed output", () => {
  it("compiles the schema and accepts an exact valid result", async () => {
    expect(() =>
      assertModelOutputSchemaCompiles(AESTHETIC_REVIEW_OUTPUT_SCHEMA),
    ).not.toThrow();
    const evalCase = (await loadAestheticEvalCases(repositoryRoot))[0];
    expect(
      assertAestheticReviewOutput(
        validOutput(evalCase.images),
        evalCase.images,
      ),
    ).toEqual(validOutput(evalCase.images));
  });

  it.each([
    ["suggestedPatch", "top"],
    ["props", "top"],
    ["css", "finding"],
    ["html", "target"],
    ["astro", "evidence"],
    ["path", "dimension"],
    ["component", "finding"],
    ["variant", "target"],
  ])(
    "rejects forbidden or unknown %s fields at %s level",
    async (field, level) => {
      const evalCase = (await loadAestheticEvalCases(repositoryRoot))[0];
      const output = clone(validOutput(evalCase.images));
      const findings = output.findings as Array<Record<string, unknown>>;
      const dimensions = output.dimensions as Record<string, unknown>;
      const target = findings[0].target as Record<string, unknown>;
      const evidence = findings[0].evidenceRef as Record<string, unknown>;
      if (level === "top") output[field] = "forbidden";
      if (level === "finding") findings[0][field] = "forbidden";
      if (level === "target") target[field] = "forbidden";
      if (level === "evidence") evidence[field] = "forbidden";
      if (level === "dimension") dimensions[field] = 90;
      expect(() =>
        assertAestheticReviewOutput(output, evalCase.images),
      ).toThrow("AESTHETIC_REVIEW_OUTPUT_INVALID");
    },
  );

  it("rejects foreign evidence and inconsistent pass/fail semantics", async () => {
    const evalCase = (await loadAestheticEvalCases(repositoryRoot))[0];
    const foreign = validOutput(evalCase.images);
    foreign.findings[0].evidenceRef.artifactId = "m1f:foreign:artifact";
    expect(() => assertAestheticReviewOutput(foreign, evalCase.images)).toThrow(
      "AESTHETIC_REVIEW_OUTPUT_INVALID",
    );

    const inconsistent = validOutput(evalCase.images);
    inconsistent.verdict = "failed";
    expect(() =>
      assertAestheticReviewOutput(inconsistent, evalCase.images),
    ).toThrow("AESTHETIC_REVIEW_OUTPUT_INCONSISTENT");
  });

  it("binds every finding target to its referenced screenshot", async () => {
    const evalCase = (await loadAestheticEvalCases(repositoryRoot))[0];
    const mismatched = validOutput(evalCase.images);
    mismatched.findings[0].target.breakpoint =
      evalCase.images[1].target.breakpoint;
    expect(() =>
      assertAestheticReviewOutput(mismatched, evalCase.images),
    ).toThrow("AESTHETIC_REVIEW_OUTPUT_INVALID");
  });

  it("scores approved false blockers and seeded-issue recall without inventing success", async () => {
    const cases = await loadAestheticEvalCases(repositoryRoot);
    const approved = cases.find((item) => item.kind === "approved")!;
    const degraded = cases.find((item) => item.kind === "degraded")!;
    const goodResult = assertAestheticReviewOutput(
      validOutput(approved.images),
      approved.images,
    );
    expect(evaluateAestheticCaseOutput(approved, goodResult)).toEqual({
      falseBlocker: false,
      seededIssueDetected: null,
      accepted: true,
    });

    const missed = validOutput(degraded.images);
    expect(evaluateAestheticCaseOutput(degraded, missed)).toEqual({
      falseBlocker: false,
      seededIssueDetected: false,
      accepted: false,
    });
  });
});
