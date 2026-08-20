import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILD_SHA = /^[0-9a-f]{40}$/;

function canonicalTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('SBOM builtAt must be canonical RFC3339 UTC');
  }
  return value;
}

function packageUrl(name, version) {
  const encodedName = name.split('/').map(encodeURIComponent).join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function packageIdentity(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid pnpm dependency record: ${name}`);
  }
  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error(`pnpm dependency version is required: ${name}`);
  }
  return { name, version: value.version, ref: packageUrl(name, value.version) };
}

export function generateRuntimeSbom({
  dependencyTrees,
  buildSha,
  builtAt,
  requiredComponents = [],
  operatingSystemPackages = [],
}) {
  if (!BUILD_SHA.test(buildSha)) throw new Error('SBOM buildSha must be 40 lowercase hex');
  if (!Array.isArray(dependencyTrees) || dependencyTrees.length === 0) {
    throw new Error('SBOM dependencyTrees must be a non-empty array');
  }
  const components = new Map();
  const dependencyEdges = new Map();
  const rootRefs = new Set();

  const visit = (name, value, root = false) => {
    const identity = packageIdentity(name, value);
    if (!components.has(identity.ref)) {
      components.set(identity.ref, {
        type: root ? 'application' : 'library',
        'bom-ref': identity.ref,
        name: identity.name,
        version: identity.version,
        purl: identity.ref,
      });
    } else if (root) {
      components.set(identity.ref, {
        ...components.get(identity.ref),
        type: 'application',
      });
    }
    if (root) rootRefs.add(identity.ref);
    const children = Object.entries(value.dependencies ?? {})
      .map(([childName, child]) => packageIdentity(childName, child))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const existing = dependencyEdges.get(identity.ref) ?? new Set();
    for (const child of children) existing.add(child.ref);
    dependencyEdges.set(identity.ref, existing);
    for (const [childName, child] of Object.entries(value.dependencies ?? {})) {
      visit(childName, child, false);
    }
  };

  for (const tree of dependencyTrees) {
    if (!tree || typeof tree.name !== 'string') {
      throw new Error('SBOM root package name is required');
    }
    visit(tree.name, tree, true);
  }
  for (const component of requiredComponents) {
    if (
      !component ||
      typeof component.name !== 'string' ||
      typeof component.version !== 'string'
    ) {
      throw new Error('SBOM required component identity is invalid');
    }
    visit(component.name, { version: component.version, dependencies: {} }, false);
  }
  for (const component of operatingSystemPackages) {
    if (
      !component ||
      typeof component.name !== 'string' ||
      typeof component.version !== 'string' ||
      typeof component.architecture !== 'string'
    ) {
      throw new Error('SBOM operating-system package identity is invalid');
    }
    const ref = `pkg:deb/debian/${encodeURIComponent(component.name)}@${encodeURIComponent(component.version)}?arch=${encodeURIComponent(component.architecture)}`;
    components.set(ref, {
      type: 'library',
      'bom-ref': ref,
      name: component.name,
      version: component.version,
      purl: ref,
      properties: [{ name: 'global:package-manager', value: 'dpkg' }],
    });
    dependencyEdges.set(ref, new Set());
  }

  const sortedComponents = [...components.values()].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref']),
  );
  const dependencies = sortedComponents.map((component) => ({
    ref: component['bom-ref'],
    dependsOn: [...(dependencyEdges.get(component['bom-ref']) ?? [])].sort(),
  }));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: canonicalTimestamp(builtAt),
      tools: {
        components: [
          {
            type: 'application',
            name: 'global-runtime-sbom-generator',
            version: '1',
          },
        ],
      },
      component: {
        type: 'application',
        'bom-ref': `urn:global-backend:${buildSha}`,
        name: 'global-backend-runtime',
        version: buildSha,
        components: [...rootRefs]
          .sort()
          .map((ref) => components.get(ref)),
      },
    },
    components: sortedComponents,
    dependencies,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, buildSha, builtAt, output, ...extra] = process.argv.slice(2);
  if (!input || !buildSha || !builtAt || !output) {
    throw new Error(
      'usage: generate-runtime-sbom.mjs <pnpm-list.json> <build-sha> <built-at> <output> [name@version...]',
    );
  }
  const dpkgFlag = extra.indexOf('--dpkg-inventory');
  const dpkgPath = dpkgFlag >= 0 ? extra[dpkgFlag + 1] : undefined;
  if (dpkgFlag >= 0 && !dpkgPath) {
    throw new Error('--dpkg-inventory requires a path');
  }
  const required = extra.filter(
    (_, index) => index !== dpkgFlag && index !== dpkgFlag + 1,
  );
  const requiredComponents = required.map((identity) => {
    const separator = identity.lastIndexOf('@');
    if (separator <= 0 || separator === identity.length - 1) {
      throw new Error('SBOM required component must be name@version');
    }
    return {
      name: identity.slice(0, separator),
      version: identity.slice(separator + 1),
    };
  });
  const operatingSystemPackages = dpkgPath
    ? (await readFile(dpkgPath, 'utf8'))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          const [name, version, architecture, ...unexpected] = line.split('\t');
          if (!name || !version || !architecture || unexpected.length > 0) {
            throw new Error('dpkg inventory row must be name, version and architecture');
          }
          return { name, version, architecture };
        })
    : [];
  const dependencyTrees = JSON.parse(await readFile(input, 'utf8'));
  const sbom = generateRuntimeSbom({
    dependencyTrees,
    buildSha,
    builtAt,
    requiredComponents,
    operatingSystemPackages,
  });
  await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: 'RUNTIME_SBOM_WRITTEN' })}\n`);
}
