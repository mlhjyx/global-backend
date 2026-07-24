import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
  validateDesignEvaluationV2,
  validateQualityArtifactSet,
  validateSiteSpecV1_1,
  type AestheticUnavailableReason,
  type DesignEvaluationFindingV2,
  type DesignEvaluationV2,
  type DesignEvaluationV2RuleCode,
  type QualityArtifactExpectedTargetV1,
  type QualityArtifactRefV1,
  type QualityArtifactSetV1,
  type QualityBreakpoint,
  type SiteSpecV1_1,
} from "@global/contracts";
import { createHash } from "node:crypto";
import { releaseSpecDigest } from "../release-artifact";

export const DETERMINISTIC_QUALITY_EVALUATOR_VERSION =
  "site-builder-deterministic-quality@1.0.0";
export const QUALITY_BREAKPOINTS = [375, 768, 1440] as const;
export const MAX_QUALITY_TARGETS = 24;
export const MAX_QUALITY_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_QUALITY_EVIDENCE_BYTES = 64 * 1024 * 1024;

export interface AxeViolationFact {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  nodeCount: number;
}

export interface QualityPageFacts {
  target: QualityArtifactExpectedTargetV1;
  screenshots: Record<QualityBreakpoint, Buffer>;
  axeViolations: AxeViolationFact[];
  h1Count: number;
  canonical: string | null;
  hreflangs: Array<{ lang: string; href: string }>;
  robots: string | null;
  robotsTxtOk: boolean;
  sitemapOk: boolean;
  jsonLdValid: boolean;
  jsonLdUnsupportedFacts: boolean;
  unresolvedPlaceholder: boolean;
  externalRequests: string[];
  brokenInternalLinks: string[];
  missingStaticAssets: string[];
  horizontalOverflow: QualityBreakpoint[];
  clippedText: QualityBreakpoint[];
  elementOverlap: QualityBreakpoint[];
  unreachableCta: QualityBreakpoint[];
}

export interface LighthouseFacts {
  target: QualityArtifactExpectedTargetV1;
  breakpoint: 375 | 1440;
  performance: number;
  accessibility: number;
  seo: number;
}

export interface QualityArtifactDraft {
  artifactId: string;
  bytes: Buffer;
  mimeType: "image/png" | "application/json";
  kind: QualityArtifactRefV1["kind"];
  target?: QualityArtifactRefV1["target"];
}

export interface QualityArtifactSink {
  persist(
    prefix: string,
    artifact: QualityArtifactDraft,
    signal?: AbortSignal,
  ): Promise<QualityArtifactRefV1>;
}

export interface CollectedQualityFacts {
  spec: SiteSpecV1_1;
  candidateSpecDigest: string;
  designBriefDigest: string;
  round: 0 | 1 | 2 | 3;
  pages: QualityPageFacts[];
  lighthouse: LighthouseFacts[];
}

export interface DeterministicQualityResult {
  artifactSet: QualityArtifactSetV1;
  hardFailures: DesignEvaluationFindingV2[];
  findings: DesignEvaluationFindingV2[];
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) {
          throw new Error("QUALITY_ARTIFACT_INVALID: non-json value");
        }
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("QUALITY_ARTIFACT_INVALID: non-json value");
}

function safeToken(value: string): string {
  const readable =
    value
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^[-.]+/, "")
      .slice(0, 28) || "target";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function targetKey(target: QualityArtifactExpectedTargetV1): string {
  return `${target.locale}\u0000${target.pageId}`;
}

function screenshotId(
  target: QualityArtifactExpectedTargetV1,
  breakpoint: QualityBreakpoint,
): string {
  return `screenshot-${safeToken(target.locale)}-${safeToken(target.pageId)}-${breakpoint}`;
}

function reportId(
  kind: "axe" | "seo" | "deterministic",
  target: QualityArtifactExpectedTargetV1,
): string {
  return `${kind}-${safeToken(target.locale)}-${safeToken(target.pageId)}`;
}

function lighthouseId(fact: LighthouseFacts): string {
  return `lighthouse-${safeToken(fact.target.locale)}-${safeToken(fact.target.pageId)}-${fact.breakpoint}`;
}

function assertDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`QUALITY_ARTIFACT_INVALID: ${field}`);
  }
}

function assertFiniteScore(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`QUALITY_ARTIFACT_INVALID: ${field}`);
  }
}

