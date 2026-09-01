# Approval Current-Main Clock Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate exact current main into the trusted-approval branch without rewriting provenance, then remove the caller-selectable fixed-clock factory from every production surface so Round 3 can obtain two clean exact-head reviews.

**Architecture:** Preserve the existing PR branch through a two-parent, non-rewriting local merge of `main@8f3f615ea9d0494a55f67075c7eee0bb126b3386`, resolve only the two pre-audited Copy derived-document conflicts to the exact main versions, and keep Copy fail-closed. The production GitHub readback module will expose only a system-clock client; deterministic time control moves into a test-only fixture that temporarily mocks `Date.now` and restores it in `finally`, so no request, policy, production option, package export, or production module can select a backdated clock.

**Tech Stack:** Git merge/worktrees, Node.js 22 ESM and `node:test`, TypeScript/tsx, ContractGraph, repository governance and Copy fixed-source verification.

**Spec:** `docs/governance/trusted-approval-readback-spec.md` and `docs/superpowers/plans/2026-08-31-trusted-approval-round3-remediation.md`

## Global Constraints

- Exact starting branch head is `b20f41dabf4f4a939517900d6a8eff8a686b40fb`; exact current main and cached `origin/main` are both `8f3f615ea9d0494a55f67075c7eee0bb126b3386`.
- Exact merge base is `c998ca7f07af0fc8f3a1687c140aa8105c9567a0`; current relation is `main-only=35 / branch-only=107`.
- Use the existing isolated worktree `/global/backend/.codex/worktrees/trusted-approval-readback-integration`; do not touch the shared root's untracked `.playwright-cli/` directory.
- The merge is local, non-rewriting, and two-parent. No rebase, squash, reset, cherry-pick reconstruction, push, PR update, comment, thread mutation, external workflow, deploy, restart, runtime mutation, or provider/paid action is authorized.
- The only allowed merge-conflict paths are `docs/evidence/site-builder/copy-runtime-eligibility.json` and `docs/implementation-records/copy-fixed-source-impact-governance.md`. Any other unmerged path is a hard stop.
- Both Copy conflict paths resolve to their exact `main@8f3f615e` bytes. The merged tree must read back `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`, fingerprint `2ea4f9e2c6155c515272c9b192e235b18e5363f056eac5977fbdc96636953d21`, and eligibility receipt SHA-256 `7c9c96f10bcf9e8492c592fad60dc2eb711fd1da9edd741b685f53d51be4da4d`.
- Copy must not be rebuilt, promoted, dispatched, or described as `CURRENT`.
- Production readback time comes only from an internal system clock captured exactly once before the first remote await. `request.observedAt` remains provenance only and cannot authorize authority currentness.
- No production export, production client option, request, policy, fixture leak, OCI/Release composition, or package root may expose caller-selectable clock injection.
- Test time control must live under `scripts/fixtures/approval-readback/`, use `node:test` mocking only, restore `Date.now` in `finally`, and never enter a product or release surface.
- New behavior follows RED → GREEN → refactor. Related lines, branches, and functions coverage remain at least 80%.
- ContractGraph is static evidence only. `Capability=UNKNOWN` and absent runtime evidence remain honest; graph results cannot authorize merge or release.
- The existing `APPROVAL-R4-CONSUMPTION-RAW-001` card remains `HOLD_CONTRACT / NOT_IMPLEMENTED`; this plan does not implement raw consumption-byte binding.
- Completion requires two independent exact-head reviewers with zero unresolved Critical/High findings. One reviewer PASS cannot cancel another reviewer High.
- External actions remain `NONE` throughout this plan.

---

### Task 1: Integrate exact current main and preserve Copy HOLD

**Files:**
- Resolve from exact main: `docs/evidence/site-builder/copy-runtime-eligibility.json`
- Resolve from exact main: `docs/implementation-records/copy-fixed-source-impact-governance.md`
- Verify: every path changed by `main@c998ca7f..8f3f615e`

**Interfaces:**
- Consumes: clean branch `b20f41da`, exact main `8f3f615e`, merge base `c998ca7f`, and the current Copy v22 binding.
- Produces: a local two-parent merge commit whose first parent descends from `b20f41da`, second parent is exact `8f3f615e`, and whose Copy receipt remains `STALE_HOLD`.

- [ ] **Step 1: Re-run the exact pre-merge guard**

