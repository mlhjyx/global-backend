import "reflect-metadata";
import { Module, VersioningType } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AuthGuard } from "../../auth/auth.guard";
import { ScopesGuard } from "../../auth/scopes.guard";
import { TokenVerifier } from "../../auth/token-verifier";
import { ROLES_TO_SCOPES_POLICY } from "../../auth/scopes";
import { DiscoveryModule } from "../../discovery/discovery.module";
import { CONTACT_ENRICHMENT_RESULTS_PORT } from "./contact-enrichment-results.controller";
import { ContactEnrichmentQualityFactsController } from "./contact-enrichment-quality-facts.controller";
import { describe, expect, it, vi } from "vitest";
describe("complete quality facts code-first surface, isolated synthetic module", () => {
  it("publishes the two versioned read routes with closed full-fact schema and no write scopes", async () => {
    const forbidden = vi.fn(async () => {
      throw new Error("code_first_must_not_access_runtime_ports");
    });
    const verifier = { verify: forbidden };
    const policy = { resolve: () => [] };
    @Module({
      controllers: [ContactEnrichmentQualityFactsController],
      providers: [
        {
          provide: CONTACT_ENRICHMENT_RESULTS_PORT,
          useValue: {
            listEnrichmentQualityFacts: forbidden,
            readEnrichmentQualityFacts: forbidden,
          },
        },
        { provide: TokenVerifier, useValue: verifier },
        { provide: ROLES_TO_SCOPES_POLICY, useValue: policy },
        { provide: AuthGuard, useValue: new AuthGuard(verifier as never, policy) },
        { provide: ScopesGuard, useValue: new ScopesGuard(new Reflector()) },
      ],
    })
    class SyntheticQualityModule {}
    const app = await NestFactory.create(SyntheticQualityModule, {
      logger: false,
    });
    try {
      app.setGlobalPrefix("api");
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      );
      const path =
        "/api/v1/canonical-companies/{id}/contact-enrichment-quality-facts";
      const list = document.paths[path]?.get,
        read = document.paths[path + "/{operationRef}"]?.get;
      expect(list?.operationId).toBe("listContactEnrichmentQualityFacts_v2");
      expect(read?.operationId).toBe("readContactEnrichmentQualityFacts_v2");
      expect(list?.["x-required-scopes"]).toEqual(
        expect.arrayContaining(["acquisition:read", "contact-discovery:read"]),
      );
      expect(JSON.stringify(list?.["x-required-scopes"])).not.toMatch(
        /acquisition:write|compliance:manage/,
      );
      expect(JSON.stringify(read?.responses)).toContain("FULL_QUALITY_FACTS");
      expect(JSON.stringify(read?.responses)).toContain(
        '"additionalProperties":false',
      );
      expect(JSON.stringify(read?.responses)).toContain(
        "FROZEN_EXECUTION_TARGETS",
      );
      expect(Object.keys(document.paths)).toHaveLength(2);
      expect(forbidden).not.toHaveBeenCalled();
      expect(app.getHttpServer().listening).toBe(false);
    } finally {
      await app.close();
    }
  });
  it("registers the quality controller in the real DiscoveryModule", () => {
    const controllers = (Reflect.getMetadata("controllers", DiscoveryModule) ??
      []) as unknown[];
    expect(controllers).toContain(ContactEnrichmentQualityFactsController);
  });
});
