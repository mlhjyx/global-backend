import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION =
  "site-builder-compiled-contracts-attestation/v1" as const;
export const COMPILED_CONTRACTS_BUILD_ID =
  "site-builder-contracts-fixed-commit-build/2026-07-30-v1" as const;
export const COMPILED_CONTRACTS_BUILD_COMMAND =
  "pnpm --filter @global/contracts build" as const;
export const COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT =
  "packages/contracts/dist/index.js" as const;

export interface CompiledContractsAttestation {
  schemaVersion: typeof COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION;
  buildId: typeof COMPILED_CONTRACTS_BUILD_ID;
  buildCommand: typeof COMPILED_CONTRACTS_BUILD_COMMAND;
  fixedCommitSha: string;
  trackedSourceFiles: readonly {
    path: string;
    sha256: string;
  }[];
  trackedSourceTreeSha256: string;
  runtimeEntrypoint: typeof COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT;
  compiledArtifacts: readonly {
    path: string;
    sha256: string;
  }[];
  compiledArtifactTreeSha256: string;
  staleOutputRemovedBeforeBuild: true;
  suiteImportedAfterBuild: true;
}

export interface CompiledContractsBuildReceipt {
  schemaVersion: typeof COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION;
  buildId: typeof COMPILED_CONTRACTS_BUILD_ID;
  buildCommand: typeof COMPILED_CONTRACTS_BUILD_COMMAND;
  fixedCommitSha: string;
  trackedSourceFiles: readonly {
    path: string;
    sha256: string;
  }[];
  trackedSourceTreeSha256: string;
  runtimeEntrypoint: typeof COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT;
  compiledArtifacts: readonly {
    path: string;
    sha256: string;
  }[];
  compiledArtifactTreeSha256: string;
  staleOutputRemovedBeforeBuild: true;
}

export interface CompiledContractsSuiteImportReceipt {
  readonly kind: "compiled_contracts_suite_import_receipt";
}

export interface CompiledContractsRuntimeBinding {
  schemaVersion: typeof COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION;
  buildId: typeof COMPILED_CONTRACTS_BUILD_ID;
  runtimeEntrypoint: typeof COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT;
  compiledArtifactCount: number;
  compiledArtifactTreeSha256: string;
}

export interface CompiledContractArtifactFingerprint {
  path: string;
  sha256: string;
}

const ATTESTATION_OBJECT_FREEZE = Object.freeze;
const ATTESTATION_OBJECT_IS_FROZEN = Object.isFrozen;
const ATTESTATION_OBJECT_KEYS = Object.keys;
const ATTESTATION_OBJECT_VALUES = Object.values;
const ATTESTATION_WEAK_SET_ADD = WeakSet.prototype.add;
const ATTESTATION_WEAK_SET_HAS = WeakSet.prototype.has;
const ATTESTATION_WEAK_MAP_GET = WeakMap.prototype.get;
const ATTESTATION_WEAK_MAP_SET = WeakMap.prototype.set;
const ATTESTATION_MAP_GET = Map.prototype.get;
const ATTESTATION_MAP_SET = Map.prototype.set;
const ATTESTATION_ARRAY_SOME = Array.prototype.some;
const APPLY_ATTESTATION_INTRINSIC = Reflect.apply;

const TRUSTED_COMPILED_CONTRACTS_BUILD_RECEIPTS = new WeakSet<object>();
const TRUSTED_COMPILED_CONTRACTS_SUITE_IMPORT_RECEIPTS = new WeakSet<object>();
const TRUSTED_COMPILED_CONTRACTS_ATTESTATIONS = new WeakSet<object>();
const LATEST_BUILD_TOKEN_BY_REPOSITORY = new Map<string, object>();
const BUILD_RECEIPT_METADATA = new WeakMap<
  object,
  Readonly<{ repositoryRoot: string; buildToken: object }>
>();
const SUITE_IMPORT_RECEIPT_METADATA = new WeakMap<
  object,
  Readonly<{
    repositoryRoot: string;
    observedBuildToken: object | null;
    runtimeBinding: CompiledContractsRuntimeBinding | null;
  }>
>();
const ATTESTATION_SUITE_IMPORT_BINDING = new WeakMap<object, object>();

function intrinsicWeakSetAdd(set: WeakSet<object>, value: object): void {
  APPLY_ATTESTATION_INTRINSIC(ATTESTATION_WEAK_SET_ADD, set, [value]);
}

