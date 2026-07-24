import {
  validateDesignEvaluationV2,
  validateQualityArtifactSet,
  type QualityArtifactRefV1,
  type SiteSpecV1_1,
} from "@global/contracts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeUnavailableAestheticEvaluation,
  evaluateDeterministicQuality,
  type CollectedQualityFacts,
  type QualityArtifactDraft,
  type QualityArtifactSink,
} from "./deterministic-quality";
import { releaseSpecDigest } from "../release-artifact";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

class MemorySink implements QualityArtifactSink {
  readonly bytes = new Map<string, Buffer>();

  async persist(
    prefix: string,
    artifact: QualityArtifactDraft,
  ): Promise<QualityArtifactRefV1> {
    const extension = artifact.mimeType === "image/png" ? "png" : "json";
    const objectKey = `${prefix}/${artifact.artifactId}.${extension}`;
    this.bytes.set(objectKey, artifact.bytes);
    return {
      artifactId: artifact.artifactId,
      objectKey,
      sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
      sizeBytes: artifact.bytes.length,
      mimeType: artifact.mimeType,
      kind: artifact.kind,
      ...(artifact.target ? { target: artifact.target } : {}),
    };
  }
}

function fixtureSpec(): SiteSpecV1_1 {
  const repositoryRoot = path.resolve(
    new URL("../../../../../", import.meta.url).pathname,
  );
  return JSON.parse(
    readFileSync(
      path.join(
        repositoryRoot,
        "apps/site-renderer/fixtures/m1-e-b-golden/natural-origin-rich-spec.json",
      ),
      "utf8",
    ),
  ) as SiteSpecV1_1;
}

function cleanFacts(): CollectedQualityFacts {
  const spec = fixtureSpec();
  return {
    spec,
    candidateSpecDigest: releaseSpecDigest(spec),
    designBriefDigest: "b".repeat(64),
    round: 0,
    pages: spec.site.locales.flatMap((locale) =>
      spec.pages.map((page) => ({
        target: { locale, pageId: page.id },
        screenshots: { 375: PNG, 768: PNG, 1440: PNG },
        axeViolations: [],
        h1Count: 1,
        canonical: `https://preview.invalid${page.path}`,
        hreflangs: [],
        robots: "noindex, nofollow",
        robotsTxtOk: true,
        sitemapOk: true,
        jsonLdValid: true,
        jsonLdUnsupportedFacts: false,
        unresolvedPlaceholder: false,
        externalRequests: [],
        brokenInternalLinks: [],
        missingStaticAssets: [],
        horizontalOverflow: [],
        clippedText: [],
        elementOverlap: [],
        unreachableCta: [],
      })),
    ),
    lighthouse: [
      {
        target: { locale: spec.site.defaultLocale, pageId: "home" },
        breakpoint: 375,
        performance: 92,
        accessibility: 100,
        seo: 100,
      },
      {
        target: { locale: spec.site.defaultLocale, pageId: "home" },
        breakpoint: 1440,
        performance: 96,
        accessibility: 100,
        seo: 100,
      },
    ],
  };
}

