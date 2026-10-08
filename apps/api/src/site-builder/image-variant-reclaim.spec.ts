import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../prisma/prisma.service";
import { reclaimSupersededImageVariants } from "./image-variant-reclaim";
import { projectDerivedImageManifest } from "./media-foundation";
import { buildVariantAttemptObjectKey, buildVariantObjectKey } from "./object-key";
import type { StorageService } from "./storage.service";

const job = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  siteId: "33333333-3333-4333-8333-333333333333",
  assetId: "44444444-4444-4444-8444-444444444444",
  sourceHash: "a".repeat(64),
  sourceObjectKey: "source",
};

interface LedgerRow {
  id: string;
  recipeHash: string;
  objectKey: string;
  status: string;
  metadata: Record<string, unknown> | null;
  sourceVariantId: string | null;
  pipelineVersion: string;
  variantType: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  contentHash: string;
}

let sequence = 0;
function row(version: string, overrides: Partial<LedgerRow> = {}): LedgerRow {
  sequence += 1;
  const recipeHash = sequence.toString(16).padStart(64, "0");
  return {
    id: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    recipeHash,
    objectKey: buildVariantObjectKey(job.workspaceId, job.siteId, job.assetId, recipeHash, "webp"),
    status: "ready",
    metadata: null,
    sourceVariantId: null,
    pipelineVersion: version,
    variantType: "card",
    mime: "image/webp",
    width: 100 + sequence,
    height: 100,
    sizeBytes: 10,
    contentHash: "c".repeat(64),
    ...overrides,
  };
}

function attemptKeyFor(target: LedgerRow, token = "77777777-7777-4777-8777-777777777777"): string {
  return buildVariantAttemptObjectKey(job.workspaceId, job.siteId, job.assetId, token, target.recipeHash, "webp");
}

function manifestOf(version: string, published: LedgerRow[]) {
  return projectDerivedImageManifest({ pipelineVersion: version, sourceHash: job.sourceHash, variants: published });
}

function attemptKeysOf(target: LedgerRow): string[] {
  const keys = target.metadata?.attemptKeys;
  return Array.isArray(keys) ? (keys as string[]) : [];
}

type SqlQuery = { strings: readonly string[]; values: readonly unknown[] };
const sqlText = (query: SqlQuery) => query.strings.join("?").replace(/\s+/g, " ");

