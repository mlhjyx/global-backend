import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  evaluateDynamicMechanisms,
  MechanismObservation,
} from "./dynamic-mechanisms";
import { extractAstro } from "./extractors/astro";
import { extractAiAndTools } from "./extractors/ai-tools";
import { extractGovernance } from "./extractors/governance";
import { extractInfrastructure } from "./extractors/infrastructure";
import { extractOssRegistry } from "./extractors/oss-registry";
import { extractPrisma } from "./extractors/prisma";
import { extractTraceability } from "./extractors/traceability";
import { extractTypeScript } from "./extractors/typescript";
import { extractWorkspace } from "./extractors/workspace";
import { GraphBuilder } from "./graph";
import {
  ContractGraphV1,
  CoverageReportV1,
  EvidenceRefV1,
  GraphDiagnosticV1,
} from "./schema";
import { readUtf8, relativePath, sha256, stableJson, walkFiles } from "./utils";

const execFile = promisify(execFileCallback);

const SOURCE_ROOT = /^(?:apps|packages|scripts|docs|infra|\.github|\.agents)\//;
const BINARY_EXTENSIONS =
  /\.(?:7z|avi|avif|bmp|class|db|dmg|docx?|eot|exe|gif|gz|ico|jpe?g|mov|mp3|mp4|o|ogg|otf|pdf|png|pptx?|pyc|sqlite3?|tar|tiff?|ttf|wav|webm|webp|woff2?|xlsx?|zip)$/i;

function isSensitiveSourcePath(relative: string): boolean {
  if (/(?:^|\/)\.env(?:\.|$)/.test(relative)) return true;
  const segments = relative.toLowerCase().split("/");
  if (
    segments.some((segment) =>
      [".secrets", "credentials", "secrets"].includes(segment),
    )
  ) {
    return true;
  }
  const basename = segments.at(-1) ?? "";
  return (
    /^(?:credentials?|service-account|service_account|secrets?)(?:[._-].*)?\.json$/.test(
      basename,
    ) ||
    /^(?:id_rsa|id_ed25519)(?:\.pub)?$/.test(basename) ||
    /\.(?:pem|key|p12|pfx|crt|cer|der)$/.test(basename)
  );
}

function isProbablyText(value: Buffer): boolean {
  if (value.includes(0)) return false;
  let disallowedControls = 0;
  for (const byte of value) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      disallowedControls += 1;
    }
  }
  return value.length === 0 || disallowedControls / value.length < 0.01;
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function canonicalMainWorktree(repositoryRoot: string): Promise<string> {
  const porcelain = await git(repositoryRoot, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const records = porcelain.split(/\n\n+/);
  for (const record of records) {
    const lines = record.split("\n");
    if (lines.includes("branch refs/heads/main")) {
      const value = lines
        .find((line) => line.startsWith("worktree "))
        ?.slice(9);
      if (value) return path.resolve(value);
    }
  }
  return path.resolve(repositoryRoot);
}

export async function computeSourceHash(
  repositoryRoot: string,
): Promise<string> {
  const files = await walkFiles(repositoryRoot, (relative) => {
    if (!SOURCE_ROOT.test(relative) && relative.includes("/")) return false;
    if (relative.startsWith("docs/archive/")) return false;
    if (/^(?:tmp|template)\//.test(relative)) return false;
    if (isSensitiveSourcePath(relative)) return false;
    return !BINARY_EXTENSIONS.test(relative);
  });
  const entries: string[] = [];
  for (const file of files) {
    const relative = relativePath(repositoryRoot, file);
    const contents = await readFile(file);
    if (!isProbablyText(contents)) continue;
    entries.push(`${relative}\u0000${sha256(contents)}`);
  }
  return sha256(entries.join("\n"));
}

export async function createEvidence(
  repositoryRoot: string,
): Promise<EvidenceRefV1> {
  const resolved = path.resolve(repositoryRoot);
  const [branch, commit, commitTime, status, sourceHash, mainWorktree] =
    await Promise.all([
      git(resolved, ["branch", "--show-current"]),
      git(resolved, ["rev-parse", "HEAD"]),
      git(resolved, ["show", "-s", "--format=%cI", "HEAD"]),
      git(resolved, ["status", "--porcelain=v1", "--untracked-files=normal"]),
      computeSourceHash(resolved),
      canonicalMainWorktree(resolved),
    ]);
  return {
    schemaVersion: "evidence-ref/v1",
    repositoryRoot: mainWorktree,
    worktreePath: resolved,
    branch: branch || "DETACHED",
    commit,
    commitTime,
    dirty: status.length > 0,
    sourceHash,
  };
}

async function configurationObservations(
  repositoryRoot: string,
): Promise<MechanismObservation[]> {
  const files = await walkFiles(repositoryRoot, (relative) => {
    return (
      relative === "docker-compose.yml" ||
      relative === "pnpm-workspace.yaml" ||
      relative === "tsconfig.base.json" ||
      /^infra\/.*\.service$/.test(relative) ||
      /^\.github\/workflows\/.*\.ya?ml$/.test(relative)
    );
  });
  const output: MechanismObservation[] = [];
  for (const file of files) {
    output.push({
      path: relativePath(repositoryRoot, file),
      text: await readUtf8(file),
    });
  }
  return output;
}

export interface BuildResult {
  graph: ContractGraphV1;
  coverage: CoverageReportV1;
}

export async function buildContractGraph(
  repositoryRoot: string,
): Promise<BuildResult> {
  const resolved = path.resolve(repositoryRoot);
  const evidence = await createEvidence(resolved);
  const builder = new GraphBuilder();
  if (evidence.dirty) {
    builder.addDiagnostic({
      code: "WORKTREE_DIRTY",
      severity: "warning",
      message:
        "graph includes uncommitted or untracked source state; sourceHash binds the exact scan",
      attributes: { sourceHash: evidence.sourceHash },
    });
  }

  await extractWorkspace(builder, resolved);
  await extractGovernance(builder, resolved);
  await extractOssRegistry(builder, resolved);
  const prisma = await extractPrisma(builder, resolved);
  const sourceObservations = await extractTypeScript(builder, resolved, prisma);
  await extractAiAndTools(builder, resolved);
  await extractAstro(builder, resolved);
  await extractInfrastructure(builder, resolved);
  await extractTraceability(builder, resolved);
  const mechanisms = evaluateDynamicMechanisms(
    builder,
    [...sourceObservations, ...(await configurationObservations(resolved))],
    evidence.commitTime.slice(0, 10),
  );
  const graph = builder.finalize(evidence);
  const diagnostics = graph.diagnostics;
  const coverage: CoverageReportV1 = {
    schemaVersion: "contract-graph-coverage/v1",
    evidence,
    totals: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      files: graph.nodes.filter((node) => node.kind === "source_file").length,
      errors: diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      ).length,
      warnings: diagnostics.filter(
        (diagnostic) => diagnostic.severity === "warning",
      ).length,
    },
    mechanisms,
    unknownMechanisms: diagnostics.filter(
      (diagnostic) => diagnostic.code === "UNCLAIMED_DYNAMIC_MECHANISM",
    ),
  };
  return { graph, coverage };
}

