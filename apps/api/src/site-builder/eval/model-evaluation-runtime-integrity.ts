import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { SiteBuilderTaskId } from "../agents/task-route-bindings";
import {
  compiledContractsRuntimeBindingMatches,
  readCompiledContractsRuntimeBinding,
  type CompiledContractsRuntimeBinding,
} from "./compiled-contracts-attestation";
import {
  DESIGN_SPEC_COMPILED_CONTRACT_ARTIFACTS,
  DESIGN_SPEC_COMPILED_CONTRACTS_RUNTIME_BINDING,
  DESIGN_SPEC_EXPECTED_LOADED_CONTRACTS_RUNTIME_FINGERPRINT,
} from "./design-spec-compiled-contracts-runtime";
import { DESIGN_SPEC_LOADED_CONTRACTS_RUNTIME_FINGERPRINT } from "./design-spec-loaded-contracts-runtime";

const REPOSITORY_ROOT = realpathSync(resolve(__dirname, "../../../../.."));
const CONTRACTS_DIST_ROOT = resolve(REPOSITORY_ROOT, "packages/contracts/dist");
const RUNTIME_OBJECT_KEYS = Object.keys;
const RUNTIME_OBJECT_FREEZE = Object.freeze;
const APPLY_RUNTIME_INTRINSIC = Reflect.apply;
const MODULE_CACHE = require.cache;

interface LoadedContractsModuleIdentity {
  path: string;
  module: NodeModule;
}

function freezeRuntimeObject<T extends object>(value: T): Readonly<T> {
  return APPLY_RUNTIME_INTRINSIC(RUNTIME_OBJECT_FREEZE, Object, [value]) as T;
}

function loadedContractsModuleIdentities(): readonly LoadedContractsModuleIdentity[] {
  const cachePaths = APPLY_RUNTIME_INTRINSIC(RUNTIME_OBJECT_KEYS, Object, [
    MODULE_CACHE,
  ]) as string[];
  return freezeRuntimeObject(
    cachePaths
      .flatMap((cachePath) => {
        let realCachePath: string;
        try {
          realCachePath = realpathSync(cachePath);
        } catch {
          return [];
        }
        const pathFromDist = relative(CONTRACTS_DIST_ROOT, realCachePath);
        if (
          pathFromDist === "" ||
          pathFromDist === ".." ||
          pathFromDist.startsWith(`..${sep}`) ||
          isAbsolute(pathFromDist) ||
          !pathFromDist.endsWith(".js")
        ) {
          return [];
        }
        const module = MODULE_CACHE[cachePath];
        if (!module) return [];
        return [
          freezeRuntimeObject({
            path: `packages/contracts/dist/${pathFromDist
              .split(sep)
              .join("/")}`,
            module,
          }),
        ];
      })
      .sort(({ path: left }, { path: right }) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
  );
}

let BOUND_LOADED_CONTRACTS_MODULES:
  readonly LoadedContractsModuleIdentity[] | null = null;

function loadedContractsModuleIdentityMatches(): boolean {
  const observed = loadedContractsModuleIdentities();
  if (
    observed.length === 0 ||
    observed.some(
      ({ path }) =>
        !DESIGN_SPEC_COMPILED_CONTRACT_ARTIFACTS.some(
          (artifact) => artifact.path === path,
        ),
    )
  ) {
    return false;
  }
  if (BOUND_LOADED_CONTRACTS_MODULES === null) {
    BOUND_LOADED_CONTRACTS_MODULES = observed;
    return true;
  }
  const bound = BOUND_LOADED_CONTRACTS_MODULES;
  return (
    observed.length === bound.length &&
    observed.every(
      ({ path, module }, index) =>
        bound[index]?.path === path && bound[index]?.module === module,
    )
  );
}

const COMPILED_CONTRACTS_RUNTIME_AT_MODULE_LOAD = (() => {
  try {
    return freezeRuntimeObject(
      readCompiledContractsRuntimeBinding(REPOSITORY_ROOT),
    );
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
    DESIGN_SPEC_LOADED_CONTRACTS_RUNTIME_FINGERPRINT !==
      DESIGN_SPEC_EXPECTED_LOADED_CONTRACTS_RUNTIME_FINGERPRINT ||
    !compiledContractsRuntimeBindingMatches(
      expected,
      COMPILED_CONTRACTS_RUNTIME_AT_MODULE_LOAD,
    ) ||
    !loadedContractsModuleIdentityMatches()
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
