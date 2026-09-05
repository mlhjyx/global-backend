import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = path.resolve(import.meta.dirname, "../..");
const worker = readFileSync(
  path.join(apiRoot, "src/temporal/worker.ts"),
  "utf8",
);
const factory = readFileSync(
  path.join(apiRoot, "src/tools/tool-broker.factory.ts"),
  "utf8",
);

describe("R4-B production worker paid-ledger wiring", () => {
  it("shares one durable ledger across gateway, ToolBroker and Site Builder activities", () => {
    expect(worker).toMatch(
      /createSiteBuildProviderWireDatabaseFromEnv\([\s\S]*process\.env,[\s\S]*releaseIdentity\.migration_revision/,
    );
    expect(worker).toMatch(
      /const costLedger = new SiteBuildCostLedger\(prisma, \{[\s\S]*providerWireDatabase,[\s\S]*\}\)/,
    );
    expect(worker).toContain("gateway.paidLedger = costLedger");
    expect(worker).toMatch(
      /buildToolBroker\(\{\s*sourcePolicyReader,\s*paidLedger: costLedger,\s*budgetStore,\s*prisma,\s*\}\)/,
    );
    expect(worker).toMatch(
      /createSiteBuilderActivities\(\{[\s\S]*?costLedger,[\s\S]*?\}\)/,
    );
    expect(factory).toContain("paidLedger?: SiteBuildCostLedger");
    expect(factory).toMatch(
      /new ToolBroker\(\{[\s\S]*paidLedger: deps\?\.paidLedger/,
    );
  });
});

describe("R1 production worker Release wiring", () => {
  it("initializes one storage client and injects one build-fenced Release service", () => {
    expect(worker).toMatch(
      /import \{\s*SiteReleaseService\s*\} from ["']\.\.\/site-builder\/site-release\.service["']/,
    );
    // renderer 身份只能从 OCI release identity 派生（禁止 env 的 dev-unpinned 旁路）。
    expect(worker).toMatch(
      /import \{[\s\S]*?rendererRuntimeIdentity,[\s\S]*?\} from ["']\.\.\/runtime\/managed-dependency-readiness["']/,
    );
    expect(worker).toContain("await siteBuilderStorage.onModuleInit()");
    expect(worker).toContain(
      "const rendererBuildIdentity = rendererRuntimeIdentity(releaseIdentity)",
    );
    expect(worker).toMatch(
      /const releaseService = new SiteReleaseService\([\s\S]*?prisma,[\s\S]*?siteBuilderStorage,[\s\S]*?buildIdentity: rendererBuildIdentity/,
    );
    expect(worker).toMatch(
      /const qualityCandidateService = new QualityCandidateService\([\s\S]*?new DeterministicQualityService\([\s\S]*?new StorageQualityArtifactSink\(siteBuilderStorage\)[\s\S]*?closedRepairService,[\s\S]*?releaseService/,
    );
    expect(worker).toMatch(
      /createSiteBuilderActivities\(\{[\s\S]*?releaseService,[\s\S]*?\}\)/,
    );
    expect(worker).toMatch(
      /new KbService\([\s\S]*?siteBuilderStorage[\s\S]*?\)/,
    );
    expect(worker).toContain("qualityCandidateService,");
    expect(worker).toMatch(
      /const qualityNarrativeService = new QualityNarrativeService\(\s*siteBuilderStorage,\s*\)/,
    );
    expect(worker).toContain("qualityNarrativeService,");
    expect(worker).toContain("closedRepairService,");
  });
});
