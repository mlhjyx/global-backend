import { createHash } from "node:crypto";

import {
  COPY_BUNDLE_SCHEMA_VERSION,
  COPY_SLOT_CATALOG_VERSION,
  copyBundleInputHash,
  finalizeCopyBundle,
} from "@global/contracts";

import {
  COPY_TASK,
  type CopyTaskInput,
  type CopyTaskOutput,
} from "../agents/copy";
import {
  canonicalizeCopySlotOutput,
  type CopySlotDefinition,
} from "../copy-bundle.service";

const CAPTURED_COPY_VALIDATE_OUTPUT = (() => {
  const validator = COPY_TASK.validateOutput;
  if (!validator) throw new Error("copy output validator is unavailable");
  return validator;
})();

export const COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION =
  "site-builder-copy-assembly-eval-fixture/v1" as const;
export const COPY_ASSEMBLY_EVALUATOR_VERSION =
  "site-builder-copy-assembly-evaluator/2026-08-04-v1" as const;
export const COPY_ASSEMBLY_ROUTE_VALIDATION_VERSION =
  "site-builder-copy-assembly-route-validation/2026-08-04-v1" as const;
export const COPY_ASSEMBLY_PROMPT_VERSION =
  "site-builder-copy-assembly-prompt/2026-08-04-v1" as const;

export const COPY_ASSEMBLY_EVALUATOR_RUBRIC = Object.freeze({
  closedOutputShape: true,
  productionValidator: "COPY_TASK.validateOutput",
  productionCanonicalizer: "canonicalizeCopySlotOutput",
  productionFinalizer: "finalizeCopyBundle",
  factualClaimTextMustBeExact: true,
  neutralCopyIsServerCanonicalized: true,
  freeFormFactsAllowed: false,
  prohibitedBehavior: Object.freeze([
    "invent_claim_reference",
    "omit_required_slot",
    "invent_slot",
    "embellish_cited_claim",
    "translate_or_normalize_cited_claim",
  ]),
} as const);

export interface CopyAssemblyEvalFixture {
  schemaVersion: typeof COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION;
  fixtureId: string;
  taskId: "site_builder.copy";
  snapshotId: string;
  input: CopyTaskInput;
  expectedOutput: CopyTaskOutput;
}

export interface PreparedCopyAssemblyEvalFixture {
  fixture: CopyAssemblyEvalFixture;
  input: CopyTaskInput;
}

export interface CopyAssemblyEvaluationOutcome {
  exactCanonicalOutput: boolean;
  productionValidationPassed: boolean;
  factualSlotContentMatches: boolean;
  rejectedSlotKeys: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function claim(
  claimId: string,
  statement: string,
): CopyTaskInput["claims"][number] {
  return {
    claimId,
    claimVersion: 1,
    factKey: "capability",
    claimType: "capability",
    statement,
    validUntil: null,
    approvedBy: "eval-reviewer",
    approvedAt: "2026-08-04T00:00:00.000Z",
    bridgeId: `bridge-${claimId}`,
    brandProfileId: "eval-brand-profile",
    evidenceRefId: `ref-${claimId}`,
    evidenceId: `evidence-${claimId}`,
    sourceSnapshotId: "eval-source-snapshot",
    sourceContentHash: sha256(`source:${claimId}`),
    quote: statement,
    selector: { start: 0, end: statement.length },
  };
}

function copyInput(input: {
  fixtureId: string;
  claims: CopyTaskInput["claims"];
  slots: CopySlotDefinition[];
}): CopyTaskInput {
  return {
    locale: "en",
    sourceLocale: "en",
    snapshotDigest: sha256(`copy-eval:${input.fixtureId}`),
    claims: input.claims,
    slots: input.slots,
  };
}

export const COPY_ASSEMBLY_EVAL_FIXTURES: readonly CopyAssemblyEvalFixture[] =
  deepFreeze([
  {
    schemaVersion: COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
    fixtureId: "copy-factual-claims",
    taskId: "site_builder.copy",
    snapshotId: "copy-eval-factual-claims",
    input: copyInput({
      fixtureId: "copy-factual-claims",
      claims: [
        claim("claim-pressure", "Industrial pumps up to 400 bar"),
        claim("claim-cert", "Certified to ISO 9001:2015"),
      ],
      slots: [
        {
          key: "home.hero.headline",
          type: "plain_text",
          maxGraphemes: 64,
          factual: true,
        },
        {
          key: "home.hero.certification",
          type: "rich_text",
          maxGraphemes: 64,
          factual: true,
        },
        {
          key: "home.hero.cta.label",
          type: "cta_label",
          maxGraphemes: 24,
          factual: false,
        },
      ],
    }),
    expectedOutput: {
      slots: {
        "home.hero.headline": {
          content: "Industrial pumps up to 400 bar",
          claimRefs: ["claim-pressure"],
        },
        "home.hero.certification": {
          content: "Certified to ISO 9001:2015",
          claimRefs: ["claim-cert"],
        },
        "home.hero.cta.label": {
          content: "Get in touch",
          claimRefs: [],
        },
      },
    } as CopyTaskOutput,
  },
  {
    schemaVersion: COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
    fixtureId: "copy-neutral-budget",
    taskId: "site_builder.copy",
    snapshotId: "copy-eval-neutral-budget",
    input: copyInput({
      fixtureId: "copy-neutral-budget",
      claims: [],
      slots: [
        {
          key: "seo.home.title",
          type: "seo_title",
          maxGraphemes: 60,
          factual: false,
        },
        {
          key: "home.hero.summary",
          type: "rich_text",
          maxGraphemes: 80,
          factual: false,
        },
      ],
    }),
    expectedOutput: {
      slots: {
        "seo.home.title": { content: "Company website", claimRefs: [] },
        "home.hero.summary": {
          content: "Further information is available on request.",
          claimRefs: [],
        },
      },
    } as CopyTaskOutput,
  },
  ]);

function isExactFixtureShape(value: CopyAssemblyEvalFixture): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "schemaVersion",
          "fixtureId",
          "taskId",
          "snapshotId",
          "input",
          "expectedOutput",
        ].sort(),
      ) &&
    value.schemaVersion === COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION &&
    value.taskId === "site_builder.copy" &&
    value.fixtureId.startsWith("copy-") &&
    /^[0-9a-f]{64}$/.test(value.input.snapshotDigest) &&
    value.input.locale === value.input.sourceLocale &&
    new Set(value.input.slots.map((slot) => slot.key)).size ===
      value.input.slots.length
  );
}

