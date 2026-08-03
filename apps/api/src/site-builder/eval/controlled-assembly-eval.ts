import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { AssemblyFinding } from "../assembly/controlled-assembly-validator";
import {
  controlledAssemblySectionTargets,
  deterministicControlledAssemblySelection,
  evaluateControlledAssemblySelection,
  type AssemblySelection,
  type DeterministicAssemblyInput,
} from "../assembly/controlled-assembly.service";
import {
  ASSEMBLE_TASK,
  ASSEMBLY_FIX_TASK,
  type ControlledAssemblyTaskInput,
} from "../agents/controlled-assembly";
import { buildM1ebGoldenAssemblyInputs } from "../design/m1eb-golden";
import { deriveCopySlotDefinitions } from "../assembly/copy-slot-derivation";
import { validateControlledAssembly } from "../assembly/controlled-assembly-validator";
import { sha256CanonicalJson } from "./eval-provenance";

const REPOSITORY_ROOT = realpathSync(resolve(__dirname, "../../../../.."));

const CAPTURED_ASSEMBLE_VALIDATE_OUTPUT = (() => {
  const validator = ASSEMBLE_TASK.validateOutput;
  if (!validator) throw new Error("assemble output validator is unavailable");
  return validator;
})();
const CAPTURED_ASSEMBLY_FIX_VALIDATE_OUTPUT = (() => {
  const validator = ASSEMBLY_FIX_TASK.validateOutput;
  if (!validator) {
    throw new Error("assembly_fix output validator is unavailable");
  }
  return validator;
})();

export const CONTROLLED_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION =
  "site-builder-controlled-assembly-eval-fixture/v1" as const;
export const CONTROLLED_ASSEMBLY_EVALUATOR_VERSION =
  "site-builder-controlled-assembly-evaluator/2026-08-04-v1" as const;
export const CONTROLLED_ASSEMBLY_ROUTE_VALIDATION_VERSION =
  "site-builder-controlled-assembly-route-validation/2026-08-04-v1" as const;
export const CONTROLLED_ASSEMBLY_PROMPT_VERSION =
  "site-builder-controlled-assembly-prompt/2026-08-04-v1" as const;

export const CONTROLLED_ASSEMBLY_EVALUATOR_RUBRIC = Object.freeze({
  closedOutputShape: true,
  productionValidator: "ControlledAssemblyService.parseSelection",
  productionMaterializer: "buildSpec",
  productionSemanticValidator: "validateControlledAssembly",
  fixtureSource: "M1-e-B approved golden sparse/rich matrix",
  taskShape: Object.freeze({
    assemble: "initial selection",
    assembly_fix: "bound prior candidate digest and validator findings",
  }),
  freeFormPropsAllowed: false,
  prohibitedBehavior: Object.freeze([
    "invent_page",
    "invent_section",
    "invent_copy_slot",
    "invent_asset_reference",
    "invent_claim_reference",
    "bypass_sitespec_validator",
  ]),
} as const);

export interface ControlledAssemblyEvalFixture {
  schemaVersion: typeof CONTROLLED_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION;
  fixtureId: string;
  sourceFixtureId: string;
  mode: "sparse" | "rich";
  taskId: "site_builder.assemble" | "site_builder.assembly_fix";
  input: ControlledAssemblyTaskInput;
  expectedOutput: AssemblySelection;
}

export interface PreparedControlledAssemblyEvalFixture {
  fixture: ControlledAssemblyEvalFixture;
  input: ControlledAssemblyTaskInput;
  assembly: DeterministicAssemblyInput;
}

