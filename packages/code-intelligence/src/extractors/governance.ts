import path from "node:path";
import { GraphBuilder } from "../graph";
import { GraphNodeKind, SourceLocationV1 } from "../schema";
import { lineOf, readUtf8, relativePath, walkFiles } from "../utils";

const GOVERNANCE_ID =
  /\b(CAP|SCN|PAGE|OBJ|OWN|DEC)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

function kindFor(prefix: string): GraphNodeKind {
  switch (prefix) {
    case "CAP":
      return "capability";
    case "SCN":
      return "scenario";
    case "PAGE":
      return "page";
    case "OBJ":
      return "business_object";
    case "OWN":
      return "owner";
    case "DEC":
      return "decision";
    default:
      throw new Error(`unsupported governance prefix ${prefix}`);
  }
}

function addGovernanceNode(
  builder: GraphBuilder,
  id: string,
  location: SourceLocationV1,
): string {
  const prefix = id.split("-", 1)[0];
  return builder.addNode({
    id: `governance:${id}`,
    kind: kindFor(prefix),
    label: id,
    attributes:
      prefix === "OWN"
        ? { accountableRole: id, assignee: "UNASSIGNED" }
        : { registryId: id },
    location,
  });
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export async function extractGovernance(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  const governanceRoot = path.join(repositoryRoot, "docs", "governance");
  const files = await walkFiles(governanceRoot, (relative) =>
    relative.endsWith(".md"),
  );
  for (const absolute of files) {
    const text = await readUtf8(absolute);
    const relative = relativePath(repositoryRoot, absolute);
    const fileNode = builder.addNode({
      id: `file:${relative}`,
      kind: "source_file",
      label: relative,
      attributes: { authorityLayer: "registry" },
      location: { path: relative, line: 1 },
    });

    for (const match of text.matchAll(GOVERNANCE_ID)) {
      const id = match[0];
      const location = {
        path: relative,
        line: lineOf(text, match.index ?? 0),
      };
      const node = addGovernanceNode(builder, id, location);
      builder.addEdge({
        kind: "references",
        from: fileNode,
        to: node,
        location,
      });
    }

    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trimStart().startsWith("|")) continue;
      const ids = [...line.matchAll(GOVERNANCE_ID)].map((match) => match[0]);
      if (ids.length === 0) continue;
      const location = { path: relative, line: index + 1 };
      const primary = addGovernanceNode(builder, ids[0], location);
      for (const referencedId of ids.slice(1)) {
        if (referencedId === ids[0]) continue;
        const referenced = addGovernanceNode(builder, referencedId, location);
        const prefix = referencedId.split("-", 1)[0];
        if (prefix === "OWN") {
          builder.addEdge({
            kind: "owns",
            from: referenced,
            to: primary,
            location,
          });
        } else if (
          ids[0].startsWith("CAP-") &&
          referencedId.startsWith("CAP-")
        ) {
          builder.addEdge({
            kind: "depends_on",
            from: primary,
            to: referenced,
            attributes: { relation: "parent-or-related-capability" },
            location,
          });
        } else {
          builder.addEdge({
            kind: "references",
            from: primary,
            to: referenced,
            location,
          });
        }
      }

      const cells = splitMarkdownRow(line);
      if (ids[0].startsWith("OWN-") && cells.length >= 3) {
        builder.addNode({
          id: `governance:${ids[0]}`,
          kind: "owner",
          label: ids[0],
          attributes: {
            roleLabel: cells[1]?.replaceAll("`", "") ?? ids[0],
            assignmentStatus: cells[2]?.replaceAll("`", "") ?? "UNKNOWN",
            assignee: "UNASSIGNED",
          },
          location,
        });
      }
      if (ids[0].startsWith("CAP-") && cells.length >= 2) {
        const outcomeCell =
          /^`?CAP-/.test(cells[1] ?? "") && cells.length >= 3
            ? cells[2]
            : cells[1];
        builder.addNode({
          id: `governance:${ids[0]}`,
          kind: "capability",
          label: ids[0],
          attributes: {
            userOutcome: outcomeCell?.replaceAll("`", "").slice(0, 500) ?? "",
          },
          location,
        });
      }
      if (ids[0].startsWith("SCN-") && cells.length >= 2) {
        builder.addNode({
          id: `governance:${ids[0]}`,
          kind: "scenario",
          label: ids[0],
          attributes: {
            scenario: cells[1]?.replaceAll("`", "").slice(0, 500) ?? "",
          },
          location,
        });
      }
      if (line.includes("EXTERNAL_OWNED") || line.includes("UNKNOWN")) {
        builder.addDiagnostic({
          code: line.includes("EXTERNAL_OWNED")
            ? "EXTERNAL_OWNED"
            : "UNKNOWN_RELATION",
          severity: "info",
          message: `${ids[0]} contains an explicit non-local or unknown boundary`,
          nodeId: primary,
          location,
        });
      }
    }
  }
}