```bash
test "$(git rev-parse HEAD)" = "b20f41dabf4f4a939517900d6a8eff8a686b40fb"
test "$(git rev-parse main)" = "8f3f615ea9d0494a55f67075c7eee0bb126b3386"
test "$(git rev-parse origin/main)" = "8f3f615ea9d0494a55f67075c7eee0bb126b3386"
test "$(git merge-base main HEAD)" = "c998ca7f07af0fc8f3a1687c140aa8105c9567a0"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git rev-list --left-right --count main...HEAD
```

Expected: `35 107`; every command exits zero. Any head/main/status drift stops the task before merge.

- [ ] **Step 2: Re-run the non-mutating merge conflict oracle**

```bash
merge_base=$(git merge-base main HEAD)
git merge-tree "$merge_base" HEAD main > /tmp/approval-current-main-merge-tree.txt
rg -n '^(changed in both|added in both|removed in)' /tmp/approval-current-main-merge-tree.txt
```

Expected: the only conflict blocks name exactly:

```text
docs/evidence/site-builder/copy-runtime-eligibility.json
docs/implementation-records/copy-fixed-source-impact-governance.md
```

- [ ] **Step 3: Start the authorized local non-rewriting merge**

```bash
git merge --no-ff --no-commit 8f3f615ea9d0494a55f67075c7eee0bb126b3386
git diff --name-only --diff-filter=U
```

Expected: the command stops for the exact two allowed Copy conflicts and no others. If the conflict set differs, run `git merge --abort` and stop.

- [ ] **Step 4: Resolve only the two Copy files to exact current-main bytes**

```bash
git restore --source=8f3f615ea9d0494a55f67075c7eee0bb126b3386 --staged --worktree -- \
  docs/evidence/site-builder/copy-runtime-eligibility.json \
  docs/implementation-records/copy-fixed-source-impact-governance.md
git add \
  docs/evidence/site-builder/copy-runtime-eligibility.json \
  docs/implementation-records/copy-fixed-source-impact-governance.md
test -z "$(git diff --name-only --diff-filter=U)"
git diff 8f3f615ea9d0494a55f67075c7eee0bb126b3386 -- \
  docs/evidence/site-builder/copy-runtime-eligibility.json \
  docs/implementation-records/copy-fixed-source-impact-governance.md
```

Expected: the final diff command has no output.

- [ ] **Step 5: Verify Copy and integration before committing**

```bash
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
node --test scripts/governance-document-drift.spec.mjs
pnpm governance:verify
git diff --check --cached
```

Expected: Copy tests pass; readback is exactly `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`; governance passes; no whitespace errors.

- [ ] **Step 6: Create the local two-parent merge commit**

```bash
git commit -m "chore: integrate current main into approval readback"
test "$(git rev-parse HEAD^2)" = "8f3f615ea9d0494a55f67075c7eee0bb126b3386"
git status --short --branch
```

Expected: a clean worktree and a two-parent merge commit. Do not push.

### Task 2: Remove fixed-clock injection from the production module

**Files:**
- Modify: `scripts/governance-github-readback.mjs`
- Create: `scripts/fixtures/approval-readback/github-readback-fixed-clock.mjs`
- Modify: `scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs`
- Modify: `scripts/governance-github-readback.spec.mjs`
- Modify: `scripts/governance-approval-test-entry.spec.mjs`

**Interfaces:**
- Consumes: `createGitHubReadbackClient(options)` and the fixture's `collect(state, options)` contract.
- Produces: production exports without `createGitHubReadbackTestClient`; test-only `withFixedSystemTime(instant, operation)` that temporarily mocks `Date.now` and always restores it.

- [ ] **Step 1: Write export and product-boundary RED tests**

Add assertions equivalent to:

```js
const readbackModule = await import('./governance-github-readback.mjs');
assert.equal('createGitHubReadbackTestClient' in readbackModule, false);
assert.deepEqual(
  Object.keys(readbackModule).filter((key) => /Clock|TestClient/.test(key)),
  [],
);
```

Add a repository scan test that fails if any non-spec, non-fixture source imports:

```text
scripts/fixtures/approval-readback/github-readback-fixed-clock.mjs
```

Run:

```bash
node --test --test-name-pattern='production.*clock|test-only.*clock' \
  scripts/governance-github-readback.spec.mjs \
  scripts/governance-approval-test-entry.spec.mjs
```

Expected: FAIL because the production module still exports `createGitHubReadbackTestClient` and the test-only helper does not exist.