function hasBlockingAxe(page: QualityPageFacts): boolean {
  return page.axeViolations.some(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );
}

function hasSeoFailure(
  page: QualityPageFacts,
  locales: readonly string[],
): boolean {
  return (
    page.h1Count !== 1 ||
    page.canonical === null ||
    (locales.length > 1 &&
      (page.hreflangs.length !== locales.length ||
        new Set(page.hreflangs.map(({ lang }) => lang)).size !==
          locales.length ||
        locales.some(
          (locale) =>
            !page.hreflangs.some(({ lang, href }) => lang === locale && href),
        ))) ||
    !page.robots
      ?.split(",")
      .map((token) => token.trim().toLowerCase())
      .includes("noindex") ||
    !page.robotsTxtOk ||
    !page.sitemapOk ||
    !page.jsonLdValid ||
    page.jsonLdUnsupportedFacts
  );
}

function finding(
  severity: "blocker" | "major" | "minor",
  ruleCode: DesignEvaluationV2RuleCode,
  target: QualityArtifactRefV1["target"],
  artifactId: string,
): DesignEvaluationFindingV2 {
  if (!target) throw new Error("QUALITY_ARTIFACT_INVALID: finding target");
  return {
    source: "deterministic",
    severity,
    ruleCode,
    target,
    evidenceRef: { artifactId },
  };
}

function genericnessFindings(
  spec: SiteSpecV1_1,
  artifactByTarget: Map<string, string>,
): DesignEvaluationFindingV2[] {
  const findings: DesignEvaluationFindingV2[] = [];
  const locales = spec.site.locales;
  const cardLike =
    /(Grid|Cards|Gallery|Showcase|Tiers|Wall|Marquee|Rows|Chapters|Library)$/;
  const heroes = new Map<string, string[]>();

  for (const page of spec.pages) {
    const blocks = page.puck.content;
    let repeated = false;
    for (let index = 2; index < blocks.length; index += 1) {
      if (
        blocks[index]!.type === blocks[index - 1]!.type &&
        blocks[index]!.type === blocks[index - 2]!.type
      ) {
        repeated = true;
        break;
      }
    }
    const cardDensity =
      blocks.length > 0 &&
      blocks.filter((block) => cardLike.test(block.type)).length /
        blocks.length >
        0.5;
    const hero = blocks.find((block) =>
      /Hero$|Hero[A-Z]|^Hero/.test(block.type),
    );
    if (hero) {
      const variant =
        typeof hero.props.variant === "string" ? hero.props.variant : "default";
      const signature = `${hero.type}:${variant}`;
      heroes.set(signature, [...(heroes.get(signature) ?? []), page.id]);
    }

    for (const locale of locales) {
      const artifactId = artifactByTarget.get(
        targetKey({ locale, pageId: page.id }),
      );
      if (!artifactId) continue;
      if (repeated) {
        findings.push(
          finding(
            "major",
            "GENERICNESS_STRUCTURE_REPEAT",
            { locale, pageId: page.id },
            artifactId,
          ),
        );
      }
      if (cardDensity) {
        findings.push(
          finding(
            "major",
            "GENERICNESS_CARD_DENSITY",
            { locale, pageId: page.id },
            artifactId,
          ),
        );
      }
    }
  }

  if (spec.pages.length > 1) {
    for (const pageIds of heroes.values()) {
      if (pageIds.length / spec.pages.length <= 0.5) continue;
      for (const pageId of pageIds) {
        for (const locale of locales) {
          const artifactId = artifactByTarget.get(
            targetKey({ locale, pageId }),
          );
          if (artifactId) {
            findings.push(
              finding(
                "major",
                "GENERICNESS_HERO_REPEAT",
                { locale, pageId },
                artifactId,
              ),
            );
          }
        }
      }
    }
  }
  return findings;
}

