import path from "node:path";
import { GraphBuilder } from "../graph";
import { readUtf8, relativePath, walkFiles } from "../utils";

function serviceNode(kind: "compose" | "systemd", name: string): string {
  return `service:${kind}:${name}`;
}

export async function extractInfrastructure(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  const composeCandidates = ["docker-compose.yml", "docker-compose.yaml"];
  for (const candidate of composeCandidates) {
    const absolute = path.join(repositoryRoot, candidate);
    let text: string;
    try {
      text = await readUtf8(absolute);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    let inServices = false;
    let current: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^services:\s*$/.test(line)) {
        inServices = true;
        continue;
      }
      if (inServices && /^\S/.test(line) && !/^services:/.test(line)) {
        inServices = false;
        current = null;
      }
      const service = inServices
        ? /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line)?.[1]
        : undefined;
      if (service) {
        current = service;
        builder.addNode({
          id: serviceNode("compose", service),
          kind: "service",
          label: service,
          attributes: { runtime: "docker-compose" },
          location: { path: candidate, line: index + 1 },
        });
        continue;
      }
      if (!current) continue;
      const image = /^\s{4}image:\s*(.+?)\s*(?:#.*)?$/.exec(line)?.[1];
      const build = /^\s{4}build:\s*(.+?)\s*(?:#.*)?$/.exec(line)?.[1];
      if (image || build) {
        builder.addNode({
          id: serviceNode("compose", current),
          kind: "service",
          label: current,
          attributes: {
            image: image ?? null,
            localBuild: Boolean(build),
          },
          location: { path: candidate, line: index + 1 },
        });
      }
      const dependency = /^\s{6}-?\s*([a-zA-Z0-9_-]+)\s*$/.exec(line)?.[1];
      if (
        dependency &&
        lines
          .slice(Math.max(0, index - 2), index)
          .some((value) => /depends_on:/.test(value))
      ) {
        builder.addNode({
          id: serviceNode("compose", dependency),
          kind: "service",
          label: dependency,
          attributes: { runtime: "docker-compose" },
          location: { path: candidate, line: index + 1 },
        });
        builder.addEdge({
          kind: "depends_on",
          from: serviceNode("compose", current),
          to: serviceNode("compose", dependency),
          location: { path: candidate, line: index + 1 },
        });
      }
    }
  }

  const unitFiles = await walkFiles(
    path.join(repositoryRoot, "infra"),
    (relative) => relative.endsWith(".service"),
  );
  for (const absolute of unitFiles) {
    const relative = relativePath(repositoryRoot, absolute);
    const text = await readUtf8(absolute);
    const name = path.basename(absolute);
    const node = builder.addNode({
      id: serviceNode("systemd", name),
      kind: "deployment",
      label: name,
      attributes: {
        runtime: "systemd",
        workingDirectory: /^WorkingDirectory=(.+)$/m.exec(text)?.[1] ?? null,
        restart: /^Restart=(.+)$/m.exec(text)?.[1] ?? null,
      },
      location: { path: relative, line: 1 },
    });
    for (const relation of ["After", "Requires", "Wants"] as const) {
      const values = new Set(
        [...text.matchAll(new RegExp(`^${relation}=(.+)$`, "gm"))]
          .flatMap((match) => match[1].trim().split(/\s+/))
          .filter(Boolean),
      );
      for (const dependency of values) {
        const target = builder.addNode({
          id: serviceNode("systemd", dependency),
          kind: "deployment",
          label: dependency,
          attributes: { runtime: "systemd", externalDefinition: true },
          location: { path: relative, line: 1 },
        });
        builder.addEdge({
          kind: "depends_on",
          from: node,
          to: target,
          attributes: { systemdRelation: relation },
          location: { path: relative, line: 1 },
        });
      }
    }
  }

  const workflowFiles = await walkFiles(
    path.join(repositoryRoot, ".github", "workflows"),
    (relative) => relative.endsWith(".yml") || relative.endsWith(".yaml"),
  );
  for (const absolute of workflowFiles) {
    const relative = relativePath(repositoryRoot, absolute);
    const text = await readUtf8(absolute);
    const lines = text.split("\n");
    let inJobs = false;
    let currentJob: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (inJobs && /^\S/.test(line)) {
        inJobs = false;
        currentJob = null;
      }
      const job = inJobs
        ? /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line)?.[1]
        : undefined;
      if (job) {
        currentJob = job;
        builder.addNode({
          id: `ci-job:${relative}:${job}`,
          kind: "ci_job",
          label: job,
          attributes: { workflow: relative },
          location: { path: relative, line: index + 1 },
        });
        continue;
      }
      if (!currentJob) continue;
      const step = /^\s{6}-\s+name:\s*(.+)$/.exec(line)?.[1];
      if (step) {
        const stepNode = builder.addNode({
          id: `ci-step:${relative}:${currentJob}:${step}`,
          kind: "test",
          label: step,
          attributes: { ciJob: currentJob },
          location: { path: relative, line: index + 1 },
        });
        builder.addEdge({
          kind: "contains",
          from: `ci-job:${relative}:${currentJob}`,
          to: stepNode,
          location: { path: relative, line: index + 1 },
        });
      }
    }
  }
}