- [ ] **Step 2: Write the backdated product-entry RED test**

Use the exact expired-authority counterexample from `final-contract-rereview.md`:

```text
authority effective_until = 2026-08-30T13:00:00.000Z
fixed test time            = 2026-08-30T12:30:00.000Z
real product time          = after expiry
```

The test must prove the product module has no API capable of passing this counterexample. The production client must return:

```text
APPROVAL_GITHUB_AUTHORITY_CURRENTNESS_MISMATCH
```

Run the same focused command. Expected: FAIL on the old public test factory path.

- [ ] **Step 3: Create the test-only fixed-system-time helper**

Implement under the fixture tree:

```js
import { mock } from 'node:test';

let fixedClockActive = false;

export const withFixedSystemTime = async (instant, operation) => {
  const millis = Date.parse(instant);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== instant) {
    throw new Error('APPROVAL_TEST_CLOCK_INVALID');
  }
  if (typeof operation !== 'function') {
    throw new Error('APPROVAL_TEST_CLOCK_OPERATION_REQUIRED');
  }
  if (fixedClockActive) {
    throw new Error('APPROVAL_TEST_CLOCK_CONCURRENT');
  }
  fixedClockActive = true;
  const tracker = mock.method(Date, 'now', () => millis);
  try {
    return await operation();
  } finally {
    tracker.mock.restore();
    fixedClockActive = false;
  }
};
```

This file is test-only. It must not be imported by the production readback module, apps, packages, infra, or release composition.

- [ ] **Step 4: Simplify the production clock surface**

In `scripts/governance-github-readback.mjs`:

```js
const captureCollectorObservedAt = () => {
  const observedAt = new Date(Date.now()).toISOString();
  requireCondition(isCanonicalInstant(observedAt), 'APPROVAL_GITHUB_CLOCK_INVALID');
  return observedAt;
};

export const createGitHubReadbackClient = (options) => createRestClient(options);
```

Remove:

- `collectorClocks`;
- `snapshotCollectorClock`;
- `createClientWithClock`;
- `createGitHubReadbackTestClient`;
- every production export or option that accepts a clock.

Keep `captureCollectorObservedAt()` before the first remote await.

- [ ] **Step 5: Adapt the fixture through the test-only helper**

The fixture's `collect()` must construct the production client, then wrap only the collection operation:

```js
const client = createGitHubReadbackClient({
  fetch: fixture.fetch,
  token: AUTH_SENTINEL,
  apiVersion: API_VERSION,
});
const evidence = await withFixedSystemTime(
  options.collectorObservedAt ?? COLLECTOR_OBSERVED_AT,
  () => collectGitHubApprovalEvidence(
    client,
    options.request ?? request(),
    options.limits ?? limits(),
    options.policy ?? policy(),
  ),
);
```

No clock field enters client options, request, policy, or evidence.

- [ ] **Step 6: Verify GREEN and restoration**

Add tests that prove:

- fixed time is observed inside the operation;
- `Date.now` is restored after success;
- `Date.now` is restored after rejection;
- nested or overlapping fixed-clock operations reject with `APPROVAL_TEST_CLOCK_CONCURRENT` rather than sharing global clock state;
- invalid instant and non-function operation reject with stable test-only codes;
- production module has no test/fixed-clock export;
- no production or release path imports the test-only module.

Run:

```bash
node --test \
  scripts/governance-github-readback.spec.mjs \
  scripts/governance-github-readback-evidence.spec.mjs \
  scripts/governance-approval-test-entry.spec.mjs
pnpm approval-readback:test
git diff --check
```

Expected: all pass with no experimental MockTimers warning.

- [ ] **Step 7: Commit the clock isolation**

```bash
git add \
  scripts/governance-github-readback.mjs \
  scripts/fixtures/approval-readback/github-readback-fixed-clock.mjs \
  scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs \
  scripts/governance-github-readback.spec.mjs \
  scripts/governance-approval-test-entry.spec.mjs
git commit -m "fix: isolate approval readback test clock"
```

### Task 3: Run exact-head gates and obtain converged reviews

**Files:**
- Create ignored evidence: `.superpowers/sdd/2026-09-01-approval-current-main-clock-closeout/local-verification.md`
- Create ignored run card: `.superpowers/sdd/2026-09-01-approval-current-main-clock-closeout/external-update-run-card.md`
- Verify: all files changed from `b20f41da` to the final local head.

