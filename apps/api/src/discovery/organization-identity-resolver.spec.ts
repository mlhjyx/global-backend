import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  OrganizationIdentityResolverError,
  resolveOrganizationIdentityForRaw,
} from "./organization-identity-resolver";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RAW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPANY_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEW_COMPANY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONFLICT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PAYLOAD_HASH = "a".repeat(64);

const PROVENANCE = Object.freeze({
  sourceUrl: "https://registry.example/companies/1",
  fetchedAt: "2026-08-25T12:00:00.000Z",
  contentHash: "b".repeat(64),
  parserVersion: "registry/v1",
});

function registryPayload() {
  return {
    externalId: "company-1",
    name: "Acme GmbH",
    domain: "acme.example",
    country: "DE",
    attributes: { products: ["pump"] },
    identifier: { scheme: "registry-id", value: "de-12/34" },
    provenance: PROVENANCE,
  };
}

function directoryPayload() {
  return {
    externalId: "directory:acme.example",
    name: "Acme GmbH",
    domain: "acme.example",
    country: "DE",
    attributes: {
      source_kind: "directory",
      source_directory: "registry.example",
      detail_url: "https://registry.example/company/1",
      source_class: "industry_data",
    },
    provenance: PROVENANCE,
  };
}

type FixtureOptions = Readonly<{
  payload?: Record<string, unknown>;
  providerKey?: string;
  legacyCompany?: null | {
    id: string;
    workspaceId: string;
    name: string;
    domain: string | null;
    status: string;
    dedupeKey: string;
  };
  identifierCompanyId?: string;
  rootMappings?: readonly {
    sourceCompanyId: string;
    canonicalCompanyId: string;
  }[];
  companies?: readonly {
    id: string;
    workspaceId: string;
    name: string;
    domain: string | null;
    status: string;
    dedupeKey: string;
  }[];
  suppressions?: readonly { type: string; value: string }[];
  commandReceipt?: (
    command: Record<string, unknown>,
  ) => Record<string, unknown>;
  commandError?: unknown;
}>;

function transactionFixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const payload = options.payload ?? registryPayload();
  const providerKey = options.providerKey ?? "registry";
  const legacyCompany =
    options.legacyCompany === undefined ? null : options.legacyCompany;
  const identifierCompanyId = options.identifierCompanyId;
  const rootMappings = options.rootMappings ?? [];
  const companies = options.companies ?? [
    {
      id: COMPANY_A,
      workspaceId: WORKSPACE_ID,
      name: "Acme GmbH",
      domain: "acme.example",
      status: "NEW",
      dedupeKey: "d:acme.example",
    },
    {
      id: COMPANY_B,
      workspaceId: WORKSPACE_ID,
      name: "Acme Legacy GmbH",
      domain: "legacy.example",
      status: "NEW",
      dedupeKey: "d:legacy.example",
    },
  ];
  let queryIndex = 0;
  let observedCommand: Record<string, unknown> | null = null;
  const queryRaw = vi.fn(async (...args: unknown[]) => {
    queryIndex += 1;
    if (queryIndex === 1) {
      events.push("suppression-lock");
      return [{ locked: true }];
    }
    if (queryIndex === 2) {
      events.push("identity-lock");
      return [{ locked: true }];
    }
    if (queryIndex === 3) {
      events.push("raw-for-key-share");
      return [
        {
          id: RAW_ID,
          workspace_id: WORKSPACE_ID,
          provider_key: providerKey,
          payload,
          payload_hash: PAYLOAD_HASH,
          ingest_version: "raw-source/v2",
          ingest_status: "ACCEPTED",
          is_current: true,
        },
      ];
    }
    events.push("command");
    const commandJson = args
      .slice(1)
      .find((value) => typeof value === "string");
    if (typeof commandJson !== "string") throw new Error("missing command");
    observedCommand = JSON.parse(commandJson) as Record<string, unknown>;
    if (options.commandError !== undefined) throw options.commandError;
    if (!options.commandReceipt) throw new Error("missing receipt fixture");
    return [options.commandReceipt(observedCommand)];
  });

  const tx = {
    $queryRaw: queryRaw,
    rawSourceGovernanceDisposition: {
      findFirst: vi.fn(async () => {
        events.push("raw-disposition");
        return null;
      }),
    },
    suppressionRecord: {
      findMany: vi.fn(async () => {
        events.push("suppression-read");
        return options.suppressions ?? [];
      }),
    },
    canonicalCompany: {
      findUnique: vi.fn(async () => {
        events.push("blocker-read");
        return legacyCompany;
      }),
      findMany: vi.fn(async () => {
        events.push("company-read");
        return companies;
      }),
      create: vi.fn(async () => {
        events.push("company-create");
        return {
          id: NEW_COMPANY,
          workspaceId: WORKSPACE_ID,
          name: "Acme GmbH",
          domain: "acme.example",
          status: "NEW",
          dedupeKey: "d:acme.example",
        };
      }),
    },
    organizationIdentifier: {
      findMany: vi.fn(async () => {
        events.push("identifier-read");
        return identifierCompanyId
          ? [
              {
                scheme: "registry-id",
                jurisdiction: "DE",
                normalizedValue: "DE1234",
                companyId: identifierCompanyId,
              },
            ]
          : [];
      }),
    },
    organizationCanonicalMapping: {
      findMany: vi.fn(async () => {
        events.push("root-read");
        return rootMappings;
      }),
    },
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    events,
    get command() {
      return observedCommand;
    },
    create: (
      tx as unknown as {
        canonicalCompany: { create: ReturnType<typeof vi.fn> };
      }
    ).canonicalCompany.create,
  };
}