function ledger(input: {
  rows: LedgerRow[];
  derivedKeys: unknown;
  building?: boolean;
  referencedVariantIds?: string[];
  undeletable?: string[];
  lockLost?: boolean;
}) {
  const rows = new Map(input.rows.map((entry) => [entry.id, { ...entry }]));
  const objects = new Set(input.rows.flatMap((entry) => [entry.objectKey, ...attemptKeysOf(entry)]));
  const undeletable = new Set(input.undeletable ?? []);
  const events: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: SqlQuery) => {
      const text = sqlText(query);
      if (text.includes("FROM asset ") && text.includes("FOR UPDATE")) {
        events.push("lock");
        return input.lockLost ? [] : [{ id: job.assetId, derivedKeys: input.derivedKeys }];
      }
      if (text.includes("FROM site_version")) {
        return (input.referencedVariantIds ?? []).map((variantId) => ({ variantId }));
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    siteVersion: {
      findFirst: vi.fn(async () => (input.building ? { id: "55555555-5555-4555-8555-555555555555" } : null)),
    },
    assetVariant: {
      findMany: vi.fn(async () => [...rows.values()].map((entry) => ({ ...entry }))),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; assetId: string; status: string } }) => {
        const current = rows.get(where.id);
        if (!current || where.assetId !== job.assetId || current.status !== where.status) return { count: 0 };
        if ([...rows.values()].some((other) => other.sourceVariantId === where.id)) {
          throw new Error("asset_variant_source_scope_fkey");
        }
        rows.delete(where.id);
        events.push(`row:${where.id}`);
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const storage = {
    delete: vi.fn(async (key: string) => {
      events.push(`object:${key}`);
      if (!undeletable.has(key)) objects.delete(key);
    }),
    head: vi.fn(async (key: string) => (objects.has(key) ? { size: 10, contentType: "image/webp" } : null)),
  };
  return {
    deps: {
      prisma: prisma as unknown as Pick<PrismaService, "withWorkspace">,
      storage: storage as unknown as Pick<StorageService, "delete" | "head">,
    },
    rows,
    objects,
    events,
    tx,
    prisma,
    storage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("superseded image variant reclamation", () => {
  it("reclaims every row nothing keeps, under the asset lock and objects before rows", async () => {
    const superseded = [row("v-a"), row("v-a"), row("v-b")];
    superseded[0].metadata = { attemptKeys: [attemptKeyFor(superseded[0])] };
    const published = [row("v-c"), row("v-c")];
    const planned = row("v-d", { status: "failed" });
    const f = ledger({ rows: [...superseded, ...published, planned], derivedKeys: manifestOf("v-c", published) });

    await expect(
      reclaimSupersededImageVariants(f.deps, job, new Set([planned.recipeHash])),
    ).resolves.toEqual({ status: "reclaimed", rows: 3, objects: 4 });

    expect([...f.rows.keys()].sort()).toEqual([...published, planned].map((entry) => entry.id).sort());
    expect(f.storage.delete.mock.calls.map(([key]) => key).sort()).toEqual(
      [...superseded.map((entry) => entry.objectKey), attemptKeyFor(superseded[0])].sort(),
    );
    const lastObjectEvent = Math.max(...f.events.flatMap((event, index) => (event.startsWith("object:") ? [index] : [])));
    const firstRowEvent = f.events.findIndex((event) => event.startsWith("row:"));
    expect(lastObjectEvent).toBeLessThan(firstRowEvent);
    expect(f.events[0]).toBe("lock");
    expect(f.prisma.withWorkspace).toHaveBeenCalledOnce();
    expect(f.prisma.withWorkspace).toHaveBeenCalledWith(job.workspaceId, expect.any(Function), {
      maxWait: 10_000,
      timeout: 30_000,
    });
  });

  it("locks exactly the asset row the producer is working from", async () => {
    const f = ledger({ rows: [], derivedKeys: null });

    await reclaimSupersededImageVariants(f.deps, job, new Set());

    const lock = f.tx.$queryRaw.mock.calls.map(([query]) => query).find((query) => sqlText(query).includes("FOR UPDATE"))!;
    expect(sqlText(lock)).toMatch(/deleted_at IS NULL AND processing_status = 'ready'/);
    expect(lock.values).toEqual([job.assetId, job.workspaceId, job.siteId, job.sourceHash, job.sourceObjectKey]);
    expect(f.tx.siteVersion.findFirst).toHaveBeenCalledWith({
      where: { siteId: job.siteId, buildStatus: "building" },
      select: { id: true },
    });
    const references = f.tx.$queryRaw.mock.calls.map(([query]) => query).find((query) => sqlText(query).includes("site_version"))!;
    expect(sqlText(references)).toMatch(/ref\.value ->> 'source' = 'tenant'/);
    expect(references.values).toEqual([job.siteId, job.assetId]);
  });

  it("keeps every variant a site version still names, even outside the published manifest", async () => {
    // A page or section build merges the active version's assets and reads each one by id.
    const namedByVersion = row("v-a");
    const unnamed = row("v-a");
    const published = row("v-b");
    const f = ledger({
      rows: [namedByVersion, unnamed, published],
      derivedKeys: manifestOf("v-b", [published]),
      referencedVariantIds: [namedByVersion.id],
    });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).resolves.toEqual({
      status: "reclaimed",
      rows: 1,
      objects: 1,
    });
    expect(f.rows.has(namedByVersion.id)).toBe(true);
    expect(f.rows.has(unnamed.id)).toBe(false);
    expect(f.storage.delete).not.toHaveBeenCalledWith(namedByVersion.objectKey, expect.anything());
  });

  it("treats an asset without a published manifest as publishing nothing", async () => {
    const superseded = [row("v-a"), row("v-a")];
    const planned = row("v-b");
    const f = ledger({ rows: [...superseded, planned], derivedKeys: null });

    await expect(
      reclaimSupersededImageVariants(f.deps, job, new Set([planned.recipeHash])),
    ).resolves.toEqual({ status: "reclaimed", rows: 2, objects: 2 });
    expect([...f.rows.keys()]).toEqual([planned.id]);
  });

  it("skips reclamation while a build of the site is in flight", async () => {
    const f = ledger({ rows: [row("v-a"), row("v-b")], derivedKeys: null, building: true });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).resolves.toEqual({
      status: "skipped",
      reason: "build_in_progress",
    });
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(2);
  });

  it("skips reclamation when the published manifest cannot be read", async () => {
    const f = ledger({ rows: [row("v-a")], derivedKeys: { schemaVersion: "1.0" } });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).resolves.toEqual({
      status: "skipped",
      reason: "manifest_unreadable",
    });
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(1);
  });

  it("skips reclamation when waiting for the asset lock left too little of the transaction", async () => {
    const f = ledger({ rows: [row("v-a")], derivedKeys: null });
    const started = 1_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(started).mockReturnValue(started + 16_000);

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).resolves.toEqual({
      status: "skipped",
      reason: "lock_contended",
    });
    expect(now).toHaveBeenCalled();
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(1);
  });

  it("leaves processing rows to lease reconciliation", async () => {
    const processing = row("v-a", {
      status: "processing",
      metadata: { reservation: { token: "t", leaseUntil: "2000-01-01T00:00:00.000Z" } },
    });
    const f = ledger({ rows: [processing], derivedKeys: null });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).resolves.toEqual({
      status: "reclaimed",
      rows: 0,
      objects: 0,
    });
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows.has(processing.id)).toBe(true);
  });

  it("refuses to reclaim once the asset no longer matches the processed source", async () => {
    const f = ledger({ rows: [row("v-a")], derivedKeys: null, lockLost: true });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).rejects.toThrow(
      /asset changed before image variant reclamation/,
    );
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.tx.assetVariant.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes derived children before their source and keeps a source that a kept row uses", async () => {
    const source = row("v-a");
    const child = row("v-a", { sourceVariantId: source.id });
    const keptSource = row("v-a");
    const published = row("v-c", { sourceVariantId: keptSource.id });
    const f = ledger({ rows: [source, child, keptSource, published], derivedKeys: manifestOf("v-c", [published]) });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).resolves.toEqual({
      status: "reclaimed",
      rows: 2,
      objects: 2,
    });
    expect(f.events.filter((event) => event.startsWith("row:"))).toEqual([`row:${child.id}`, `row:${source.id}`]);
    expect(f.rows.has(keptSource.id)).toBe(true);
    expect(f.storage.delete).not.toHaveBeenCalledWith(keptSource.objectKey, expect.anything());
  });

  it("fails closed before touching the ledger when an object survives deletion", async () => {
    const stuck = row("v-a");
    const f = ledger({ rows: [stuck, row("v-a")], derivedKeys: null, undeletable: [stuck.objectKey] });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).rejects.toThrow(
      /reclamation could not delete/,
    );
    expect(f.tx.assetVariant.deleteMany).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(2);
  });

  it("refuses a candidate whose keys do not match variant provenance", async () => {
    const foreign = row("v-a", { objectKey: "ws/other/site/variants/asset/elsewhere.webp" });
    const f = ledger({ rows: [foreign], derivedKeys: null });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).rejects.toThrow(/provenance conflicts/);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });

  it("refuses more objects than one bounded cleanup plan", async () => {
    const crowded = Array.from({ length: 16 }, () => row("v-a"));
    for (const entry of crowded) {
      entry.metadata = {
        attemptKeys: Array.from({ length: 8 }, (_unused, index) =>
          attemptKeyFor(entry, `77777777-7777-4777-8777-${index.toString(16).padStart(12, "0")}`),
        ),
      };
    }
    const f = ledger({ rows: crowded, derivedKeys: null });

    await expect(reclaimSupersededImageVariants(f.deps, job, new Set())).rejects.toThrow(/exceeds 128 objects/);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });
});