function intrinsicWeakSetHas(set: WeakSet<object>, value: object): boolean {
  return APPLY_ATTESTATION_INTRINSIC(ATTESTATION_WEAK_SET_HAS, set, [
    value,
  ]) as boolean;
}

function intrinsicWeakMapGet<T>(
  map: WeakMap<object, T>,
  key: object,
): T | undefined {
  return APPLY_ATTESTATION_INTRINSIC(ATTESTATION_WEAK_MAP_GET, map, [key]) as
    T | undefined;
}

function intrinsicWeakMapSet<T>(
  map: WeakMap<object, T>,
  key: object,
  value: T,
): void {
  APPLY_ATTESTATION_INTRINSIC(ATTESTATION_WEAK_MAP_SET, map, [key, value]);
}

function intrinsicMapGet<T>(map: Map<string, T>, key: string): T | undefined {
  return APPLY_ATTESTATION_INTRINSIC(ATTESTATION_MAP_GET, map, [key]) as
    T | undefined;
}

function intrinsicMapSet<T>(map: Map<string, T>, key: string, value: T): void {
  APPLY_ATTESTATION_INTRINSIC(ATTESTATION_MAP_SET, map, [key, value]);
}

function intrinsicObjectIsFrozen(value: object): boolean {
  return APPLY_ATTESTATION_INTRINSIC(ATTESTATION_OBJECT_IS_FROZEN, Object, [
    value,
  ]) as boolean;
}

function intrinsicArraySome<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): boolean {
  return APPLY_ATTESTATION_INTRINSIC(ATTESTATION_ARRAY_SOME, values, [
    predicate,
  ]) as boolean;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !intrinsicObjectIsFrozen(value)) {
    const children = APPLY_ATTESTATION_INTRINSIC(
      ATTESTATION_OBJECT_VALUES,
      Object,
      [value],
    ) as unknown[];
    for (const nested of children) deepFreeze(nested);
    APPLY_ATTESTATION_INTRINSIC(ATTESTATION_OBJECT_FREEZE, Object, [value]);
  }
  return value;
}