export interface ControlledAssemblyEvaluationOutcome {
  semanticAssemblyPassed: boolean;
  productionValidationPassed: boolean;
  explicitSelectionPassed: boolean;
  specDigest: string;
  findingCodes: string[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function invalidCandidateFindings(
  assembly: DeterministicAssemblyInput,
): { digest: string; findings: AssemblyFinding[] } {
  const copyKeys = Object.keys(
    assembly.copyBundleSet.bundles[assembly.copyBundleSet.sourceLocale]!.slots,
  ).sort();
  const valid = evaluateControlledAssemblySelection({
    assembly,
    selection: deterministicControlledAssemblySelection({
      brief: assembly.brief,
      catalog: assembly.catalog,
      copyKeys,
      assetIds: Object.keys(assembly.assets).sort(),
      claimIds: assembly.claimSnapshot.items.map((item) => item.claimId),
    }),
  });
  const candidate = structuredClone(valid.spec);
  candidate.pages[0]!.puck.content.shift();
  const copySlots = deriveCopySlotDefinitions({
    brief: assembly.brief,
    catalog: assembly.catalog,
    templates: assembly.templates,
  });
  const findings = validateControlledAssembly({
    spec: candidate,
    brief: assembly.brief,
    catalog: assembly.catalog,
    claimSnapshot: assembly.claimSnapshot,
    copySlots,
  });
  if (findings.length === 0) {
    throw new Error("controlled assembly repair fixture has no finding");
  }
  return { digest: sha256CanonicalJson(candidate), findings };
}

function taskInput(
  assembly: DeterministicAssemblyInput,
  taskId: ControlledAssemblyEvalFixture["taskId"],
): ControlledAssemblyTaskInput {
  const shared = {
    designBriefDigest: assembly.brief.digest,
    allowedSectionTargets: controlledAssemblySectionTargets({
      brief: assembly.brief,
      catalog: assembly.catalog,
    }),
    allowedCopySlotKeys: Object.keys(
      assembly.copyBundleSet.bundles[assembly.copyBundleSet.sourceLocale]!.slots,
    ).sort(),
    allowedAssetReferenceIds: Object.keys(assembly.assets).sort(),
    allowedClaimIds: assembly.claimSnapshot.items.map((item) => item.claimId),
  };
  if (taskId === "site_builder.assemble") {
    return { ...shared, findings: [] };
  }
  const previous = invalidCandidateFindings(assembly);
  return {
    ...shared,
    previousCandidateDigest: previous.digest,
    findings: previous.findings,
  };
}

const GOLDEN_ASSEMBLY_INPUTS = buildM1ebGoldenAssemblyInputs(REPOSITORY_ROOT);
const GOLDEN_ASSEMBLY_BY_ID = new Map(
  GOLDEN_ASSEMBLY_INPUTS.map((entry) => [entry.id, entry]),
);

export const CONTROLLED_ASSEMBLY_EVAL_FIXTURES: readonly ControlledAssemblyEvalFixture[] =
  deepFreeze(
    GOLDEN_ASSEMBLY_INPUTS.flatMap((source) =>
      (["site_builder.assemble", "site_builder.assembly_fix"] as const).map(
        (taskId) => ({
          schemaVersion: CONTROLLED_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
          fixtureId: `${taskId === "site_builder.assemble" ? "assemble" : "assembly-fix"}-${source.id}`,
          sourceFixtureId: source.id,
          mode: source.mode,
          taskId,
          input: taskInput(source.assembly, taskId),
          expectedOutput: deterministicControlledAssemblySelection({
            brief: source.assembly.brief,
            catalog: source.assembly.catalog,
            copyKeys: Object.keys(
              source.assembly.copyBundleSet.bundles[
                source.assembly.copyBundleSet.sourceLocale
              ]!.slots,
            ).sort(),
            assetIds: Object.keys(source.assembly.assets).sort(),
            claimIds: source.assembly.claimSnapshot.items.map(
              (item) => item.claimId,
            ),
          }),
        }),
      ),
    ),
  );

function taskValidator(
  taskId: ControlledAssemblyEvalFixture["taskId"],
) {
  return taskId === "site_builder.assemble"
    ? CAPTURED_ASSEMBLE_VALIDATE_OUTPUT
    : CAPTURED_ASSEMBLY_FIX_VALIDATE_OUTPUT;
}

const PREPARED_CANONICAL_FIXTURES = new WeakMap<
  ControlledAssemblyEvalFixture,
  PreparedControlledAssemblyEvalFixture
>();
const CANONICAL_FIXTURES = new WeakSet(CONTROLLED_ASSEMBLY_EVAL_FIXTURES);

export function prepareControlledAssemblyEvalFixture(
  fixture: ControlledAssemblyEvalFixture,
): PreparedControlledAssemblyEvalFixture {
  const cached =
    CANONICAL_FIXTURES.has(fixture) && PREPARED_CANONICAL_FIXTURES.get(fixture);
  if (cached) return cached;
  const copy = structuredClone(fixture);
  const source = GOLDEN_ASSEMBLY_BY_ID.get(copy.sourceFixtureId);
  if (
    !source ||
    copy.schemaVersion !== CONTROLLED_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION ||
    copy.mode !== source.mode ||
    !copy.fixtureId.endsWith(`-${copy.sourceFixtureId}`) ||
    JSON.stringify(Object.keys(copy).sort()) !==
      JSON.stringify(
        [
          "schemaVersion",
          "fixtureId",
          "sourceFixtureId",
          "mode",
          "taskId",
          "input",
          "expectedOutput",
        ].sort(),
      ) ||
    JSON.stringify(copy.input) !== JSON.stringify(taskInput(source.assembly, copy.taskId))
  ) {
    throw new Error(`invalid controlled assembly fixture: ${copy.fixtureId}`);
  }
  taskValidator(copy.taskId)(copy.input, copy.expectedOutput);
  const expected = evaluateControlledAssemblySelection({
    assembly: source.assembly,
    selection: copy.expectedOutput,
  });
  if (expected.findings.length > 0) {
    throw new Error(
      `controlled assembly expected output is not valid: ${copy.fixtureId}`,
    );
  }
  const prepared = deepFreeze({
    fixture: copy,
    input: copy.input,
    assembly: source.assembly,
  });
  if (CANONICAL_FIXTURES.has(fixture)) {
    PREPARED_CANONICAL_FIXTURES.set(fixture, prepared);
  }
  return prepared;
}

export function evaluateControlledAssemblyOutput(
  prepared: PreparedControlledAssemblyEvalFixture,
  output: AssemblySelection,
): ControlledAssemblyEvaluationOutcome {
  taskValidator(prepared.fixture.taskId)(prepared.input, output);
  const evaluated = evaluateControlledAssemblySelection({
    assembly: prepared.assembly,
    selection: output,
  });
  const explicitSelectionPassed =
    sha256CanonicalJson(evaluated.selection) ===
    sha256CanonicalJson(prepared.fixture.expectedOutput);
  const findingCodes = [
    ...(explicitSelectionPassed ? [] : ["selection_mismatch"]),
    ...evaluated.findings.map((finding) => finding.code),
  ].sort();
  return {
    semanticAssemblyPassed:
      explicitSelectionPassed && evaluated.findings.length === 0,
    productionValidationPassed: true,
    explicitSelectionPassed,
    specDigest: sha256CanonicalJson(evaluated.spec),
    findingCodes,
  };
}
