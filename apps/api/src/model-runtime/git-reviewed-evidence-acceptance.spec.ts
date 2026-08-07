import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "./context-engine";
import {
  assertGitReviewedEvidenceAcceptanceCurrent,
  createGitReviewedEvidenceAcceptanceArtifact,
  getGitReviewedEvidenceAcceptanceAttestation,
  verifyGitReviewedEvidenceAcceptanceArtifact,
  writeGitReviewedEvidenceAcceptanceArtifact,
} from "./git-reviewed-evidence-acceptance";

const directories: string[] = [];
const REQUIRE = createRequire(import.meta.url);
const digest = (character: string) => character.repeat(64);

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const candidateReceipt = Object.freeze({
  classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY",
  evidenceClass: "copy_gateway_settlement_candidate",
  evidenceKind: "capability_pilot",
  taskId: "site_builder.copy",
  executionId: "copy-capability-3-claude-sonnet-5",
  outputDigest: digest("1"),
  ledgerDigest: digest("2"),
  fixedSourceCommit: "a".repeat(40),
  sourceBundleDigest: digest("3"),
  manifestDigest: digest("4"),
  compiledRuntimeDigest: digest("5"),
  compiledBindingDigest: digest("6"),
  settlementObserverDigest: digest("7"),
  knownSettlementDigest: digest("8"),
  alias: "claude-sonnet-5",
  protocol: "anthropic_messages",
  reasoning: "medium",
});

function artifact() {
  return createGitReviewedEvidenceAcceptanceArtifact({
    artifactId: "copy-capability-sonnet-acceptance-001",
    acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
    taskId: "site_builder.copy",
    evidenceKind: "capability_pilot",
    candidateReceipt,
    subject: {
      executionId: candidateReceipt.executionId,
      outputDigest: candidateReceipt.outputDigest,
      candidateLedgerDigest: candidateReceipt.ledgerDigest,
      fixedSourceCommit: candidateReceipt.fixedSourceCommit,
      sourceBundleDigest: candidateReceipt.sourceBundleDigest,
      manifestDigest: candidateReceipt.manifestDigest,
      compiledRuntimeDigest: candidateReceipt.compiledRuntimeDigest,
      compiledBindingDigest: candidateReceipt.compiledBindingDigest,
      settlementObserverDigest: candidateReceipt.settlementObserverDigest,
      knownSettlementDigest: candidateReceipt.knownSettlementDigest,
      alias: candidateReceipt.alias,
      protocol: candidateReceipt.protocol,
      reasoning: candidateReceipt.reasoning,
    },
  });
}

async function mergedRepository(
  acceptanceArtifact = artifact(),
  unsafeWrite = false,
) {
  const root = await mkdtemp(join(tmpdir(), "git-evidence-acceptance-"));
  directories.push(root);
  await mkdir(join(root, "docs", "evidence"), { recursive: true });
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "git-evidence@example.test");
  git(root, "config", "user.name", "Git Evidence Test");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "acceptance/copy-sonnet");
  const artifactPath = join(
    root,
    "docs",
    "evidence",
    "copy-sonnet-acceptance.json",
  );
  if (unsafeWrite) {
    await writeFile(
      artifactPath,
      `${JSON.stringify(acceptanceArtifact, null, 2)}\n`,
    );
  } else {
    await writeGitReviewedEvidenceAcceptanceArtifact({
      artifactPath,
      artifact: acceptanceArtifact,
    });
  }
  git(root, "add", "docs/evidence/copy-sonnet-acceptance.json");
  git(root, "commit", "-qm", "test: accept Copy Sonnet evidence");
  const artifactCommit = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(
    root,
    "merge",
    "--no-ff",
    "acceptance/copy-sonnet",
    "-m",
    "Merge pull request #401 from test/acceptance-copy-sonnet",
  );
  const mergeCommit = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", mergeCommit);
  return {
    root,
    artifactPath,
    acceptanceArtifact,
    artifactCommit,
    mergeCommit,
  };
}