async function atomicWrite(file: string, body: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export async function writeDerivedArtifacts(
  repositoryRoot: string,
  result: BuildResult,
): Promise<{
  graphPath: string;
  coveragePath: string;
  diagnosticsPath: string;
  manifestPath: string;
}> {
  const outputDirectory = path.join(
    path.resolve(repositoryRoot),
    ".code-intelligence",
  );
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const graphPath = path.join(outputDirectory, "graph-v1.json");
  const coveragePath = path.join(outputDirectory, "coverage-v1.json");
  const diagnosticsPath = path.join(outputDirectory, "diagnostics-v1.json");
  const manifestPath = path.join(outputDirectory, "manifest-v1.json");
  const graphBody = stableJson(result.graph);
  const coverageBody = stableJson(result.coverage);
  const diagnosticsBody = stableJson({
    schemaVersion: "contract-graph-diagnostics/v1",
    evidence: result.graph.evidence,
    diagnostics: result.graph.diagnostics,
  });
  await atomicWrite(graphPath, graphBody);
  await atomicWrite(coveragePath, coverageBody);
  await atomicWrite(diagnosticsPath, diagnosticsBody);
  await atomicWrite(
    manifestPath,
    stableJson({
      schemaVersion: "contract-graph-artifact-manifest/v1",
      evidence: result.graph.evidence,
      files: {
        "coverage-v1.json": sha256(coverageBody),
        "diagnostics-v1.json": sha256(diagnosticsBody),
        "graph-v1.json": sha256(graphBody),
      },
    }),
  );
  return { graphPath, coveragePath, diagnosticsPath, manifestPath };
}

export async function readGraph(
  repositoryRoot: string,
): Promise<ContractGraphV1> {
  const outputDirectory = path.join(
    path.resolve(repositoryRoot),
    ".code-intelligence",
  );
  const file = path.join(outputDirectory, "graph-v1.json");
  const manifestFile = path.join(outputDirectory, "manifest-v1.json");
  const [body, manifestBody] = await Promise.all([
    readUtf8(file),
    readUtf8(manifestFile),
  ]);
  const manifest = JSON.parse(manifestBody) as {
    schemaVersion?: string;
    files?: Record<string, string>;
  };
  if (
    manifest.schemaVersion !== "contract-graph-artifact-manifest/v1" ||
    manifest.files?.["graph-v1.json"] !== sha256(body)
  ) {
    throw new Error("derived ContractGraph artifact integrity check failed");
  }
  const graph = JSON.parse(body) as ContractGraphV1;
  if (
    graph.schemaVersion !== "contract-graph/v1" ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.diagnostics)
  ) {
    throw new Error("derived ContractGraph schema/content check failed");
  }
  return graph;
}

export async function graphFreshnessDiagnostics(
  repositoryRoot: string,
  graph: ContractGraphV1,
): Promise<GraphDiagnosticV1[]> {
  const current = await createEvidence(repositoryRoot);
  const diagnostics: GraphDiagnosticV1[] = [];
  if (path.resolve(graph.evidence.worktreePath) !== current.worktreePath) {
    diagnostics.push({
      code: "WRONG_WORKTREE",
      severity: "error",
      message: `graph belongs to ${graph.evidence.worktreePath}, current worktree is ${current.worktreePath}`,
    });
  }
  if (
    graph.evidence.commit !== current.commit ||
    graph.evidence.sourceHash !== current.sourceHash
  ) {
    diagnostics.push({
      code: "STALE_GRAPH",
      severity: "error",
      message: "graph commit or source hash does not match current worktree",
      attributes: {
        graphCommit: graph.evidence.commit,
        currentCommit: current.commit,
        graphSourceHash: graph.evidence.sourceHash,
        currentSourceHash: current.sourceHash,
      },
    });
  }
  return diagnostics;
}

export function criticalDiagnostics(
  diagnostics: GraphDiagnosticV1[],
): GraphDiagnosticV1[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}