function assertFactCoverage(input: CollectedQualityFacts): void {
  validateSiteSpecV1_1(input.spec);
  assertDigest(input.candidateSpecDigest, "candidateSpecDigest");
  if (releaseSpecDigest(input.spec) !== input.candidateSpecDigest) {
    throw new Error("QUALITY_ARTIFACT_INVALID: candidateSpecDigest mismatch");
  }
  assertDigest(input.designBriefDigest, "designBriefDigest");
  const expected = input.spec.site.locales.flatMap((locale) =>
    input.spec.pages.map((page) => ({ locale, pageId: page.id })),
  );
  if (
    expected.length < 1 ||
    expected.length > MAX_QUALITY_TARGETS ||
    input.pages.length !== expected.length
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID: target coverage");
  }
  const expectedKeys = new Set(expected.map(targetKey));
  const actualKeys = new Set(
    input.pages.map(({ target }) => targetKey(target)),
  );
  if (
    expectedKeys.size !== expected.length ||
    actualKeys.size !== input.pages.length ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID: target identity");
  }
  if (
    expected.some(
      (target, index) =>
        targetKey(target) !== targetKey(input.pages[index]!.target),
    )
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID: target order");
  }
  for (const page of input.pages) {
    if (
      page.axeViolations.length > 128 ||
      page.externalRequests.length > 512 ||
      page.brokenInternalLinks.length > 512 ||
      page.missingStaticAssets.length > 512 ||
      [
        ...page.externalRequests,
        ...page.brokenInternalLinks,
        ...page.missingStaticAssets,
      ].some((value) => typeof value !== "string" || value.length > 2_048)
    ) {
      throw new Error("QUALITY_ARTIFACT_INVALID: bounded page facts");
    }
    for (const breakpoint of QUALITY_BREAKPOINTS) {
      const screenshot = page.screenshots[breakpoint];
      if (
        !Buffer.isBuffer(screenshot) ||
        screenshot.length < 1 ||
        screenshot.length > MAX_QUALITY_SCREENSHOT_BYTES ||
        !screenshot
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ) {
        throw new Error(
          `QUALITY_ARTIFACT_INVALID: screenshot ${targetKey(page.target)} ${breakpoint}`,
        );
      }
    }
  }
  for (const score of input.lighthouse) {
    assertFiniteScore(score.performance, "lighthouse.performance");
    assertFiniteScore(score.accessibility, "lighthouse.accessibility");
    assertFiniteScore(score.seo, "lighthouse.seo");
    if (!expectedKeys.has(targetKey(score.target))) {
      throw new Error("QUALITY_ARTIFACT_INVALID: lighthouse target");
    }
  }
  const homePage =
    input.spec.pages.find((page) => page.id === "home") ?? input.spec.pages[0]!;
  const expectedLighthouseTarget = targetKey({
    locale: input.spec.site.defaultLocale,
    pageId: homePage.id,
  });
  const lighthouseKeys = new Set(
    input.lighthouse.map(
      (fact) => `${targetKey(fact.target)}\u0000${fact.breakpoint}`,
    ),
  );
  if (
    input.lighthouse.length !== 2 ||
    lighthouseKeys.size !== 2 ||
    !lighthouseKeys.has(`${expectedLighthouseTarget}\u0000375`) ||
    !lighthouseKeys.has(`${expectedLighthouseTarget}\u00001440`)
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID: lighthouse coverage");
  }
  const projectedArtifactCount =
    input.pages.length * 4 +
    input.lighthouse.length +
    2 +
    input.pages.filter(hasBlockingAxe).length +
    input.pages.filter((page) => hasSeoFailure(page, input.spec.site.locales))
      .length;
  const pageReportBytes = input.pages.reduce((total, page) => {
    const deterministic = jsonBytes({
      unresolvedPlaceholder: page.unresolvedPlaceholder,
      externalRequests: page.externalRequests,
      brokenInternalLinks: page.brokenInternalLinks,
      missingStaticAssets: page.missingStaticAssets,
      wcagContrastFailed: page.axeViolations.some(
        (violation) =>
          violation.id === "color-contrast" &&
          (violation.impact === "critical" || violation.impact === "serious"),
      ),
    }).length;
    const axe = hasBlockingAxe(page)
      ? jsonBytes({ violations: page.axeViolations }).length
      : 0;
    const seo = hasSeoFailure(page, input.spec.site.locales)
      ? jsonBytes({
          h1Count: page.h1Count,
          canonical: page.canonical,
          hreflangs: page.hreflangs,
          robots: page.robots,
          robotsTxtOk: page.robotsTxtOk,
          sitemapOk: page.sitemapOk,
          jsonLdValid: page.jsonLdValid,
          jsonLdUnsupportedFacts: page.jsonLdUnsupportedFacts,
        }).length
      : 0;
    return (
      total +
      deterministic +
      axe +
      seo +
      QUALITY_BREAKPOINTS.reduce(
        (bytes, breakpoint) => bytes + page.screenshots[breakpoint].length,
        0,
      )
    );
  }, 0);
  const projectedEvidenceBytes =
    pageReportBytes +
    jsonBytes({ pages: input.pages.map((page) => page.axeViolations) }).length +
    jsonBytes({
      pages: input.pages.map((page) => ({
        h1Count: page.h1Count,
        canonical: page.canonical,
        hreflangs: page.hreflangs,
        robots: page.robots,
      })),
    }).length +
    input.lighthouse.reduce((total, fact) => total + jsonBytes(fact).length, 0);
  const projectedHardFailures =
    input.pages.reduce((total, page) => {
      const axe =
        Number(
          page.axeViolations.some(
            (violation) => violation.impact === "critical",
          ),
        ) +
        Number(
          page.axeViolations.some(
            (violation) => violation.impact === "serious",
          ),
        ) +
        Number(
          page.axeViolations.some(
            (violation) =>
              violation.id === "color-contrast" &&
              (violation.impact === "critical" ||
                violation.impact === "serious"),
          ),
        );
      const seo =
        Number(page.h1Count !== 1) +
        Number(page.canonical === null) +
        Number(
          input.spec.site.locales.length > 1 &&
            (page.hreflangs.length !== input.spec.site.locales.length ||
              new Set(page.hreflangs.map(({ lang }) => lang)).size !==
                input.spec.site.locales.length ||
              input.spec.site.locales.some(
                (locale) =>
                  !page.hreflangs.some(
                    ({ lang, href }) => lang === locale && href,
                  ),
              )),
        ) +
        Number(
          !page.robots
            ?.split(",")
            .map((token) => token.trim().toLowerCase())
            .includes("noindex"),
        ) +
        Number(!page.robotsTxtOk) +
        Number(!page.sitemapOk) +
        Number(!page.jsonLdValid) +
        Number(page.jsonLdUnsupportedFacts);
      const deterministic =
        Number(page.unresolvedPlaceholder) +
        Number(page.externalRequests.length > 0) +
        Number(page.brokenInternalLinks.length > 0) +
        Number(page.missingStaticAssets.length > 0);
      const visual = [
        page.horizontalOverflow,
        page.clippedText,
        page.elementOverlap,
        page.unreachableCta,
      ].reduce((count, breakpoints) => count + new Set(breakpoints).size, 0);
      return total + axe + seo + deterministic + visual;
    }, 0) +
    input.lighthouse.reduce(
      (total, fact) =>
        total +
        Number(fact.performance < 85) +
        Number(fact.accessibility < 90) +
        Number(fact.seo < 90),
      0,
    );
  if (
    projectedArtifactCount > 128 ||
    projectedEvidenceBytes > MAX_QUALITY_EVIDENCE_BYTES ||
    projectedHardFailures > 128
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID: evidence bounds");
  }
}

