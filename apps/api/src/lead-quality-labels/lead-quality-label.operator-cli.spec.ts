import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileLeadQualityLabelOperatorStateStore,
  runLeadQualityLabelOperator,
  type LeadQualityLabelOperatorState,
  type LeadQualityLabelOperatorStateStore,
} from "./lead-quality-label.operator-cli";

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAKE_BEARER = ["unit", "test", "bearer"].join("-");
const FIXED_DIGEST = "a".repeat(64);

const qgoInput = JSON.stringify({
  source_event_id: "operator:qgo:1001",
  lead_id: LEAD_ID,
  lead_qualified_event_id: EVENT_ID,
  label: "QGO_CREATED",
  occurred_at: "2026-08-07T12:00:00.000Z",
  source_system: "quality-label-operator",
});

const rejectInput = JSON.stringify({
  source_event_id: "operator:reject:1001",
  lead_id: LEAD_ID,
  lead_qualified_event_id: EVENT_ID,
  label: "LEAD_OUTCOME_REJECTED",
  reason_code: "NOT_ICP",
  occurred_at: "2026-08-07T12:00:00.000Z",
  source_system: "quality-label-operator",
});

const validLeadQualified = {
  event_id: EVENT_ID,
  event_type: "LeadQualified",
  schema_version: 1,
  workspace_id: WORKSPACE_ID,
  aggregate_type: "Lead",
  aggregate_id: LEAD_ID,
  occurred_at: "2026-08-07T11:00:00.000Z",
  producer: "global-backend",
  correlation_id: null,
  causation_id: null,
  privacy_classification: "CONFIDENTIAL",
  payload: {
    snapshot_version: 1,
    lead_id: LEAD_ID,
    workspace_id: WORKSPACE_ID,
    icp_id: "33333333-3333-4333-8333-333333333333",
    icp_version: 1,
    company_ref: {
      canonical_company_id: "44444444-4444-4444-8444-444444444444",
      name: "Example Co",
      domain: "example.com",
      country: "DE",
      identifiers: { lei: null, fda_reg: null },
    },
    contact_refs: [],
    scores: {
      fit: 1,
      role: 0,
      intent: 0,
      demand_proof: null,
      reachability: 0,
      data_quality: 1,
      engagement: 0,
      total: 0.5,
    },
    fit_verdict: "match",
    evidence_refs: {
      score_detail_available: true,
      fit_reasons_available: true,
    },
    qualification_rule_version: "additive-6dim-v2",
    storage_rights_decision: "ALLOW",
    personal_data_class: "company_facts_only",
    suppression_state: "none",
    recommended_action: "handoff_to_campaign",
    valid_until: null,
    sanctions_screening: {
      status: "not_screened",
      screened_at: null,
      list_versions: {},
    },
  },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestDigest(input = qgoInput): string {
  return createHash("sha256")
    .update(
      canonical({ envelope: validLeadQualified, label: JSON.parse(input) }),
    )
    .digest("hex");
}

function labelResponse(input = qgoInput, replayed = false) {
  const parsed = JSON.parse(input) as Record<string, unknown>;
  return {
    data: {
      id: "55555555-5555-4555-8555-555555555555",
      source_event_id: parsed.source_event_id,
      lead_id: parsed.lead_id,
      lead_qualified_event_id: parsed.lead_qualified_event_id,
      label: parsed.label,
      occurred_at: parsed.occurred_at,
      source_system: parsed.source_system,
      external_object_ref: parsed.external_object_ref ?? null,
      reason_code: parsed.reason_code ?? null,
      commercial_result: parsed.commercial_result ?? null,
      disposition: "ACCEPTED",
      held_reason: null,
      ingested_at: "2026-08-07T12:00:01.000Z",
      replayed,
    },
  };
}

const ackResponse = (outcome: "ACKED_NOW" | "ALREADY_ACKED" = "ACKED_NOW") => ({
  data: {
    acked: outcome === "ACKED_NOW" ? 1 : 0,
    results: [{ event_id: EVENT_ID, outcome }],
  },
});

const labelArgs = (action: "qgo" | "reject", execute = false) => [
  action,
  "--input",
  "label.json",
  "--event-envelope",
  "event.json",
  ...(execute ? ["--execute"] : []),
];

class MemoryStateStore implements LeadQualityLabelOperatorStateStore {
  readonly records = new Map<string, LeadQualityLabelOperatorState>();
  readonly writes: LeadQualityLabelOperatorState[] = [];
  readonly lockEvents: string[] = [];

  get(eventId: string): LeadQualityLabelOperatorState | null {
    return this.records.get(eventId) ?? null;
  }

  set(state: LeadQualityLabelOperatorState): void {
    this.records.set(state.eventId, state);
    this.writes.push(state);
  }

  async withEventLock<T>(_eventId: string, work: () => Promise<T>): Promise<T> {
    this.lockEvents.push(_eventId);
    return work();
  }
}

function io() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function deps(
  fetchImpl: typeof fetch,
  stateStore = new MemoryStateStore(),
  input = qgoInput,
) {
  const output = io();
  return {
    output,
    stateStore,
    value: {
      env: {
        GLOBAL_API_BASE_URL: "https://api.example.test",
        GLOBAL_API_BEARER_TOKEN: FAKE_BEARER,
      },
      fetchImpl,
      stateStore,
      readFileText: (path: string) =>
        path === "event.json" ? JSON.stringify(validLeadQualified) : input,
      write: output.write,
    },
  };
}

describe("lead-quality-label operator CLI", () => {
  it("defaults qgo/reject to dry-run with zero network and zero state writes, while redacting identifiers", async () => {
    const fetchImpl = vi.fn();
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo"), h.value),
    ).resolves.toBe(0);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.stateStore.writes).toHaveLength(0);
    expect(h.output.lines.join("\n")).toContain("DRY_RUN");
    expect(h.output.lines.join("\n")).not.toContain(LEAD_ID);
    expect(h.output.lines.join("\n")).not.toContain(EVENT_ID);
  });

  it("pulls only LeadQualified, validates envelope/payload, and reports durable dedupe state without raw data", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [validLeadQualified],
            page: { next_cursor: "11", has_more: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const state = new MemoryStateStore();
    state.set({
      eventId: EVENT_ID,
      status: "ACKED",
      label: "QGO_CREATED",
      labelReceiptId: "55555555-5555-4555-8555-555555555555",
      labelPostedAt: "2026-08-07T12:00:00.000Z",
      ackedAt: "2026-08-07T12:00:01.000Z",
      ackOutcome: "ACKED_NOW",
      requestDigest: requestDigest(),
      updatedAt: "2026-08-07T12:00:01.000Z",
    });
    state.writes.length = 0;
    const h = deps(fetchImpl as unknown as typeof fetch, state);

    await expect(runLeadQualityLabelOperator(["pull"], h.value)).resolves.toBe(
      0,
    );

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/api/v1/events?type=LeadQualified",
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: `Bearer ${FAKE_BEARER}` },
      signal: expect.any(AbortSignal),
    });
    const rendered = h.output.lines.join("\n");
    expect(rendered).toContain("schema_valid");
    expect(rendered).toContain("ACKED");
    expect(rendered).not.toContain(LEAD_ID);
    expect(rendered).not.toContain(EVENT_ID);
    expect(rendered).not.toContain(FAKE_BEARER);
    expect(rendered).not.toContain("Example Co");
    expect(state.writes).toHaveLength(0);
  });

  it("qgo POST success/replay durably records LABEL_POSTED before ACK, then records ACKED", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(labelResponse()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ackResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), h.value),
    ).resolves.toBe(0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.stateStore.lockEvents).toEqual([EVENT_ID]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/api/v1/lead-quality-labels",
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      "/api/v1/events/ack",
    );
    expect(h.stateStore.writes.map((entry) => entry.status)).toEqual([
      "LABEL_POSTED",
      "ACKED",
    ]);
    expect(h.output.lines.join("\n")).not.toContain(FAKE_BEARER);
    expect(h.output.lines.join("\n")).not.toContain(EVENT_ID);
  });

  it("reject action requires a rejection input/reason and follows the same POST-then-ACK state machine", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(labelResponse(rejectInput, true)), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ackResponse("ALREADY_ACKED")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const h = deps(
      fetchImpl as unknown as typeof fetch,
      new MemoryStateStore(),
      rejectInput,
    );

    await expect(
      runLeadQualityLabelOperator(labelArgs("reject", true), h.value),
    ).resolves.toBe(0);
    expect(h.stateStore.writes.at(-1)?.status).toBe("ACKED");

    const wrong = deps(
      vi.fn() as unknown as typeof fetch,
      new MemoryStateStore(),
      qgoInput,
    );
    await expect(
      runLeadQualityLabelOperator(labelArgs("reject", true), wrong.value),
    ).rejects.toThrow(/reject/i);
    expect(wrong.stateStore.writes).toHaveLength(0);
  });

  it("does not ACK or advance state when POST fails; defer also performs no network/state change", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "CONFLICT", message: "conflict" } }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), h.value),
    ).rejects.toThrow(/label post failed/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(h.stateStore.writes).toHaveLength(0);

    fetchImpl.mockClear();
    await expect(
      runLeadQualityLabelOperator(
        ["defer", "--event-id", EVENT_ID, "--execute"],
        h.value,
      ),
    ).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.stateStore.writes).toHaveLength(0);
  });

  it("keeps LABEL_POSTED after ACK failure and retry-ack is gated to that durable state", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(labelResponse()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ackResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), h.value),
    ).rejects.toThrow(/ack failed/i);
    expect(h.stateStore.records.get(EVENT_ID)?.status).toBe("LABEL_POSTED");

    await expect(
      runLeadQualityLabelOperator(
        ["retry-ack", "--event-id", EVENT_ID, "--execute"],
        h.value,
      ),
    ).resolves.toBe(0);
    expect(h.stateStore.records.get(EVENT_ID)?.status).toBe("ACKED");

    const pending = deps(vi.fn() as unknown as typeof fetch);
    await expect(
      runLeadQualityLabelOperator(
        ["retry-ack", "--event-id", EVENT_ID, "--execute"],
        pending.value,
      ),
    ).rejects.toThrow(/LABEL_POSTED/);
  });

  it("deduplicates an ACKED event across restarts and never repeats POST", async () => {
    const state = new MemoryStateStore();
    state.set({
      eventId: EVENT_ID,
      status: "ACKED",
      label: "QGO_CREATED",
      labelReceiptId: "55555555-5555-4555-8555-555555555555",
      labelPostedAt: "2026-08-07T12:00:00.000Z",
      ackedAt: "2026-08-07T12:00:01.000Z",
      ackOutcome: "ACKED_NOW",
      requestDigest: requestDigest(),
      updatedAt: "2026-08-07T12:00:01.000Z",
    });
    state.writes.length = 0;
    const fetchImpl = vi.fn();
    const h = deps(fetchImpl as unknown as typeof fetch, state);

    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), h.value),
    ).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
    expect(h.output.lines.join("\n")).toContain("ACKED");
  });

  it("rejects unsafe base URLs and oversized responses without echoing token/response body", async () => {
    const bodyMarker = ["private", "response", "marker"].join("-");
    const fetchImpl = vi.fn(
      async () => new Response(bodyMarker.repeat(400_000), { status: 200 }),
    );
    const output = io();
    await expect(
      runLeadQualityLabelOperator(["pull"], {
        env: {
          GLOBAL_API_BASE_URL: "http://api.example.test",
          GLOBAL_API_BEARER_TOKEN: FAKE_BEARER,
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stateStore: new MemoryStateStore(),
        readFileText: () => "",
        write: output.write,
      }),
    ).rejects.toThrow(/https/i);
    await expect(
      runLeadQualityLabelOperator(["pull"], {
        env: {
          GLOBAL_API_BASE_URL: "https://user@api.example.test",
          GLOBAL_API_BEARER_TOKEN: FAKE_BEARER,
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stateStore: new MemoryStateStore(),
        readFileText: () => "",
        write: output.write,
      }),
    ).rejects.toThrow(/userinfo/i);

    await expect(
      runLeadQualityLabelOperator(["pull"], {
        env: {
          GLOBAL_API_BASE_URL: "https://api.example.test",
          GLOBAL_API_BEARER_TOKEN: FAKE_BEARER,
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stateStore: new MemoryStateStore(),
        readFileText: () => "",
        write: output.write,
      }),
    ).rejects.toThrow(/response.*limit/i);
    expect(output.lines.join("\n")).not.toContain(FAKE_BEARER);
    expect(output.lines.join("\n")).not.toContain(bodyMarker);
  });

  it("fails closed on an invalid LeadQualified payload without ACK", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                ...validLeadQualified,
                payload: { snapshot_version: 1, lead_id: LEAD_ID },
              },
            ],
            page: { next_cursor: "11", has_more: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(["pull"], h.value),
    ).rejects.toThrow(/schema/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(h.stateStore.writes).toHaveLength(0);
  });

  it("fails closed on malformed event-page metadata instead of hiding pagination", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [validLeadQualified],
            page: { next_cursor: 42, has_more: "yes" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(["pull"], h.value),
    ).rejects.toThrow(/page response schema/i);
    expect(h.stateStore.writes).toHaveLength(0);
  });

  it("requires a checkpoint cursor whenever a non-empty terminal page is returned", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [validLeadQualified],
            page: { next_cursor: null, has_more: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(["pull"], h.value),
    ).rejects.toThrow(/page response schema/i);
  });

  it("fails closed when the LeadQualified envelope and payload identities are cross-wired", async () => {
    for (const candidate of [
      {
        ...validLeadQualified,
        payload: {
          ...validLeadQualified.payload,
          lead_id: "66666666-6666-4666-8666-666666666666",
        },
      },
      {
        ...validLeadQualified,
        payload: {
          ...validLeadQualified.payload,
          workspace_id: "77777777-7777-4777-8777-777777777777",
        },
      },
    ]) {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [candidate],
              page: { next_cursor: "11", has_more: false },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const h = deps(fetchImpl as unknown as typeof fetch);

      await expect(
        runLeadQualityLabelOperator(["pull"], h.value),
      ).rejects.toThrow(/binding/i);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(h.stateStore.writes).toHaveLength(0);
    }
  });

  it("does not persist or ACK an invalid label receipt returned by the API", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { id: "not-a-uuid", replayed: false },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const h = deps(fetchImpl as unknown as typeof fetch);

    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), h.value),
    ).rejects.toThrow(/response schema/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(h.stateStore.writes).toHaveLength(0);
  });

  it("requires and validates the exact full LeadQualified envelope before POST or ACK", async () => {
    const fetchImpl = vi.fn();
    const h = deps(fetchImpl as unknown as typeof fetch);
    await expect(
      runLeadQualityLabelOperator(
        ["qgo", "--input", "label.json", "--execute"],
        h.value,
      ),
    ).rejects.toThrow(/event-envelope|required/i);

    const mismatched = {
      ...h.value,
      readFileText: (path: string) =>
        path === "event.json"
          ? JSON.stringify({
              ...validLeadQualified,
              event_id: "99999999-9999-4999-8999-999999999999",
            })
          : qgoInput,
    };
    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), mismatched),
    ).rejects.toThrow(/binding/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a UUID-only receipt and preserves LABEL_POSTED on non-acknowledging ACK outcomes", async () => {
    const sparse = deps(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: "55555555-5555-4555-8555-555555555555",
                replayed: false,
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      ) as unknown as typeof fetch,
    );
    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), sparse.value),
    ).rejects.toThrow(/response schema/i);
    expect(sparse.stateStore.writes).toHaveLength(0);

    const notDeliveredFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(labelResponse()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              acked: 0,
              results: [{ event_id: EVENT_ID, outcome: "NOT_DELIVERED" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const held = deps(notDeliveredFetch as unknown as typeof fetch);
    await expect(
      runLeadQualityLabelOperator(labelArgs("qgo", true), held.value),
    ).rejects.toThrow(/NOT_DELIVERED/);
    expect(held.stateStore.records.get(EVENT_ID)?.status).toBe("LABEL_POSTED");
  });
});

