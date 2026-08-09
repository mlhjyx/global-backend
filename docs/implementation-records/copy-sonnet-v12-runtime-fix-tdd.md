# Copy Sonnet v12 runtime fix — TDD evidence

## Source and scope

No standalone plan file was supplied. The journeys and acceptance criteria were
derived from the stopped Copy Sonnet recovery v12 run and the user's approval
to implement the zero-model-call runtime fix.

This change does not call a real model, create or modify a gateway credential,
accept v12 as capability evidence, run the Copy quality matrix, promote a
model, or change a production route. The consumed and frozen v12 authorization
is not reusable.

## User journeys

1. As a model-runtime operator, I want an Anthropic consume log with zero
   uncached input and positive cache-write input to settle to the complete input
   total, so a known charge is not incorrectly frozen as unknown.
2. As a model-runtime operator, I want a failed HTTP 2xx response-schema parse
   to expose only bounded, allowlisted response structure and validation paths,
   so compatibility failures can be diagnosed without persisting Copy text,
   request bodies, or raw response bodies.
3. As a Copy capability operator, I want that same redacted response shape in
   the durable wire observation, so a paid schema failure remains diagnosable
   after the process exits without retaining provider or customer content.

## RED and GREEN report

| Task                                            | Test target                                                                   | RED evidence                                                                                                                                                                                                                                                    | GREEN evidence                                                            | Guarantee                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconcile cache-write-only Anthropic settlement | `apps/api/src/model-gateway/new-api-request-bound-settlement.spec.ts`         | `pnpm --filter @global/api test -- src/model-gateway/new-api-request-bound-settlement.spec.ts src/model-runtime/adapters/ai-sdk-native-adapters.spec.ts` ran 42 tests: 2 failed and 40 passed. The new settlement case returned `unknown` instead of `settled`. | The same command ran 42 tests: 42 passed.                                 | `prompt_tokens=0`, `cache_creation_tokens=1199`, and `cache_tokens=0` settle as 1199 input tokens; a true zero-total input still fails closed.                       |
| Preserve cache-write-only native Messages usage | `apps/api/src/model-runtime/adapters/ai-sdk-native-adapters.spec.ts`          | The test passed during RED, proving that valid native Messages usage already normalized zero uncached plus positive cache-write input correctly.                                                                                                                | The same test remains green.                                              | The adapter reports 1199 total input, 0 uncached input, and 1199 cache-write input without a real gateway call.                                                      |
| Redact invalid HTTP 2xx response diagnostics    | `apps/api/src/model-runtime/adapters/ai-sdk-native-adapters.spec.ts`          | The new diagnostic test failed because `NativeModelApiError` had no `responseShape`.                                                                                                                                                                            | The same command passed after the implementation.                         | Only allowlisted top-level keys, content block types, usage keys, and validation paths are exposed; sensitive values and unknown keys do not enter the error object. |
| Persist the redacted shape end to end           | `apps/api/src/site-builder/eval/copy-sonnet-recovery-trusted-gateway.spec.ts` | The fixed-source Sonnet recovery test received the invalid HTTP 200 response and recorded the bounded failure reason, but the durable wire observation had no `responseShape`.                                                                                  | The same test passes and the ledger contains the exact allowlisted shape. | The real runner threads the shape through `ModelObservation` and both durable ledgers; customer text and unknown response fields remain absent.                      |

The RED checkpoint is commit `41657230` (`test: reproduce Copy v12
settlement gaps`). The GREEN checkpoint is commit `5893ee8d` (`fix: reconcile
cache-only Anthropic settlement`). Both commits are reachable from the branch
HEAD and belong only to this task.

The P1 review follow-up RED checkpoint is commit `7c0ae0b6` (`test: reproduce
lost Copy response shape`). Its GREEN checkpoint is commit `475fbc83` (`fix:
persist redacted Copy response shape`).

## Coverage

Command:

```text
pnpm --filter @global/api exec vitest run \
  src/model-gateway/new-api-request-bound-settlement.spec.ts \
  src/model-runtime/adapters/ai-sdk-native-adapters.spec.ts \
  src/model-runtime/model-execution-ledger.spec.ts \
  --coverage \
  --coverage.include=src/model-gateway/new-api-request-bound-settlement.ts \
  --coverage.include=src/model-runtime/adapters/ai-sdk-adapter-result.ts \
  --coverage.include=src/model-runtime/adapters/ai-sdk-native-adapter.contract.ts \
  --coverage.include=src/model-runtime/types.ts \
  --coverage.reporter=text
```

Result:

- Statements: 88.47%
- Branches: 81.38%
- Functions: 93.10%
- Lines: 91.42%

The compiled Sonnet recovery end-to-end test is intentionally reported as a
separate behavioral gate because the 2,000-line runner contains a large
pre-existing surface unrelated to this patch. The new runner mapping is
executed by that test, while the response-shape creation and normalization
core above remains above 80% on every metric.

## Verification

| Gate           | Command                                                                                                                                                  | Result                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Targeted tests | `pnpm --filter @global/api test -- src/model-gateway/new-api-request-bound-settlement.spec.ts src/model-runtime/adapters/ai-sdk-native-adapters.spec.ts` | PASS — 42/42                                                       |
| P1 follow-up   | Six settlement, adapter, ledger, durable-runtime, and fixed-source Sonnet test files                                                                     | PASS — 90/90                                                       |
| API build      | `pnpm --filter @global/api build`                                                                                                                        | PASS                                                               |
| API lint       | `pnpm --filter @global/api lint`                                                                                                                         | PASS — 0 errors, 7 pre-existing warnings outside the changed files |
| Documentation  | `pnpm docs:verify`                                                                                                                                       | PASS — 0 errors, 1 pre-existing table warning                      |
| Full API suite | `pnpm --filter @global/api test`                                                                                                                         | PASS — 275 files; 4,335 passed, 1 skipped                          |
| Contract lint  | `pnpm contracts:lint`                                                                                                                                    | PASS — 0 errors, 15 pre-existing warnings                          |
| Code graph     | `pnpm code-intelligence:check`                                                                                                                           | PASS — deterministic; 0 errors, 5 warnings                         |
| Secret scan    | `gitleaks git --redact --no-banner --log-opts='origin/main..HEAD'`                                                                                       | PASS — 6 branch commits scanned; no secret finding                 |

The first full-suite attempt was incorrectly launched in parallel with
`nest build`. Tests that require `apps/api/dist` observed the build's temporary
clean state and reported 12 `MODULE_NOT_FOUND` failures. After the build
completed, the suite was rerun sequentially and passed with the counts above.
No production change was made to mask those failures.

## Security and known gaps

- Response-shape diagnostics are created only for HTTP 2xx JSON object bodies
  at or below 64 KiB.
- Every recorded key and block type is selected from a fixed allowlist.
- Validation paths accept only allowlisted path segments, bounded array
  indices, bounded depth, and bounded length.
- Raw response bodies, provider error messages, request bodies, Copy text, and
  unknown fields remain absent from `NativeModelApiError`.
- `pnpm audit --registry=https://registry.npmjs.org --audit-level high`
  reports 34 high, 29 moderate, and 7 low advisories in the repository's
  existing dependency graph. This branch does not change a package manifest or
  `pnpm-lock.yaml`; dependency remediation remains a separate governance task.
- This PR fixes the deterministic usage-reconciliation bug and provides an
  adapter-boundary diagnostic. It does not reconstruct or accept the lost v12
  output and does not authorize another real wire.
- Because protected runtime source changes, any future recovery must use a new
  fixed-source manifest generated from the merged commit. The old v12 manifest
  and authorization must not be replayed.
