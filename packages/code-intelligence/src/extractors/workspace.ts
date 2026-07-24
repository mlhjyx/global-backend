import path from "node:path";
import { GraphBuilder } from "../graph";
import { readUtf8, relativePath, walkFiles } from "../utils";

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function packageId(name: string): string {
  return `package:${name}`;
}

export async function extractWorkspace(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<Map<string, string>> {
  const packageFiles = await walkFiles(repositoryRoot, (relative) => {
    if (relative === "package.json") return true;
    return /^(?:apps|packages)\/[^/]+\/package\.json$/.test(relative);
  });
  const packagePaths = new Map<string, string>();
  const manifests: Array<{
    manifest: PackageManifest;
    relative: string;
    name: string;
  }> = [];

  for (const file of packageFiles) {
    const relative = relativePath(repositoryRoot, file);
    const manifest = JSON.parse(await readUtf8(file)) as PackageManifest;
    const name = manifest.name ?? `workspace-root:${path.dirname(relative)}`;
    manifests.push({ manifest, relative, name });
    packagePaths.set(name, path.dirname(relative));
    const packageNode = builder.addNode({
      id: packageId(name),
      kind: "package",
      label: name,
      attributes: {
        workspacePath:
          path.dirname(relative) === "." ? "." : path.dirname(relative),
        scripts: Object.keys(manifest.scripts ?? {}).sort(),
        internal: true,
      },
      location: { path: relative, line: 1 },
    });
    builder.addEdge({
      kind: "contains",
      from: builder.addNode({
        id: `file:${relative}`,
        kind: "source_file",
        label: relative,
        location: { path: relative, line: 1 },
      }),
      to: packageNode,
      location: { path: relative, line: 1 },
    });
  }

  for (const { manifest, relative, name } of manifests) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    for (const [dependency, version] of Object.entries(dependencies)) {
      const target = builder.addNode({
        id: packageId(dependency),
        kind: "package",
        label: dependency,
        attributes: {
          internal: packagePaths.has(dependency),
          workspacePath: packagePaths.get(dependency) ?? null,
        },
        location: { path: relative, line: 1 },
      });
      builder.addEdge({
        kind: "depends_on",
        from: packageId(name),
        to: target,
        attributes: { version },
        location: { path: relative, line: 1 },
      });
    }
  }

  const tsconfigFiles = await walkFiles(repositoryRoot, (relative) =>
    /(?:^|\/)tsconfig(?:\.[^.]+)?\.json$/.test(relative),
  );
  for (const file of tsconfigFiles) {
    const relative = relativePath(repositoryRoot, file);
    const raw = await readUtf8(file);
    const withoutComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    let config: {
      compilerOptions?: { paths?: Record<string, string[]> };
      references?: Array<{ path: string }>;
    };
    try {
      config = JSON.parse(withoutComments);
    } catch {
      continue;
    }
    const fileNode = builder.addNode({
      id: `file:${relative}`,
      kind: "source_file",
      label: relative,
      location: { path: relative, line: 1 },
    });
    for (const [alias, targets] of Object.entries(
      config.compilerOptions?.paths ?? {},
    )) {
      const aliasNode = builder.addNode({
        id: `package-alias:${alias}`,
        kind: "package",
        label: alias,
        attributes: { aliasTargets: targets },
        location: { path: relative, line: 1 },
      });
      builder.addEdge({
        kind: "registers",
        from: fileNode,
        to: aliasNode,
        location: { path: relative, line: 1 },
      });
    }
  }
  return packagePaths;
}