function boundReceipt(command: Record<string, unknown>, companyId: string) {
  const plan = command.plan as Record<string, unknown>;
  return {
    outcome_kind: "bound",
    raw_record_id: RAW_ID,
    company_id: companyId,
    conflict_id: null,
    match_rule: plan.matchRule,
    input_hash: plan.inputHash,
    conflict_fingerprint: null,
    replayed: false,
    identifier_count: Array.isArray(plan.identifiers)
      ? plan.identifiers.length
      : 0,
    party_count: 0,
  };
}

function conflictReceipt(command: Record<string, unknown>) {
  const plan = command.plan as Record<string, unknown>;
  return {
    outcome_kind: "conflict",
    raw_record_id: RAW_ID,
    company_id: null,
    conflict_id: CONFLICT_ID,
    match_rule: "identity_conflict",
    input_hash: plan.inputHash,
    conflict_fingerprint: plan.conflictFingerprint,
    replayed: false,
    identifier_count: 0,
    party_count: 2,
  };
}

describe("organization identity DB resolver source contract", () => {
  it("binds an admitted strong identifier to its existing canonical root", async () => {
    const fixture = transactionFixture({
      identifierCompanyId: COMPANY_A,
      commandReceipt: (command) => boundReceipt(command, COMPANY_A),
    });

    const receipt = await resolveOrganizationIdentityForRaw(fixture.tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: RAW_ID,
    });

    expect(receipt).toMatchObject({
      schemaVersion: "organization-identity-resolution-receipt/v1",
      kind: "bound",
      companyId: COMPANY_A,
      matchRule: "identity_v2",
      rawRecordId: RAW_ID,
      replayed: false,
      identifierCount: 1,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.events.indexOf("suppression-lock")).toBeLessThan(
      fixture.events.indexOf("identity-lock"),
    );
    expect(fixture.events.indexOf("identity-lock")).toBeLessThan(
      fixture.events.indexOf("raw-for-key-share"),
    );
    expect(fixture.events.at(-1)).toBe("command");
  });

  it("lazily upgrades an existing blocker candidate without changing its business facts", async () => {
    const fixture = transactionFixture({
      payload: directoryPayload(),
      providerKey: "directory",
      legacyCompany: {
        id: COMPANY_A,
        workspaceId: WORKSPACE_ID,
        name: "Acme GmbH",
        domain: "acme.example",
        status: "NEW",
        dedupeKey: "d:acme.example",
      },
      commandReceipt: (command) => boundReceipt(command, COMPANY_A),
    });

    const receipt = await resolveOrganizationIdentityForRaw(fixture.tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: RAW_ID,
    });

    expect(receipt).toMatchObject({
      kind: "bound",
      companyId: COMPANY_A,
      matchRule: "domain_exact",
      identifierCount: 0,
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect((fixture.command?.plan as { kind: string }).kind).toBe(
      "lazy_upgrade",
    );
  });

  it("creates a minimal company only inside the locked transaction when no candidate exists", async () => {
    const fixture = transactionFixture({
      payload: directoryPayload(),
      providerKey: "directory",
      commandReceipt: (command) => boundReceipt(command, NEW_COMPANY),
    });

    const receipt = await resolveOrganizationIdentityForRaw(fixture.tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: RAW_ID,
    });

    expect(receipt).toMatchObject({
      kind: "bound",
      companyId: NEW_COMPANY,
      matchRule: "domain_exact",
    });
    expect(fixture.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WORKSPACE_ID,
        name: "Acme GmbH",
        domain: "acme.example",
        country: "DE",
        status: "NEW",
        dedupeKey: "d:acme.example",
        attributes: null,
      },
      select: expect.objectContaining({ id: true }),
    });
    expect(fixture.events.indexOf("company-create")).toBeLessThan(
      fixture.events.indexOf("command"),
    );
  });

  it("persists a blocker disagreement as a conflict instead of guessing", async () => {
    const fixture = transactionFixture({
      identifierCompanyId: COMPANY_A,
      legacyCompany: {
        id: COMPANY_B,
        workspaceId: WORKSPACE_ID,
        name: "Other Acme GmbH",
        domain: "acme.example",
        status: "NEW",
        dedupeKey: "d:acme.example",
      },
      commandReceipt: conflictReceipt,
    });

    const receipt = await resolveOrganizationIdentityForRaw(fixture.tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: RAW_ID,
    });

    expect(receipt).toMatchObject({
      kind: "conflict",
      conflictId: CONFLICT_ID,
      matchRule: "identity_conflict",
      partyCount: 2,
    });
    const plan = fixture.command?.plan as {
      kind: string;
      conflictType: string;
      companyIds: string[];
    };
    expect(plan).toMatchObject({
      kind: "conflict",
      conflictType: "blocking_key_disagreement",
      companyIds: [COMPANY_A, COMPANY_B],
    });
  });

  it("fails closed on current suppression before any company or identity command write", async () => {
    const fixture = transactionFixture({
      payload: directoryPayload(),
      providerKey: "directory",
      suppressions: [{ type: "domain", value: "acme.example" }],
      commandReceipt: (command) => boundReceipt(command, NEW_COMPANY),
    });

    await expect(
      resolveOrganizationIdentityForRaw(fixture.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      }),
    ).rejects.toMatchObject({
      code: "IDENTITY_RESOLUTION_SUPPRESSED",
      message: "organization identity resolution failed",
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.events).not.toContain("command");
  });

  it("rejects malformed input and malformed DB receipts without echoing attacker text", async () => {
    const marker = "Bearer do-not-echo@example.test";
    const noCall = transactionFixture({
      commandReceipt: (command) => boundReceipt(command, COMPANY_A),
    });
    await expect(
      resolveOrganizationIdentityForRaw(noCall.tx, {
        workspaceId: marker,
        rawRecordId: RAW_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "IDENTITY_RESOLUTION_INPUT_INVALID",
        message: "organization identity resolution failed",
      }),
    );
    expect(noCall.events).toEqual([]);

    const malformed = transactionFixture({
      identifierCompanyId: COMPANY_A,
      commandReceipt: () => ({
        outcome_kind: "bound",
        raw_record_id: RAW_ID,
        company_id: COMPANY_A,
        conflict_id: null,
        match_rule: marker,
        input_hash: "not-a-hash",
        conflict_fingerprint: null,
        replayed: false,
        identifier_count: 1,
        party_count: 0,
      }),
    });
    await expect(
      resolveOrganizationIdentityForRaw(malformed.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "IDENTITY_RESOLUTION_RECEIPT_INVALID",
        message: "organization identity resolution failed",
      }),
    );
  });

  it("maps only closed PostgreSQL failures and never exposes database details", async () => {
    const marker = "postgresql://owner:secret@customer";
    const fixture = transactionFixture({
      identifierCompanyId: COMPANY_A,
      commandError: Object.assign(new Error(marker), {
        code: "42501",
      }),
    });

    await expect(
      resolveOrganizationIdentityForRaw(fixture.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "IDENTITY_RESOLUTION_COMMAND_DENIED",
        message: "organization identity resolution failed",
      }),
    );
  });

  it("uses a closed generic error type", () => {
    const error = new OrganizationIdentityResolverError(
      "IDENTITY_RESOLUTION_PLAN_STALE",
    );
    expect(error).toMatchObject({
      name: "OrganizationIdentityResolverError",
      code: "IDENTITY_RESOLUTION_PLAN_STALE",
      message: "organization identity resolution failed",
    });
  });
});