**Interfaces:**
- Consumes: the Task 1 merge commit and Task 2 test-clock isolation commit.
- Produces: exact-head local evidence plus two independent reviewer decisions; no external write.

- [ ] **Step 1: Run focused and complete approval gates**

```bash
node --test \
  scripts/governance-github-readback.spec.mjs \
  scripts/governance-github-readback-evidence.spec.mjs \
  scripts/governance-approval-test-entry.spec.mjs
pnpm approval-readback:test
node --experimental-test-coverage \
  --test-coverage-include='scripts/governance-approval-*.mjs' \
  --test-coverage-include='scripts/governance-github-readback*.mjs' \
  --test-coverage-exclude='scripts/*.spec.mjs' \
  --test-coverage-exclude='scripts/fixtures/**' \
  --test-coverage-lines=80 \
  --test-coverage-branches=80 \
  --test-coverage-functions=80 \
  --test \
  scripts/governance-approval-schemas.spec.mjs \
  scripts/governance-approval-safe-json.spec.mjs \
  scripts/governance-approval-readback.spec.mjs \
  scripts/governance-approval-readback-fix.spec.mjs \
  scripts/governance-approval-identity-review.spec.mjs \
  scripts/governance-approval-state.spec.mjs \
  scripts/governance-approval-state-review.spec.mjs \
  scripts/governance-approval-state-round4.spec.mjs \
  scripts/governance-approval-state-round5.spec.mjs \
  scripts/governance-approval-status.spec.mjs \
  scripts/governance-github-readback.spec.mjs \
  scripts/governance-approval-attestation.spec.mjs \
  scripts/governance-approval-test-entry.spec.mjs
```

Expected: every test passes and all three coverage axes remain at least 80%.

- [ ] **Step 2: Run current-main integration, governance, docs, Copy, and graph gates**

```bash
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
pnpm governance:verify
pnpm docs:verify
pnpm --filter @global/code-intelligence test
pnpm --filter @global/code-intelligence build
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact \
  scripts/governance-github-readback.mjs \
  scripts/governance-github-readback.spec.mjs \
  scripts/fixtures/approval-readback/github-readback-fixed-clock.mjs \
  scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs \
  --repo ../..
git diff --check b20f41dabf4f4a939517900d6a8eff8a686b40fb...HEAD
git status --short --branch
```

Expected: governance/docs/build/tests pass; Copy remains `STALE_HOLD`; ContractGraph is clean/fresh with zero errors; impact may remain `UNKNOWN` and must not be promoted.

- [ ] **Step 3: Record local evidence without force-adding ignored files**

Record exact starting head, exact integrated main, merge parents, final head/tree, complete path list, tests/coverage, Copy readback, ContractGraph evidence, absence of product clock injection, and every external HOLD. Do not use `git add -f` for `.superpowers/sdd`.

- [ ] **Step 4: Obtain two independent exact-head reviews**

Dispatch:

1. correctness/contracts reviewer: merge provenance, exact conflict resolution, production export closure, test-only isolation, Date restoration, and regression quality;
2. security/governance reviewer: caller-controlled clock elimination, TOCTOU/first-await semantics, fixture non-admission, product/release exclusion, Copy HOLD, secret/PII non-retention, and external-action boundaries.

Each reviewer must bind the same exact head. Completion requires both to report zero unresolved Critical/High.

- [ ] **Step 5: Stop before every external action**

Report the exact local head, merge parents, tests, reviewer verdicts, residual Medium/Low assignments, and all rulings. Do not push, update PR #430, comment, resolve threads, rerun hosted workflows, merge remotely, deploy, restart services, or modify runtime.

## Local completion criteria

- Exact current main `8f3f615e` is a parent of the local branch through a non-rewriting merge.
- Only the two audited Copy documents conflicted and both equal exact current-main bytes after resolution.
- Copy remains `STALE_HOLD / NOT_AUTHORIZED / BLOCKED` and its fingerprint/receipt SHA match current main.
- The production readback module has no fixed/test clock export and accepts no caller clock through options, request, policy, or composition.
- Deterministic time exists only in a fixture module, restores `Date.now` on every exit, and is absent from product/release imports.
- The expired-authority/backdated-clock counterexample cannot pass through any production entry.
- Approval tests and all three coverage axes pass at or above 80%; governance/docs/Copy/Code Intelligence pass.
- Two independent exact-head reviewers have zero unresolved Critical/High findings.
- No external action occurred.
