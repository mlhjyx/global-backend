import {
  finalizeDesignCatalogV2,
  type DesignCatalogV2,
  type DesignCatalogV2Draft,
} from "@global/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
} from "../site-build-cost-ledger";
import { STATIC_DESIGN_CATALOG_V2 } from "./catalog";
import {
  DESIGN_SPEC_INPUT_VERSION,
  DESIGN_SPEC_TASK,
  M1_E_A_COMPONENT_LIBRARY_VERSION,
  DesignBriefProducer,
  designSpecInputDigest,
  mapAssetCapabilitiesToRoles,
  resolveAuthoritativeArchetype,
  type DesignBriefTaskLedger,
  type DesignSpecInputV1,
  type DesignSpecTaskInput,
} from "./design-brief-producer";

function approvedCatalog(): DesignCatalogV2 {
  const { digest: _digest, ...raw } = structuredClone(STATIC_DESIGN_CATALOG_V2);
  const draft = raw as DesignCatalogV2Draft;
  draft.catalogVersion = "m1-e-b-approved-test/1";
  for (const preset of draft.stylePresets) preset.status = "approved";
  for (const pack of draft.demoVisualPacks) pack.status = "approved";
  for (const family of draft.families) family.status = "approved";
  return finalizeDesignCatalogV2(draft);
}

function input(
  catalog: DesignCatalogV2,
  overrides: Partial<DesignSpecInputV1> = {},
): DesignSpecInputV1 {
  return {
    schemaVersion: DESIGN_SPEC_INPUT_VERSION,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    siteId: "22222222-2222-4222-8222-222222222222",
    buildRunId: "33333333-3333-4333-8333-333333333333",
    brandProfile: {
      industryTags: ["oem", "fabrication"],
      businessType: "custom OEM",
      frozenFactCount: 3,
    },
    frozenIntake: { description: "untrusted intake fallback" },
    assetCapabilities: {
      assets: [
        { assetId: "logo-1", kind: "logo", status: "ready" },
        { assetId: "factory-1", kind: "factory_image", status: "ready" },
        { assetId: "product-1", kind: "product_image", status: "ready" },
      ],
    },
    locales: ["en"],
    catalogDigest: catalog.digest,
    componentLibraryVersion: M1_E_A_COMPONENT_LIBRARY_VERSION,
    rendererVersion: "renderer-test@sha256:abc",
    ...overrides,
  };
}

class Ledger implements DesignBriefTaskLedger {
  completed?: Record<string, unknown>;
  frozen?: Record<string, unknown>;
  stored?: Record<string, unknown>;
  released = 0;
  completeThenThrow = false;

  async claimTaskAttempt() {
    if (this.completed) {
      return { kind: "completed" as const, result: this.completed };
    }
    return {
      kind: "claimed" as const,
      attempt: { id: "attempt-1", fenceToken: "fence-1" },
    };
  }

  async freezeTaskInput<T extends Record<string, unknown>>(
    _fence: unknown,
    candidate: T,
  ) {
    if (!this.frozen) this.frozen = structuredClone(candidate);
    return {
      inputHash: "a".repeat(64),
      input: structuredClone(this.frozen) as T,
      replayed: this.frozen !== candidate,
    };
  }

  async storeTaskOutput(_fence: unknown, output: Record<string, unknown>) {
    this.stored = structuredClone(output);
  }

  async completeTask(_fence: unknown, result: Record<string, unknown>) {
    this.completed = structuredClone(result);
    if (this.completeThenThrow) throw new Error("ACK_LOST");
  }

  async releaseTask() {
    this.released += 1;
  }
}

