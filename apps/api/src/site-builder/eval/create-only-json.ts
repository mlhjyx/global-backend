import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export const SITE_BUILDER_EVIDENCE_OUTPUT_PREFIX =
  "docs/evidence/site-builder/" as const;

function validateCreateOnlyOutputPath(
  repositoryRelativePath: string,
  extension: ".json" | ".md",
): void {
  if (
    repositoryRelativePath.length === 0 ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath.includes("\\") ||
    repositoryRelativePath.split("/").includes("..") ||
    !repositoryRelativePath.startsWith(SITE_BUILDER_EVIDENCE_OUTPUT_PREFIX) ||
    !repositoryRelativePath.endsWith(extension)
  ) {
    const format = extension === ".json" ? "JSON" : "Markdown";
    throw new Error(
      `output must be a new repository-relative Site Builder evidence ${format} path`,
    );
  }
}

async function writeRepositoryFileCreateOnly(
  repositoryRoot: string,
  repositoryRelativePath: string,
  content: string,
  extension: ".json" | ".md",
): Promise<void> {
  validateCreateOnlyOutputPath(repositoryRelativePath, extension);
  const realRepositoryRoot = await realpath(repositoryRoot);
  const lexicalOutput = resolve(realRepositoryRoot, repositoryRelativePath);
  const lexicalRelative = relative(realRepositoryRoot, lexicalOutput);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("create-only output escapes the repository");
  }

  const parentParts = dirname(repositoryRelativePath)
    .split("/")
    .filter((part) => part !== "." && part !== "");
  let safeParent = realRepositoryRoot;
  for (const part of parentParts) {
    const next = resolve(safeParent, part);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(next);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("create-only parent must be a real directory");
    }
    const realNext = await realpath(next);
    const nextRelative = relative(realRepositoryRoot, realNext);
    if (
      nextRelative === ".." ||
      nextRelative.startsWith(`..${sep}`) ||
      isAbsolute(nextRelative)
    ) {
      throw new Error("create-only parent escapes the repository");
    }
    safeParent = realNext;
  }

  const directory = await open(
    safeParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let output;
  try {
    const descriptorPath = `/proc/self/fd/${directory.fd}`;
    const descriptorTarget = await realpath(descriptorPath);
    const descriptorRelative = relative(realRepositoryRoot, descriptorTarget);
    if (
      descriptorRelative === ".." ||
      descriptorRelative.startsWith(`..${sep}`) ||
      isAbsolute(descriptorRelative)
    ) {
      throw new Error("create-only directory escaped the repository");
    }
    output = await open(
      `${descriptorPath}/${basename(repositoryRelativePath)}`,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await output.writeFile(content, "utf8");
    await output.sync();
  } finally {
    await output?.close();
    await directory.close();
  }
}

export async function writeRepositoryMarkdownCreateOnly(
  repositoryRoot: string,
  repositoryRelativePath: string,
  content: string,
): Promise<void> {
  await writeRepositoryFileCreateOnly(
    repositoryRoot,
    repositoryRelativePath,
    content,
    ".md",
  );
}

export async function writeRepositoryJsonCreateOnly(
  repositoryRoot: string,
  repositoryRelativePath: string,
  value: unknown,
): Promise<void> {
  await writeRepositoryFileCreateOnly(
    repositoryRoot,
    repositoryRelativePath,
    `${JSON.stringify(value, null, 2)}\n`,
    ".json",
  );
}
