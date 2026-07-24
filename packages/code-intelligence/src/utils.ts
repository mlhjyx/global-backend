import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function relativePath(root: string, value: string): string {
  return toPosix(path.relative(root, value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2) + "\n";
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortDeep(child)]),
    );
  }
  return value;
}

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".codegraph",
  ".code-intelligence",
  ".codex",
  ".nx",
  ".astro",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function excludedDirectory(name: string): boolean {
  return EXCLUDED_SEGMENTS.has(name) || /^dist-test-/.test(name);
}

export async function walkFiles(
  root: string,
  predicate: (relative: string) => boolean,
): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && excludedDirectory(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        const relative = relativePath(root, absolute);
        if (predicate(relative)) output.push(absolute);
      }
    }
  }
  await visit(root);
  return output;
}

export async function readUtf8(file: string): Promise<string> {
  return readFile(file, "utf8");
}

export async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