function assertCompiledContractsRuntimeNotCached(repositoryRoot: string): void {
  const contractsDist = resolve(repositoryRoot, "packages/contracts/dist");
  const cachedModulePaths = APPLY_ATTESTATION_INTRINSIC(
    ATTESTATION_OBJECT_KEYS,
    Object,
    [require.cache],
  ) as string[];
  if (
    intrinsicArraySome(cachedModulePaths, (cachedPath) => {
      const pathFromDist = relative(contractsDist, cachedPath);
      return (
        pathFromDist === "" ||
        (!pathFromDist.startsWith(`..${sep}`) &&
          pathFromDist !== ".." &&
          !isAbsolute(pathFromDist))
      );
    })
  ) {
    throw new Error(
      "compiled contracts runtime must not be imported before the trusted build",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") {
    throw new Error("contracts attestation must be JSON serializable");
  }
  return encoded;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixedCommitFile(
  repositoryRoot: string,
  fixedCommitSha: string,
  path: string,
): Buffer {
  try {
    return execFileSync("git", ["show", `${fixedCommitSha}:${path}`], {
      cwd: repositoryRoot,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${path} must be tracked at the fixed commit`);
  }
}

function trackedContractsAtFixedCommit(
  repositoryRoot: string,
  fixedCommitSha: string,
) {
  const paths = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      fixedCommitSha,
      "--",
      "packages/contracts",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  if (paths.length === 0) {
    throw new Error("fixed commit has no tracked contracts source tree");
  }
  return paths.map((path) => {
    const committed = fixedCommitFile(repositoryRoot, fixedCommitSha, path);
    const working = readFileSync(resolve(repositoryRoot, path));
    if (!working.equals(committed)) {
      throw new Error(`${path} drifted from the fixed commit`);
    }
    return { path, sha256: sha256(committed) };
  });
}

function compiledContractArtifacts(repositoryRoot: string) {
  const realRoot = realpathSync(repositoryRoot);
  const realDist = realpathSync(
    resolve(repositoryRoot, "packages/contracts/dist"),
  );
  const relativeDist = relative(realRoot, realDist);
  if (
    relativeDist !== "packages/contracts/dist" ||
    relativeDist.startsWith(`..${sep}`)
  ) {
    throw new Error("compiled contracts output escaped the repository");
  }
  const pending = [realDist];
  const paths: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("compiled contracts output must not contain symlinks");
      }
      if (metadata.isDirectory()) {
        pending.push(absolute);
      } else if (metadata.isFile() && name.endsWith(".js")) {
        paths.push(relative(realRoot, absolute).split(sep).join("/"));
      }
    }
  }
  paths.sort();
  if (!paths.includes(COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT)) {
    throw new Error("compiled contracts runtime entrypoint is missing");
  }
  return paths.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(realRoot, path))),
  }));
}

export function readCompiledContractsRuntimeBinding(
  repositoryRoot: string,
): CompiledContractsRuntimeBinding {
  const compiledArtifacts = compiledContractArtifacts(repositoryRoot);
  return {
    schemaVersion: COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION,
    buildId: COMPILED_CONTRACTS_BUILD_ID,
    runtimeEntrypoint: COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
    compiledArtifactCount: compiledArtifacts.length,
    compiledArtifactTreeSha256: sha256(canonicalJson(compiledArtifacts)),
  };
}

export function compiledContractsRuntimeBindingFromAttestation(
  attestation: CompiledContractsAttestation,
): CompiledContractsRuntimeBinding {
  return compiledContractsRuntimeBindingFromArtifacts(
    attestation.compiledArtifacts,
  );
}

export function compiledContractsRuntimeBindingFromArtifacts(
  compiledArtifacts: readonly CompiledContractArtifactFingerprint[],
): CompiledContractsRuntimeBinding {
  return {
    schemaVersion: COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION,
    buildId: COMPILED_CONTRACTS_BUILD_ID,
    runtimeEntrypoint: COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
    compiledArtifactCount: compiledArtifacts.length,
    compiledArtifactTreeSha256: sha256(canonicalJson(compiledArtifacts)),
  };
}

export function compiledContractsRuntimeBindingMatches(
  expected: CompiledContractsRuntimeBinding,
  observed: CompiledContractsRuntimeBinding,
): boolean {
  return (
    expected.schemaVersion === observed.schemaVersion &&
    expected.buildId === observed.buildId &&
    expected.runtimeEntrypoint === observed.runtimeEntrypoint &&
    expected.compiledArtifactCount === observed.compiledArtifactCount &&
    expected.compiledArtifactTreeSha256 === observed.compiledArtifactTreeSha256
  );
}

export function buildCompiledContractsForSuiteImport(options: {
  repositoryRoot: string;
  fixedCommitSha: string;
}): CompiledContractsBuildReceipt {
  const repositoryRoot = realpathSync(options.repositoryRoot);
  assertCompiledContractsRuntimeNotCached(repositoryRoot);
  const trackedSourceFiles = trackedContractsAtFixedCommit(
    repositoryRoot,
    options.fixedCommitSha,
  );
  const contractsDist = resolve(repositoryRoot, "packages/contracts/dist");
  rmSync(contractsDist, { recursive: true, force: true });
  execFileSync("pnpm", ["--filter", "@global/contracts", "build"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    },
  });
  const compiledArtifacts = compiledContractArtifacts(repositoryRoot);
  const receipt: CompiledContractsBuildReceipt = deepFreeze({
    schemaVersion: COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION,
    buildId: COMPILED_CONTRACTS_BUILD_ID,
    buildCommand: COMPILED_CONTRACTS_BUILD_COMMAND,
    fixedCommitSha: options.fixedCommitSha,
    trackedSourceFiles,
    trackedSourceTreeSha256: sha256(canonicalJson(trackedSourceFiles)),
    runtimeEntrypoint: COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
    compiledArtifacts,
    compiledArtifactTreeSha256: sha256(canonicalJson(compiledArtifacts)),
    staleOutputRemovedBeforeBuild: true,
  });
  const buildToken = deepFreeze({});
  intrinsicMapSet(LATEST_BUILD_TOKEN_BY_REPOSITORY, repositoryRoot, buildToken);
  intrinsicWeakMapSet(BUILD_RECEIPT_METADATA, receipt, {
    repositoryRoot,
    buildToken,
  });
  intrinsicWeakSetAdd(TRUSTED_COMPILED_CONTRACTS_BUILD_RECEIPTS, receipt);
  return receipt;
}

export function captureCompiledContractsSuiteImport(
  repositoryRoot: string,
): CompiledContractsSuiteImportReceipt {
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const runtimeBinding: CompiledContractsRuntimeBinding | null = (() => {
    try {
      return deepFreeze(
        readCompiledContractsRuntimeBinding(realRepositoryRoot),
      );
    } catch {
      return null;
    }
  })();
  const receipt: CompiledContractsSuiteImportReceipt = deepFreeze({
    kind: "compiled_contracts_suite_import_receipt",
  });
  intrinsicWeakMapSet(SUITE_IMPORT_RECEIPT_METADATA, receipt, {
    repositoryRoot: realRepositoryRoot,
    observedBuildToken:
      intrinsicMapGet(LATEST_BUILD_TOKEN_BY_REPOSITORY, realRepositoryRoot) ??
      null,
    runtimeBinding,
  });
  intrinsicWeakSetAdd(
    TRUSTED_COMPILED_CONTRACTS_SUITE_IMPORT_RECEIPTS,
    receipt,
  );
  return receipt;
}

export function attestCompiledContractsAfterSuiteImport(
  buildReceipt: CompiledContractsBuildReceipt,
  suiteImportReceipt: CompiledContractsSuiteImportReceipt,
): CompiledContractsAttestation {
  if (
    !intrinsicWeakSetHas(
      TRUSTED_COMPILED_CONTRACTS_BUILD_RECEIPTS,
      buildReceipt,
    ) ||
    !intrinsicWeakSetHas(
      TRUSTED_COMPILED_CONTRACTS_SUITE_IMPORT_RECEIPTS,
      suiteImportReceipt,
    )
  ) {
    throw new Error("compiled contracts build/import receipt is not trusted");
  }
  const buildMetadata = intrinsicWeakMapGet(
    BUILD_RECEIPT_METADATA,
    buildReceipt,
  );
  const importMetadata = intrinsicWeakMapGet(
    SUITE_IMPORT_RECEIPT_METADATA,
    suiteImportReceipt,
  );
  if (
    !buildMetadata ||
    !importMetadata ||
    buildMetadata.repositoryRoot !== importMetadata.repositoryRoot ||
    importMetadata.observedBuildToken !== buildMetadata.buildToken ||
    importMetadata.runtimeBinding === null ||
    !compiledContractsRuntimeBindingMatches(
      compiledContractsRuntimeBindingFromArtifacts(
        buildReceipt.compiledArtifacts,
      ),
      importMetadata.runtimeBinding,
    )
  ) {
    throw new Error(
      "compiled contracts suite must be imported after the trusted build",
    );
  }
  const attestation: CompiledContractsAttestation = deepFreeze({
    ...buildReceipt,
    suiteImportedAfterBuild: true,
  });
  intrinsicWeakMapSet(
    ATTESTATION_SUITE_IMPORT_BINDING,
    attestation,
    suiteImportReceipt,
  );
  intrinsicWeakSetAdd(TRUSTED_COMPILED_CONTRACTS_ATTESTATIONS, attestation);
  return attestation;
}

export function isTrustedCompiledContractsAttestation(
  value: unknown,
): value is CompiledContractsAttestation {
  return (
    typeof value === "object" &&
    value !== null &&
    intrinsicObjectIsFrozen(value) &&
    intrinsicWeakSetHas(TRUSTED_COMPILED_CONTRACTS_ATTESTATIONS, value)
  );
}

export function isCompiledContractsAttestationBoundToSuiteImport(
  attestation: CompiledContractsAttestation,
  suiteImportReceipt: CompiledContractsSuiteImportReceipt,
): boolean {
  return (
    isTrustedCompiledContractsAttestation(attestation) &&
    intrinsicWeakSetHas(
      TRUSTED_COMPILED_CONTRACTS_SUITE_IMPORT_RECEIPTS,
      suiteImportReceipt,
    ) &&
    intrinsicWeakMapGet(ATTESTATION_SUITE_IMPORT_BINDING, attestation) ===
      suiteImportReceipt
  );
}

export function assertCompiledContractsAttestationStable(
  repositoryRoot: string,
  expected: CompiledContractsAttestation,
): void {
  if (!isTrustedCompiledContractsAttestation(expected)) {
    throw new Error("compiled contracts attestation is not builder-trusted");
  }
  const trackedSourceFiles = trackedContractsAtFixedCommit(
    repositoryRoot,
    expected.fixedCommitSha,
  );
  const compiledArtifacts = compiledContractArtifacts(repositoryRoot);
  if (
    sha256(canonicalJson(trackedSourceFiles)) !==
      expected.trackedSourceTreeSha256 ||
    sha256(canonicalJson(compiledArtifacts)) !==
      expected.compiledArtifactTreeSha256
  ) {
    throw new Error("compiled contracts drifted during suite preparation");
  }
}
