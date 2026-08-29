# Discovery Lineage G0 Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PR #425 已进入 current main 的零代码 Program B successor card 持久回读为 G0 PASS，并保持所有产品实现、G1–G7、runtime 与发布门不变。

**Architecture:** 本计划从 `main@d2c93dd6bea0348381286558896b395c84945171` 开始，只关闭 ownership/provenance 控制面。它原子地把 ownership conflict 转为 `RESOLVED_WITH_REMEDIATION`、关闭 blocker、admit card、更新 current/release-plan 与机器测试；任何 ACK/Raw/Provider/DB/Activity/Workflow 实现都属于后续 G2/G3 计划。

**Tech Stack:** Markdown governance、Node.js test runner、Git worktree/PR/CI readback。

**Spec:** [`ADR-025`](../../adr/registry.md)、[`DEC-GPP-001`](../../governance/conflict-register.md)、[`GPP-B-LINEAGE-001 admission plan`](2026-08-29-discovery-query-lineage-foundation.md) 与 [`current status`](../../status/current.md)。

## Global Constraints

- Exact base is `origin/main@d2c93dd6bea0348381286558896b395c84945171`, merge result of PR #425.
- Unique closeout writer is `codex/discovery-lineage-g0-closeout` at `/global/backend/.codex/worktrees/discovery-lineage-g0-closeout`.
- Change only this plan, `docs/governance/conflict-register.md`, `docs/status/current.md`, `docs/roadmap/release-plan.md`, and `scripts/governance-contracts.spec.mjs`.
- `GPP-B-LINEAGE-001` remains zero product code. G0 PASS means ownership truth is closed; it does not mean G2 source, G3 data integration, runtime, Release, UAT or Pilot pass.
- Preserve G1–G7 rows byte-for-byte except references whose only meaning is the now-closed G0 condition.
- Preserve `DISCOVERY_GOVERNED_LINEAGE_NOT_READY`; no product source, schema, migration, Provider/model/tool wire, paid call, service, runtime, deploy, image, GrowthOS, PII, Billing/Credits, RuntimeEvidence or Release Bundle mutation.
- This plan stops after a locally reviewed commit. Push, PR creation/update and merge each require a new exact user authorization and current head/base run card.

---

### Task 1: Persist and verify the G0 closeout

**Files:**
- Create: `docs/superpowers/plans/2026-08-30-discovery-lineage-g0-closeout.md`
- Modify: `docs/governance/conflict-register.md`
- Modify: `docs/status/current.md`
- Modify: `docs/roadmap/release-plan.md`
- Test: `scripts/governance-contracts.spec.mjs`

**Interfaces:**
- Consumes: PR #425 merge `d2c93dd6bea0348381286558896b395c84945171`, exact admitted candidate row and the existing awaiting-state negative mutations.
- Produces: no runtime interface; only durable G0 ownership truth.

- [ ] **Step 1: Write the RED exact-state test**

  Change the existing `expectedCard`, `expectedProgramBRow` and `expectedG0Row` constants to the admitted closeout forms. Add exact constants for the `CON-GPP-001`, `BLK-GPP-001` and Phase 0 release-plan rows. Require each row exactly once and add negative mutations for conflict/blocker/card state, writer, merge SHA, G0 verdict, product-code status and G1–G7 drift.

  The target card state is `ADMITTED / ZERO_PRODUCT_CODE / CURRENT_MAIN_READBACK_PASS`. The target conflict state is `RESOLVED_WITH_REMEDIATION`. The target G0 verdict is `PASS / OWNERSHIP_CLOSED` and must say G2/G3 remain pending.

- [ ] **Step 2: Run RED**

  Run: `node --test --test-name-pattern='discovery lineage successor' scripts/governance-contracts.spec.mjs`

  Expected: FAIL because current main still contains awaiting card/conflict/blocker/G0 rows.

- [ ] **Step 3: Apply the exact governance closeout**

  Update conflict register, current status and release plan to the target states. Bind all current-main facts to PR #425 merge `d2c93dd6bea0348381286558896b395c84945171`. Refresh the source/runtime observation timestamp and read-only facts if the shared current-status timestamp changes.

- [ ] **Step 4: Run GREEN and full local gates**

  Run: `node --test --test-name-pattern='discovery lineage successor' scripts/governance-contracts.spec.mjs`

  Run: `pnpm docs:verify && pnpm governance:verify && pnpm code-intelligence:scan && git diff --check`

  Expected: focused PASS; governance 136/136 PASS; docs 0 errors; ContractGraph 0 errors; exactly five changed governance files; no product/runtime/release evidence count increase.

- [ ] **Step 5: Independent review and local commit**

  Require 0 Critical/High/Medium findings for ownership consistency, exact-state tests, G1–G7 preservation and external-action boundaries.

  Run: `git add docs/superpowers/plans/2026-08-30-discovery-lineage-g0-closeout.md docs/governance/conflict-register.md docs/status/current.md docs/roadmap/release-plan.md scripts/governance-contracts.spec.mjs && git commit -m "docs: close discovery lineage ownership gate"`

  Stop after the clean local commit. Report exact base/head, diff, tests and review. Obtain separate user authorization before push, PR creation/update and merge; after any authorized merge, synchronize and independently read back current main before starting a product implementation plan.

## Not authorized by this closeout

- Any ACK, Raw, Provider, DB, Prisma, Activity, Workflow, runtime, deployment or real-call implementation.
- Any inference that G0 PASS means G2–G7 pass.
- Any use of the old A mega-branch as a base, cherry-pick source, migration subject or evidence source.