describe("FileLeadQualityLabelOperatorStateStore", () => {
  it("persists only minimal state via a 0600 file in a 0700 directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lead-label-state-"));
    const directory = join(root, "private");
    const path = join(directory, "state.json");
    const store = new FileLeadQualityLabelOperatorStateStore(path);
    store.set({
      eventId: EVENT_ID,
      status: "LABEL_POSTED",
      label: "QGO_CREATED",
      labelReceiptId: "55555555-5555-4555-8555-555555555555",
      labelPostedAt: "2026-08-07T12:00:00.000Z",
      ackedAt: null,
      ackOutcome: null,
      requestDigest: FIXED_DIGEST,
      updatedAt: "2026-08-07T12:00:00.000Z",
    });

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).toContain(EVENT_ID);
    expect(persisted).not.toContain(FAKE_BEARER);
    expect(persisted).not.toContain("Example Co");
    expect(JSON.parse(persisted)).toEqual({
      version: 2,
      events: {
        [EVENT_ID]: expect.objectContaining({ status: "LABEL_POSTED" }),
      },
    });
  });

  it("never chmods an arbitrary existing parent directory and rejects non-0700 parents", () => {
    const parent = tmpdir();
    const modeBefore = statSync(parent).mode & 0o777;
    const store = new FileLeadQualityLabelOperatorStateStore(
      join(parent, `lead-label-unsafe-parent-${process.pid}.json`),
    );
    expect(() =>
      store.set({
        eventId: EVENT_ID,
        status: "LABEL_POSTED",
        label: "QGO_CREATED",
        labelReceiptId: "55555555-5555-4555-8555-555555555555",
        labelPostedAt: "2026-08-07T12:00:00.000Z",
        ackedAt: null,
        ackOutcome: null,
        requestDigest: FIXED_DIGEST,
        updatedAt: "2026-08-07T12:00:00.000Z",
      }),
    ).toThrow(/0700/);
    expect(statSync(parent).mode & 0o777).toBe(modeBefore);
  });

  it("allows only PENDING -> LABEL_POSTED -> ACKED and rejects a concurrent lock", () => {
    const root = mkdtempSync(join(tmpdir(), "lead-label-transition-"));
    const path = join(root, "private", "state.json");
    const store = new FileLeadQualityLabelOperatorStateStore(path);
    const posted: LeadQualityLabelOperatorState = {
      eventId: EVENT_ID,
      status: "LABEL_POSTED",
      label: "QGO_CREATED",
      labelReceiptId: "55555555-5555-4555-8555-555555555555",
      labelPostedAt: "2026-08-07T12:00:00.000Z",
      ackedAt: null,
      ackOutcome: null,
      requestDigest: FIXED_DIGEST,
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    store.set(posted);
    expect(() => store.set(posted)).toThrow(/LABEL_POSTED to ACKED/);

    writeFileSync(`${path}.lock`, "occupied\n", { mode: 0o600 });
    expect(() =>
      store.set({
        ...posted,
        status: "ACKED",
        ackedAt: "2026-08-07T12:00:01.000Z",
        ackOutcome: "ACKED_NOW",
        updatedAt: "2026-08-07T12:00:01.000Z",
      }),
    ).toThrow(/locked/);
  });

  it("persists the one allowed LABEL_POSTED -> ACKED transition without rewriting its receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "lead-label-acked-"));
    const path = join(root, "private", "state.json");
    const store = new FileLeadQualityLabelOperatorStateStore(path);
    const posted: LeadQualityLabelOperatorState = {
      eventId: EVENT_ID,
      status: "LABEL_POSTED",
      label: "QGO_CREATED",
      labelReceiptId: "55555555-5555-4555-8555-555555555555",
      labelPostedAt: "2026-08-07T12:00:00.000Z",
      ackedAt: null,
      ackOutcome: null,
      requestDigest: FIXED_DIGEST,
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    store.set(posted);
    store.set({
      ...posted,
      status: "ACKED",
      ackedAt: "2026-08-07T12:00:01.000Z",
      ackOutcome: "ACKED_NOW",
      updatedAt: "2026-08-07T12:00:01.000Z",
    });

    expect(store.get(EVENT_ID)).toMatchObject({
      status: "ACKED",
      labelReceiptId: posted.labelReceiptId,
      labelPostedAt: posted.labelPostedAt,
    });
    expect(() =>
      store.set({
        ...posted,
        status: "ACKED",
        ackedAt: "2026-08-07T12:00:02.000Z",
        ackOutcome: "ACKED_NOW",
        updatedAt: "2026-08-07T12:00:02.000Z",
      }),
    ).toThrow(/LABEL_POSTED to ACKED/);
  });

  it("fails closed before parsing an oversized state file", () => {
    const root = mkdtempSync(join(tmpdir(), "lead-label-oversized-"));
    const directory = join(root, "private");
    const path = join(directory, "state.json");
    const store = new FileLeadQualityLabelOperatorStateStore(path);
    store.set({
      eventId: EVENT_ID,
      status: "LABEL_POSTED",
      label: "QGO_CREATED",
      labelReceiptId: "55555555-5555-4555-8555-555555555555",
      labelPostedAt: "2026-08-07T12:00:00.000Z",
      ackedAt: null,
      ackOutcome: null,
      requestDigest: FIXED_DIGEST,
      updatedAt: "2026-08-07T12:00:00.000Z",
    });
    writeFileSync(path, "x".repeat(1_048_577), { mode: 0o600 });
    expect(() => store.get(EVENT_ID)).toThrow(/size limit/);
  });

  it("rejects malformed persisted receipts and impossible LABEL_POSTED state", () => {
    const root = mkdtempSync(join(tmpdir(), "lead-label-invalid-state-"));
    const path = join(root, "private", "state.json");
    const store = new FileLeadQualityLabelOperatorStateStore(path);

    expect(() =>
      store.set({
        eventId: EVENT_ID,
        status: "LABEL_POSTED",
        label: "QGO_CREATED",
        labelReceiptId: "receipt\nforged",
        labelPostedAt: "2026-08-07T12:00:00.000Z",
        ackedAt: null,
        ackOutcome: null,
        requestDigest: FIXED_DIGEST,
        updatedAt: "2026-08-07T12:00:00.000Z",
      }),
    ).toThrow(/invalid/);

    expect(() =>
      store.set({
        eventId: EVENT_ID,
        status: "LABEL_POSTED",
        label: "QGO_CREATED",
        labelReceiptId: "55555555-5555-4555-8555-555555555555",
        labelPostedAt: "2026-08-07T12:00:00.000Z",
        ackedAt: "2026-08-07T12:00:01.000Z",
        ackOutcome: null,
        requestDigest: FIXED_DIGEST,
        updatedAt: "2026-08-07T12:00:01.000Z",
      }),
    ).toThrow(/invalid/);
  });

  it("holds an event-scoped cross-process lock for the entire async operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lead-label-operation-lock-"));
    const path = join(root, "private", "state.json");
    const first = new FileLeadQualityLabelOperatorStateStore(path);
    const second = new FileLeadQualityLabelOperatorStateStore(path);
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = first.withEventLock(EVENT_ID, async () => {
      entered();
      await releasePromise;
    });
    await enteredPromise;
    await expect(
      second.withEventLock(EVENT_ID, async () => undefined),
    ).rejects.toThrow(/locked/);
    release();
    await running;
    await expect(
      second.withEventLock(EVENT_ID, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("recovers only an attested stale event lock and leaves malformed locks fail-closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lead-label-stale-lock-"));
    const path = join(root, "private", "state.json");
    const store = new FileLeadQualityLabelOperatorStateStore(path);
    const posted: LeadQualityLabelOperatorState = {
      eventId: EVENT_ID,
      status: "LABEL_POSTED",
      label: "QGO_CREATED",
      labelReceiptId: "55555555-5555-4555-8555-555555555555",
      labelPostedAt: "2026-08-07T12:00:00.000Z",
      ackedAt: null,
      ackOutcome: null,
      requestDigest: FIXED_DIGEST,
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    store.set(posted);
    const lockPath = `${path}.${EVENT_ID}.operation.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        startTime: "1",
        purpose: "event-operation",
        createdAt: "2026-08-07T12:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      store.withEventLock(EVENT_ID, async () => "recovered"),
    ).resolves.toBe("recovered");

    writeFileSync(lockPath, "malformed\n", { mode: 0o600 });
    await expect(
      store.withEventLock(EVENT_ID, async () => "unsafe"),
    ).rejects.toThrow(/locked/);
  });
});
