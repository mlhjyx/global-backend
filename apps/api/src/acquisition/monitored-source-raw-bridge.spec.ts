// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import { describe, expect, it, vi } from "vitest";
import {
  MonitoredSourceRawBridgeError,
  persistMonitoredSourceRawBridge,
  prepareMonitoredSourceRawBridge,
} from "./monitored-source-raw-bridge";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const source = Object.freeze({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceKey: "fair:example-2026",
  providerKey: "mapyourshow",
  config: { host: "example.mapyourshow.com", untrustedLicense: "ignore-me" },
});
const entity = Object.freeze({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  externalId: "EX-42",
  name: "Example Maschinenbau GmbH",
  domain: "example.test",
  country: "DE",
  cleaned: {
    products: ["press brake"],
    stand: "A42",
    hall: "1",
    source_fair: "example-2026",
    source_kind: "trade_fair_exhibitor_mys",
    email: "named.person@example.test",
    email_kind: "personal",
    phone: "+49 555 0100",
    description: "unbounded source prose",
    unknown_field: "must not persist",
  },
  contentHash: "a".repeat(64),
  lastSeenAt: new Date("2026-08-25T16:31:00.000Z"),
  lastSeenFetchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const fetch = Object.freeze({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  sourceId: source.id,
  status: "DONE",
  parserVersion: "acquisition/v1",
  finishedAt: new Date("2026-08-25T16:31:00.000Z"),
});
const policies = Object.freeze([
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    domain: "mapyourshow.com",
    retentionDays: 365,
    reviewStatus: "APPROVED",
    allowedPurpose: ["discovery", "enrichment"],
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
  },
]);

describe("monitored source to Raw Source bridge", () => {
  it("creates an idempotent, fetch-bound, governed company-only snapshot", () => {
    const first = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
    });
    const repeated = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity: {
        ...entity,
        cleaned: {
          hall: "1",
          products: ["press brake"],
          source_kind: "trade_fair_exhibitor_mys",
          source_fair: "example-2026",
          stand: "A42",
          email: "different.person@example.test",
        },
      },
      fetch,
      policies,
    });

    expect(repeated.row.ingestKey).toBe(first.row.ingestKey);
    expect(repeated.row.payloadHash).toBe(first.row.payloadHash);
    expect(first).toMatchObject({
      identityProviderKey: "trade_fair",
      sourceClass: "industry_data",
      license: "SOURCE_SPECIFIC_RESTRICTED",
      row: {
        ingestStatus: "ACCEPTED",
        sourceUrl:
          "https://example.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm",
        fetchedAt: fetch.finishedAt,
        contentHash: entity.contentHash,
        parserVersion: fetch.parserVersion,
      },
      uniqueWhere: {
        workspaceId: WORKSPACE_A,
        sourceEntityId: entity.id,
      },
    });
    expect(first.row.payload).toMatchObject({
      name: entity.name,
      domain: entity.domain,
      country: entity.country,
      attributes: {
        products: ["press brake"],
        stand: "A42",
        hall: "1",
        source_fair: "example-2026",
        source_kind: "trade_fair_exhibitor_mys",
      },
      monitoredSource: { sourceFetchId: fetch.id },
    });
    const persisted = JSON.stringify(first.row.payload);
    for (const forbidden of [
      "named.person",
      "+49",
      "unbounded source prose",
      "must not persist",
      "untrustedLicense",
    ]) {
      expect(persisted).not.toContain(forbidden);
    }
  });

  it("keeps the source snapshot identity stable across workspaces and changes it for a later fetch", () => {
    const left = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
    });
    const right = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_B,
      source,
      entity,
      fetch,
      policies,
    });
    const laterFetch = {
      ...fetch,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      finishedAt: new Date("2026-08-26T16:31:00.000Z"),
    };
    const later = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity: {
        ...entity,
        lastSeenAt: laterFetch.finishedAt,
        lastSeenFetchId: laterFetch.id,
      },
      fetch: laterFetch,
      policies,
    });

    expect(right.uniqueWhere.ingestKey).toBe(left.uniqueWhere.ingestKey);
    expect(right.uniqueWhere.workspaceId).not.toBe(
      left.uniqueWhere.workspaceId,
    );
    expect(later.uniqueWhere.ingestKey).not.toBe(left.uniqueWhere.ingestKey);
    expect(later.row.payload).toMatchObject({
      monitoredSource: { sourceFetchId: laterFetch.id },
    });
  });

  it("derives the existing trade-fair Algolia URL without persisting its API key", () => {
    const nonPersistedConfigKey = ["api", "Key"].join("");
    const prepared = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source: {
        ...source,
        providerKey: "trade_fair",
        config: {
          algolia: {
            appId: "PUBLICAPP",
            [nonPersistedConfigKey]: "must-not-persist",
            indexName: "public exhibitors",
          },
        },
      },
      entity,
      fetch,
      policies: [{ ...policies[0]!, domain: "algolia.net" }],
    });

    expect(prepared.row.sourceUrl).toBe(
      "https://publicapp-dsn.algolia.net/1/indexes/public%20exhibitors",
    );
    expect(JSON.stringify(prepared.row.payload)).not.toContain(
      "must-not-persist",
    );
  });

  it("uses one compound upsert and rejects an existing receipt with drift", async () => {
    const prepared = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
    });
    const upsert = vi.fn(async ({ create }) => ({
      id: "raw-1",
      payloadHash: create.payloadHash,
      ingestStatus: create.ingestStatus,
    }));

    await expect(
      persistMonitoredSourceRawBridge(
        { rawSourceRecord: { upsert } } as never,
        { workspaceId: WORKSPACE_A, prepared },
      ),
    ).resolves.toMatchObject({ id: "raw-1", ingestStatus: "ACCEPTED" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_sourceEntityId_ingestKey: prepared.uniqueWhere },
        update: {},
      }),
    );

    upsert.mockResolvedValueOnce({
      id: "raw-1",
      payloadHash: "b".repeat(64),
      ingestStatus: "ACCEPTED",
    });
    await expect(
      persistMonitoredSourceRawBridge(
        { rawSourceRecord: { upsert } } as never,
        { workspaceId: WORKSPACE_A, prepared },
      ),
    ).rejects.toMatchObject({ code: "MONITORED_SOURCE_RAW_DRIFT" });

    await expect(
      persistMonitoredSourceRawBridge(
        { rawSourceRecord: { upsert } } as never,
        { workspaceId: WORKSPACE_B, prepared },
      ),
    ).rejects.toMatchObject({ code: "MONITORED_SOURCE_WORKSPACE_MISMATCH" });
  });

  it.each([
    ["unknown provider", { source: { ...source, providerKey: "unknown" } }],
    [
      "missing fetch provenance",
      { entity: { ...entity, lastSeenFetchId: null } },
    ],
    [
      "cross-source fetch",
      { fetch: { ...fetch, sourceId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
    ],
    [
      "mismatched observation time",
      {
        entity: { ...entity, lastSeenAt: new Date("2026-08-25T16:30:00.000Z") },
      },
    ],
    [
      "incomplete fetch",
      { fetch: { ...fetch, status: "RUNNING", finishedAt: null } },
    ],
    [
      "suspended policy",
      { policies: [{ ...policies[0]!, reviewStatus: "SUSPENDED" }] },
    ],
    [
      "purpose-less policy",
      { policies: [{ ...policies[0]!, allowedPurpose: [] }] },
    ],
    ["invalid content hash", { entity: { ...entity, contentHash: "invalid" } }],
    [
      "invalid source config",
      { source: { ...source, config: { host: "example.test" } } },
    ],
  ])("fails closed for %s", (_name, override) => {
    expect(() =>
      prepareMonitoredSourceRawBridge({
        workspaceId: WORKSPACE_A,
        source: override.source ?? source,
        entity: override.entity ?? entity,
        fetch: override.fetch ?? fetch,
        policies: override.policies ?? policies,
      }),
    ).toThrow(MonitoredSourceRawBridgeError);
  });
});
