// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import { describe, expect, it, vi } from "vitest";
import { TenantProjectionService } from "./tenant-projection.service";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FETCH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("TenantProjectionService Raw Source bridge", () => {
  it("materializes one governed Raw origin and uses its id for identity/evidence writes", async () => {
    const writerCommands: Record<string, unknown>[] = [];
    const identityCreate = vi.fn(async () => ({}));
    const evidenceCreate = vi.fn(async () => ({}));
    const canonicalCreate = vi.fn(async ({ data }) => ({
      id: "company-1",
      ...data,
    }));
    const queryRaw = vi.fn(
      async (statement: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        if (statement.strings?.join("?").includes("write_raw_source_record_v2")) {
          const command = JSON.parse(String(statement.values?.[0])) as Record<
            string,
            unknown
          >;
          writerCommands.push(command);
          return [
            {
              raw_record_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              payload_hash: "b".repeat(64),
              payload_bytes: Buffer.byteLength(JSON.stringify(command.payload)),
              ingest_status: command.ingestStatus,
              inserted: true,
            },
          ];
        }
        return [{ pg_advisory_xact_lock: null }];
      },
    );
    const tx = {
      $queryRaw: queryRaw,
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: canonicalCreate,
        update: vi.fn(),
      },
      identityLink: {
        findFirst: vi.fn(async () => null),
        create: identityCreate,
      },
      fieldEvidence: { create: evidenceCreate },
    };
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn(async () => ({
          id: SOURCE,
          sourceKey: "fair:example",
          providerKey: "mapyourshow",
          config: { host: "example.mapyourshow.com" },
        })),
      },
      sourceEntity: {
        findMany: vi.fn(async () => [
          {
            id: ENTITY,
            sourceId: SOURCE,
            externalId: "exhibitor-1",
            name: "Example GmbH",
            domain: "example.test",
            country: "DE",
            cleaned: {
              products: ["pump"],
              email: "sales@example.test",
              email_kind: "role",
              stand: "A42",
              source_kind: "trade_fair_exhibitor_mys",
            },
            contentHash: "a".repeat(64),
            lastSeenAt: new Date("2026-08-25T16:31:00.000Z"),
            lastSeenFetchId: FETCH,
            withdrawnAt: null,
          },
        ]),
      },
      sourceFetch: {
        findMany: vi.fn(async () => [
          {
            id: FETCH,
            sourceId: SOURCE,
            status: "DONE",
            parserVersion: "acquisition/v1",
            finishedAt: new Date("2026-08-25T16:31:00.000Z"),
          },
        ]),
      },
      sourcePolicy: {
        findMany: vi.fn(async () => [
          {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            domain: "mapyourshow.com",
            retentionDays: 365,
            reviewStatus: "APPROVED",
            allowedPurpose: ["discovery"],
            updatedAt: new Date("2026-08-20T00:00:00.000Z"),
          },
        ]),
      },
      withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
    };
    const service = new TenantProjectionService({ prisma: prisma as never });

    await expect(
      service.projectSource(WORKSPACE, SOURCE),
    ).resolves.toMatchObject({
      projected: 1,
      personalContactsWithheld: 1,
    });
    expect(writerCommands).toHaveLength(1);
    expect(identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawRecordId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        }),
      }),
    );
    expect(evidenceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawRecordId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        }),
      }),
    );
    expect(JSON.stringify(writerCommands[0])).not.toContain(
      "sales@example.test",
    );
    const preparedPayload = writerCommands[0]!.payload as Record<
      string,
      unknown
    >;
    expect(canonicalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: preparedPayload.name,
          domain: preparedPayload.domain,
          country: preparedPayload.country,
          attributes: preparedPayload.attributes,
        }),
      }),
    );
    expect(
      canonicalCreate.mock.calls[0]![0].data.attributes,
    ).not.toHaveProperty("contact_email");
    const attributeEvidence = evidenceCreate.mock.calls.find(
      ([call]) => call.data.field === "attributes",
    );
    expect(attributeEvidence?.[0].data.value).toEqual(
      preparedPayload.attributes,
    );
  });
});
