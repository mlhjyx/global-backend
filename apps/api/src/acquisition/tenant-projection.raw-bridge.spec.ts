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

  it("keeps response-loss replay byte-stable and updates once for a changed governed snapshot", async () => {
    const FETCH_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let entity = {
      id: ENTITY,
      sourceId: SOURCE,
      externalId: "exhibitor-1",
      name: "Example GmbH",
      domain: "example.test",
      country: "DE",
      cleaned: { products: ["pump"], stand: "A42" },
      contentHash: "a".repeat(64),
      lastSeenAt: new Date("2026-08-25T16:31:00.000Z"),
      lastSeenFetchId: FETCH,
      withdrawnAt: null,
    };
    let fetch = {
      id: FETCH,
      sourceId: SOURCE,
      status: "DONE",
      parserVersion: "acquisition/v1",
      finishedAt: new Date("2026-08-25T16:31:00.000Z"),
    };
    let company: Record<string, unknown> | null = null;
    const rawByIngestKey = new Map<string, string>();
    const links: Array<Record<string, unknown>> = [];
    const evidence: Array<Record<string, unknown>> = [];
    let updateClock = 0;
    const writer = vi.fn(
      async (statement: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        if (!statement.strings?.join("?").includes("write_raw_source_record_v2")) {
          return [{ pg_advisory_xact_lock: null }];
        }
        const command = JSON.parse(String(statement.values?.[0])) as Record<
          string,
          unknown
        >;
        const ingestKey = String(command.ingestKey);
        const existing = rawByIngestKey.get(ingestKey);
        const rawId = existing ?? `raw-${rawByIngestKey.size + 1}`;
        if (!existing) rawByIngestKey.set(ingestKey, rawId);
        return [
          {
            raw_record_id: rawId,
            payload_hash: "b".repeat(64),
            payload_bytes: Buffer.byteLength(JSON.stringify(command.payload)),
            ingest_status: command.ingestStatus,
            inserted: existing === undefined,
          },
        ];
      },
    );
    const canonicalCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      updateClock += 1;
      company = {
        id: "company-1",
        ...data,
        version: 1,
        updatedAt: new Date(`2026-08-26T00:00:0${updateClock}.000Z`),
      };
      return company;
    });
    const canonicalUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      updateClock += 1;
      company = {
        ...company,
        ...(data.domain && typeof data.domain === "object"
          ? { domain: (data.domain as { set: string }).set }
          : {}),
        ...(data.country && typeof data.country === "object"
          ? { country: (data.country as { set: string }).set }
          : {}),
        attributes: data.attributes,
        version: Number(company?.version ?? 0) + 1,
        updatedAt: new Date(`2026-08-26T00:00:0${updateClock}.000Z`),
      };
      return company;
    });
    const tx = {
      $queryRaw: writer,
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: canonicalCreate,
        update: canonicalUpdate,
      },
      identityLink: {
        findFirst: vi.fn(async ({ where }: { where: { rawRecordId: string } }) =>
          links.find((row) => row.rawRecordId === where.rawRecordId) ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          links.push({ id: `link-${links.length + 1}`, ...data });
          return {};
        }),
      },
      fieldEvidence: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          evidence.push({ id: `evidence-${evidence.length + 1}`, ...data });
          return {};
        }),
      },
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
      sourceEntity: { findMany: vi.fn(async () => [entity]) },
      sourceFetch: { findMany: vi.fn(async () => [fetch]) },
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

    await expect(service.projectSource(WORKSPACE, SOURCE)).resolves.toMatchObject({
      entities: 1,
      projected: 1,
    });
    const firstBytes = JSON.stringify(company);
    const firstVersion = company!.version;
    const firstUpdatedAt = company!.updatedAt;
    const firstLinks = links.length;
    const firstEvidence = evidence.length;

    // The first transaction committed, but its activity response was lost.
    await expect(service.projectSource(WORKSPACE, SOURCE)).resolves.toMatchObject({
      entities: 1,
      projected: 0,
    });
    expect(JSON.stringify(company)).toBe(firstBytes);
    expect(company!.version).toBe(firstVersion);
    expect(company!.updatedAt).toEqual(firstUpdatedAt);
    expect(links).toHaveLength(firstLinks);
    expect(evidence).toHaveLength(firstEvidence);

    entity = {
      ...entity,
      cleaned: { products: ["pump", "valve"], stand: "A42" },
      contentHash: "c".repeat(64),
      lastSeenAt: new Date("2026-08-25T17:31:00.000Z"),
      lastSeenFetchId: FETCH_2,
    };
    fetch = {
      ...fetch,
      id: FETCH_2,
      finishedAt: new Date("2026-08-25T17:31:00.000Z"),
    };
    await expect(service.projectSource(WORKSPACE, SOURCE)).resolves.toMatchObject({
      projected: 1,
    });
    expect(company!.attributes).toMatchObject({ products: ["pump", "valve"] });
    expect(company!.version).toBe(Number(firstVersion) + 1);
    expect(links).toHaveLength(firstLinks + 1);
    expect(evidence.length).toBeGreaterThan(firstEvidence);

    const changedBytes = JSON.stringify(company);
    const changedEvidence = evidence.length;
    await expect(service.projectSource(WORKSPACE, SOURCE)).resolves.toMatchObject({
      projected: 0,
    });
    expect(JSON.stringify(company)).toBe(changedBytes);
    expect(evidence).toHaveLength(changedEvidence);
  });
});
