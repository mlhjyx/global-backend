# Typed Projection Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every first-wave small managed Model/Tool output a closed, bounded, versioned projector/restorer that can be safely persisted and replayed.

**Architecture:** A central registry owns discriminated durable-result declarations. Each typed schema has an AJV boundary plus an explicit projector and restorer; Provider wire output is projected into the minimum domain-write shape, canonicalized and byte-checked before settlement. ModelGateway and ToolBroker reference a schema ID rather than accepting arbitrary callback projections from product call sites.

**Tech Stack:** TypeScript, AJV 8, canonical JSON SHA-256, NestJS, PostgreSQL JSONB, Vitest.

**Spec:** `docs/architecture/execution-budget-authority-artifact-replay-design.md`

## Global Constraints

- Every physical managed Model/Tool declares exactly one strategy: `typed_projection`, `artifact_reference`, or `no_physical_call`.
- Typed objects are closed; every string has `maxLength`; every array has `maxItems`; every number has an explicit integer/decimal-string/range contract.
- Unknown fields, open `Record<string, unknown>`, prompt/reasoning/raw response/evidence bodies and unrestricted attributes are rejected.
- The projected envelope is at most 120 KiB in the application and at most 128 KiB as PostgreSQL JSONB text.
- Projection validation runs before a physical Model call where an output JSON Schema is available and again after the Provider returns.
- Projection failure after a physical call leaves the operation unresolved and never permits fallback or a second wire.
- Strategy/schema selection is independent of environment.

---

## File Structure

**Create:**

- `apps/api/src/durable-results/durable-result-strategy.ts` — discriminated strategy and schema IDs.
- `apps/api/src/durable-results/typed-projection.types.ts` — registry/projector/restorer interfaces.
- `apps/api/src/durable-results/typed-projection.registry.ts` — immutable registry, AJV compilation and byte checks.
- `apps/api/src/durable-results/model-result-projections.ts` — ICP, Understanding, Taxonomy and Fit schemas/projectors.
- `apps/api/src/durable-results/source-result-projections.ts` — TED, OpenFDA, SAM and SMTP schemas/projectors.
- `apps/api/src/durable-results/catalog-result-projections.ts` — remaining structured search/registry/geodata/patent/trade-fair schemas/projectors.
- `apps/api/src/durable-results/*.spec.ts` — boundary, maximum-size, restore and mutation tests.

**Modify:**

- `apps/api/src/tools/tool-contract.ts` — mandatory `durableResultStrategy` and removal of callback-shaped authorization semantics.
- `apps/api/src/tools/tool-registry.ts` — reject missing/inconsistent strategies at registration.
- `apps/api/src/tools/tool-broker.ts` — project/restore through registry.
- `apps/api/src/tools/source-tools.ts` and `apps/api/src/tools/builtin-tools.ts` — declare schema IDs.
- `apps/api/src/model-gateway/types.ts` — replace `genericReplay` callbacks with `durableResultSchema`.
- `apps/api/src/model-gateway/router-model-gateway.ts` — registry projection/restore and no-fallback failure semantics.
- `apps/api/src/icp/icp-budget-execution.ts`, `apps/api/src/temporal/understanding.activities.ts`, `apps/api/src/discovery/taxonomy-resolver.ts`, `apps/api/src/discovery/fit-judge.ts`, `apps/api/src/discovery/providers/email-verify.provider.ts` — bind approved schema IDs.
- Corresponding existing specs plus new registry tests.

## Locked Interfaces