describe("deterministic M1-f quality evaluation", () => {
  it("persists complete three-breakpoint evidence without claiming model success", async () => {
    const facts = cleanFacts();
    const sink = new MemorySink();
    const result = await evaluateDeterministicQuality(
      facts,
      "private/build/quality/round-0",
      sink,
    );
    expect(validateQualityArtifactSet(result.artifactSet)).toEqual(
      result.artifactSet,
    );
    expect(result.hardFailures).toEqual([]);
    expect(
      result.artifactSet.artifacts.filter(
        (artifact) => artifact.kind === "screenshot",
      ),
    ).toHaveLength(facts.pages.length * 3);

    const evaluation = composeUnavailableAestheticEvaluation(
      facts,
      result,
      "model_not_listed",
    );
    expect(
      validateDesignEvaluationV2(evaluation, result.artifactSet).aesthetic,
    ).toEqual({
      status: "unavailable",
      overallScore: null,
      dimensions: null,
      unavailableReason: "model_not_listed",
      findings: [],
    });
    expect(evaluation.deterministic.status).toBe("passed");
  });

  it("turns SEO, accessibility, egress, layout, and Lighthouse defects into evidence-bound blockers", async () => {
    const facts = cleanFacts();
    const first = facts.pages[0]!;
    first.axeViolations = [
      { id: "color-contrast", impact: "serious", nodeCount: 2 },
      { id: "button-name", impact: "critical", nodeCount: 1 },
    ];
    first.h1Count = 2;
    first.canonical = null;
    first.robots = "index, follow";
    first.robotsTxtOk = false;
    first.sitemapOk = false;
    first.jsonLdValid = false;
    first.jsonLdUnsupportedFacts = true;
    first.unresolvedPlaceholder = true;
    first.externalRequests = ["https://outside.invalid"];
    first.brokenInternalLinks = ["http://127.0.0.1:1/missing"];
    first.missingStaticAssets = ["/missing.png"];
    first.horizontalOverflow = [375];
    first.clippedText = [768];
    first.elementOverlap = [1440];
    first.unreachableCta = [375];
    facts.lighthouse[0] = {
      ...facts.lighthouse[0]!,
      performance: 84,
      accessibility: 89,
      seo: 89,
    };

    const result = await evaluateDeterministicQuality(
      facts,
      "private/build/quality/round-0",
      new MemorySink(),
    );
    const codes = new Set(
      result.hardFailures.map((failure) => failure.ruleCode),
    );
    for (const expected of [
      "AXE_CRITICAL",
      "AXE_SERIOUS",
      "WCAG_AA_CONTRAST_FAILED",
      "H1_COUNT_INVALID",
      "CANONICAL_INVALID",
      "PREVIEW_NOINDEX_INVALID",
      "ROBOTS_INVALID",
      "SITEMAP_INVALID",
      "JSON_LD_INVALID",
      "JSON_LD_FACT_UNSUPPORTED",
      "PLACEHOLDER_UNRESOLVED",
      "OUTBOUND_REQUEST_FORBIDDEN",
      "INTERNAL_LINK_BROKEN",
      "STATIC_ASSET_MISSING",
      "HORIZONTAL_OVERFLOW",
      "TEXT_CLIPPED",
      "ELEMENT_OVERLAP",
      "CTA_UNREACHABLE",
      "LIGHTHOUSE_PERFORMANCE_BELOW_THRESHOLD",
      "LIGHTHOUSE_ACCESSIBILITY_BELOW_THRESHOLD",
      "LIGHTHOUSE_SEO_BELOW_THRESHOLD",
    ]) {
      expect(codes.has(expected as never), expected).toBe(true);
    }
    const artifactIds = new Set(
      result.artifactSet.artifacts.map(({ artifactId }) => artifactId),
    );
    expect(
      result.hardFailures.every((failure) =>
        artifactIds.has(failure.evidenceRef.artifactId),
      ),
    ).toBe(true);
    expect(
      composeUnavailableAestheticEvaluation(
        facts,
        result,
        "timeout",
      ).deterministic.status,
    ).toBe("failed");
  });

  it("rejects forged screenshots before any private object is written", async () => {
    const facts = cleanFacts();
    facts.pages[0]!.screenshots[375] = Buffer.from("not-a-png");
    const sink = new MemorySink();
    await expect(
      evaluateDeterministicQuality(
        facts,
        "private/build/quality/round-0",
        sink,
      ),
    ).rejects.toThrow("QUALITY_ARTIFACT_INVALID");
    expect(sink.bytes.size).toBe(0);
  });

  it("requires both final-candidate homepage Lighthouse profiles", async () => {
    const facts = cleanFacts();
    facts.lighthouse.pop();
    const sink = new MemorySink();
    await expect(
      evaluateDeterministicQuality(
        facts,
        "private/build/quality/round-0",
        sink,
      ),
    ).rejects.toThrow("lighthouse coverage");
    expect(sink.bytes.size).toBe(0);
  });

  it("rejects a stale candidate digest before evidence upload", async () => {
    const facts = cleanFacts();
    facts.candidateSpecDigest = "c".repeat(64);
    const sink = new MemorySink();
    await expect(
      evaluateDeterministicQuality(
        facts,
        "private/build/quality/round-0",
        sink,
      ),
    ).rejects.toThrow("candidateSpecDigest mismatch");
    expect(sink.bytes.size).toBe(0);
  });
});