describe("M1-e-B DesignBrief producer", () => {
  it("uses the authoritative five-archetype resolver and BrandProfile priority", () => {
    const resolved = (text: string) =>
      resolveAuthoritativeArchetype({
        frozenIntake: { description: text },
      });
    expect(resolved("private label contract manufacturing")).toBe("custom-oem");
    expect(resolved("food ingredient and agriculture exporter")).toBe(
      "ingredient-exporter",
    );
    expect(resolved("software consulting and integration service")).toBe(
      "b2b-service",
    );
    expect(resolved("equipment distributor with a product catalog")).toBe(
      "equipment-supplier",
    );
    expect(resolved("precision metal parts")).toBe("industrial-manufacturer");
    expect(
      resolveAuthoritativeArchetype({
        brandProfile: {
          industryTags: ["software"],
          frozenFactCount: 1,
        },
        frozenIntake: { description: "private label OEM" },
      }),
    ).toBe("b2b-service");
  });

  it("maps only ready image capabilities to the fixed semantic roles", () => {
    expect(
      mapAssetCapabilitiesToRoles({
        assets: [
          { assetId: "1", kind: "logo", status: "ready" },
          { assetId: "2", kind: "product_image", status: "ready" },
          { assetId: "3", kind: "factory_image", status: "ready" },
          { assetId: "4", kind: "cert", status: "ready" },
          { assetId: "5", kind: "doc", status: "ready" },
          { assetId: "6", kind: "video", status: "ready" },
          { assetId: "7", kind: "product_image", status: "pending" },
        ],
      }),
    ).toEqual([
      "evidence",
      "generic-process",
      "generic-product",
      "hero",
      "logo",
    ]);
  });

  it("never selects the main draft catalog", async () => {
    const ledger = new Ledger();
    const producer = new DesignBriefProducer({
      ledger,
      catalog: STATIC_DESIGN_CATALOG_V2,
    });
    await expect(
      producer.produce(input(STATIC_DESIGN_CATALOG_V2)),
    ).rejects.toMatchObject({
      code: "DESIGN_BRIEF_NO_CANDIDATE",
    });
    expect(ledger.released).toBe(1);
  });

  it("ranks matching industry and real asset coverage deterministically", async () => {
    const catalog = approvedCatalog();
    const ledger = new Ledger();
    const seen = vi.fn(async (taskInput: DesignSpecTaskInput) => ({
      candidateId: taskInput.candidates[0].id,
      reasons: ["model-confirmed-frozen-candidate"],
      warnings: [],
    }));
    const result = await new DesignBriefProducer({
      ledger,
      catalog,
      executeTask: seen,
    }).produce(input(catalog));

    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0][0].candidates).toHaveLength(3);
    expect(result.designBrief.familyId).toBe("oem-capability");
    expect(result.designBrief.archetype).toBe("custom-oem");
    expect(result.designBrief.assetStrategy.availableRoles).toEqual([
      "generic-process",
      "generic-product",
      "hero",
      "logo",
    ]);
    expect(result.designBrief.reasons).toEqual([
      "model-confirmed-frozen-candidate",
    ]);
    expect(ledger.stored).toMatchObject({
      selectionSource: "model",
      designBriefDigest: result.designBrief.digest,
    });
  });

  it("uses a stable DemoVisualPack fallback for sparse assets", async () => {
    const catalog = approvedCatalog();
    const ledger = new Ledger();
    const result = await new DesignBriefProducer({
      ledger,
      catalog,
      executeTask: async (taskInput) => ({
        candidateId: taskInput.candidates[0].id,
        reasons: [],
        warnings: [],
      }),
    }).produce(
      input(catalog, {
        assetCapabilities: { assets: [] },
        brandProfile: {
          industryTags: ["oem"],
          businessType: "private label OEM",
          frozenFactCount: 0,
        },
      }),
    );

    expect(result.designBrief.assetStrategy.availableRoles).toEqual([]);
    expect(result.designBrief.assetStrategy.demoVisualPackId).toBe(
      "oem-capability-demo-pack",
    );
    expect(result.designBrief.warnings).toContain(
      "evidence-bound-sections-must-use-neutral-copy",
    );
  });

  it("discards unknown model ids and provider failures without structure drift", async () => {
    const catalog = approvedCatalog();
    for (const executeTask of [
      async () => ({
        candidateId: "invented-family:free-form-component",
        reasons: [],
        warnings: [],
      }),
      async () => {
        throw new Error("provider unavailable");
      },
      async (taskInput: DesignSpecTaskInput) =>
        ({
          candidateId: taskInput.candidates[0].id,
          reasons: [],
          warnings: [],
          componentType: "InventedHero",
        }) as never,
    ]) {
      const ledger = new Ledger();
      const result = await new DesignBriefProducer({
        ledger,
        catalog,
        executeTask,
      }).produce(input(catalog));
      expect(result.designBrief.familyId).toBe("oem-capability");
      expect(result.designBrief.reasons[0]).toBe(
        "deterministic-approved-candidate",
      );
      expect(ledger.stored).toMatchObject({
        selectionSource: "deterministic",
      });
    }
  });

  it("fails a style lock that no approved compatible family can map", async () => {
    const catalog = approvedCatalog();
    await expect(
      new DesignBriefProducer({ ledger: new Ledger(), catalog }).produce(
        input(catalog, { stylePreset: "clean" }),
      ),
    ).rejects.toMatchObject({
      code: "DESIGN_STYLE_PRESET_INCOMPATIBLE",
    });
  });

  it("uses the existing DesignBrief catalog mismatch contract", async () => {
    const catalog = approvedCatalog();
    await expect(
      new DesignBriefProducer({ ledger: new Ledger(), catalog }).produce(
        input(catalog, { catalogDigest: "0".repeat(64) }),
      ),
    ).rejects.toMatchObject({
      code: "DESIGN_BRIEF_V2_CATALOG_MISMATCH",
    });
  });

  it("does not fallback across budget kill switches or cancellation", async () => {
    const catalog = approvedCatalog();
    const denied = new Ledger();
    await expect(
      new DesignBriefProducer({
        ledger: denied,
        catalog,
        executeTask: async () => {
          throw new PaidCallDeniedError("DENIED_KILL_SWITCH");
        },
      }).produce(input(catalog)),
    ).rejects.toBeInstanceOf(PaidCallDeniedError);
    expect(denied.stored).toBeUndefined();

    const unknown = new Ledger();
    await expect(
      new DesignBriefProducer({
        ledger: unknown,
        catalog,
        executeTask: async () => {
          throw new PaidOperationUnknownError("design-spec-provider-call");
        },
      }).produce(input(catalog)),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
    expect(unknown.stored).toBeUndefined();

    const cancelled = new Ledger();
    const execute = vi.fn();
    await expect(
      new DesignBriefProducer({
        ledger: cancelled,
        catalog,
        isCancelled: () => true,
        executeTask: execute,
      }).produce(input(catalog)),
    ).rejects.toMatchObject({ code: "DESIGN_BRIEF_CANCELLED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("replays the exact frozen input and survives a completion ACK loss", async () => {
    const catalog = approvedCatalog();
    const ledger = new Ledger();
    ledger.completeThenThrow = true;
    const firstInput = input(catalog);
    const expectedInputDigest = designSpecInputDigest(firstInput);
    const first = new DesignBriefProducer({
      ledger,
      catalog,
      executeTask: async (taskInput) => ({
        candidateId: taskInput.candidates[0].id,
        reasons: ["stable"],
        warnings: [],
      }),
    });
    await expect(first.produce(firstInput)).rejects.toThrow("ACK_LOST");
    expect(designSpecInputDigest(ledger.frozen as DesignSpecInputV1)).toBe(
      expectedInputDigest,
    );

    ledger.completeThenThrow = false;
    const replay = await new DesignBriefProducer({
      ledger,
      catalog,
      executeTask: async () => {
        throw new Error("must not execute after completed replay");
      },
    }).produce(
      input(catalog, {
        locales: ["de"],
        rendererVersion: "changed-caller-input",
      }),
    );
    const stored = ledger.completed as unknown as {
      taskAttemptId: string;
      designBrief: typeof replay.designBrief;
    };
    expect(replay).toEqual(stored);
    expect(replay.designBrief.digest).toBe(stored.designBrief.digest);
    expect(replay.designBrief.localePolicy).toEqual(["en"]);
  });

  it("keeps the bounded model task on the existing design_spec route", () => {
    expect(DESIGN_SPEC_TASK.id).toBe("site_builder.design_spec");
    expect(DESIGN_SPEC_TASK.inputSchema).toMatchObject({
      additionalProperties: false,
    });
    expect(DESIGN_SPEC_TASK.outputSchema).toMatchObject({
      additionalProperties: false,
    });
  });
});
