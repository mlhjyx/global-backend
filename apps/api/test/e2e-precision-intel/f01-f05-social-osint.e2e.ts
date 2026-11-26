import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSocialExaPeopleTool,
  createSocialSerperSearchTool,
} from "../../src/tools/search-provider-tools";
import { TypedProjectionRegistry } from "../../src/durable-results/typed-projection.registry";
import { registerCatalogResultProjections } from "../../src/durable-results/catalog-result-projections";
import type { ExecutionBroker, ToolContext } from "../../src/tools/tool-contract";
import {
  parseSocialResults,
  SocialPresenceContactAdapter,
} from "../../src/discovery/providers/social-presence.provider";
import {
  inferConservativeEuUkFallback,
  resolveCompanyJurisdiction,
} from "../../src/discovery/jurisdiction-resolver";
import { rankLegalPageLinks } from "../../src/discovery/impressum/find-legal-pages";
import { extractVisibleBodyText } from "../../src/discovery/streaming/raw-html-parser";
import { startMockUpstreamsServer, type MockUpstreamsServer } from "./harness/mock-upstreams";
import { loadProductExport } from "./harness/load-product-export";
import { getE2eTargetMode, requireIntegratedOrSelfcheck } from "./harness/mode-gate-temporal";
import {
  WAVE1_DNS_FIXTURES,
  WAVE1_SOCIAL_FIXTURES,
  WAVE1_STATUTORY_HTML_FIXTURES,
} from "./fixtures/wave1-pilot.test-fixture";

const TOOL_CTX: ToolContext = {
  workspaceId: "51000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  purpose: "discovery",
  authorizeExternalAction: async () => true,
} as unknown as ToolContext;

const EMAIL_REDACT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const PHONE_REDACT_RE = /(?:\+?\d[\d\s\-()]{6,}\d)/gu;

function redactContactPii(text: string): string {
  return text
    .replace(EMAIL_REDACT_RE, "[REDACTED_EMAIL]")
    .replace(PHONE_REDACT_RE, "[REDACTED_PHONE]");
}

