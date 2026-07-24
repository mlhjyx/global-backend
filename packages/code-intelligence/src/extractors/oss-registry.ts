import path from "node:path";
import { GraphBuilder } from "../graph";
import { readUtf8, relativePath } from "../utils";

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replaceAll("`", ""));
}

export async function extractOssRegistry(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  const absolute = path.join(
    repositoryRoot,
    "docs",
    "backend",
    "oss-registry.md",
  );
  const text = await readUtf8(absolute);
  const relative = relativePath(repositoryRoot, absolute);
  const lines = text.split("\n");
  const fileNode = builder.addNode({
    id: `file:${relative}`,
    kind: "source_file",
    label: relative,
    attributes: { authorityLayer: "adoption-registry" },
    location: { path: relative, line: 1 },
  });
  for (let index = 0; index < lines.length; index += 1) {
    const row = cells(lines[index]);
    if (!/^ADP-FE-\d{3}$/.test(row[0] ?? "") || row.length < 7) continue;
    const [cardId, candidate, domain, decision, license, boundary, ownerId] =
      row;
    const location = { path: relative, line: index + 1 };
    const card = builder.addNode({
      id: `governance:${cardId}`,
      kind: "decision",
      label: cardId,
      attributes: {
        adoptionCandidate: candidate,
        domain,
        decision,
      },
      location,
    });
    const candidateNode = builder.addNode({
      id: candidate.startsWith("@global/")
        ? `service:internal:${candidate}`
        : `external:adoption:${cardId}`,
      kind: candidate.startsWith("@global/") ? "service" : "external_system",
      label: candidate,
      attributes: {
        adoptionCard: cardId,
        decision,
        licenseBoundary: license,
        localBoundary: boundary,
        ownership: candidate.startsWith("@global/")
          ? "INTERNAL_OWNED"
          : "EXTERNAL_OWNED",
        assignee: "UNASSIGNED",
      },
      location,
    });
    const owner = builder.addNode({
      id: `governance:${ownerId}`,
      kind: "owner",
      label: ownerId,
      attributes: {
        accountableRole: ownerId,
        assignee: "UNASSIGNED",
      },
      location,
    });
    builder.addEdge({ kind: "contains", from: fileNode, to: card, location });
    builder.addEdge({
      kind: "references",
      from: card,
      to: candidateNode,
      location,
    });
    builder.addEdge({ kind: "owns", from: owner, to: candidateNode, location });
  }
}
