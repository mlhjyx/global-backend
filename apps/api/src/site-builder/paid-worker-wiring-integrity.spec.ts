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
      /const costLedger = new SiteBuildCostLedger\(prisma\)/,
    );
    expect(worker).toContain("gateway.paidLedger = costLedger");
    expect(worker).toMatch(
      /buildToolBroker\(\{\s*sourcePolicyReader,\s*paidLedger: costLedger,\s*\}\)/,
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
      /import \{\s*SiteReleaseService,\s*resolveSiteRendererBuildIdentity,\s*\} from ["']\.\.\/site-builder\/site-release\.service["']/,
    );
    expect(worker).toContain("await siteBuilderStorage.onModuleInit()");
    expect(worker).toContain(
      "const rendererBuildIdentity = resolveSiteRendererBuildIdentity()",
    );
    expect(worker).toMatch(
      /const releaseService = new SiteReleaseService\([\s\S]*?prisma,[\s\S]*?siteBuilderStorage,[\s\S]*?buildIdentity: rendererBuildIdentity/,
    );
    expect(worker).toMatch(
      /createSiteBuilderActivities\(\{[\s\S]*?releaseService,[\s\S]*?\}\)/,
    );
    expect(worker).toMatch(
      /new KbService\([\s\S]*?siteBuilderStorage[\s\S]*?\)/,
    );
  });
});
