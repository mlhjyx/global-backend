# Task 0L Plan Rebind Report

Date: 2026-09-04
Worktree: `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2`
Branch: `codex/pr407-organization-identity-caller-cutover-v2`
Base head before change: `7e5f9e787123ade54c492fa6f05f8fa42dbf7f11`

## Scope

Rebind the Task 0L launcher trust root from the superseded plan identity

- old commit `e8a2b2aa08ed5933b3228cc5dd24c468d0f417c2`
- old blob `6e6234913f00c9bf496ccdeb3eb60bad88fc9691`
- old SHA-256 `3bd1c56dff6c2f284b5f34a7ee16c8d14ba0a44069abf0c3aa8ab4c47b78555f`

to the independently accepted current plan identity

- commit `33ddcee4e6cb31c107b7ffe4fd5b2ba427e927c3`
- blob `599cd7f7769e0ad40fc42f8a3ea8d26cf6741a10`
- SHA-256 `7a0aee3b3533373330ae02d4a4db84779411d6624b48d4d7dc10a91a269fabb5`

Spec identity remained unchanged.

## TDD Record

1. Updated `scripts/governance-organization-identity-launcher-trust.spec.mjs` first to require the current accepted plan identity and to reject:
   - the stale `e8a2`/`6e6234`/`3bd1c5` tuple
   - the current plan commit paired with the wrong old blob
2. RED verification:

```bash
node --test scripts/governance-organization-identity-launcher-trust.spec.mjs
```

Observed failure: `LAUNCHER_CONTRACT_PLAN_INVALID`

3. Minimal GREEN change:
   - updated `scripts/governance-organization-identity-launcher.mjs`
   - no other production files changed

## Verification

Focused RED:

```bash
node --test scripts/governance-organization-identity-launcher-trust.spec.mjs
```

Focused GREEN:

```bash
node --test scripts/governance-organization-identity-launcher-trust.spec.mjs
```

Full Task 0L nine-spec suite:

```bash
node --test \
  scripts/governance-organization-identity-controller-contracts.spec.mjs \
  scripts/governance-organization-identity-github-controller.spec.mjs \
  scripts/governance-organization-identity-gitleaks-controller.spec.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs \
  scripts/governance-organization-identity-launcher-request.spec.mjs \
  scripts/governance-organization-identity-launcher-trust.spec.mjs \
  scripts/governance-organization-identity-launcher-execution.spec.mjs \
  scripts/governance-organization-identity-root-anchor-closure.spec.mjs \
  scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs
```

Result: `68/68` passing.

Bounded coverage on the same nine-spec suite:

```bash
node --test --experimental-test-coverage \
  scripts/governance-organization-identity-controller-contracts.spec.mjs \
  scripts/governance-organization-identity-github-controller.spec.mjs \
  scripts/governance-organization-identity-gitleaks-controller.spec.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs \
  scripts/governance-organization-identity-launcher-request.spec.mjs \
  scripts/governance-organization-identity-launcher-trust.spec.mjs \
  scripts/governance-organization-identity-launcher-execution.spec.mjs \
  scripts/governance-organization-identity-root-anchor-closure.spec.mjs \
  scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs
```

Coverage summary:

- all files line coverage `95.04%`
- all files branch coverage `90.65%`
- all files function coverage `92.01%`
- `scripts/governance-organization-identity-launcher.mjs` line coverage `85.82%`

Formatting and static gates:

```bash
pnpm exec prettier --check scripts/governance-organization-identity-launcher.mjs scripts/governance-organization-identity-launcher-trust.spec.mjs
git diff --check
```

Both passed.

Line-count gate snapshot:

- `scripts/governance-organization-identity-launcher.mjs`: `2469` lines, still the explicit plan-exempt path
- `scripts/governance-organization-identity-launcher-trust.spec.mjs`: `630` lines
- all other checked non-exempt Task 0L files remained below `800` lines

## Changed Files

- `scripts/governance-organization-identity-launcher.mjs`
- `scripts/governance-organization-identity-launcher-trust.spec.mjs`
