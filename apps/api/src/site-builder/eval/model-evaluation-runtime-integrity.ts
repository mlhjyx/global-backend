import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { SiteBuilderTaskId } from "../agents/task-route-bindings";
import {
  compiledContractsRuntimeBindingMatches,
  readCompiledContractsRuntimeBinding,
  type CompiledContractsRuntimeBinding,
} from "./compiled-contracts-attestation";
import { DESIGN_SPEC_COMPILED_CONTRACTS_RUNTIME_BINDING } from "./design-spec-compiled-contracts-runtime";

const REPOSITORY_ROOT = realpathSync(resolve(__dirname, "../../../../.."));
const COMPILED_CONTRACTS_RUNTIME_AT_MODULE_LOAD = (() => {
  try {
    return Object.freeze(readCompiledContractsRuntimeBinding(REPOSITORY_ROOT));
  } catch {
    return null;
  }
})();

export class ModelEvaluationRuntimeIntegrityError extends Error {
  readonly failureCode =
    "compiled_contracts_runtime_attestation_mismatch" as const;

  constructor() {
    super("compiled contracts runtime attestation mismatch");
    this.name = "ModelEvaluationRuntimeIntegrityError";
  }
}

export function expectedModelEvaluationCompiledRuntimeBinding(
  taskId: SiteBuilderTaskId,
): CompiledContractsRuntimeBinding | null {
  return taskId === "site_builder.design_spec"
    ? DESIGN_SPEC_COMPILED_CONTRACTS_RUNTIME_BINDING
    : null;
}

export function modelEvaluationRuntimeIntegrityMatches(
  taskId: SiteBuilderTaskId,
): boolean {
  const expected = expectedModelEvaluationCompiledRuntimeBinding(taskId);
  if (expected === null) return true;
  if (
    COMPILED_CONTRACTS_RUNTIME_AT_MODULE_LOAD === null ||
    !compiledContractsRuntimeBindingMatches(
      expected,
      COMPILED_CONTRACTS_RUNTIME_AT_MODULE_LOAD,
    )
  ) {
    return false;
  }
  try {
    return compiledContractsRuntimeBindingMatches(
      expected,
      readCompiledContractsRuntimeBinding(REPOSITORY_ROOT),
    );
  } catch {
    return false;
  }
}

export function assertModelEvaluationRuntimeIntegrity(
  taskId: SiteBuilderTaskId,
): void {
  if (!modelEvaluationRuntimeIntegrityMatches(taskId)) {
    throw new ModelEvaluationRuntimeIntegrityError();
  }
}