export function prepareCopyAssemblyEvalFixture(
  fixture: CopyAssemblyEvalFixture,
): PreparedCopyAssemblyEvalFixture {
  const copy = structuredClone(fixture);
  if (!isExactFixtureShape(copy)) {
    throw new Error(`invalid copy evaluation fixture: ${copy.fixtureId}`);
  }
  CAPTURED_COPY_VALIDATE_OUTPUT(copy.input, copy.expectedOutput);
  return deepFreeze({ fixture: copy, input: copy.input });
}

function canonicalBundleDigest(
  prepared: PreparedCopyAssemblyEvalFixture,
  output: CopyTaskOutput,
): { digest: string; factualSlotContentMatches: boolean; rejectedSlotKeys: string[] } {
  const claims = new Map(
    prepared.input.claims.map((item) => [
      item.claimId,
      { statement: item.statement, protectedTokens: [] as readonly string[] },
    ]),
  );
  const slots = Object.fromEntries(
    prepared.input.slots.map((slot) => {
      const generated = output.slots[slot.key];
      if (!generated) throw new Error(`copy output slot missing: ${slot.key}`);
      const canonical = canonicalizeCopySlotOutput(
        prepared.input.locale,
        slot,
        generated,
        claims,
      );
      const expectedContent = canonical.claimRefs
        .map((claimId) => claims.get(claimId)!.statement)
        .join(" · ");
      const claimRefsPreserved =
        generated.claimRefs.length === canonical.claimRefs.length &&
        generated.claimRefs.every(
          (claimId, index) => claimId === canonical.claimRefs[index],
        );
      return [
        slot.key,
        {
          type: slot.type,
          maxGraphemes: slot.maxGraphemes,
          factual: canonical.factual,
          content: canonical.content,
          claimRefs: canonical.claimRefs,
          factualContentMatches:
            claimRefsPreserved &&
            (canonical.claimRefs.length === 0 ||
              generated.content === expectedContent),
        },
      ];
    }),
  );
  const bundle = finalizeCopyBundle(
    {
      schemaVersion: COPY_BUNDLE_SCHEMA_VERSION,
      slotCatalogVersion: COPY_SLOT_CATALOG_VERSION,
      locale: prepared.input.locale,
      sourceLocale: prepared.input.sourceLocale,
      status: "complete",
      claimSnapshot: {
        id: prepared.fixture.snapshotId,
        digest: prepared.input.snapshotDigest,
      },
      inputHash: copyBundleInputHash({
        claimSnapshotDigest: prepared.input.snapshotDigest,
        locale: prepared.input.locale,
        sourceLocale: prepared.input.sourceLocale,
        slots: prepared.input.slots,
      }),
      slots: Object.fromEntries(
        Object.entries(slots).map(([key, value]) => {
          const { factualContentMatches: _ignored, ...slot } = value;
          return [key, slot];
        }),
      ),
    },
    {
      supportedLocales: [prepared.input.locale],
      claims,
      approvedOutboundDomains: [],
    },
  );
  const rejectedSlotKeys = Object.entries(slots)
    .filter(([, value]) => !value.factualContentMatches)
    .map(([key]) => key)
    .sort();
  return {
    digest: bundle.digest,
    factualSlotContentMatches: rejectedSlotKeys.length === 0,
    rejectedSlotKeys,
  };
}

export function evaluateCopyAssemblyOutput(
  prepared: PreparedCopyAssemblyEvalFixture,
  output: CopyTaskOutput,
): CopyAssemblyEvaluationOutcome {
  CAPTURED_COPY_VALIDATE_OUTPUT(prepared.input, output);
  const actual = canonicalBundleDigest(prepared, output);
  const expected = canonicalBundleDigest(
    prepared,
    prepared.fixture.expectedOutput,
  );
  return {
    exactCanonicalOutput:
      actual.digest === expected.digest && actual.factualSlotContentMatches,
    productionValidationPassed: true,
    factualSlotContentMatches: actual.factualSlotContentMatches,
    rejectedSlotKeys: actual.rejectedSlotKeys,
  };
}
