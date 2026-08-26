// Test intent source-mined from tugjvnh@70885cdb; rewritten around least-privilege DB functions.
import { describe, expect, it, vi } from "vitest";
import { createRawSourceActivities } from "./raw-source.activities";
import { createDiscoveryActivities } from "./discovery.activities";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("Raw Source retention activities", () => {
  it("lists only bounded workspace ids through the aggregate DB function", async () => {
    const query = vi.fn(async () => [
      { workspace_id: "11111111-1111-4111-8111-111111111111" },
      { workspace_id: "22222222-2222-4222-8222-222222222222" },
    ]);
    const activities = createRawSourceActivities({
      prisma: { $queryRaw: query } as never,
      now: () => NOW,
    });

    await expect(
      activities.listRawRetentionWorkspaces({
        limit: 5_000,
        afterWorkspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      workspaceIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
      nextCursor: null,
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("expires only inside the requested workspace transaction and returns the DB receipt", async () => {
    const query = vi.fn(async () => [{ expired: 3, deferred_for_conflict: 0 }]);
    const withWorkspace = vi.fn(async (_workspaceId, callback) =>
      callback({ $queryRaw: query }),
    );
    const activities = createRawSourceActivities({
      prisma: { withWorkspace } as never,
      now: () => NOW,
    });

    await expect(
      activities.expireRawSourceRecords({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        limit: 10_000,
      }),
    ).resolves.toEqual({ expired: 3, deferredForConflict: 0 });
    expect(withWorkspace).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.any(Function),
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("propagates database failure so the workflow cannot report a false terminal success", async () => {
    const activities = createRawSourceActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) =>
          callback({
            $queryRaw: vi.fn(async () => {
              throw new Error("db unavailable");
            }),
          }),
        ),
      } as never,
      now: () => NOW,
    });

    await expect(
      activities.expireRawSourceRecords({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        limit: 50,
      }),
    ).rejects.toThrow("db unavailable");
  });
});

describe("executeQuery Raw Source v2 persistence", () => {
  it("persists only accepted bounded receipts and reports minimized/quarantined records explicitly", async () => {
    const created: Record<string, unknown>[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      rawSourceRecord: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(
          async ({ data }: { data: Record<string, unknown>[] }) => {
            created.push(...data);
            return { count: data.length };
          },
        ),
        count: vi.fn(
          async ({ where }: { where: { ingestStatus?: string } }) =>
            created.filter(
              (row) =>
                !where.ingestStatus || row.ingestStatus === where.ingestStatus,
            ).length,
        ),
      },
      usageLedger: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      sourcePolicy: {
        findMany: vi.fn(async () => [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            domain: "registry.example",
            retentionDays: 90,
            reviewStatus: "APPROVED",
            updatedAt: new Date("2026-08-25T00:00:00.000Z"),
          },
        ]),
      },
      withWorkspace: vi.fn(
        async (
          _workspaceId: string,
          callback: (client: typeof tx) => Promise<unknown>,
        ) => callback(tx),
      ),
    };
    const providers = {
      routeCompanyDiscovery: vi.fn(async () => [
        {
          key: "registry",
          classes: ["company_registry"],
          discoverCompanies: vi.fn(async () => ({
            costCents: 0,
            records: [
              {
                externalId: "safe",
                name: "Safe GmbH",
                attributes: {
                  products: ["pump"],
                  public_email: "named.person@example.test",
                },
                provenance: {
                  sourceUrl: "https://registry.example/safe",
                  fetchedAt: "2026-08-25T12:00:00.000Z",
                  contentHash: "a".repeat(64),
                  parserVersion: "registry/v1",
                },
              },
              {
                externalId: "unknown",
                name: "Unknown GmbH",
                secret_extension: "must not persist",
                provenance: {
                  sourceUrl: "https://registry.example/unknown",
                  fetchedAt: "2026-08-25T12:00:00.000Z",
                  contentHash: "b".repeat(64),
                  parserVersion: "registry/v1",
                },
              },
            ],
          })),
        },
      ]),
    };
    const binding = {
      authorityId: "20000000-0000-4000-8000-000000000002",
      scopeKey: "10000000-0000-4000-8000-000000000001",
      accountKey: `discovery.run:discovery_run:request:${"a".repeat(64)}:${"a".repeat(64)}`,
      purpose: "discovery.run",
      subjectType: "discovery_run",
      subjectId: `request:${"a".repeat(64)}`,
      requestSha256: "a".repeat(64),
    } as const;
    const activities = createDiscoveryActivities({
      prisma,
      providers,
      gateway: {},
      budgetStore: {
        attestAuthorized: vi.fn(async () => ({
          accountId: "30000000-0000-4000-8000-000000000001",
          authorityId: binding.authorityId,
          authorizedCapMicrousd: 1_000_000n,
          generation: 1,
        })),
        status: vi.fn(async () => ({
          remainingCents: 100,
          exhausted: false,
          open: true,
        })),
      },
      rawIngestLimits: {
        maxRecordBytes: 1_024,
        maxBatchBytes: 2_048,
        defaultRetentionDays: 30,
      },
    } as never);

    await expect(
      activities.executeQuery({
        workspaceId: binding.scopeKey,
        runId: "40000000-0000-4000-8000-000000000001",
        query: {
          source_class: "company_registry",
          filters: {},
          keywords: [],
          priority: 1,
        },
        executionContractVersion: 2,
        executionBudget: binding,
      }),
    ).resolves.toMatchObject({
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 1,
    });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      ingestVersion: "raw-source/v2",
      ingestStatus: "ACCEPTED",
    });
    expect(JSON.stringify(created[0]?.payload)).not.toContain("named.person");
    expect(created[1]).toMatchObject({
      ingestStatus: "REJECTED",
      dispositionCode: "UNKNOWN_PAYLOAD_FIELD",
      externalId: null,
    });
    expect(JSON.stringify(created[1]?.payload)).not.toContain(
      "must not persist",
    );
  });
});
