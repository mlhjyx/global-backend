import { describe, expect, it } from "vitest";
import {
  DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
  DesignSourceManifestContractError,
  validateDesignSourceManifest,
} from "@global/contracts";

function authorizedSource(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
    id: "owned-precision-system",
    title: "Owned precision-system export",
    sourceClass: "owned_export_authorized",
    sourceUrl: "https://design.example/exports/precision-system",
    capturedAt: "2026-07-22T00:00:00.000Z",
    licenseSpdx: "LicenseRef-Platform-Authorization",
    licenseEvidencePath: "authorizations/precision-system.pdf",
    allowedUses: [
      "visual_analysis",
      "token_abstraction",
      "structure_abstraction",
      "code_transformation",
    ],
    prohibitedUses: [],
    retentionPolicy: "licensed_archive",
    trainingPolicy: "license_permits",
    sourceContributionGroup: "owned-precision-system",
    externalAssets: [
      { kind: "font", source: "vendor-font", disposition: "self_host" },
    ],
    reviewer: "design-governance",
    ownerAuthorization: {
      evidencePath: "authorizations/precision-system.pdf",
      covers: {
        aiSiteBuilder: true,
        derivativeComponents: true,
        commercialDistribution: true,
        training: true,
      },
      territories: ["global"],
      validity: { kind: "perpetual" },
      revocationTerms: "Written revocation applies prospectively.",
      redistribution: { kind: "allowed" },
      recordedAt: "2026-07-21T00:00:00.000Z",
    },
    approvedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

function visualResearchSource(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
    id: "research-layout-study",
    title: "Visual layout study",
    sourceClass: "visual_research_only",
    capturedAt: "2026-07-22T00:00:00.000Z",
    allowedUses: [
      "visual_analysis",
      "token_abstraction",
      "structure_abstraction",
    ],
    prohibitedUses: ["training", "code_transformation"],
    retentionPolicy: "ephemeral_source",
    trainingPolicy: "prohibited",
    externalAssets: [
      { kind: "image", source: "research-page", disposition: "remove" },
    ],
    reviewer: "design-governance",
    ...overrides,
  };
}