describe("Git-reviewed evidence acceptance", () => {
  it("derives the add commit and first-parent PR merge before branding an exact immutable artifact", async () => {
    const fixture = await mergedRepository();
    const acceptance = await verifyGitReviewedEvidenceAcceptanceArtifact({
      repositoryRoot: fixture.root,
      artifactPath: fixture.artifactPath,
    });
    const attestation =
      getGitReviewedEvidenceAcceptanceAttestation(acceptance)!;

    expect(Object.keys(acceptance)).toEqual([]);
    expect(attestation).toMatchObject({
      classification: "OPAQUE_GIT_REVIEWED_EVIDENCE_ACCEPTANCE",
      artifactId: fixture.acceptanceArtifact.artifactId,
      artifactDigest: fixture.acceptanceArtifact.artifactDigest,
      artifactCommit: fixture.artifactCommit,
      mergeCommit: fixture.mergeCommit,
      pullRequestNumber: 401,
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      taskId: "site_builder.copy",
      evidenceKind: "capability_pilot",
      candidateReceipt,
      candidateReceiptDigest: fixture.acceptanceArtifact.candidateReceiptDigest,
      subject: fixture.acceptanceArtifact.subject,
    });
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.subject)).toBe(true);
    expect(Object.isFrozen(attestation.candidateReceipt)).toBe(true);
    await expect(
      assertGitReviewedEvidenceAcceptanceCurrent(acceptance),
    ).resolves.toBeUndefined();

    expect(
      getGitReviewedEvidenceAcceptanceAttestation(structuredClone(acceptance)),
    ).toBeUndefined();
  });

  it("writes the artifact create-only and rejects an overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-evidence-write-"));
    directories.push(root);
    const artifactPath = join(root, "acceptance.json");
    const acceptanceArtifact = artifact();

    await writeGitReviewedEvidenceAcceptanceArtifact({
      artifactPath,
      artifact: acceptanceArtifact,
    });
    await expect(
      writeGitReviewedEvidenceAcceptanceArtifact({
        artifactPath,
        artifact: acceptanceArtifact,
      }),
    ).rejects.toThrow("GIT_EVIDENCE_ACCEPTANCE_CREATE_ONLY");
    expect(JSON.parse(await readFile(artifactPath, "utf8"))).toMatchObject(
      acceptanceArtifact,
    );
  });

  it("rejects working, HEAD, origin/main, and post-add history drift", async () => {
    const fixture = await mergedRepository();
    await writeFile(fixture.artifactPath, "{}\n");
    await expect(
      verifyGitReviewedEvidenceAcceptanceArtifact({
        repositoryRoot: fixture.root,
        artifactPath: fixture.artifactPath,
      }),
    ).rejects.toThrow("GIT_EVIDENCE_ACCEPTANCE_BYTES_MISMATCH");

    git(
      fixture.root,
      "checkout",
      "--",
      "docs/evidence/copy-sonnet-acceptance.json",
    );
    await writeFile(
      fixture.artifactPath,
      `${JSON.stringify({ ...fixture.acceptanceArtifact, decision: "REJECT" })}\n`,
    );
    git(fixture.root, "add", "docs/evidence/copy-sonnet-acceptance.json");
    git(fixture.root, "commit", "-qm", "mutate accepted artifact");
    git(fixture.root, "update-ref", "refs/remotes/origin/main", "HEAD");
    await expect(
      verifyGitReviewedEvidenceAcceptanceArtifact({
        repositoryRoot: fixture.root,
        artifactPath: fixture.artifactPath,
      }),
    ).rejects.toThrow(/GIT_EVIDENCE_ACCEPTANCE_(IMMUTABLE|BYTES_MISMATCH)/u);
  });

  it("rejects an artifact not introduced by a first-parent PR merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-evidence-direct-"));
    directories.push(root);
    await mkdir(join(root, "docs", "evidence"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "git-evidence@example.test");
    git(root, "config", "user.name", "Git Evidence Test");
    const artifactPath = join(root, "docs", "evidence", "direct.json");
    await writeGitReviewedEvidenceAcceptanceArtifact({
      artifactPath,
      artifact: artifact(),
    });
    git(root, "add", "docs/evidence/direct.json");
    git(root, "commit", "-qm", "direct acceptance");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");

    await expect(
      verifyGitReviewedEvidenceAcceptanceArtifact({
        repositoryRoot: root,
        artifactPath,
      }),
    ).rejects.toThrow("GIT_EVIDENCE_ACCEPTANCE_PR_MERGE_REQUIRED");
  });

  it.each([
    ["executionId", "copy-capability-other"],
    ["outputDigest", digest("f")],
    ["candidateLedgerDigest", digest("f")],
    ["fixedSourceCommit", "f".repeat(40)],
    ["sourceBundleDigest", digest("f")],
    ["manifestDigest", digest("f")],
    ["compiledRuntimeDigest", digest("f")],
    ["compiledBindingDigest", digest("f")],
    ["settlementObserverDigest", digest("f")],
    ["knownSettlementDigest", digest("f")],
    ["alias", "gpt-5.6-terra"],
    ["protocol", "openai_responses"],
    ["reasoning", "high"],
  ] as const)(
    "rejects subject drift from the candidate receipt: %s",
    (key, value) => {
      expect(() =>
        createGitReviewedEvidenceAcceptanceArtifact({
          artifactId: "copy-capability-sonnet-acceptance-002",
          acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
          taskId: "site_builder.copy",
          evidenceKind: "capability_pilot",
          candidateReceipt,
          subject: { ...artifact().subject, [key]: value },
        }),
      ).toThrow("GIT_EVIDENCE_ACCEPTANCE_SUBJECT_MISMATCH");
    },
  );

  it("rejects a tracked, merged artifact whose semantic binding was forged directly", async () => {
    const valid = artifact();
    const withoutDigest = {
      ...valid,
      subject: { ...valid.subject, outputDigest: digest("f") },
    };
    const { artifactDigest: _oldDigest, ...material } = withoutDigest;
    const forged = {
      ...material,
      artifactDigest: canonicalDigest(material),
    };
    const fixture = await mergedRepository(forged as never, true);

    await expect(
      verifyGitReviewedEvidenceAcceptanceArtifact({
        repositoryRoot: fixture.root,
        artifactPath: fixture.artifactPath,
      }),
    ).rejects.toThrow("GIT_EVIDENCE_ACCEPTANCE_SUBJECT_MISMATCH");
  });

  it("uses captured Object, JSON, and WeakMap intrinsics after ambient replacement", async () => {
    const fixture = await mergedRepository();
    const acceptance = await verifyGitReviewedEvidenceAcceptanceArtifact({
      repositoryRoot: fixture.root,
      artifactPath: fixture.artifactPath,
    });
    const expected = getGitReviewedEvidenceAcceptanceAttestation(acceptance)!;
    const originalObjectKeys = Object.keys;
    const originalObjectValues = Object.values;
    const originalObjectGetPrototypeOf = Object.getPrototypeOf;
    const originalObjectFreeze = Object.freeze;
    const originalArrayIsArray = Array.isArray;
    const originalJsonParse = JSON.parse;
    const originalJsonStringify = JSON.stringify;
    const originalWeakMapGet = WeakMap.prototype.get;
    const childProcess = REQUIRE("node:child_process") as Record<
      string,
      unknown
    >;
    const originalExecFileSync = childProcess.execFileSync;
    const originalSpawnSync = childProcess.spawnSync;
    let ambientError: unknown;
    let observedArtifactId: string | undefined;

    try {
      Object.keys = () => ["forged"];
      Object.values = () => ["forged"];
      Object.getPrototypeOf = () => null;
      Object.freeze = ((value: unknown) => value) as typeof Object.freeze;
      Array.isArray = () => false;
      JSON.parse = () => ({ forged: true });
      JSON.stringify = () => '"forged"';
      Reflect.set(childProcess, "execFileSync", () => {
        throw new Error("forged execFileSync");
      });
      Reflect.set(childProcess, "spawnSync", () => ({ status: 0 }));
      await assertGitReviewedEvidenceAcceptanceCurrent(acceptance);
      observedArtifactId =
        getGitReviewedEvidenceAcceptanceAttestation(acceptance)?.artifactId;
    } catch (error) {
      ambientError = error;
    } finally {
      Object.keys = originalObjectKeys;
      Object.values = originalObjectValues;
      Object.getPrototypeOf = originalObjectGetPrototypeOf;
      Object.freeze = originalObjectFreeze;
      Array.isArray = originalArrayIsArray;
      JSON.parse = originalJsonParse;
      JSON.stringify = originalJsonStringify;
      Reflect.set(childProcess, "execFileSync", originalExecFileSync);
      Reflect.set(childProcess, "spawnSync", originalSpawnSync);
    }

    let weakMapObservedArtifactId: string | undefined;
    try {
      WeakMap.prototype.get = () => ({ artifactId: "forged" });
      weakMapObservedArtifactId =
        getGitReviewedEvidenceAcceptanceAttestation(acceptance)?.artifactId;
    } finally {
      WeakMap.prototype.get = originalWeakMapGet;
    }

    expect(ambientError).toBeUndefined();
    expect(observedArtifactId).toBe(expected.artifactId);
    expect(weakMapObservedArtifactId).toBe(expected.artifactId);
  });
});
