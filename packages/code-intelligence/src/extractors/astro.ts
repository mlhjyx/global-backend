import path from "node:path";
import { GraphBuilder } from "../graph";
import { lineOf, readUtf8, relativePath, walkFiles } from "../utils";

function resolveAstroImport(
  relative: string,
  specifier: string,
  knownFiles: Set<string>,
): string {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(relative), specifier),
  );
  const candidates = [
    base,
    `${base}.astro`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.astro`,
    `${base}/index.ts`,
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? base;
}

export async function extractAstro(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  const files = await walkFiles(repositoryRoot, (relative) =>
    /^apps\/[^/]+\/.*\.astro$/.test(relative),
  );
  const knownFiles = new Set(
    (
      await walkFiles(repositoryRoot, (relative) =>
        /^(?:apps|packages)\/.*\.(?:astro|ts|tsx)$/.test(relative),
      )
    ).map((file) => relativePath(repositoryRoot, file)),
  );
  for (const absolute of files) {
    const relative = relativePath(repositoryRoot, absolute);
    const text = await readUtf8(absolute);
    const fileNode = builder.addNode({
      id: `file:${relative}`,
      kind: "source_file",
      label: relative,
      attributes: { language: "astro" },
      location: { path: relative, line: 1 },
    });
    const component = builder.addNode({
      id: `symbol:${relative}#default`,
      kind: "code_symbol",
      label: path.basename(relative, ".astro"),
      attributes: { framework: "astro", file: relative, exported: true },
      location: { path: relative, line: 1 },
    });
    builder.addEdge({
      kind: "contains",
      from: fileNode,
      to: component,
      location: { path: relative, line: 1 },
    });

    const imports = new Map<string, string>();
    const importPattern =
      /import\s+([A-Za-z][A-Za-z0-9_]*)\s+from\s+["']([^"']+)["']/g;
    for (const match of text.matchAll(importPattern)) {
      const name = match[1];
      const specifier = match[2];
      const location = {
        path: relative,
        line: lineOf(text, match.index ?? 0),
      };
      if (specifier.startsWith(".")) {
        const targetPath = resolveAstroImport(relative, specifier, knownFiles);
        imports.set(name, targetPath);
        const target = builder.addNode({
          id: `file:${targetPath}`,
          kind: "source_file",
          label: targetPath,
          attributes: { unresolved: !knownFiles.has(targetPath) },
          location,
        });
        builder.addEdge({
          kind: "depends_on",
          from: fileNode,
          to: target,
          attributes: { import: specifier },
          location,
        });
      } else {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/", 1)[0];
        const target = builder.addNode({
          id: `package:${packageName}`,
          kind: "package",
          label: packageName,
          attributes: { internal: packageName.startsWith("@global/") },
          location,
        });
        builder.addEdge({
          kind: "depends_on",
          from: fileNode,
          to: target,
          attributes: { import: specifier },
          location,
        });
      }
    }

    for (const match of text.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)) {
      const importedPath = imports.get(match[1]);
      if (!importedPath) continue;
      const location = {
        path: relative,
        line: lineOf(text, match.index ?? 0),
      };
      const target = builder.addNode({
        id: `symbol:${importedPath}#default`,
        kind: "code_symbol",
        label: path.basename(importedPath).replace(/\.[^.]+$/, ""),
        attributes: {
          framework: importedPath.endsWith(".astro") ? "astro" : "typescript",
          file: importedPath,
          exported: true,
        },
        location,
      });
      builder.addEdge({
        kind: "calls",
        from: component,
        to: target,
        attributes: { render: true },
        location,
      });
    }
  }
}