```ts
export type TypedProjectionSchema =
  | "icp-design/v1"
  | "icp-query-plan/v1"
  | "understanding-claims/v1"
  | "understanding-profile/v1"
  | "understanding-offerings/v1"
  | "taxonomy-code/v1"
  | "fit-judgment/v1"
  | "discovery-extract-company/v1"
  | "discovery-extract-list/v1"
  | "contact-decision-makers/v1"
  | "ted-search/v1"
  | "openfda-search/v1"
  | "samgov-search/v1"
  | "smtp-probe-verdict/v1"
  | "searxng-search/v1"
  | "wikidata-sparql/v1"
  | "osm-overpass/v1"
  | "wikidata-entity/v1"
  | "gleif-fetch/v1"
  | "companies-house-search/v1"
  | "inpi-rne-search/v1"
  | "google-patents-search/v1"
  | "tradefair-algolia/v1"
  | "mapyourshow-fetch/v1";

export interface TypedProjectionDefinition<Raw, Projected> {
  readonly schema: TypedProjectionSchema;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  project(raw: Raw): Projected;
  restore(projected: Projected): Raw;
}

export interface TypedProjectionEnvelope {
  schemaVersion: "generic-operation-projection/v2";
  schema: TypedProjectionSchema;
  digest: string;
  data: unknown;
}
```

### Task 1: Strategy and registry foundation

**Files:**

- Create: `apps/api/src/durable-results/durable-result-strategy.ts`
- Create: `apps/api/src/durable-results/typed-projection.types.ts`
- Create: `apps/api/src/durable-results/typed-projection.registry.ts`
- Test: `apps/api/src/durable-results/typed-projection.registry.spec.ts`

**Interfaces:**

- Consumes: existing canonical generic projection digest behavior.
- Produces: `DurableResultStrategy`, `TypedProjectionRegistry.register/project/restore`, `TypedProjectionEnvelope`.

- [ ] **Step 1: Write RED registry boundary tests**

```ts
registry.register(definition);
expect(() => registry.register(definition)).toThrow(
  "DURABLE_RESULT_SCHEMA_DUPLICATE",
);
expect(() =>
  registry.project("taxonomy-code/v1", { code: "A", unexpected: true }),
).toThrow("TYPED_PROJECTION_INVALID");
expect(
  Buffer.byteLength(JSON.stringify(maxProjected), "utf8"),
).toBeLessThanOrEqual(120 * 1024);
```

Also test canonical digest stability across object insertion order and rejection at 120 KiB + 1 byte.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/durable-results/typed-projection.registry.spec.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement immutable registry and two byte gates**

Compile each JSON Schema once with AJV `{allErrors:true, strict:true}`. Freeze registrations after module bootstrap. `project` calls the explicit projector, AJV-validates the result, canonicalizes it, enforces 120 KiB and returns a new frozen envelope. `restore` validates the stored envelope, recalculates digest, invokes the restorer and does not mutate stored data.

Add a PostgreSQL integration helper that executes `SELECT octet_length($1::jsonb::text)` against the projected envelope and rejects over 128 KiB in real-DB tests.

- [ ] **Step 4: Run GREEN and coverage**

Run: `pnpm --filter @global/api test -- src/durable-results/typed-projection.registry.spec.ts --coverage`

