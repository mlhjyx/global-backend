# Discovery Query Lineage Successor Admission Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只把 Program B 的唯一 successor/card/writer 作为治理事实合入 current main 并完成独立 G0 readback，不修改任何 Discovery 产品代码。

**Architecture:** PR #424 已把 ADR-025/`DEC-GPP-001` 与旧 mega-branch 的 `NON_DEPLOYABLE / PROVENANCE_ONLY` disposition 合入 `main@c7e39e050b2f30ed9ff155aec139ff206fb850d0`。本计划只登记 `GPP-B-LINEAGE-001` 的 exact branch、worktree、base、零产品代码状态与 ownership scope；card 合入并从 main 独立回读后，另建 post-card current-main worktree 和新的产品实现计划。

**Tech Stack:** Markdown governance、Node.js test runner、Git worktree/PR/CI readback。

**Spec:** [`ADR-025`](../../adr/registry.md)、[`DEC-GPP-001`](../../governance/conflict-register.md)、[`current status`](../../status/current.md) 与用户批准的“开发即生产”能力优先计划。

## Global Constraints

- Exact base is `origin/main@c7e39e050b2f30ed9ff155aec139ff206fb850d0`, the merge result of PR #424.
- Candidate writer is branch `codex/discovery-query-materialization-successor` at `/global/backend/.codex/worktrees/discovery-query-materialization-successor`.
- `codex/production-parity-capability-cutover@91cae351795cceced59893bcf552c2b502a4ebaa` remains `NON_DEPLOYABLE / PROVENANCE_ONLY`; do not base on it, cherry-pick it, run its migration, or copy its PASS evidence.
- Until this card is merged and independently read back from main, G0 remains `HOLD_OWNERSHIP` and no ACK/Raw/Provider/DB/Activity/Workflow implementation may begin.
- This plan has a strict no-product-code boundary: it may change only this plan, `docs/governance/conflict-register.md`, and `scripts/governance-contracts.spec.mjs`.
- No product source, schema, migration, database, Provider/model/tool wire, paid call, service, runtime, deploy, image, GrowthOS, Contact/PII/SMTP, Billing/Credits, RuntimeEvidence or Release Bundle change.

---

### Task 1: Admit and independently read back the unique Program B successor

**Files:**
- Create: `docs/superpowers/plans/2026-08-29-discovery-query-lineage-foundation.md`
- Modify: `docs/governance/conflict-register.md`
- Test: `scripts/governance-contracts.spec.mjs`

**Interfaces:**
- Consumes: current-main ADR-025/`DEC-GPP-001`, exact branch/worktree/base and the old branch disposition.
- Produces: exactly one tracked `GPP-B-LINEAGE-001` card row. It does not produce a TypeScript, SQL, Prisma, Temporal or runtime interface.

- [ ] **Step 1: Write and capture the RED governance test**

  Add this exact row constant to `scripts/governance-contracts.spec.mjs`:

```js
const expectedCard = "| `GPP-B-LINEAGE-001` | `ASSIGNED / ZERO_PRODUCT_CODE / AWAITING_CURRENT_MAIN_READBACK` | `codex/discovery-query-materialization-successor` | `c7e39e050b2f30ed9ff155aec139ff206fb850d0`；仅 Program B ACK identity、index-preserving Raw resolution 与 Provider-owned company lineage。旧 A mega-branch 继续 `NON_DEPLOYABLE / PROVENANCE_ONLY`；本卡进入 current main 并被独立 readback 前 G0 不升级。 |";
```

  Implement `assertUniqueDiscoveryLineageCard(document)` by splitting on `\n`, selecting lines that contain `GPP-B-LINEAGE-001`, and requiring exactly one line equal to `expectedCard`. Test the real conflict register plus negative mutations of state, writer, base, scope and G0 wording. Separately assert this plan contains the exact base, branch, `NON_DEPLOYABLE / PROVENANCE_ONLY`, `DISCOVERY_GOVERNED_LINEAGE_NOT_READY`, and the no-product-code boundary.

- [ ] **Step 2: Run RED**

  Run: `node --test --test-name-pattern='discovery lineage successor' scripts/governance-contracts.spec.mjs`

  Expected: FAIL because the conflict register has no `GPP-B-LINEAGE-001` row.

- [ ] **Step 3: Register the exact zero-code card and run GREEN**

  Add exactly the `expectedCard` row under `BLK-GPP-001`, without changing G0 to PASS. Do not change any product file.

  Run: `node --test --test-name-pattern='discovery lineage successor' scripts/governance-contracts.spec.mjs`

  Run: `pnpm docs:verify && pnpm governance:verify && pnpm code-intelligence:scan && git diff --check`

  Expected: focused PASS; governance 136/136 PASS; docs 0 errors; ContractGraph 0 errors; changed paths are exactly the three files in this task; `runtime_current=0`, `runtime_historical=0`, `release_bundles=0`.

- [ ] **Step 4: Independent review, commit, push, PR and CI**

  Require an independent reviewer to verify: no product code; exact current-main base; one atomic card; old A branch remains provenance-only; G0 remains HOLD; no future product work is executable from this plan. Resolve all Critical/Important findings.

  Run: `git add docs/superpowers/plans/2026-08-29-discovery-query-lineage-foundation.md docs/governance/conflict-register.md scripts/governance-contracts.spec.mjs && git commit -m "docs: assign discovery lineage successor"`

  Push the exact commit, open a PR to `main`, require hosted CI/review to pass, re-read exact base/head and mergeability, then merge only under the user's existing authorization. Do not deploy or delete either branch.

- [ ] **Step 5: Hand off a second governance-only G0 closeout**

  Synchronize the root main with `scripts/governance-main-worktree-sync.mjs` and prove status preservation. Read back the merged card row, ADR-025, `DEC-GPP-001`, `NON_DEPLOYABLE / PROVENANCE_ONLY`, and the exact merge commit from main. Obtain a fresh independent readback verdict, but do not treat that external verdict as durable G0 PASS while main still says `AWAITING_CURRENT_MAIN_READBACK` and `HOLD_OWNERSHIP`.

  From the card-merged main create a separate governance-only branch and plan named `codex/discovery-lineage-g0-closeout`. That closeout must atomically update the card to `ADMITTED / ZERO_PRODUCT_CODE / CURRENT_MAIN_READBACK_PASS`, mark `BLK-GPP-001` resolved with the exact card merge/readback commit, update `docs/status/current.md` G0 to PASS without changing G1–G7, and update the machine test from the awaiting row to the admitted row with the same negative mutations. It must pass independent review, hosted CI, merge and a second current-main readback.

  This admission plan never creates an implementation worktree. Only after current main itself contains the durable G0 PASS closeout may a later implementation plan/worktree begin RED tests for the known P0 gaps: one v3 Domain ACK identity, index-preserving Raw resolution, provider-owned company lineage and the absent A-owned generic governed-relation interface. That later plan must preserve `DISCOVERY_GOVERNED_LINEAGE_NOT_READY` until DB materialization, canonical/terminal outcomes and Temporal replay are separately complete.

## Not authorized by this admission plan

- Creating or editing ACK, Raw, Provider, DB, Prisma, Activity, Workflow or runtime product code.
- Reusing/cherry-picking `6c3ca8a0` through `91cae351` as accepted implementation or evidence.
- Adding a migration before the A-owned generic relation append/read-only-attest interface exists in current main.
- Running a real Provider/model/tool call, paid operation, retained migration, deployment, service restart or Pilot.