/**
 * Converts browser facts into private immutable evidence and a closed deterministic
 * decision. It never invokes or impersonates an aesthetic model.
 */
export async function evaluateDeterministicQuality(
  input: CollectedQualityFacts,
  artifactPrefix: string,
  sink: QualityArtifactSink,
  signal?: AbortSignal,
): Promise<DeterministicQualityResult> {
  if (!artifactPrefix.endsWith(`/quality/round-${input.round}`)) {
    throw new Error("QUALITY_ARTIFACT_INVALID: round-scoped prefix");
  }
  assertFactCoverage(input);
  const artifacts: QualityArtifactRefV1[] = [];
  const hardFailures: DesignEvaluationFindingV2[] = [];
  const findings: DesignEvaluationFindingV2[] = [];
  const deterministicArtifactByTarget = new Map<string, string>();
  const aggregateAxe: Array<{
    target: QualityArtifactExpectedTargetV1;
    violations: AxeViolationFact[];
  }> = [];
  const aggregateSeo: Array<Record<string, unknown>> = [];

  for (const page of input.pages) {
    for (const breakpoint of QUALITY_BREAKPOINTS) {
      artifacts.push(
        await sink.persist(
          artifactPrefix,
          {
            artifactId: screenshotId(page.target, breakpoint),
            bytes: page.screenshots[breakpoint],
            mimeType: "image/png",
            kind: "screenshot",
            target: { ...page.target, breakpoint },
          },
          signal,
        ),
      );
    }

    const axeArtifactId = reportId("axe", page.target);
    aggregateAxe.push({
      target: page.target,
      violations: page.axeViolations,
    });
    const wcagContrastFailed = page.axeViolations.some(
      (violation) =>
        violation.id === "color-contrast" &&
        (violation.impact === "critical" || violation.impact === "serious"),
    );
    if (hasBlockingAxe(page)) {
      artifacts.push(
        await sink.persist(
          artifactPrefix,
          {
            artifactId: axeArtifactId,
            bytes: jsonBytes({ violations: page.axeViolations }),
            mimeType: "application/json",
            kind: "axe_report",
            target: page.target,
          },
          signal,
        ),
      );
    }
    if (
      page.axeViolations.some((violation) => violation.impact === "critical")
    ) {
      hardFailures.push(
        finding("blocker", "AXE_CRITICAL", page.target, axeArtifactId),
      );
    }
    if (
      page.axeViolations.some((violation) => violation.impact === "serious")
    ) {
      hardFailures.push(
        finding("blocker", "AXE_SERIOUS", page.target, axeArtifactId),
      );
    }

    const seoArtifactId = reportId("seo", page.target);
    const seoReport = {
      target: page.target,
      h1Count: page.h1Count,
      canonical: page.canonical,
      hreflangs: page.hreflangs,
      robots: page.robots,
      robotsTxtOk: page.robotsTxtOk,
      sitemapOk: page.sitemapOk,
      jsonLdValid: page.jsonLdValid,
      jsonLdUnsupportedFacts: page.jsonLdUnsupportedFacts,
    };
    aggregateSeo.push(seoReport);
    const seoFailures: Array<[boolean, DesignEvaluationV2RuleCode]> = [
      [page.h1Count !== 1, "H1_COUNT_INVALID"],
      [page.canonical === null, "CANONICAL_INVALID"],
      [
        input.spec.site.locales.length > 1 &&
          (page.hreflangs.length !== input.spec.site.locales.length ||
            new Set(page.hreflangs.map(({ lang }) => lang)).size !==
              input.spec.site.locales.length ||
            input.spec.site.locales.some(
              (locale) =>
                !page.hreflangs.some(
                  ({ lang, href }) => lang === locale && href,
                ),
            )),
        "HREFLANG_INVALID",
      ],
      [
        !page.robots
          ?.split(",")
          .map((token) => token.trim().toLowerCase())
          .includes("noindex"),
        "PREVIEW_NOINDEX_INVALID",
      ],
      [!page.robotsTxtOk, "ROBOTS_INVALID"],
      [!page.sitemapOk, "SITEMAP_INVALID"],
      [!page.jsonLdValid, "JSON_LD_INVALID"],
      [page.jsonLdUnsupportedFacts, "JSON_LD_FACT_UNSUPPORTED"],
    ];
    if (seoFailures.some(([failed]) => failed)) {
      artifacts.push(
        await sink.persist(
          artifactPrefix,
          {
            artifactId: seoArtifactId,
            bytes: jsonBytes(seoReport),
            mimeType: "application/json",
            kind: "seo_report",
            target: page.target,
          },
          signal,
        ),
      );
    }
    for (const [failed, code] of seoFailures) {
      if (failed) {
        hardFailures.push(finding("blocker", code, page.target, seoArtifactId));
      }
    }

    const deterministicArtifactId = reportId("deterministic", page.target);
    deterministicArtifactByTarget.set(
      targetKey(page.target),
      deterministicArtifactId,
    );
    artifacts.push(
      await sink.persist(
        artifactPrefix,
        {
          artifactId: deterministicArtifactId,
          bytes: jsonBytes({
            unresolvedPlaceholder: page.unresolvedPlaceholder,
            externalRequests: page.externalRequests,
            brokenInternalLinks: page.brokenInternalLinks,
            missingStaticAssets: page.missingStaticAssets,
            wcagContrastFailed,
          }),
          mimeType: "application/json",
          kind: "deterministic_evaluation",
          target: page.target,
        },
        signal,
      ),
    );
    const deterministicFailures: Array<[boolean, DesignEvaluationV2RuleCode]> =
      [
        [page.unresolvedPlaceholder, "PLACEHOLDER_UNRESOLVED"],
        [page.externalRequests.length > 0, "OUTBOUND_REQUEST_FORBIDDEN"],
        [page.brokenInternalLinks.length > 0, "INTERNAL_LINK_BROKEN"],
        [page.missingStaticAssets.length > 0, "STATIC_ASSET_MISSING"],
      ];
    for (const [failed, code] of deterministicFailures) {
      if (failed) {
        hardFailures.push(
          finding("blocker", code, page.target, deterministicArtifactId),
        );
      }
    }
    if (wcagContrastFailed) {
      hardFailures.push(
        finding(
          "blocker",
          "WCAG_AA_CONTRAST_FAILED",
          page.target,
          deterministicArtifactId,
        ),
      );
    }

    const visualFailures: Array<
      [QualityBreakpoint[], DesignEvaluationV2RuleCode]
    > = [
      [page.horizontalOverflow, "HORIZONTAL_OVERFLOW"],
      [page.clippedText, "TEXT_CLIPPED"],
      [page.elementOverlap, "ELEMENT_OVERLAP"],
      [page.unreachableCta, "CTA_UNREACHABLE"],
    ];
    for (const [breakpoints, code] of visualFailures) {
      for (const breakpoint of [...new Set(breakpoints)]) {
        hardFailures.push(
          finding(
            "blocker",
            code,
            { ...page.target, breakpoint },
            screenshotId(page.target, breakpoint),
          ),
        );
      }
    }
  }

  artifacts.push(
    await sink.persist(
      artifactPrefix,
      {
        artifactId: "axe-summary",
        bytes: jsonBytes({ pages: aggregateAxe }),
        mimeType: "application/json",
        kind: "axe_report",
      },
      signal,
    ),
    await sink.persist(
      artifactPrefix,
      {
        artifactId: "seo-summary",
        bytes: jsonBytes({ pages: aggregateSeo }),
        mimeType: "application/json",
        kind: "seo_report",
      },
      signal,
    ),
  );

  for (const fact of input.lighthouse) {
    const artifactId = lighthouseId(fact);
    artifacts.push(
      await sink.persist(
        artifactPrefix,
        {
          artifactId,
          bytes: jsonBytes(fact),
          mimeType: "application/json",
          kind: "lighthouse_report",
          target: { ...fact.target, breakpoint: fact.breakpoint },
        },
        signal,
      ),
    );
    const failures: Array<[boolean, DesignEvaluationV2RuleCode]> = [
      [fact.performance < 85, "LIGHTHOUSE_PERFORMANCE_BELOW_THRESHOLD"],
      [fact.accessibility < 90, "LIGHTHOUSE_ACCESSIBILITY_BELOW_THRESHOLD"],
      [fact.seo < 90, "LIGHTHOUSE_SEO_BELOW_THRESHOLD"],
    ];
    for (const [failed, code] of failures) {
      if (failed) {
        hardFailures.push(
          finding(
            "blocker",
            code,
            { ...fact.target, breakpoint: fact.breakpoint },
            artifactId,
          ),
        );
      }
    }
  }

  findings.push(
    ...genericnessFindings(input.spec, deterministicArtifactByTarget),
  );
  if (artifacts.length > 128) {
    throw new Error("QUALITY_ARTIFACT_INVALID: evidence ref limit");
  }
  const expectedTargets = input.pages.map(({ target }) => target);
  const draft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: input.candidateSpecDigest,
    designBriefDigest: input.designBriefDigest,
    round: input.round,
    expectedTargets,
    artifacts,
  } satisfies Omit<QualityArtifactSetV1, "artifactSetDigest">;
  const artifactSet = validateQualityArtifactSet({
    ...draft,
    artifactSetDigest: qualityArtifactSetDigest(draft),
  });
  return { artifactSet, hardFailures, findings };
}

export function composeUnavailableAestheticEvaluation(
  input: CollectedQualityFacts,
  deterministic: DeterministicQualityResult,
  unavailableReason: AestheticUnavailableReason,
): DesignEvaluationV2 {
  const evaluation: DesignEvaluationV2 = {
    schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
    candidateSpecDigest: input.candidateSpecDigest,
    designBriefDigest: input.designBriefDigest,
    artifactSetDigest: deterministic.artifactSet.artifactSetDigest,
    round: input.round,
    evaluatorVersion: DETERMINISTIC_QUALITY_EVALUATOR_VERSION,
    deterministic: {
      status: deterministic.hardFailures.length === 0 ? "passed" : "failed",
      hardFailures: deterministic.hardFailures,
      findings: deterministic.findings,
    },
    aesthetic: {
      status: "unavailable",
      overallScore: null,
      dimensions: null,
      unavailableReason,
      findings: [],
    },
  };
  return validateDesignEvaluationV2(evaluation, deterministic.artifactSet);
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
