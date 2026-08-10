# Copy OpenOx source-policy seed — TDD evidence

| Stage | Evidence |
| --- | --- |
| RED | `pnpm --filter @global/api exec vitest run src/site-builder/eval/copy-sonnet-recovery-source-policy-seed.spec.ts` failed because the new seed module did not exist. |
| GREEN | The same command passed: 9 tests. |
| Coverage | `pnpm --filter @global/api exec vitest run --coverage src/site-builder/eval/copy-sonnet-recovery-source-policy-seed.spec.ts` reported 100% statements, branches, functions, and lines. |
| Build | `pnpm --filter @global/api build` passed. |

The tests guarantee that the seed creates only the exact `openox.tech` public-pricing policy, is idempotent via `update: {}`, rejects policy drift without overwriting it, and requires SELECT plus INSERT privileges outside `app_user`.