Expected: PASS with registry changed statements/branches >=80%.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results
git commit -m "feat(replay): add typed projection registry"
```

### Task 2: Closed projections for all ten non-Site-Builder Model tasks

**Files:**

- Create: `apps/api/src/durable-results/model-result-projections.ts`
- Test: `apps/api/src/durable-results/model-result-projections.spec.ts`
- Modify: `apps/api/src/icp/icp-budget-execution.ts`
- Modify: `apps/api/src/icp/icp-budget-execution.spec.ts`
- Modify: `apps/api/src/temporal/understanding.activities.ts`
- Modify: `apps/api/src/temporal/understanding.activities.spec.ts`
- Modify: `apps/api/src/discovery/taxonomy-resolver.ts`
- Modify: `apps/api/src/discovery/taxonomy-resolver.spec.ts`
- Modify: `apps/api/src/discovery/fit-judge.ts`
- Modify: `apps/api/src/discovery/fit-judge.spec.ts`
- Modify: `apps/api/src/discovery/providers/public-web.provider.ts` and specs.
- Modify: `apps/api/src/discovery/providers/directory.provider.ts` and specs.
- Modify: `apps/api/src/discovery/providers/decision-maker.provider.ts` and specs.
- Modify: `apps/api/src/ai-tasks/task-registry.ts` and contract tests.

**Interfaces:**

- Consumes: Task 1 registry.
- Produces: all ten non-Site-Builder model-side schema definitions and call-site schema IDs.

- [ ] **Step 1: Write RED maximum-boundary and unknown-field tests**

For each schema create one maximum legal fixture and mutations for maxLength + 1, maxItems + 1, unknown root field, unknown nested field and non-canonical number. Lock these bounds:

```text
icp-design: name 200; summary/value strings 2000; buyerRoles 32; rules 64; each rule field/operator/value strings 200/80/1000
icp-query-plan: queries 64; rationale 4000; sourceClass 80; keywords 32 x 200; filter entries represented by a closed 32-item key/value array
understanding-claims: pages 64; claims/page 64; statement 4000; evidence excerpt 2000; no raw page body
understanding-profile: name 500; description 8000; markets/industries 64 x 300; no open attributes
understanding-offerings: offerings 128; name 500; description 4000; categories 32 x 300
taxonomy-code: code 80; provider/model 120; no catalog or prompt
fit-judgment: verdict enum; reasons 16 x 1000; provider/model 120; no prompt or full ICP/company input
discovery-extract-company: companies 64; domain/name/location/industry strings bounded; evidence is a bounded source reference/excerpt, never raw page body
discovery-extract-list: companies 128 with the same closed company shape; no open attributes
contact-decision-makers: people 64; name/title/source reference bounded; email/phone only where the existing privacy contract permits and each field has a hard bound
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/durable-results/model-result-projections.spec.ts src/icp/icp-budget-execution.spec.ts src/temporal/understanding.activities.spec.ts src/discovery/taxonomy-resolver.spec.ts src/discovery/fit-judge.spec.ts src/discovery/providers/public-web.provider.spec.ts src/discovery/providers/directory.provider.spec.ts src/discovery/providers/decision-maker.provider.spec.ts`

Expected: FAIL because current JSON-string callbacks accept unbounded shapes.

- [ ] **Step 3: Implement explicit projectors and bind schema IDs**

Projectors must construct new objects field-by-field. Replace callback contexts with:

```ts
{
  workspaceId,
  runId: accountKey,
  durableResultSchema: 'icp-design/v1',
}
```

Never use `JSON.stringify(result.data)` as the projection shape. Restorers reconstruct only the `ModelResult.data`, provider and model fields required by the existing domain path.

Also tighten every provider-facing Task output schema in `task-registry.ts`: root and nested objects use `additionalProperties:false`; every string/array/number carries the same or tighter bounds than its durable projection. This pre-wire contract prevents paying for output that can never be persisted.

- [ ] **Step 4: Run GREEN and real JSONB boundary test**

Run the focused tests, then the real-PostgreSQL envelope-size test. Expected: every maximum legal fixture is <=120 KiB application bytes and <=128 KiB PostgreSQL bytes; every mutation fails before settlement.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/model-result-projections.ts apps/api/src/durable-results/model-result-projections.spec.ts apps/api/src/icp apps/api/src/temporal/understanding.activities.ts apps/api/src/temporal/understanding.activities.spec.ts apps/api/src/discovery/taxonomy-resolver.ts apps/api/src/discovery/taxonomy-resolver.spec.ts apps/api/src/discovery/fit-judge.ts apps/api/src/discovery/fit-judge.spec.ts apps/api/src/discovery/providers apps/api/src/ai-tasks/task-registry.ts
git commit -m "feat(replay): bound model result projections"
```

### Task 3: Closed TED, OpenFDA, SAM and SMTP projections

**Files:**

