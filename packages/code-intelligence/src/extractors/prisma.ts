import path from "node:path";
import { GraphBuilder } from "../graph";
import { lineOf, readUtf8, relativePath, walkFiles } from "../utils";

export interface PrismaModelInfo {
  name: string;
  table: string;
}

export interface PrismaCatalog {
  models: PrismaModelInfo[];
  modelNames: Set<string>;
  clientNames: Map<string, string>;
}

export function prismaModelId(name: string): string {
  return `data-model:prisma:${name}`;
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0].toLowerCase() + value.slice(1);
}

export async function extractPrisma(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<PrismaCatalog> {
  const schemaPath = path.join(
    repositoryRoot,
    "packages",
    "db",
    "prisma",
    "schema.prisma",
  );
  const schema = await readUtf8(schemaPath);
  const relativeSchema = relativePath(repositoryRoot, schemaPath);
  const models: PrismaModelInfo[] = [];
  const modelBlock = /^model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm;
  for (const match of schema.matchAll(modelBlock)) {
    const name = match[1];
    const body = match[2];
    const mapped = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    const location = {
      path: relativeSchema,
      line: lineOf(schema, match.index ?? 0),
    };
    models.push({ name, table: mapped });
    const modelNode = builder.addNode({
      id: prismaModelId(name),
      kind: "data_model",
      label: name,
      attributes: {
        prismaModel: name,
        databaseTable: mapped,
        tenantScoped: /\bworkspaceId\b/.test(body),
        hasRlsContract: /\bworkspaceId\b/.test(body),
        complianceSurface:
          /(Claim|Evidence|Personal|Contact|Suppression|Retention|Deletion|Privacy|Consent|License|SourcePolicy)/.test(
            name,
          ),
      },
      location,
    });
    builder.addEdge({
      kind: "contains",
      from: builder.addNode({
        id: `file:${relativeSchema}`,
        kind: "source_file",
        label: relativeSchema,
        location: { path: relativeSchema, line: 1 },
      }),
      to: modelNode,
      location,
    });
  }

  const byName = new Map(models.map((model) => [model.name, model]));
  const byTable = new Map(models.map((model) => [model.table, model]));
  for (const match of schema.matchAll(modelBlock)) {
    const fromName = match[1];
    const body = match[2];
    const bodyStart = (match.index ?? 0) + match[0].indexOf(body);
    const field =
      /^\s*([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*)(?:\[\]|\?)?\s*(.*)$/gm;
    for (const fieldMatch of body.matchAll(field)) {
      const targetName = fieldMatch[2];
      if (!byName.has(targetName) || targetName === fromName) continue;
      const location = {
        path: relativeSchema,
        line: lineOf(schema, bodyStart + (fieldMatch.index ?? 0)),
      };
      builder.addEdge({
        kind: "references",
        from: prismaModelId(fromName),
        to: prismaModelId(targetName),
        attributes: { field: fieldMatch[1], relation: "prisma-relation" },
        location,
      });
    }
  }

  const migrationsRoot = path.join(
    repositoryRoot,
    "packages",
    "db",
    "prisma",
    "migrations",
  );
  const migrations = await walkFiles(
    migrationsRoot,
    (relative) =>
      relative.endsWith("/migration.sql") || relative === "migration.sql",
  );
  for (const migrationPath of migrations) {
    const sql = await readUtf8(migrationPath);
    const relative = relativePath(repositoryRoot, migrationPath);
    const migrationName = path.basename(path.dirname(migrationPath));
    const migrationNode = builder.addNode({
      id: `migration:${migrationName}`,
      kind: "migration",
      label: migrationName,
      attributes: {
        rls: /ROW LEVEL SECURITY|CREATE\s+POLICY|FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(
          sql,
        ),
      },
      location: { path: relative, line: 1 },
    });
    for (const tableMatch of sql.matchAll(
      /(?:TABLE|ON)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:"public"\.)?"([^"]+)"/gi,
    )) {
      const table = tableMatch[1];
      const known = byTable.get(table);
      const target = known
        ? prismaModelId(known.name)
        : builder.addNode({
            id: `data-model:table:${table}`,
            kind: "data_model",
            label: table,
            attributes: { databaseTable: table, prismaModel: null },
            location: {
              path: relative,
              line: lineOf(sql, tableMatch.index ?? 0),
            },
          });
      builder.addEdge({
        kind: "modifies",
        from: migrationNode,
        to: target,
        location: {
          path: relative,
          line: lineOf(sql, tableMatch.index ?? 0),
        },
      });
    }
  }

  return {
    models: models.sort((left, right) => left.name.localeCompare(right.name)),
    modelNames: new Set(models.map((model) => model.name)),
    clientNames: new Map(
      models.map((model) => [lowerFirst(model.name), model.name]),
    ),
  };
}