describe("DesignSourceManifest contract", () => {
  it("accepts an authorized source only when every conversion and training guard is present", () => {
    expect(validateDesignSourceManifest(authorizedSource())).toMatchObject({
      sourceClass: "owned_export_authorized",
      approvedAt: "2026-07-22T00:00:00.000Z",
    });
  });

  it("rejects historical source-class aliases instead of silently normalizing them", () => {
    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({ sourceClass: "visual_reference_only" }),
      ),
    ).toThrowError(/DESIGN_SOURCE_INVALID/);
  });

  it("fails closed when code transformation lacks a verifiable license", () => {
    expect(() =>
      validateDesignSourceManifest(
        authorizedSource({
          licenseSpdx: undefined,
          licenseEvidencePath: undefined,
        }),
      ),
    ).toThrowError(/DESIGN_SOURCE_LICENSE_REQUIRED/);
  });

  it("rejects a use that is simultaneously allowed and prohibited", () => {
    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({ prohibitedUses: ["visual_analysis"] }),
      ),
    ).toThrowError(/DESIGN_SOURCE_POLICY_CONFLICT/);
  });

  it("rejects unknown fields at every source-manifest record boundary", () => {
    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({ rawHtml: "<main>source page</main>" }),
      ),
    ).toThrowError(/DESIGN_SOURCE_INVALID/);
    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({
          externalAssets: [
            {
              kind: "image",
              source: "research-page",
              disposition: "remove",
              screenshotData: "base64-source-content",
            },
          ],
        }),
      ),
    ).toThrowError(/DESIGN_SOURCE_INVALID/);
    expect(() =>
      validateDesignSourceManifest(
        authorizedSource({
          ownerAuthorization: {
            ...((authorizedSource().ownerAuthorization as Record<
              string,
              unknown
            >) ?? {}),
            rawCopy: "source content",
          },
        }),
      ),
    ).toThrowError(/DESIGN_SOURCE_AUTHORIZATION_INVALID/);
  });

  it("rejects expired authorizations and training without explicit training coverage", () => {
    const expired = authorizedSource({
      ownerAuthorization: {
        ...((authorizedSource().ownerAuthorization as Record<
          string,
          unknown
        >) ?? {}),
        validity: { kind: "expires", expiresAt: "2026-07-21T23:59:59.000Z" },
      },
    });
    expect(() => validateDesignSourceManifest(expired)).toThrowError(
      /DESIGN_SOURCE_AUTHORIZATION_INVALID/,
    );

    const trainingNotCovered = authorizedSource({
      ownerAuthorization: {
        ...((authorizedSource().ownerAuthorization as Record<
          string,
          unknown
        >) ?? {}),
        covers: {
          aiSiteBuilder: true,
          derivativeComponents: true,
          commercialDistribution: true,
          training: false,
        },
      },
    });
    expect(() => validateDesignSourceManifest(trainingNotCovered)).toThrowError(
      /DESIGN_SOURCE_TRAINING_NOT_AUTHORIZED/,
    );
  });

  it("requires clear evidence for every non-prohibited training policy", () => {
    const thirdPartyTraining = authorizedSource({
      sourceClass: "permissive_licensed",
      ownerAuthorization: undefined,
      approvedAt: undefined,
      allowedUses: ["visual_analysis"],
      trainingPolicy: "platform_corpus",
      licenseSpdx: undefined,
      licenseEvidencePath: undefined,
    });
    expect(() => validateDesignSourceManifest(thirdPartyTraining)).toThrowError(
      /DESIGN_SOURCE_LICENSE_REQUIRED/,
    );

    expect(() =>
      validateDesignSourceManifest({
        ...thirdPartyTraining,
        licenseSpdx: "MIT",
        licenseEvidencePath: "licenses/template.txt",
      }),
    ).toThrowError(/DESIGN_SOURCE_TRAINING_NOT_AUTHORIZED/);
  });

  it("rejects approvals and authorization records that are not yet effective", () => {
    const now = new Date("2026-07-22T00:00:00.000Z");
    expect(() =>
      validateDesignSourceManifest(
        authorizedSource({ approvedAt: "2026-07-22T00:00:01.000Z" }),
        { now },
      ),
    ).toThrowError(/DESIGN_SOURCE_AUTHORIZATION_INVALID/);
    expect(() =>
      validateDesignSourceManifest(
        authorizedSource({
          ownerAuthorization: {
            ...((authorizedSource().ownerAuthorization as Record<
              string,
              unknown
            >) ?? {}),
            recordedAt: "2026-07-22T00:00:01.000Z",
          },
        }),
        { now },
      ),
    ).toThrowError(/DESIGN_SOURCE_AUTHORIZATION_INVALID/);
  });

  it("keeps visual-research sources out of transformation, archives, and training", () => {
    expect(validateDesignSourceManifest(visualResearchSource())).toMatchObject({
      sourceClass: "visual_research_only",
      trainingPolicy: "prohibited",
    });

    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({
          allowedUses: ["visual_analysis", "code_transformation"],
        }),
      ),
    ).toThrowError(/DESIGN_SOURCE_RESEARCH_ONLY/);

    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({ retentionPolicy: "licensed_archive" }),
      ),
    ).toThrowError(/DESIGN_SOURCE_RESEARCH_ONLY/);

    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({ trainingPolicy: "license_permits" }),
      ),
    ).toThrowError(/DESIGN_SOURCE_RESEARCH_ONLY/);
  });

  it("requires external identity when a non-platform source contributes rule evidence", () => {
    expect(() =>
      validateDesignSourceManifest(
        visualResearchSource({ sourceContributionGroup: "research-a" }),
      ),
    ).toThrowError(/DESIGN_SOURCE_INVALID/);
  });

  it("exposes a stable machine-readable error code", () => {
    try {
      validateDesignSourceManifest(
        visualResearchSource({ trainingPolicy: "platform_corpus" }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DesignSourceManifestContractError);
      expect((error as DesignSourceManifestContractError).code).toBe(
        "DESIGN_SOURCE_RESEARCH_ONLY",
      );
    }
  });
});