- Create: `apps/api/src/durable-results/source-result-projections.ts`
- Test: `apps/api/src/durable-results/source-result-projections.spec.ts`
- Modify: `apps/api/src/tools/source-tools.ts`
- Modify: `apps/api/src/tools/source-tools-replay.spec.ts`
- Modify: `apps/api/src/tools/builtin-tools.ts`
- Modify: `apps/api/src/tools/builtin-tools.spec.ts`
- Modify: `apps/api/src/discovery/providers/email-verify.provider.ts`
- Modify: `apps/api/src/discovery/providers/email-verify.provider.spec.ts`

**Interfaces:**

- Consumes: Task 1 registry.
- Produces: four source-side schema definitions and declarations.

- [ ] **Step 1: Write RED leaf-bound tests**

Lock arrays and every nested string instead of only slicing top-level result counts:

```text
TED: awards 32, notices 32, winners 32, CPV/buyer/country/deadline arrays 64; identifiers/URLs/names 500; titles/descriptions 4000
OpenFDA: establishments/clearances 12; deviceFacts as a closed array of at most 64 {key<=120,value<=1000}; all names/IDs 500
SAM: notices 32; title 2000; department/office/codes 500; link 2048
SMTP: verdict enum, reason code enum, domain 253, evidence code 120; never persist the probed personal email address or random catch-all local part
```

Assert a single 64 KiB leaf and unknown `accessToken`, `responseBody`, `cookie`, `prompt` and `attributes` fields fail.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/durable-results/source-result-projections.spec.ts src/tools/source-tools-replay.spec.ts src/tools/builtin-tools.spec.ts src/discovery/providers/email-verify.provider.spec.ts`

Expected: FAIL because current callback projections do not enforce all leaf bounds.

- [ ] **Step 3: Implement source projectors and declarations**

Replace each `durableReplayResult` callback with `durableResultStrategy: {kind:'typed_projection', schema:'.../v1'}`. Put all field selection in `source-result-projections.ts`; Tool definitions must not carry a second projection implementation.

- [ ] **Step 4: Run GREEN and provider regressions**

Run focused projection tests plus TED/OpenFDA/SAM provider specs and SMTP double-invocation replay regression. Expected: retry restores the exact typed result and Provider/SMTP execute counts remain one.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/source-result-projections.ts apps/api/src/durable-results/source-result-projections.spec.ts apps/api/src/tools/source-tools.ts apps/api/src/tools/source-tools-replay.spec.ts apps/api/src/tools/builtin-tools.ts apps/api/src/tools/builtin-tools.spec.ts apps/api/src/discovery/providers/email-verify.provider.ts apps/api/src/discovery/providers/email-verify.provider.spec.ts
git commit -m "feat(replay): bound source result projections"
```

### Task 4: Closed projections for the remaining ten small Tools

**Files:**

- Create: `apps/api/src/durable-results/catalog-result-projections.ts`
- Test: `apps/api/src/durable-results/catalog-result-projections.spec.ts`
- Modify: `apps/api/src/tools/builtin-tools.ts`, `apps/api/src/tools/source-tools.ts` and their specs.

**Interfaces:**

- Consumes: Task 1 registry.
- Produces: registered projections for every non-artifact Tool not covered by Task 3.

- [ ] **Step 1: Write RED maximum/unknown/privacy-field tests**

Cover `searxng.search`, `wikidata.sparql`, `osm.overpass`, `wikidata.entity`, `gleif.fetch`, `companies_house.search`, `inpi_rne.search`, `google_patents.search`, `tradefair.algolia` and `mapyourshow.fetch`. Derive bounds from each Tool's existing input/output cap, then add explicit maximum lengths/items for every nested field. Assert unknown fields, unrestricted attributes, raw provider response, credentials and personal fields outside the existing data-minimization contract fail.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/durable-results/catalog-result-projections.spec.ts src/tools/builtin-tools.spec.ts src/tools/source-tools-replay.spec.ts`

Expected: FAIL because these Tools lack registered closed projections.