function capUtf16Safe(text: string, max = 240): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function isValidUtf16(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

type SocialHit = { url: string; title?: string; snippet?: string; highlights?: readonly string[] };
type SocialCompany = { name: string; domain?: string; country?: string };
type ScoreSocialAttribution = (hit: SocialHit, company: SocialCompany) => {
  score: number;
  decision: "ACCEPTED" | "REVIEW" | "REJECTED";
  matchedFeatures: readonly string[];
};

const productSuite = describe.runIf(getE2eTargetMode() === "integrated");

describe("F01–F05 Wave 1 Social Intelligence & Zero-Cost OSINT (E2E Tiers 1–2)", () => {
  let upstreams: MockUpstreamsServer;

  beforeAll(async () => {
    upstreams = await startMockUpstreamsServer();
  });

  afterAll(async () => {
    await upstreams.close();
  });

  beforeEach(() => {
    upstreams.reset();
    upstreams.applyEnv();
  });

  // ---------------------------------------------------------------------------
  // F1: Social search snippet/highlights restoration (10 cases)
  // ---------------------------------------------------------------------------
  describe("F1: Social search snippet & highlights restoration", () => {
    it("T1-F01-01: Serper social search preserves <=240-char snippet", async () => {
      upstreams.setResponse("/serper", {
        json: {
          organic: [
            {
              link: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url,
              title: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.title,
              snippet: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.snippet,
            },
          ],
        },
      });

      const tool = createSocialSerperSearchTool();
      const out = await tool.execute({ query: "Italsol Srl LinkedIn", num: 5 }, TOOL_CTX);
      expect(out.data.results).toHaveLength(1);

      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T1-F01-01",
        integratedCheck: () => {
          const item = out.data.results[0] as Record<string, unknown>;
          expect(typeof item.snippet).toBe("string");
          expect((item.snippet as string).length).toBeGreaterThan(0);
          expect((item.snippet as string).length).toBeLessThanOrEqual(240);
        },
        selfcheckContract: () => {
          expect(upstreams.getCalls("/serper")).toHaveLength(1);
          const contracted = capUtf16Safe(
            redactContactPii(WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.snippet),
            240,
          );
          expect(contracted.length).toBeLessThanOrEqual(240);
          expect(contracted).toContain("Italsol Srl");
        },
      });
    });

    it("T1-F01-02: Exa people search preserves bounded highlights (<=3 x <=240 chars)", async () => {
      upstreams.setResponse("/exa", {
        json: {
          results: [
            {
              url: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.url,
              title: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.title,
              highlights: [...WAVE1_SOCIAL_FIXTURES.effeDirectorHit.highlights],
            },
          ],
        },
      });

      const tool = createSocialExaPeopleTool();
      const out = await tool.execute({ query: "Effe Energy Srl Brescia", numResults: 5 }, TOOL_CTX);
      expect(out.data.results).toHaveLength(1);

      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T1-F01-02",
        integratedCheck: () => {
          const item = out.data.results[0] as Record<string, unknown>;
          expect(Array.isArray(item.highlights)).toBe(true);
          const highlights = item.highlights as string[];
          expect(highlights.length).toBeGreaterThan(0);
          expect(highlights.length).toBeLessThanOrEqual(3);
          for (const h of highlights) {
            expect(h.length).toBeLessThanOrEqual(240);
          }
        },
        selfcheckContract: () => {
          expect(upstreams.getCalls("/exa")).toHaveLength(1);
          const highlights = WAVE1_SOCIAL_FIXTURES.effeDirectorHit.highlights.slice(0, 3);
          expect(highlights.length).toBeLessThanOrEqual(3);
          expect(highlights[0]!.length).toBeLessThanOrEqual(240);
        },
      });
    });

    it("T1-F01-03: durablePersonSearchHits & projection retain snippet and highlights", async () => {
      const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T1-F01-03",
        integratedCheck: () => {
          const env = registry.project("social-search-serper/v1", {
            data: {
              results: [
                {
                  url: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url,
                  title: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.title,
                  snippet: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.snippet,
                  highlights: [...WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.highlights],
                },
              ],
            },
            costCents: 1,
          });
          const restored = registry.restore(env) as { data: { results: Array<Record<string, unknown>> } };
          expect(restored.data.results[0]!.snippet).toBe(WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.snippet);
          expect(restored.data.results[0]!.highlights).toEqual([...WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.highlights]);
        },
        selfcheckContract: () => {
          expect(registry.has("social-search-serper/v1")).toBe(true);
          expect(registry.has("social-search-exa-people/v1")).toBe(true);
        },
      });
    });

    it("T1-F01-04: replayPersonSearchResult restores snippet & highlights faithfully", async () => {
      const tool = createSocialSerperSearchTool();
      const input = {
        data: {
          results: [
            {
              url: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url,
              title: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.title,
              snippet: "Amministratore presso Italsol Srl",
              highlights: ["Italsol Srl"],
            } as any,
          ],
        },
        costCents: 1,
      };
      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T1-F01-04",
        integratedCheck: () => {
          const replayed = tool.durableReplayResult!(input) as { data: { results: Array<Record<string, unknown>> } };
          expect(replayed.data.results[0]!.snippet).toBe("Amministratore presso Italsol Srl");
          expect(replayed.data.results[0]!.highlights).toEqual(["Italsol Srl"]);
        },
        selfcheckContract: () => {
          const replayed = tool.durableReplayResult!(input) as { data: { results: Array<Record<string, unknown>> } };
          expect(replayed.data.results[0]!.url).toBe(WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url);
        },
      });
    });

    it("T1-F01-05: searxResultSchema validates {url, title, snippet, highlights} in Exa projection", async () => {
      const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T1-F01-05",
        integratedCheck: () => {
          const env = registry.project("social-search-exa-people/v1", {
            data: {
              results: [
                {
                  url: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.url,
                  title: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.title,
                  snippet: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.snippet,
                  highlights: [...WAVE1_SOCIAL_FIXTURES.effeDirectorHit.highlights],
                },
              ],
            },
            costCents: 1,
          });
          expect(env.schema).toBe("social-search-exa-people/v1");
        },
        selfcheckContract: () => {
          const env = registry.project("social-search-exa-people/v1", {
            data: {
              results: [
                {
                  url: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.url,
                  title: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.title,
                },
              ],
            },
            costCents: 1,
          });
          expect(env.schema).toBe("social-search-exa-people/v1");
        },
      });
    });

    it("T2-F01-01: 500-char Serper snippet with surrogate pairs is capped <=240 without splitting pairs", async () => {
      const longWithEmoji = `${"A".repeat(239)}🛰${"B".repeat(260)}`;
      upstreams.setResponse("/serper", {
        json: {
          organic: [
            {
              link: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url,
              title: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.title,
              snippet: longWithEmoji,
            },
          ],
        },
      });
      const tool = createSocialSerperSearchTool();
      const out = await tool.execute({ query: "Italsol Srl", num: 5 }, TOOL_CTX);

      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T2-F01-01",
        integratedCheck: () => {
          const snippet = (out.data.results[0] as Record<string, unknown>).snippet as string;
          expect(snippet.length).toBeLessThanOrEqual(240);
          expect(isValidUtf16(snippet)).toBe(true);
        },
        selfcheckContract: () => {
          const capped = capUtf16Safe(longWithEmoji, 240);
          expect(capped.length).toBeLessThanOrEqual(240);
          expect(isValidUtf16(capped)).toBe(true);
        },
      });
    });

    it("T2-F01-02: Serper snippet containing raw personal email and phone is redacted", async () => {
      const dirtySnippet = "Contact jane.doe@acme.example or call +39 02 1234567 for solar orders.";
      upstreams.setResponse("/serper", {
        json: {
          organic: [
            {
              link: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url,
              title: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.title,
              snippet: dirtySnippet,
            },
          ],
        },
      });
      const tool = createSocialSerperSearchTool();
      const out = await tool.execute({ query: "Italsol Srl", num: 5 }, TOOL_CTX);

      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T2-F01-02",
        integratedCheck: () => {
          const snippet = (out.data.results[0] as Record<string, unknown>).snippet as string;
          expect(typeof snippet).toBe("string");
          expect(snippet).not.toContain("jane.doe@acme.example");
          expect(snippet).not.toContain("1234567");
        },
        selfcheckContract: () => {
          const redacted = redactContactPii(dirtySnippet);
          expect(redacted).not.toContain("jane.doe@acme.example");
          expect(redacted).not.toContain("1234567");
        },
      });
    });

    it("T2-F01-03: Exa highlights with 10x 400-char entries are bounded to <=3 x <=240 chars", async () => {
      const rawHighlights = Array.from({ length: 10 }, (_, idx) => `Highlight-${idx}-${"X".repeat(390)}`);
      upstreams.setResponse("/exa", {
        json: {
          results: [
            {
              url: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.url,
              title: WAVE1_SOCIAL_FIXTURES.effeDirectorHit.title,
              highlights: rawHighlights,
            },
          ],
        },
      });
      const tool = createSocialExaPeopleTool();
      const out = await tool.execute({ query: "Effe Energy", numResults: 5 }, TOOL_CTX);

      await requireIntegratedOrSelfcheck({
        featureId: "F1",
        caseId: "T2-F01-03",
        integratedCheck: () => {
          const highlights = (out.data.results[0] as Record<string, unknown>).highlights as string[];
          expect(Array.isArray(highlights)).toBe(true);
          expect(highlights.length).toBeLessThanOrEqual(3);
          for (const h of highlights) expect(h.length).toBeLessThanOrEqual(240);
        },
        selfcheckContract: () => {
          const bounded = rawHighlights.slice(0, 3).map((h) => capUtf16Safe(h, 240));
          expect(bounded).toHaveLength(3);
          for (const h of bounded) expect(h.length).toBeLessThanOrEqual(240);
        },
      });
    });

    it("T2-F01-04: Legacy {url, title} durable row without snippet/highlights passes replay validation", () => {
      const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
      const env = registry.project("social-search-serper/v1", {
        data: { results: [{ url: "https://www.linkedin.com/in/jdoe", title: "Jane Doe" }] },
        costCents: 1,
      });
      const restored = registry.restore(env) as { data: { results: Array<{ url: string; title?: string }> }; costCents: number };
      expect(restored.data.results).toEqual([{ url: "https://www.linkedin.com/in/jdoe", title: "Jane Doe" }]);
      expect(restored.costCents).toBe(1);
    });

    it("T2-F01-05: snippet:null or non-string garbage in upstream hit does not crash social search tool", async () => {
      upstreams.setResponse("/serper", {
        json: {
          organic: [
            {
              link: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url,
              title: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.title,
              snippet: null,
              highlights: [123, null, { bad: true }],
            },
          ],
        },
      });
      const tool = createSocialSerperSearchTool();
      const out = await tool.execute({ query: "Italsol Srl", num: 5 }, TOOL_CTX);
      expect(out.data.results).toHaveLength(1);
      expect(out.data.results[0]!.url).toBe(WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url);
    });
  });

  // ---------------------------------------------------------------------------
  // F2: Fellegi-Sunter v1 social attribution (10 cases)
  // ---------------------------------------------------------------------------
  productSuite("F2: Social attribution and candidate materialization", () => {
    const { italsolCompany, effeCompany } = WAVE1_SOCIAL_FIXTURES;
    const cases: {
      name: string;
      company: SocialCompany;
      hit: SocialHit;
      decision: "ACCEPTED" | "REVIEW" | "REJECTED";
      feature?: string;
    }[] = [
      {
        name: "T1-F02-01: distinctive slug with role evidence accepts the indexed person",
        company: italsolCompany,
        hit: { ...WAVE1_SOCIAL_FIXTURES.italsolDirectorHit, title: "Alba Fixture - Responsabile Commerciale" },
        decision: "ACCEPTED",
        feature: "slug_company_distinctive",
      },
      {
        name: "T1-F02-02: context identifies a matched employer for an opaque profile URL",
        company: effeCompany,
        hit: {
          ...WAVE1_SOCIAL_FIXTURES.effeDirectorHit,
          title: "Bruno Fixture | LinkedIn",
          snippet: "Purchasing Manager at Effe Energy Srl in Brescia.",
        },
        decision: "ACCEPTED",
        feature: "context_company_distinctive",
      },
      {
        name: "T1-F02-03: a current executive at the company is eligible",
        company: italsolCompany,
        hit: WAVE1_SOCIAL_FIXTURES.italsolDirectorHit,
        decision: "ACCEPTED",
        feature: "role_headline",
      },
      {
        name: "T1-F02-04: explicit company domain and procurement title reinforce attribution",
        company: italsolCompany,
        hit: {
          url: "https://www.linkedin.com/in/elena-fixture",
          title: "Elena Fixture - Head of Procurement",
          snippet: "Head of Procurement at Italsol Srl (italsol.example)",
        },
        decision: "ACCEPTED",
        feature: "domain_match",
      },
      {
        name: "T1-F02-05: unrelated career history leaves a current company match eligible",
        company: italsolCompany,
        hit: {
          ...WAVE1_SOCIAL_FIXTURES.italsolDirectorHit,
          snippet: "Amministratore at Italsol Srl. Previously employed at Altacrest.",
        },
        decision: "ACCEPTED",
      },
      {
        name: "T2-F02-01: different current employer rejects a namesake",
        company: italsolCompany,
        hit: WAVE1_SOCIAL_FIXTURES.namesakeDifferentEmployerHit,
        decision: "REJECTED",
      },
      {
        name: "T2-F02-02: a past affiliation alone stays in review",
        company: italsolCompany,
        hit: WAVE1_SOCIAL_FIXTURES.formerEmployeeHit,
        decision: "REVIEW",
        feature: "previous_affiliation",
      },
      {
        name: "T2-F02-03: geography and sector without company evidence reject attribution",
        company: italsolCompany,
        hit: WAVE1_SOCIAL_FIXTURES.greyZoneHit,
        decision: "REJECTED",
      },
      {
        name: "T2-F02-04: generic industry terms cannot establish attribution",
        company: effeCompany,
        hit: WAVE1_SOCIAL_FIXTURES.genericTokenOnlyHit,
        decision: "REJECTED",
      },
      {
        name: "T2-F02-05: a malformed result with no headline is rejected",
        company: italsolCompany,
        hit: { url: "invalid-url" },
        decision: "REJECTED",
      },
    ];

    it.each(cases)("$name", async ({ company, hit, decision, feature }) => {
      const score = await loadProductExport<ScoreSocialAttribution>(
        "F2", "src/discovery/providers/social-attribution.ts", "scoreSocialAttribution",
      );
      const result = score(hit, company);
      expect(result.decision).toBe(decision);
      if (feature) expect(result.matchedFeatures).toContain(feature);
      const contacts = parseSocialResults([hit], company);
      if (decision === "ACCEPTED") {
        expect(result.score).toBeGreaterThanOrEqual(0.75);
        expect(contacts).toEqual([expect.objectContaining({ linkedin: hit.url })]);
      } else {
        expect(result.score).toBeLessThan(0.75);
        expect(contacts).toEqual([]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F3: EU/UK LinkedIn L2 social.fetch ban (10 cases)
  // ---------------------------------------------------------------------------
  describe("F3: EU/UK LinkedIn L2 social.fetch ban", () => {
    function makeSocialBroker(candidateUrl: string, headline: string) {
      const l2FetchUrls: string[] = [];
      const broker: ExecutionBroker = {
        invoke: async (toolId: string, input: any) => {
          if (toolId === "social.search_serper" || toolId === "social.search_exa_people") {
            return { data: { results: [{ url: candidateUrl, title: headline }] }, costCents: 1 };
          }
          if (toolId === "social.search") {
            return { data: { results: [] }, costCents: 0 };
          }
          if (toolId === "social.fetch") {
            const url = String(input?.url ?? "");
            if (url.includes("archive.org/wayback/available")) {
              return { data: { url, status: 200, text: "{}" }, costCents: 0 };
            }
            l2FetchUrls.push(url);
            return {
              data: {
                url,
                status: 200,
                text: `<html><body><h1>${headline}</h1><p>${"Solar executive profile details ".repeat(8)}</p></body></html>`,
              },
              costCents: 0,
            };
          }
          return { data: {}, costCents: 0 };
        },
      } as unknown as ExecutionBroker;
      return { broker, l2FetchUrls };
    }

    it("T1-F03-01: US non-EU/UK company with lawful basis allows L2 social.fetch (calls === 1)", async () => {
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/alex-reed-sunwest",
        "Alex Reed - VP Procurement - SunWest Solar Corp | LinkedIn",
      );
      const adapter = new SocialPresenceContactAdapter({
        broker,
        extract: async () => [{ fullName: "Alex Reed", title: "VP Procurement", emails: [], phones: [] }],
      });
      await adapter.discoverContacts(
        { name: "SunWest Solar Corp", domain: "sunwest.example", country: "US" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-us-1",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );
      expect(l2FetchUrls).toHaveLength(1);
    });

    it("T1-F03-02: Italian company (IT) prohibits LinkedIn L2 social.fetch (0 calls)", async () => {
      const { broker, l2FetchUrls } = makeSocialBroker(
        WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.url,
        WAVE1_SOCIAL_FIXTURES.italsolDirectorHit.title,
      );
      const adapter = new SocialPresenceContactAdapter({
        broker,
        extract: async () => [],
      });
      const res = await adapter.discoverContacts(
        { name: "Italsol Srl", domain: "italsol.example", country: "IT" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-it-1",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );

      await requireIntegratedOrSelfcheck({
        featureId: "F3",
        caseId: "T1-F03-02",
        integratedCheck: () => {
          expect(l2FetchUrls).toHaveLength(0);
          expect(res.contacts.length).toBeGreaterThanOrEqual(1);
        },
        selfcheckContract: () => {
          const juris = resolveCompanyJurisdiction({ country: "IT", name: "Italsol Srl", domain: "italsol.example" });
          expect(juris?.iso).toBe("IT");
          expect(res.contacts.length).toBeGreaterThanOrEqual(1);
        },
      });
    });

    it("T1-F03-03: UK company (GB) prohibits LinkedIn L2 social.fetch (0 calls)", async () => {
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/arthur-smith-uksolar",
        "Arthur Smith - Procurement Director - UK Solar Importer Ltd | LinkedIn",
      );
      const adapter = new SocialPresenceContactAdapter({ broker, extract: async () => [] });
      await adapter.discoverContacts(
        { name: "UK Solar Importer Ltd", domain: "uksolar.co.uk", country: "GB" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-gb-1",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );

      await requireIntegratedOrSelfcheck({
        featureId: "F3",
        caseId: "T1-F03-03",
        integratedCheck: () => {
          expect(l2FetchUrls).toHaveLength(0);
        },
        selfcheckContract: () => {
          const juris = resolveCompanyJurisdiction({ country: "GB", name: "UK Solar Importer Ltd" });
          expect(juris?.iso).toBe("GB");
        },
      });
    });

    it("T1-F03-04: German company (DE) prohibits LinkedIn L2 social.fetch (0 calls)", async () => {
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/hans-mueller-solarbau",
        "Hans Mueller - Managing Director - SolarBau GmbH | LinkedIn",
      );
      const adapter = new SocialPresenceContactAdapter({ broker, extract: async () => [] });
      await adapter.discoverContacts(
        { name: "SolarBau GmbH", domain: "solarbau.de", country: "DE" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-de-1",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );

      await requireIntegratedOrSelfcheck({
        featureId: "F3",
        caseId: "T1-F03-04",
        integratedCheck: () => {
          expect(l2FetchUrls).toHaveLength(0);
        },
        selfcheckContract: () => {
          const juris = resolveCompanyJurisdiction({ country: "DE", name: "SolarBau GmbH" });
          expect(juris?.iso).toBe("DE");
        },
      });
    });

    it("T1-F03-05: Brazilian company (BR) non-EU/UK with lawful basis allows L2 social.fetch", async () => {
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/carlos-silva-brasol",
        "Carlos Silva - Purchasing Director - BraSol Energia | LinkedIn",
      );
      const adapter = new SocialPresenceContactAdapter({
        broker,
        extract: async () => [{ fullName: "Carlos Silva", title: "Purchasing Director", emails: [], phones: [] }],
      });
      await adapter.discoverContacts(
        { name: "BraSol Energia", domain: "brasol.com.br", country: "BR" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-br-1",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );
      expect(l2FetchUrls).toHaveLength(1);
    });

    it("T2-F03-01: Conservative EU fallback for country:null and .eu domain blocks L2 social.fetch", async () => {
      expect(inferConservativeEuUkFallback({ name: "PV Euro", domain: "pv.eu" })).toBe("EU");
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/jean-marc-pveu",
        "Jean Marc - Procurement Manager - PV Euro | LinkedIn",
      );
      const adapter = new SocialPresenceContactAdapter({ broker, extract: async () => [] });
      await adapter.discoverContacts(
        { name: "PV Euro", domain: "pv.eu" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-eu-fallback-1",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );

      await requireIntegratedOrSelfcheck({
        featureId: "F3",
        caseId: "T2-F03-01",
        integratedCheck: () => {
          expect(l2FetchUrls).toHaveLength(0);
        },
        selfcheckContract: () => {
          expect(inferConservativeEuUkFallback({ name: "PV Euro", domain: "pv.eu" })).toBe("EU");
        },
      });
    });

    it("T2-F03-02: Conservative EU fallback for country:null and GmbH suffix blocks L2 social.fetch", async () => {
      expect(inferConservativeEuUkFallback({ name: "SolarBau GmbH", domain: "solarbau.example" })).toBe("EU");
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/lukas-weber-solarbau",
        "Lukas Weber - Procurement Lead - SolarBau GmbH | LinkedIn",
      );
      const adapter = new SocialPresenceContactAdapter({ broker, extract: async () => [] });
      await adapter.discoverContacts(
        { name: "SolarBau GmbH", domain: "solarbau.example" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-eu-fallback-2",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );

      await requireIntegratedOrSelfcheck({
        featureId: "F3",
        caseId: "T2-F03-02",
        integratedCheck: () => {
          expect(l2FetchUrls).toHaveLength(0);
        },
        selfcheckContract: () => {
          expect(inferConservativeEuUkFallback({ name: "SolarBau GmbH" })).toBe("EU");
        },
      });
    });

    it("T2-F03-03: UK company inferred via .co.uk blocks L2 social.fetch", async () => {
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/oliver-brown-ukpv",
        "Oliver Brown - Sourcing Director - UK PV Ltd | LinkedIn",
      );
      const adapter = new SocialPresenceContactAdapter({ broker, extract: async () => [] });
      await adapter.discoverContacts(
        { name: "UK PV Ltd", domain: "ukpv.co.uk" },
        {
          workspaceId: "51000000-0000-4000-8000-000000000001",
          runId: "r-uk-co-1",
          lawfulBasis: { kind: "legitimate_interest", ref: "lia-1", recordedBy: "u1", recordedAt: new Date().toISOString() },
        } as any,
      );

      await requireIntegratedOrSelfcheck({
        featureId: "F3",
        caseId: "T2-F03-03",
        integratedCheck: () => {
          expect(l2FetchUrls).toHaveLength(0);
        },
        selfcheckContract: () => {
          expect(resolveCompanyJurisdiction({ domain: "ukpv.co.uk" })?.iso).toBe("GB");
        },
      });
    });

    it("T2-F03-04: search-only adapter configuration does not request L2 pages", async () => {
      const { broker, l2FetchUrls } = makeSocialBroker(
        "https://www.linkedin.com/in/alex-reed-sunwest",
        "Alex Reed - VP Procurement - SunWest Solar Corp | LinkedIn",
      );
      // Without extract/gateway, SocialPresenceContactAdapter does not issue L2 page scrape
      const adapter = new SocialPresenceContactAdapter({ broker });
      await adapter.discoverContacts(
        { name: "SunWest Solar Corp", domain: "sunwest.example", country: "US" },
        { workspaceId: "51000000-0000-4000-8000-000000000001", runId: "r-us-nobasis" } as any,
      );
      expect(l2FetchUrls).toHaveLength(0);
    });

    it("T2-F03-05: LinkedIn /company/ URL is never treated as personal L2 profile scrape", () => {
      const parsed = parseSocialResults(
        [{ url: "https://www.linkedin.com/company/italsol-srl", title: "Italsol Srl | LinkedIn" }],
        WAVE1_SOCIAL_FIXTURES.italsolCompany,
      );
      expect(parsed).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // F4: Zero-cost statutory disclosure extractors (10 cases)
  // ---------------------------------------------------------------------------
  productSuite("F4: Statutory disclosures and legal-page discovery", () => {
    type ExtractDirectors = (html: string, url: string) =>
      Array<{ name: string; role: string; sourceUrl: string; jurisdictionHint: string }>;

    const loadExtractor = () => loadProductExport<ExtractDirectors>(
      "F4", "src/discovery/impressum/statutory-director-extract.ts", "extractStatutoryDirectorsFromHtml",
    );

    it.each([
      { id: "T1-F04-01", country: "DE", path: "/impressum", html: WAVE1_STATUTORY_HTML_FIXTURES.deImpressumUtf8, name: "Hans Müller", role: "Geschäftsführer" },
      { id: "T1-F04-02", country: "IT", path: "/informativa-privacy", html: WAVE1_STATUTORY_HTML_FIXTURES.itInformativaPrivacy, name: "Mario Fixture", role: "Legale Rappresentante" },
      { id: "T1-F04-03", country: "FR", path: "/mentions-legales", html: WAVE1_STATUTORY_HTML_FIXTURES.frMentionsLegales, name: "Claire Dupont", role: "Directeur Général" },
      { id: "T1-F04-04", country: "JP", path: "/company/gaiyou", html: WAVE1_STATUTORY_HTML_FIXTURES.jpGaiyou, name: "山田太郎", role: "代表取締役" },
      { id: "T1-F04-05", country: "KR", path: "/", html: WAVE1_STATUTORY_HTML_FIXTURES.krFooter, name: "김철수", role: "대표자" },
    ])("$id: extracts a verified statutory role in $country", async ({ country, path, html, name, role }) => {
      const extract = await loadExtractor();
      const url = "https://buyer.example" + path;
      expect(extract(html, url)).toEqual([{ name, role, sourceUrl: url, jurisdictionHint: country }]);
    });

    it("T2-F04-01: only statutory discovery opts into the privacy link", () => {
      const url = "https://buyer.example/informativa-privacy";
      const rankLinks: (
        links: readonly string[], options?: { includePrivacy: boolean },
      ) => ReturnType<typeof rankLegalPageLinks> = rankLegalPageLinks;
      expect(rankLinks([url])).toEqual([]);
      expect(rankLinks([url], { includePrivacy: true }))
        .toEqual([expect.objectContaining({ url, kind: "impressum" })]);
    });

    it("T2-F04-02: raw website extraction preserves footer directors outside visible text", async () => {
      type ExtractWebsite = (input: {
        broker: ExecutionBroker; workspaceId: string; companyId: string; runId: string;
        domain: string; robotsCache: Map<string, readonly string[]>;
      }) => Promise<{ statutoryDirectors?: unknown[]; visibleText: string }>;
      const extractWebsite = await loadProductExport<ExtractWebsite>(
        "F4", "src/discovery/streaming/raw-http-extractor.ts", "extractCompanyWebsiteStreaming",
      );
      const url = "https://buyer.example/";
      const html = WAVE1_STATUTORY_HTML_FIXTURES.krFooter.replace(
        "Solar Korea Co.", "Solar Korea Co. " + "Industrial pumps and diverter valves. ".repeat(12),
      );
      const invoke = vi.fn(async (tool: string, input: { url: string }) => {
        expect(tool).toBe("http.get");
        expect(input.url).toBe(url);
        return {
          data: {
            url, finalUrl: url, ok: true, status: 200, text: html,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
          costCents: 0,
        };
      });
      const result = await extractWebsite({
        broker: { invoke } as unknown as ExecutionBroker,
        workspaceId: "51000000-0000-4000-8000-000000000001",
        companyId: "51000000-0000-4000-8000-000000000004",
        runId: "20000000-0000-4000-8000-000000000001",
        domain: "buyer.example",
        robotsCache: new Map([["https://buyer.example", []]]),
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(result.visibleText).toContain("Industrial pumps");
      expect(result.visibleText).not.toContain("김철수");
      expect(result.statutoryDirectors).toEqual([expect.objectContaining({ name: "김철수", sourceUrl: url })]);
    });

    it("T2-F04-03: generic privacy roles and company-valued controllers are excluded", async () => {
      const extract = await loadExtractor();
      const html = WAVE1_STATUTORY_HTML_FIXTURES.nonPersonNoise +
        "<p>Titolare del trattamento: Solar Test S.r.l.</p>";
      expect(extract(html, "https://buyer.example/privacy")).toEqual([]);
    });

    it("T2-F04-04: a decoded Latin-1 fixture retains accented director names", async () => {
      const extract = await loadExtractor();
      const html = WAVE1_STATUTORY_HTML_FIXTURES.deImpressumLatin1.toString("latin1");
      expect(extract(html, "https://buyer.example/impressum")).toEqual([
        expect.objectContaining({ name: "Hans Müller", role: "Geschäftsführer" }),
      ]);
    });

    it("T2-F04-05: oversized malformed HTML keeps visible text bounded", () => {
      const visible = extractVisibleBodyText("<main>Buyer description <div>" + "X".repeat(2_100_000));
      expect(visible).toContain("Buyer description");
      expect(visible.length).toBeLessThan(2_100_000);
    });
  });

  productSuite("F5: Passive DNS classification and bounded failure", () => {
    type InspectDns = (input: {
      domain: string;
      authorizeExternalAction: () => Promise<boolean>;
      resolveMxImpl: (name: string) => Promise<Array<{ exchange: string; priority?: number }>>;
      resolveTxtImpl: (name: string) => Promise<string[][]>;
      timeoutMs?: number;
    }) => Promise<null | {
      mxProvider?: string;
      mxHosts: readonly string[];
      segVendors: readonly string[];
      spfIncludes: readonly string[];
      dmarcPolicy: string | null;
      techSignals: readonly string[];
    }>;
    const loadInspector = () => loadProductExport<InspectDns>(
      "F5", "src/discovery/providers/passive-dns.ts", "inspectPassiveDns",
    );
    const authorize = async () => true;

    it.each([
      { name: "T1-F05-01: Google Workspace", fixture: WAVE1_DNS_FIXTURES.googleWorkspace, facts: { mxProvider: "google_workspace" } },
      { name: "T1-F05-02: Microsoft 365", fixture: WAVE1_DNS_FIXTURES.microsoft365, facts: { mxProvider: "microsoft_365" } },
      { name: "T1-F05-03: Mimecast security gateway", fixture: WAVE1_DNS_FIXTURES.mimecastSeg, facts: { segVendors: ["mimecast"] } },
      { name: "T1-F05-04: HubSpot and Salesforce from SPF", fixture: WAVE1_DNS_FIXTURES.hubspotSalesforceSpf, facts: { techSignals: ["hubspot", "salesforce"] } },
      { name: "T1-F05-05: DMARC policy is read from the DMARC name", fixture: WAVE1_DNS_FIXTURES.hubspotSalesforceSpf, facts: { dmarcPolicy: "reject" } },
      { name: "T2-F05-03: null SPF and absent MX do not invent a provider", fixture: WAVE1_DNS_FIXTURES.parkedNoMail, facts: null },
    ])("$name", async ({ fixture, facts }) => {
      const inspect = await loadInspector();
      const domain = "buyer.example";
      const isDmarc = (record: readonly string[]) => record[0]?.startsWith("v=DMARC1");
      const output = await inspect({
        domain,
        authorizeExternalAction: authorize,
        resolveMxImpl: async () => [...fixture.mx],
        resolveTxtImpl: async (name) => {
          expect([domain, "_dmarc." + domain]).toContain(name);
          return fixture.txt
            .filter((record) => Boolean(isDmarc(record)) === (name !== domain))
            .map((record) => [...record]);
        },
      });
      if (facts === null) {
        expect(output).toBeNull();
      } else {
        expect(output).toMatchObject(facts);
      }
    });

    it("T2-F05-01: failed DNS responses return no facts", async () => {
      const inspect = await loadInspector();
      await expect(inspect({
        domain: "buyer.example",
        authorizeExternalAction: authorize,
        resolveMxImpl: async () => { throw new Error("ENOTFOUND"); },
        resolveTxtImpl: async () => { throw new Error("ESERVFAIL"); },
      })).resolves.toBeNull();
    });

    it("T2-F05-02: hung resolver does not delay discovery past the DNS deadline", async () => {
      const inspect = await loadInspector();
      vi.useFakeTimers();
      try {
        const result = inspect({
          domain: "buyer.example",
          authorizeExternalAction: authorize,
          resolveMxImpl: () => new Promise(() => undefined),
          resolveTxtImpl: () => new Promise(() => undefined),
          timeoutMs: 100,
        });
        await vi.advanceTimersByTimeAsync(100);
        await expect(result).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("T2-F05-04: direct SPF include is captured without recursive DNS", async () => {
      const inspect = await loadInspector();
      const resolveTxtImpl = vi.fn(async (name: string) =>
        name === "buyer.example" ? [["v=spf1 redirect=_spf.sendgrid.net include:mailgun.org ~all"]] : [],
      );
      const result = await inspect({
        domain: "buyer.example",
        authorizeExternalAction: authorize,
        resolveMxImpl: async () => [],
        resolveTxtImpl,
      });
      expect(result?.spfIncludes).toEqual(["mailgun.org"]);
      expect(resolveTxtImpl.mock.calls).toEqual([["buyer.example"], ["_dmarc.buyer.example"]]);
    });

    it("T2-F05-05: domain names are normalized before DNS lookup", async () => {
      const inspect = await loadInspector();
      const resolveMxImpl = vi.fn(async () => []);
      const resolveTxtImpl = vi.fn(async () => []);
      await inspect({ domain: "BUYER.EXAMPLE.", authorizeExternalAction: authorize, resolveMxImpl, resolveTxtImpl });
      expect(resolveMxImpl).toHaveBeenCalledExactlyOnceWith("buyer.example");
      expect(resolveTxtImpl.mock.calls).toEqual([["buyer.example"], ["_dmarc.buyer.example"]]);
    });

    it("denied external action performs no DNS lookups", async () => {
      const inspect = await loadInspector();
      const resolveMxImpl = vi.fn(async () => []);
      const resolveTxtImpl = vi.fn(async () => []);
      await expect(inspect({
        domain: "buyer.example", authorizeExternalAction: async () => false, resolveMxImpl, resolveTxtImpl,
      })).resolves.toBeNull();
      expect(resolveMxImpl).not.toHaveBeenCalled();
      expect(resolveTxtImpl).not.toHaveBeenCalled();
    });
  });
});
