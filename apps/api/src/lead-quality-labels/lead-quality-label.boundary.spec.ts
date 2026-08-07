import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".spec.ts")
      ? [path]
      : [];
  });
}

describe("acquisition/QGO ownership boundary", () => {
  it("marks CONTACTED/CONVERTED legacy read-only and has no backend source write literal for either state", () => {
    const schema = readFileSync(
      resolve(process.cwd(), "../../packages/db/prisma/schema.prisma"),
      "utf8",
    );
    expect(schema).toContain("CONTACTED // legacy read-only SaaS return value");
    expect(schema).toContain("CONVERTED // legacy read-only SaaS return value");

    const apiSource = resolve(process.cwd(), "src");
    const writes = sourceFiles(apiSource).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return /\bstatus\s*:\s*['"](?:CONTACTED|CONVERTED)['"]/.test(source)
        ? [path]
        : [];
    });
    expect(writes).toEqual([]);
  });
});