- [ ] **Step 3: Implement field-by-field projectors/restorers**

Keep only data required by current domain consumers. Preserve provider provenance as bounded source URL/digest/parser identifiers; never persist raw bodies. Bind each Tool to the exact schema ID in the locked union.

- [ ] **Step 4: Run GREEN and PostgreSQL envelope-size tests**

Expected: every maximum fixture passes both byte gates; every boundary mutation fails before settle.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/durable-results/catalog-result-projections.ts apps/api/src/durable-results/catalog-result-projections.spec.ts apps/api/src/tools/builtin-tools.ts apps/api/src/tools/builtin-tools.spec.ts apps/api/src/tools/source-tools.ts apps/api/src/tools/source-tools-replay.spec.ts
git commit -m "feat(replay): bound catalog tool projections"
```

### Task 5: Make strategy mandatory in ToolRegistry

**Task-5 artifact policy ruling (approved):** all four first artifact Tools use
`privacyClass: PERSONAL_DATA` and `ttlSeconds: 86400`. `http.get` declares a
normalized `text/plain` body with `maxBytes: 3000000`; `crawl4ai.fetch`
declares the existing PII-scrubbed `text/markdown` representation with
`maxBytes: 300000` UTF-8 bytes; `crawl4ai.render` declares an HTML-only
artifact body with `maxBytes: 3000000`; and `sanctions.download` declares only
`application/xml` or `text/xml` with `maxBytes: 33554432`. The Tool code must
enforce each applicable current output/media boundary before its declaration is
registered; a declaration must never promise an unimplemented cap.

`crawl4ai.render` response headers remain transient first-run data in this task:
`DigitalFootprintProvider` currently uses them for platform detection. They are
explicitly excluded from future artifacts, references and replay payloads. The
Artifact+Broker task may not wire render replay until it either records a
bounded header-derived domain acknowledgement or proves that the current result
can be recomputed from persisted HTML alone. Task 5 does not change that
provider, ToolBroker, Router, settlement, replay or object-store behavior.

**Files:**

- Modify: `apps/api/src/tools/tool-contract.ts`
- Modify: `apps/api/src/tools/tool-registry.ts`
- Modify: `apps/api/src/tools/tool-registry.spec.ts`
- Modify: every product Tool declaration under `apps/api/src/tools/`.

**Interfaces:**

- Consumes: `DurableResultStrategy` and typed schema IDs.
- Produces: product registry completeness; no optional replay callback.

- [ ] **Step 1: Write RED completeness and contradictory-strategy tests**

```ts
expect(() => registry.register(externalToolWithoutStrategy)).toThrow(
  "TOOL_DURABLE_RESULT_STRATEGY_REQUIRED",
);
expect(() => registry.register(externalToolWithNoPhysicalCall)).toThrow(
  "TOOL_DURABLE_RESULT_STRATEGY_INVALID",
);
expect(() =>
  registry.register(localDeterministicToolWithNoPhysicalCall),
).not.toThrow();
```

Add a repository scan test that imports `registerBuiltinTools` and `registerSourceTools`, enumerates all Tools, and asserts exactly one valid strategy and a registered schema/materializer.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/tools/tool-registry.spec.ts`

Expected: FAIL because the field is optional/absent on many Tools.

- [ ] **Step 3: Implement the discriminated field and classify every Tool**

Use typed projection only where the bounded business result fits. Mark `sanctions.download`, `http.get` and Crawl4AI fetch/render as `artifact_reference` with exact byte/media/privacy/TTL declarations from the artifact plan. Use `no_physical_call` only for proven local/deterministic Tools; do not use it for a Tool merely because its price is zero.

- [ ] **Step 4: Run all Tool tests GREEN**

Run: `pnpm --filter @global/api test -- src/tools`

