import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const REGISTRY_VERSION_SPECIFIER = /^[a-z0-9*.+<>=~^| -]+$/i;
const WORKSPACE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const EXTERNAL_SOURCE_MARKER =
  /(?:^|[\s'"{,\[])(?:https?:\/\/|git\+|git:\/\/|ssh:\/\/|github:|git@|(?:[a-z0-9._-]+@)?[a-z0-9.-]+\.[a-z]{2,}:[^\s'"},\]]+|file:|portal:|tarball\s*:|repo\s*:|commit\s*:|directory\s*:|type\s*:\s*(?:git|directory))/i;
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const TRUSTED_PROCESS_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "HOME",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
]);

function issue(code, message) {
  return Object.freeze({ code, message });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildTrustedPnpmEnvironment(
  inheritedEnvironment = process.env,
) {
  if (!isObject(inheritedEnvironment)) {
    throw new Error("pnpm environment must be an object");
  }
  const trustedEnvironment = {};
  for (const key of TRUSTED_PROCESS_ENVIRONMENT_KEYS) {
    const value = inheritedEnvironment[key];
    if (typeof value === "string" && value.length > 0) {
      trustedEnvironment[key] = value;
    }
  }
  return Object.freeze({
    ...trustedEnvironment,
    NPM_CONFIG_REGISTRY: OFFICIAL_REGISTRY,
    NPM_CONFIG_USERCONFIG: "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    NPM_CONFIG_IGNORE_PNPMFILE: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  });
}

export function assertNoRepositoryNpmrc(paths) {
  if (
    !Array.isArray(paths) ||
    paths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    throw new Error("repository .npmrc inventory is malformed");
  }
  if (paths.length > 0) {
    throw new Error(
      `repository .npmrc is not admitted by the production audit trust boundary (${paths.length} path entries)`,
    );
  }
}

export function assertNoRepositoryNonRegularFiles(entries) {
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !isObject(entry) ||
        !/^[0-9]{6}$/u.test(entry.mode ?? "") ||
        !isNonEmptyString(entry.path),
    )
  ) {
    throw new Error("repository file-mode inventory is malformed");
  }
  const nonRegularEntries = entries.filter(
    (entry) => entry.mode !== "100644" && entry.mode !== "100755",
  );
  if (nonRegularEntries.length > 0) {
    throw new Error(
      `repository symlinks and gitlinks are not admitted by the production audit trust boundary (${nonRegularEntries.length} path entries)`,
    );
  }
}

function buildTrustedGitEnvironment() {
  return Object.freeze({
    ...buildTrustedPnpmEnvironment(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
}

function listTrackedRepositoryFiles(cwd, pathspecs, description) {
  const execution = spawnSync(
    "git",
    ["-C", cwd, "ls-files", "-z", "--", ...pathspecs],
    {
      encoding: "utf8",
      maxBuffer: MAX_INPUT_BYTES,
      env: buildTrustedGitEnvironment(),
    },
  );
  if (execution.error || execution.signal || execution.status !== 0) {
    throw new Error(`cannot prove the repository ${description} inventory`);
  }
  return execution.stdout.split("\0").filter((path) => path.length > 0);
}

function listTrackedRepositoryIndexEntries(cwd) {
  const execution = spawnSync("git", ["-C", cwd, "ls-files", "-s", "-z"], {
    encoding: "utf8",
    maxBuffer: MAX_INPUT_BYTES,
    env: buildTrustedGitEnvironment(),
  });
  if (execution.error || execution.signal || execution.status !== 0) {
    throw new Error("cannot prove the repository file-mode inventory");
  }
  return execution.stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const match = record.match(
        /^([0-9]{6}) [0-9a-f]{40,64} [0-3]\t([\s\S]+)$/u,
      );
      if (match === null) {
        throw new Error("repository file-mode inventory is malformed");
      }
      return Object.freeze({ mode: match[1], path: match[2] });
    });
}

export function listTrackedRepositoryNpmrc(cwd) {
  return listTrackedRepositoryFiles(
    cwd,
    [".npmrc", ":(glob)**/.npmrc"],
    ".npmrc",
  );
}

function trustedRegistrySpecifier(specifier) {
  if (!isNonEmptyString(specifier)) return false;
  if (specifier.startsWith("workspace:")) {
    const workspaceRange = specifier.slice("workspace:".length);
    return (
      workspaceRange.length === 0 ||
      REGISTRY_VERSION_SPECIFIER.test(workspaceRange)
    );
  }
  if (specifier.startsWith("npm:")) {
    const alias = specifier.slice("npm:".length);
    const match = alias.match(/^(@[^/]+\/[^@]+|[^@/]+)@(.+)$/);
    return (
      match !== null &&
      PACKAGE_NAME.test(match[1]) &&
      REGISTRY_VERSION_SPECIFIER.test(match[2])
    );
  }
  return REGISTRY_VERSION_SPECIFIER.test(specifier);
}

function validateDependencyMap(
  map,
  { workspaceNames, requireWorkspaceTarget, issues },
) {
  if (!isObject(map)) {
    issues.push(
      issue(
        "DEPENDENCY_MAP_INVALID",
        "dependency declarations must be objects",
      ),
    );
    return;
  }
  for (const [name, specifier] of Object.entries(map)) {
    if (!PACKAGE_NAME.test(name) || !trustedRegistrySpecifier(specifier)) {
      issues.push(
        issue(
          "DEPENDENCY_SOURCE_NOT_TRUSTED",
          "dependencies must resolve through the fixed registry or a tracked workspace package",
        ),
      );
      continue;
    }
    if (
      requireWorkspaceTarget &&
      specifier.startsWith("workspace:") &&
      !workspaceNames.has(name)
    ) {
      issues.push(
        issue(
          "DEPENDENCY_WORKSPACE_TARGET_UNKNOWN",
          "workspace dependencies must name a tracked package manifest",
        ),
      );
    }
  }
}

function workspacePatternMatches(pattern, directory) {
  const patternSegments = pattern.split("/");
  const directorySegments = directory.split("/");
  return (
    patternSegments.length === directorySegments.length &&
    patternSegments.every(
      (segment, index) =>
        segment === "*" || segment === directorySegments[index],
    )
  );
}

function workspaceSourceIssues(workspaceText, workspaceDirectories) {
  const issues = [];
  const patterns = [];
  let packagesDeclarationSeen = false;

  for (const line of workspaceText.split(/\r?\n/u)) {
    if (line.trim().length === 0 || /^\s*#/u.test(line)) continue;
    if (line === "packages:" && !packagesDeclarationSeen) {
      packagesDeclarationSeen = true;
      continue;
    }

    const entry = line.match(/^ {2}- (["'])([^"']+)\1$/u);
    if (!packagesDeclarationSeen || entry === null) {
      issues.push(
        issue(
          "WORKSPACE_SOURCE_NOT_TRUSTED",
          "workspace configuration must use only one block-style packages list",
        ),
      );
      continue;
    }

    const pattern = entry[2];
    const segments = pattern.split("/");
    if (
      pattern.includes("\\") ||
      pattern.includes("\0") ||
      pattern.startsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          (segment !== "*" && !WORKSPACE_PATH_SEGMENT.test(segment)),
      ) ||
      patterns.includes(pattern)
    ) {
      issues.push(
        issue(
          "WORKSPACE_SOURCE_NOT_TRUSTED",
          "workspace package globs must be unique repository-relative path segments",
        ),
      );
      continue;
    }
    patterns.push(pattern);
  }

  if (!packagesDeclarationSeen || patterns.length === 0) {
    issues.push(
      issue(
        "WORKSPACE_SOURCE_NOT_TRUSTED",
        "workspace configuration must declare at least one trusted package glob",
      ),
    );
  }
  for (const directory of workspaceDirectories) {
    if (
      directory !== "." &&
      !patterns.some((pattern) => workspacePatternMatches(pattern, directory))
    ) {
      issues.push(
        issue(
          "WORKSPACE_SOURCE_NOT_TRUSTED",
          "every tracked workspace package must be admitted by the packages list",
        ),
      );
    }
  }
  return issues;
}

function lockfileSyntaxIssues(lockfileText) {
  const ambiguousSyntax = [
    /["\\]/u,
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u,
    /(?:^|\n)\s*(?:---|\.\.\.|%YAML|%TAG)(?:\s|$)/u,
    /\?/u,
    /[!&]/u,
    /(?:^|[\s[{,:-])\*[^\s,[\]{}]+/u,
    /(?:^|[\n{,])\s*\[[^\]\r\n]*\]\s*:/u,
    /(?:^|[\s{,])'(?:resolution|repo|commit|type|tarball|directory)'\s*:/iu,
    /(?:^|\n)\s*<<\s*:/u,
    /:\s*[>|][+-]?[0-9]*\s*(?:#.*)?(?:\n|$)/u,
  ];
  if (ambiguousSyntax.some((pattern) => pattern.test(lockfileText))) {
    return [
      issue(
        "LOCKFILE_SYNTAX_NOT_TRUSTED",
        "lockfile must use the generated YAML subset without escapes, tags, aliases, merges, or block scalars",
      ),
    ];
  }

  for (const line of lockfileText.split(/\r?\n/u)) {
    if (/^\s+resolution\s*:/u.test(line)) {
      if (
        !/^ {4}resolution: \{integrity: sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}\}$/u.test(
          line,
        )
      ) {
        return [
          issue(
            "LOCKFILE_EXTERNAL_SOURCE_NOT_TRUSTED",
            "lockfile resolution entries must be registry integrity records",
          ),
        ];
      }
    }
  }
  return [];
}

function lockfileLinkIssues(lockfileText, workspaceDirectories) {
  const issues = [];
  let insideImporters = false;
  let currentImporter = null;
  for (const line of lockfileText.split(/\r?\n/u)) {
    if (/^importers:\s*$/u.test(line)) {
      insideImporters = true;
      currentImporter = null;
      continue;
    }
    if (/^[^\s]/u.test(line)) {
      insideImporters = false;
      currentImporter = null;
    }
    if (insideImporters) {
      const importer = line.match(/^ {2}(?! )(['"]?)([^'"]+)\1:\s*$/u);
      if (importer !== null) {
        currentImporter = importer[2];
        if (
          currentImporter !== "." &&
          !workspaceDirectories.has(currentImporter)
        ) {
          issues.push(
            issue(
              "LOCKFILE_IMPORTER_NOT_TRUSTED",
              "lockfile importers must resolve to tracked workspace package directories",
            ),
          );
        }
      }
    }
    const links = [...line.matchAll(/\blink:([^\s'"},]+)/gu)];
    for (const link of links) {
      if (currentImporter === null || link[1].startsWith("/")) {
        issues.push(
          issue(
            "LOCKFILE_LINK_NOT_TRUSTED",
            "lockfile links must originate from an importer and stay inside tracked workspaces",
          ),
        );
        continue;
      }
      const importerDirectory = currentImporter === "." ? "" : currentImporter;
      const target = posix.normalize(posix.join(importerDirectory, link[1]));
      if (
        target === ".." ||
        target.startsWith("../") ||
        !workspaceDirectories.has(target)
      ) {
        issues.push(
          issue(
            "LOCKFILE_LINK_NOT_TRUSTED",
            "lockfile links must resolve to a tracked workspace package",
          ),
        );
      }
    }
  }
  return issues;
}

export function validateDependencySourcePolicy(input) {
  const issues = [];
  if (
    !isObject(input) ||
    !Array.isArray(input.manifests) ||
    !isNonEmptyString(input.workspaceText) ||
    !isNonEmptyString(input.lockfileText)
  ) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([
        issue(
          "DEPENDENCY_SOURCE_INPUT_INVALID",
          "source policy requires manifests, workspace configuration, and lockfile text",
        ),
      ]),
    });
  }

  const manifests = [];
  const manifestPaths = new Set();
  const workspaceNames = new Set();
  const workspaceDirectories = new Set();
  for (const manifest of input.manifests) {
    if (
      !isObject(manifest) ||
      !isNonEmptyString(manifest.path) ||
      !(
        manifest.path === "package.json" ||
        manifest.path.endsWith("/package.json")
      ) ||
      manifest.path.startsWith("/") ||
      manifest.path.split("/").includes("..") ||
      !isObject(manifest.document) ||
      !PACKAGE_NAME.test(manifest.document.name ?? "") ||
      manifestPaths.has(manifest.path) ||
      workspaceNames.has(manifest.document.name)
    ) {
      issues.push(
        issue(
          "DEPENDENCY_MANIFEST_INVALID",
          "tracked package manifests must have unique repository paths and package names",
        ),
      );
      continue;
    }
    manifestPaths.add(manifest.path);
    workspaceNames.add(manifest.document.name);
    workspaceDirectories.add(posix.dirname(manifest.path));
    manifests.push(manifest);
  }
  if (!manifestPaths.has("package.json")) {
    issues.push(
      issue(
        "DEPENDENCY_ROOT_MANIFEST_MISSING",
        "the source policy requires the tracked root package manifest",
      ),
    );
  }

  for (const manifest of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      if (manifest.document[field] !== undefined) {
        validateDependencyMap(manifest.document[field], {
          workspaceNames,
          requireWorkspaceTarget: true,
          issues,
        });
      }
    }
    if (manifest.document.resolutions !== undefined) {
      validateDependencyMap(manifest.document.resolutions, {
        workspaceNames,
        requireWorkspaceTarget: false,
        issues,
      });
    }
    if (manifest.document.pnpm?.overrides !== undefined) {
      validateDependencyMap(manifest.document.pnpm.overrides, {
        workspaceNames,
        requireWorkspaceTarget: false,
        issues,
      });
    }
    if (manifest.document.pnpm?.auditConfig !== undefined) {
      issues.push(
        issue(
          "DEPENDENCY_AUDIT_IGNORE_NOT_TRUSTED",
          "dependency manifests cannot filter advisories before the production audit ratchet",
        ),
      );
    }
    if (manifest.document.pnpm?.patchedDependencies !== undefined) {
      issues.push(
        issue(
          "DEPENDENCY_SOURCE_NOT_TRUSTED",
          "patched dependency sources require a separately reviewed policy",
        ),
      );
    }
    const extensions = manifest.document.pnpm?.packageExtensions;
    if (extensions !== undefined) {
      if (!isObject(extensions)) {
        issues.push(
          issue(
            "DEPENDENCY_MAP_INVALID",
            "pnpm packageExtensions must be an object",
          ),
        );
      } else {
        for (const extension of Object.values(extensions)) {
          if (!isObject(extension)) {
            issues.push(
              issue(
                "DEPENDENCY_MAP_INVALID",
                "pnpm package extension entries must be objects",
              ),
            );
            continue;
          }
          for (const field of DEPENDENCY_FIELDS) {
            if (extension[field] !== undefined) {
              validateDependencyMap(extension[field], {
                workspaceNames,
                requireWorkspaceTarget: false,
                issues,
              });
            }
          }
        }
      }
    }
  }

  issues.push(
    ...workspaceSourceIssues(input.workspaceText, workspaceDirectories),
  );
  issues.push(...lockfileSyntaxIssues(input.lockfileText));
  if (EXTERNAL_SOURCE_MARKER.test(input.lockfileText)) {
    issues.push(
      issue(
        "LOCKFILE_EXTERNAL_SOURCE_NOT_TRUSTED",
        "lockfile cannot contain direct URL, Git, tarball, or external filesystem sources",
      ),
    );
  }
  issues.push(...lockfileLinkIssues(input.lockfileText, workspaceDirectories));

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    manifest_count: manifests.length,
  });
}

function sameOpenedFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function readBoundedRegularText(
  path,
  maximumBytes = MAX_INPUT_BYTES,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("input byte limit must be a non-negative safe integer");
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error("input must be an openable no-follow regular file");
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) {
      throw new Error("input must be a bounded regular file");
    }

    const expectedBytes = Number(before.size);
    const buffer = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    if (offset !== expectedBytes || !sameOpenedFile(before, after)) {
      throw new Error("input changed while it was being read");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(path) {
  return JSON.parse(await readBoundedRegularText(path));
}

function resolveRepositoryInput(repositoryRoot, relativePath) {
  const target = resolve(repositoryRoot, relativePath);
  if (
    target !== repositoryRoot &&
    !target.startsWith(`${repositoryRoot}${sep}`)
  ) {
    throw new Error("repository dependency input escaped its root");
  }
  return target;
}

export async function validateRepositoryDependencySources(repositoryRoot) {
  const root = resolve(repositoryRoot);
  assertNoRepositoryNonRegularFiles(listTrackedRepositoryIndexEntries(root));
  assertNoRepositoryNpmrc(listTrackedRepositoryNpmrc(root));
  const paths = listTrackedRepositoryFiles(
    root,
    ["package.json", ":(glob)**/package.json"],
    "package manifest",
  );
  const manifests = await Promise.all(
    paths.map(async (path) =>
      Object.freeze({
        path,
        document: await readBoundedJson(resolveRepositoryInput(root, path)),
      }),
    ),
  );
  return validateDependencySourcePolicy({
    manifests,
    workspaceText: await readBoundedRegularText(
      resolveRepositoryInput(root, "pnpm-workspace.yaml"),
    ),
    lockfileText: await readBoundedRegularText(
      resolveRepositoryInput(root, "pnpm-lock.yaml"),
    ),
  });
}

async function main() {
  const [command = "", option, repositoryRoot, ...rest] = process.argv.slice(2);
  if (
    command !== "validate-sources" ||
    option !== "--repository-root" ||
    !isNonEmptyString(repositoryRoot) ||
    rest.length > 0
  ) {
    throw new Error(
      "validate-sources requires exactly --repository-root <path>",
    );
  }
  const result = await validateRepositoryDependencySources(repositoryRoot);
  if (!result.ok) {
    for (const item of result.issues) {
      console.error(`[${item.code}] ${item.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      schema_version: "production-dependency-source-policy-result/v1",
      result: "DEPENDENCY_SOURCES_TRUSTED",
      manifest_count: result.manifest_count,
      registry: OFFICIAL_REGISTRY,
    }),
  );
}

const directExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directExecution) {
  main().catch((error) => {
    console.error(
      `[DEPENDENCY_SOURCE_POLICY_FAILED] ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
    process.exitCode = 1;
  });
}
