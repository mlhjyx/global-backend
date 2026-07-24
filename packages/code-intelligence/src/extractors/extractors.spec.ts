import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractAstro } from "./astro";
import { extractAiAndTools } from "./ai-tools";
import { extractGovernance } from "./governance";
import { extractPrisma } from "./prisma";
import { extractTraceability } from "./traceability";
import { extractTypeScript } from "./typescript";
import { GraphBuilder } from "../graph";
import { createImpactReport } from "../impact";
import { EvidenceRefV1 } from "../schema";

const EVIDENCE: EvidenceRefV1 = {
  schemaVersion: "evidence-ref/v1",
  repositoryRoot: "/repo",
  worktreePath: "/repo",
  branch: "main",
  commit: "a".repeat(40),
  commitTime: "2026-07-25T00:00:00Z",
  dirty: false,
  sourceHash: "b".repeat(64),
};

async function fixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "contract-graph-test-"));
}

test("governance extraction separates responsibility role from real assignee", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "docs", "governance"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "governance", "capability-register.md"),
      [
        "| Capability ID | Parent | 用户结果 | Pages | 产品状态 | Owner |",
        "|---|---|---|---|---|---|",
        "| `CAP-SITE-X-001` | `CAP-SITE-001` | 完成目标 | `PAGE-FE-001` | `APPROVED_NOT_BUILT` | `OWN-PRODUCT` |",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "docs", "governance", "core-object-register.md"),
      [
        "| Blocker | 缺失 Owner/合同 | 阻止什么 |",
        "|---|---|---|",
        "| `OBJ-BLK-001` | 正式 SaaS repo 与 Owner | 正式前端施工 |",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "docs", "governance", "terminology-and-status.md"),
      [
        "| Owner ID | Role | Status |",
        "|---|---|---|",
        "| `OWN-PRODUCT` | 产品负责人 | `ROLE_EXISTS_ASSIGNEE_UNRECORDED` |",
      ].join("\n"),
    );
    const builder = new GraphBuilder();
    await extractGovernance(builder, root);
    const graph = builder.finalize(EVIDENCE);
    const capability = graph.nodes.find(
      (node) => node.id === "governance:CAP-SITE-X-001",
    );
    const owner = graph.nodes.find(
      (node) => node.id === "governance:OWN-PRODUCT",
    );
    const blocker = graph.nodes.find(
      (node) => node.id === "governance:OBJ-BLK-001",
    );
    assert.equal(capability?.attributes.userOutcome, "完成目标");
    assert.equal(capability?.attributes.productStatus, "APPROVED_NOT_BUILT");
    assert.equal(owner?.attributes.assignee, "UNASSIGNED");
    assert.equal(
      blocker?.attributes.boundaryStatus,
      "OPEN_EXTERNAL_OWNERSHIP_BLOCKER",
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "owns" &&
          edge.from === owner?.id &&
          edge.to === capability?.id,
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical traceability links Capability to API, implementation, test, and impact report", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "docs", "governance"), { recursive: true });
    await mkdir(path.join(root, "apps", "api", "src", "temporal"), {
      recursive: true,
    });
    await mkdir(path.join(root, "packages", "db", "prisma", "migrations"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "docs", "governance", "traceability-matrix.md"),
      [
        "| Capability | Public contract | Controller/DTO | TEST_ANCHOR | Scenario |",
        "|---|---|---|---|---|",
        "| `CAP-SITE-INTAKE-001` | `IntakeController_create_v1` | `apps/api/src/intake.controller.ts` | `apps/api/src/intake.controller.spec.ts` | `SCN-FE-SITE-001` |",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "packages", "db", "prisma", "schema.prisma"),
      'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n',
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "temporal", "workflows.ts"),
      "",
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "intake.controller.ts"),
      [
        'import { Controller, Post } from "@nestjs/common";',
        '@Controller("intake")',
        "export class IntakeController {",
        '  @Post("")',
        "  async create() { return {}; }",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "intake.controller.spec.ts"),
      [
        'import { IntakeController } from "./intake.controller";',
        "void IntakeController;",
      ].join("\n"),
    );
    const builder = new GraphBuilder();
    await extractGovernance(builder, root);
    const prisma = await extractPrisma(builder, root);
    await extractTypeScript(builder, root, prisma);
    await extractTraceability(builder, root);
    const graph = builder.finalize(EVIDENCE);
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.from === "governance:CAP-SITE-INTAKE-001" &&
          edge.to === "api:POST:/intake" &&
          edge.attributes.relation === "public-contract",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.from === "governance:CAP-SITE-INTAKE-001" &&
          edge.to === "file:apps/api/src/intake.controller.ts",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.from === "test:apps/api/src/intake.controller.spec.ts" &&
          edge.to === "governance:CAP-SITE-INTAKE-001",
      ),
      true,
    );
    const impact = createImpactReport(graph, [
      "apps/api/src/intake.controller.ts",
    ]);
    assert.equal(
      impact.businessImpact.some(
        (item) => item.capabilityId === "CAP-SITE-INTAKE-001",
      ),
      true,
    );
    assert.equal(
      impact.recommendedTests.includes(
        "apps/api/src/intake.controller.spec.ts",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Prisma and TypeScript extraction connect API, Outbox, workflow activity, and data access", async () => {
  const root = await fixture();
  try {
    await mkdir(
      path.join(root, "packages", "db", "prisma", "migrations", "001_init"),
      {
        recursive: true,
      },
    );
    await mkdir(path.join(root, "apps", "api", "src", "temporal"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "packages", "db", "prisma", "schema.prisma"),
      [
        'datasource db { provider = "postgresql" url = env("DATABASE_URL") }',
        "model Site {",
        "  id String @id",
        "  workspaceId String",
        '  @@map("site")',
        "}",
        "model Secured {",
        "  id String @id",
        "  workspaceId String",
        '  @@map("secured")',
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(
        root,
        "packages",
        "db",
        "prisma",
        "migrations",
        "001_init",
        "migration.sql",
      ),
      [
        'CREATE TABLE "site" ("id" text primary key);',
        'CREATE TABLE "secured" ("id" text primary key);',
        'ALTER TABLE "secured" ENABLE ROW LEVEL SECURITY;',
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "temporal", "workflows.ts"),
      "export { siteWorkflow } from './site.workflow';\n",
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "temporal", "site.workflow.ts"),
      [
        'import { proxyActivities } from "@temporalio/workflow";',
        "const acts = proxyActivities<Activities>({ startToCloseTimeout: '1 minute' });",
        "const { publishSite } = proxyActivities<Activities>({ startToCloseTimeout: '1 minute' });",
        "export async function siteWorkflow() { await acts.buildSite(); await publishSite(); }",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "temporal", "site.activities.ts"),
      [
        "async function publishSite() { return undefined; }",
        "export function createSiteActivities() {",
        "  return {",
        "    async buildSite() { return undefined; },",
        "    arrowSite: async () => undefined,",
        "    functionSite: async function () { return undefined; },",
        "    publishSite,",
        "    missingActivity,",
        "  };",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(
        root,
        "apps",
        "api",
        "src",
        "temporal",
        "understanding.constants.ts",
      ),
      [
        "export const SITE_WORKFLOW = 'siteWorkflow';",
        "export const SITE_SCHEDULE_ID = 'site-daily';",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "temporal", "ensure-schedules.ts"),
      [
        "import { SITE_SCHEDULE_ID, SITE_WORKFLOW } from './understanding.constants';",
        "const SPECS = [{ id: SITE_SCHEDULE_ID, workflowType: SITE_WORKFLOW }];",
        "export async function ensureSchedules(client: any) {",
        "  for (const spec of SPECS) await client.schedule.create({ scheduleId: spec.id, action: { workflowType: spec.workflowType } });",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "site.controller.ts"),
      [
        'import { Controller, Get } from "@nestjs/common";',
        '@Controller("sites")',
        "export class SiteController {",
        '  @Get(":id")',
        "  async get() {",
        "    await this.prisma.site.findUnique({ where: { id: 'x' } });",
        "    await this.prisma.outboxEvent.create({ data: { eventType: 'SiteRead' } });",
        "  }",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "apps", "api", "src", "site.controller.spec.ts"),
      'const adversarialFixture = "http://169.254.169.254/latest/meta-data";\nvoid adversarialFixture;\n',
    );
    const builder = new GraphBuilder();
    const prisma = await extractPrisma(builder, root);
    await extractTypeScript(builder, root, prisma);
    const graph = builder.finalize(EVIDENCE);
    assert.equal(
      graph.nodes.some((node) => node.id === "api:GET:/sites/:id"),
      true,
    );
    assert.equal(
      graph.nodes.some((node) => node.id === "workflow:temporal:siteWorkflow"),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.from === "workflow:temporal:siteWorkflow" &&
          edge.to === "activity:temporal:buildSite",
      ),
      true,
    );
    for (const expected of [
      {
        from: "symbol:apps/api/src/temporal/site.activities.ts#createSiteActivities.arrowSite",
        to: "activity:temporal:arrowSite",
      },
      {
        from: "symbol:apps/api/src/temporal/site.activities.ts#createSiteActivities.functionSite",
        to: "activity:temporal:functionSite",
      },
      {
        from: "symbol:apps/api/src/temporal/site.activities.ts#publishSite",
        to: "activity:temporal:publishSite",
      },
    ]) {
      assert.equal(
        graph.edges.some(
          (edge) =>
            edge.kind === "implements" &&
            edge.from === expected.from &&
            edge.to === expected.to &&
            edge.attributes.binding === "activity-factory-return" &&
            edge.attributes.confidence === "PROVEN_STATIC_FACTORY",
        ),
        true,
      );
    }
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "implements" &&
          edge.from ===
            "symbol-ref:apps/api/src/temporal/site.activities.ts#missingActivity" &&
          edge.to === "activity:temporal:missingActivity" &&
          edge.attributes.confidence === "UNKNOWN",
      ),
      true,
    );
    assert.equal(
      graph.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "UNKNOWN_RELATION" &&
          diagnostic.nodeId ===
            "symbol-ref:apps/api/src/temporal/site.activities.ts#missingActivity",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "implements" &&
          edge.from.endsWith("#createSiteActivities.buildSite") &&
          edge.to === "activity:temporal:buildSite" &&
          edge.attributes.binding === "activity-factory-return" &&
          edge.attributes.confidence === "PROVEN_STATIC_FACTORY",
      ),
      true,
    );
    assert.equal(
      graph.nodes
        .find((node) => node.id === "activity:temporal:buildSite")
        ?.locations.some(
          (location) =>
            location.path === "apps/api/src/temporal/site.activities.ts",
        ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.from === "workflow:temporal:siteWorkflow" &&
          edge.to === "activity:temporal:publishSite" &&
          edge.attributes.binding === "destructured-proxy-activity",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.from === "service:temporal-schedule:site-daily" &&
          edge.to === "workflow:temporal:siteWorkflow",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) => edge.kind === "reads" && edge.to === "data-model:prisma:Site",
      ),
      true,
    );
    assert.equal(
      graph.nodes.some((node) => node.id === "event:outbox:SiteRead"),
      true,
    );
    assert.equal(
      graph.nodes.find((node) => node.id === "data-model:prisma:Site")
        ?.attributes.hasRlsContract,
      false,
    );
    assert.equal(
      graph.nodes.find((node) => node.id === "data-model:prisma:Secured")
        ?.attributes.hasRlsContract,
      true,
    );
    assert.equal(
      graph.nodes.some((node) => node.id === "external:http://169.254.169.254"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Outbox Set registries emit exact registration and membership-dispatch edges", async () => {
  const root = await fixture();
  try {
    const relay = path.join(root, "apps", "api", "src", "relay");
    const prisma = path.join(root, "packages", "db", "prisma");
    const temporal = path.join(root, "apps", "api", "src", "temporal");
    await mkdir(relay, { recursive: true });
    await mkdir(prisma, { recursive: true });
    await mkdir(path.join(prisma, "migrations"), { recursive: true });
    await mkdir(temporal, { recursive: true });
    await writeFile(
      path.join(prisma, "schema.prisma"),
      'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n',
    );
    await writeFile(path.join(temporal, "workflows.ts"), "");
    await writeFile(
      path.join(relay, "event-registry.ts"),
      [
        "export const INTERNAL_COMMANDS: ReadonlySet<string> = new Set([",
        "  'AssetObjectCleanupRequested',",
        "]);",
        "export const INTEGRATION_EVENTS: ReadonlySet<string> = new Set([",
        "  'LeadQualified',",
        "]);",
      ].join("\n"),
    );
    await writeFile(
      path.join(relay, "outbox-relay.service.ts"),
      [
        "import { INTERNAL_COMMANDS, INTEGRATION_EVENTS } from './event-registry';",
        "export class OutboxRelayService {",
        "  async routeEvent(ev: { eventType: string }) {",
        "    if (INTERNAL_COMMANDS.has(ev.eventType)) return 'internal';",
        "    if (INTEGRATION_EVENTS.has(ev.eventType)) return 'integration';",
        "    return 'unknown';",
        "  }",
        "}",
      ].join("\n"),
    );
    const builder = new GraphBuilder();
    const prismaCatalog = await extractPrisma(builder, root);
    await extractTypeScript(builder, root, prismaCatalog);
    const graph = builder.finalize(EVIDENCE);
    const routeEvent =
      "symbol:apps/api/src/relay/outbox-relay.service.ts#OutboxRelayService.routeEvent";
    for (const registry of ["INTERNAL_COMMANDS", "INTEGRATION_EVENTS"]) {
      assert.equal(
        graph.edges.some(
          (edge) =>
            edge.kind === "consumes" &&
            edge.from === routeEvent &&
            edge.to === `service:outbox-event-registry:${registry}` &&
            edge.attributes.confidence === "PROVEN_STATIC_SET_MEMBERSHIP",
        ),
        true,
      );
    }
    for (const [registry, eventType] of [
      ["INTERNAL_COMMANDS", "AssetObjectCleanupRequested"],
      ["INTEGRATION_EVENTS", "LeadQualified"],
    ]) {
      assert.equal(
        graph.edges.some(
          (edge) =>
            edge.kind === "registers" &&
            edge.from === `service:outbox-event-registry:${registry}` &&
            edge.to === `event:outbox:${eventType}` &&
            edge.attributes.confidence === "PROVEN_STATIC_SET_REGISTRATION",
        ),
        true,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Astro extraction records component render edges", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "apps", "site", "src", "components"), {
      recursive: true,
    });
    await mkdir(path.join(root, "apps", "site", "src", "pages"), {
      recursive: true,
    });
    await mkdir(path.join(root, "apps", "site", "src", "lib"), {
      recursive: true,
    });
    await mkdir(path.join(root, "apps", "site", "src", "styles"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "apps", "site", "src", "components", "Hero.astro"),
      "<h1>Hero</h1>",
    );
    await writeFile(
      path.join(root, "apps", "site", "src", "lib", "page-reference.ts"),
      "export const localeQualifiedPageHref = () => '/';",
    );
    await writeFile(
      path.join(root, "apps", "site", "src", "styles", "global.css"),
      "body { color: black; }\n",
    );
    await writeFile(
      path.join(root, "apps", "site", "src", "pages", "index.astro"),
      [
        "---",
        'import Hero from "../components/Hero.astro";',
        'import { localeQualifiedPageHref } from "../lib/page-reference";',
        'import "../styles/global.css";',
        'import "@fontsource/noto-sans/latin-400.css";',
        "---",
        "<Hero href={localeQualifiedPageHref()} />",
      ].join("\n"),
    );
    const builder = new GraphBuilder();
    await extractAstro(builder, root);
    const graph = builder.finalize(EVIDENCE);
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.from.endsWith("pages/index.astro#default") &&
          edge.to.endsWith("components/Hero.astro#default"),
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "depends_on" &&
          edge.from === "file:apps/site/src/pages/index.astro" &&
          edge.to === "file:apps/site/src/styles/global.css",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "depends_on" &&
          edge.from === "file:apps/site/src/pages/index.astro" &&
          edge.to === "package:@fontsource/noto-sans",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "depends_on" &&
          edge.from === "file:apps/site/src/pages/index.astro" &&
          edge.to === "file:apps/site/src/lib/page-reference.ts",
      ),
      true,
    );
    const styleImpact = createImpactReport(graph, [
      "apps/site/src/styles/global.css",
    ]);
    assert.equal(
      styleImpact.codeImpact.includes("file:apps/site/src/pages/index.astro"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI and ToolBroker extraction preserves route, budget, evidence, and personal-data gates", async () => {
  const root = await fixture();
  try {
    const agents = path.join(
      root,
      "apps",
      "api",
      "src",
      "site-builder",
      "agents",
    );
    const tools = path.join(root, "apps", "api", "src", "tools");
    await mkdir(agents, { recursive: true });
    await mkdir(tools, { recursive: true });
    await writeFile(
      path.join(agents, "model-policy.registry.ts"),
      [
        "const EVIDENCE = { id: 'evidence-1' };",
        "const LEGACY_TASK_POLICIES = {",
        "  'site_builder.copy': { state: 'currentRoute', route: { primary: 'legacy', fallbacks: [] } },",
        "};",
        "const ACTIVE_TASK_POLICIES = {",
        "  ...LEGACY_TASK_POLICIES,",
        "  'site_builder.copy': { state: 'promotedRoute', route: { primary: 'primary-model', fallbacks: ['fallback-model'] }, promotionEvidenceId: EVIDENCE.id },",
        "};",
      ].join("\n"),
    );
    await writeFile(
      path.join(agents, "task-route-bindings.ts"),
      [
        "const TIMEOUT = 120_000;",
        "const TASK_BINDINGS = Object.freeze({",
        "  'site_builder.copy': Object.freeze({ profile: 'copy.premium', maxTokens: 4000, timeoutMs: TIMEOUT, maxCostCents: 20 }),",
        "});",
      ].join("\n"),
    );
    await writeFile(
      path.join(tools, "tool-broker.ts"),
      "export class ToolBroker {}",
    );
    await writeFile(
      path.join(tools, "builtin-tools.ts"),
      [
        "const smtpTool = {",
        "  id: 'smtp.rcpt_probe',",
        "  cost: { external: false },",
        "  compliance: { sourcePolicy: 'advisory', personalData: true, allowedPurpose: ['discovery'], risk: 'medium' },",
        "};",
      ].join("\n"),
    );
    const builder = new GraphBuilder();
    await extractAiAndTools(builder, root);
    const graph = builder.finalize(EVIDENCE);
    const task = graph.nodes.find(
      (node) => node.id === "service:ai-task:site_builder.copy",
    );
    const tool = graph.nodes.find(
      (node) => node.id === "service:tool:smtp.rcpt_probe",
    );
    assert.equal(task?.attributes.routeState, "promotedRoute");
    assert.equal(task?.attributes.maxCostCents, 20);
    assert.equal(task?.attributes.timeoutMs, 120000);
    assert.equal(
      task?.attributes.killSwitch,
      "UNKNOWN_NOT_PROVEN_BY_TASK_BINDING",
    );
    assert.equal(task?.attributes.budgetContract, "DECLARED_STATIC_TASK_LIMIT");
    assert.equal(tool?.attributes.personalData, true);
    assert.equal(
      graph.nodes.find((node) => node.id === "service:tool-broker")?.attributes
        .sourcePolicy,
      "UNKNOWN",
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "routes_to" &&
          edge.from === task?.id &&
          edge.to === "external:model:primary-model",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "validates" &&
          edge.from === "evidence:model-policy:evidence-1" &&
          edge.to === task?.id,
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