Expected: PASS; no registered external Tool lacks a strategy.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tools
git commit -m "feat(tools): require durable result strategy"
```

### Task 6: Route ModelGateway and ToolBroker through the registry

**Files:**

- Modify: `apps/api/src/model-gateway/types.ts`
- Modify: `apps/api/src/model-gateway/router-model-gateway.ts`
- Modify: `apps/api/src/model-gateway/router-model-gateway.spec.ts`
- Modify: `apps/api/src/tools/tool-broker.ts`
- Modify: `apps/api/src/tools/tool-broker.spec.ts`
- Modify: `apps/api/src/model-gateway/model-gateway.module.ts`

**Interfaces:**

- Consumes: typed registry and mandatory Tool strategy.
- Produces: single projection/restore path for model and tool results.

- [ ] **Step 1: Write RED crash/replay/fallback tests**

Cover:

- Provider returns valid output, projection succeeds, settle ACK is lost, retry restores with one Provider call.
- Provider returns output with an oversized/unknown field, projection fails, operation remains unresolved, fallback Provider call count is zero.
- Stored schema ID differs from current requested schema, replay fails closed without Provider call.
- Tool replay digest or schema mismatch fails without execute/fallback.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/model-gateway/router-model-gateway.spec.ts src/tools/tool-broker.spec.ts`

Expected: FAIL while the old callback path remains.

- [ ] **Step 3: Implement registry-only project/restore**

`AiContext` exposes `durableResultSchema?: TypedProjectionSchema`, not callbacks. Router and Broker resolve definitions from the injected frozen registry, create a v2 envelope, settle it, and verify digest/schema during replay. Once a physical call starts, projection/settlement failure must not continue a fallback chain.

- [ ] **Step 4: Run GREEN and build**

Run: `pnpm --filter @global/api test -- src/model-gateway/router-model-gateway.spec.ts src/tools/tool-broker.spec.ts && pnpm --filter @global/api build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/model-gateway apps/api/src/tools/tool-broker.ts apps/api/src/tools/tool-broker.spec.ts
git commit -m "feat(replay): enforce registered result projection"
```

### Task 7: Typed projection governance and verification

**Files:**

- Create: `scripts/durable-result-strategy-policy.mjs`
- Create: `scripts/durable-result-strategy-policy.spec.mjs`
- Modify: `scripts/governance-verify.mjs`
- Modify: `scripts/governance-contracts.spec.mjs`
- Create: `docs/governance/durable-result-strategies.json`
- Modify: `docs/roadmap/changelog.md`

**Interfaces:**

- Consumes: registry declarations and schemas.
- Produces: machine policy preventing missing strategies, open schemas and environment-selected behavior.

- [ ] **Step 1: Write RED mutation tests**

Fixtures must prove governance fails when a Tool strategy is removed, a schema permits additional properties, a string/array bound is removed, a body/prompt field is added, an environment conditional changes schema/strategy, or the maximum fixture exceeds 120 KiB.

- [ ] **Step 2: Run RED**

Run: `node --test scripts/durable-result-strategy-policy.spec.mjs`

Expected: FAIL because the policy is absent.

- [ ] **Step 3: Implement deterministic policy generation and verification**

Generate a stable registry manifest containing tool/model identifier, strategy, schema, max bytes, privacy class and test path. Verification must compare exact source declarations to the checked-in manifest and reject stale entries; it must not allow migration exceptions for provider, validation, fallback or replay semantics.

- [ ] **Step 4: Run full subproject gates**

```bash
pnpm --filter @global/api build
pnpm --filter @global/api test
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
git diff --check
```

Expected: PASS; changed statements and branches >=80%.

- [ ] **Step 5: Commit**

```bash
git add scripts/durable-result-strategy-policy.mjs scripts/durable-result-strategy-policy.spec.mjs scripts/governance-verify.mjs scripts/governance-contracts.spec.mjs docs/governance/durable-result-strategies.json docs/roadmap/changelog.md
git commit -m "feat(governance): enforce durable result schemas"
```
