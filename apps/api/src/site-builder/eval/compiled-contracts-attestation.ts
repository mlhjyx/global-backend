import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

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

export function buildCompiledContractsAttestation(options: {
  repositoryRoot: string;
  fixedCommitSha: string;
}): CompiledContractsAttestation {
  const trackedSourceFiles = trackedContractsAtFixedCommit(
    options.repositoryRoot,
    options.fixedCommitSha,
  );
  const contractsDist = resolve(
    options.repositoryRoot,
    "packages/contracts/dist",
  );
  rmSync(contractsDist, { recursive: true, force: true });
  execFileSync("pnpm", ["--filter", "@global/contracts", "build"], {
    cwd: options.repositoryRoot,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    },
  });
  const compiledArtifacts = compiledContractArtifacts(options.repositoryRoot);
  return {
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
    suiteImportedAfterBuild: true,
  };
}

export function assertCompiledContractsAttestationStable(
  repositoryRoot: string,
  expected: CompiledContractsAttestation,
): void {
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
