import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface PiiBackfillSourceRequirement {
  expectedBuildSha: string;
  expectedRepositoryRoot: string;
}

interface PiiBackfillSourceFacts {
  repositoryRoot: string;
  headSha: string;
  porcelainStatus: string;
}

export interface VerifiedPiiBackfillSourceIdentity {
  actualBuildSha: string;
  repositoryRoot: string;
}

export type PiiBackfillSourceProbe = () => PiiBackfillSourceFacts;

function git(repositoryRoot: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("PII_BACKFILL_SOURCE_IDENTITY_UNVERIFIED");
  }
}

/** Read one clean-checkout snapshot without including Git output in errors. */
export function probePiiBackfillGitSource(
  expectedRepositoryRoot: string,
): PiiBackfillSourceFacts {
  let root: string;
  try {
    root = realpathSync(expectedRepositoryRoot);
  } catch {
    throw new Error("PII_BACKFILL_SOURCE_IDENTITY_UNVERIFIED");
  }
  const reportedRoot = git(root, ["rev-parse", "--show-toplevel"]);
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(reportedRoot);
  } catch {
    throw new Error("PII_BACKFILL_SOURCE_IDENTITY_UNVERIFIED");
  }
  return {
    repositoryRoot,
    headSha: git(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
    porcelainStatus: git(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
  };
}

/**
 * Bind maintenance authorization to an exact, clean checkout. This source
 * script is intentionally not runnable from a dirty developer worktree.
 */
export function verifyPiiBackfillSourceIdentity(
  requirement: PiiBackfillSourceRequirement,
  probe: PiiBackfillSourceProbe = () =>
    probePiiBackfillGitSource(requirement.expectedRepositoryRoot),
): VerifiedPiiBackfillSourceIdentity {
  const expectedBuildSha = requirement.expectedBuildSha.trim().toLowerCase();
  const expectedRepositoryRoot = requirement.expectedRepositoryRoot;
  const facts = probe();
  const actualBuildSha = facts.headSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(actualBuildSha)) {
    throw new Error("PII_BACKFILL_SOURCE_IDENTITY_UNVERIFIED");
  }
  if (facts.repositoryRoot !== expectedRepositoryRoot) {
    throw new Error("PII_BACKFILL_SOURCE_ROOT_MISMATCH");
  }
  if (facts.porcelainStatus.length !== 0) {
    throw new Error("PII_BACKFILL_SOURCE_DIRTY");
  }
  if (actualBuildSha !== expectedBuildSha) {
    throw new Error("PII_BACKFILL_BUILD_SHA_MISMATCH");
  }
  return Object.freeze({
    actualBuildSha,
    repositoryRoot: facts.repositoryRoot,
  });
}
