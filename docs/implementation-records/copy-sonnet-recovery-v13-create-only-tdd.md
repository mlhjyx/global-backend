# Copy Sonnet recovery v13 create-only TDD record

Date: 2026-08-09

## Outcome

The v13 preparation reissues the Sonnet-only Copy recovery against the merge
commit that contains the complete v12 runtime diagnosis fixes. It creates a
versioned manifest and compiled-runtime binding without dispatching a model
request or reading credentials.

The artifacts remain inputs to a future, separately authorized capability
recovery. They are not capability, quality, promotion, or production-route
evidence.

## Fixed provenance

- #355 merge commit: `a29b222a45ae5fdb4868d5235cc94aeab1574ecd`
- manifest preparation commit: `b6e01204d0900be418ca44f594b03ac25df39738`
- runtime-binding fixed source after the authorized main sync: `874a8cc2aa637c35f8c78302006ffb370913fcb7`
- manifest source bundle: 77 files, `c1269c2fd789eebe3a889beafb2a5d62f6a0a787df71b525270d391a5a99ba4a`
- runtime source bundle: 82 files, `139c8661b03ea74135d901ec5e0ce5d399f53a9267a73e8e9f2900724626e3ed`
- compiled runtime: 53 files, `a7ac0ca8825dc4fdc802a58facae0b9fa42549e33adb03a4fdc1347d3b79bb6c`

## RED

The v13 tests were introduced before implementation. After workspace build
prerequisites were generated, the focused run failed on the old fixed commit,
v12 identifiers and paths, missing v13 manifest, and missing v13 runtime
binding. The unrelated first-run missing `@global/contracts` build artifact was
corrected before recording the contract failures.

RED commit: `a2f7de35`

## GREEN

The minimal implementation:

- binds the manifest to #355 merge `a29b222a...`;
- gives the recovery a new v13 execution and plan identity;
- allows only `claude-sonnet-5 / anthropic_messages / medium`;
- preserves 1 execution, at most 2 wires, and at most 1 closed repair;
- excludes Terra and Sol from dispatch;
- forbids replay of successful v11 wires and the stopped v12 wire or
  authorization;
- fixes the manifest and compiled runtime by tracked-byte and digest checks;
- keeps both artifacts create-only and not authorized for dispatch.

Preparation commit: `b6e01204`

Post-sync merge commit: `e361451a5601f1117c7391e85cb05f841b1fd6bf`

Post-sync runtime-binding preparation commit:
`874a8cc2aa637c35f8c78302006ffb370913fcb7`

## Generated artifacts

### Manifest

- path: `docs/evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v13.json`
- file SHA-256: `99a1d51497b2112a83f5e18f8509baddd5f6486be13f92e08c3b5fec8dac0b47`
- artifact digest: `476a8d68a0fae68a7ddeb28bd58ff3bc21956b505420586e81d6a08fef903152`

### Runtime binding

- path: `docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v13.json`
- file SHA-256: `ce1ddef1d5a862817cc154f63fff05130e5ef462815e15b69421a1e828e4e6a6`
- artifact digest: `caa42cbfd69c1fcad25c1bc5dc0b8c787098ca84fa6619270c882d41b7a901e5`

## Post-sync binding refresh

After PR #356 was opened, `origin/main` advanced to
`2a54024512c0c7f5e373cd31c4e4e208e2fa1106`. The authorized merge preserved
both histories but changed the root `package.json` by adding governance-only
scripts. That file is intentionally part of the raw build source bundle, so
the old runtime binding would have failed closed with a tracked-byte mismatch
on the post-sync mainline even though the Copy implementation was unchanged.

The refresh did not loosen the verifier or change the v13 manifest. It removed
the old generated binding, committed a clean post-sync source snapshot, and
used the existing create-only generator to bind that exact snapshot. The
compiled runtime tree remained `a7ac0ca8…`; only the source-bundle and binding
digests changed. No credential, gateway, or model path was accessed.

Both artifacts record:

- `dispatchAuthorization=NOT_AUTHORIZED`
- `dispatchCapable=false`
- `observedNetworkCalls=0`
- `observedModelWireCalls=0`
- observed model cost CNY 0 and USD 0

## Deterministic verification

- focused recovery, real-runner, and source-verifier tests: 35 passed and 1
  opt-in rebuild test skipped in the normal run;
- clean-HEAD manifest and runtime-binding rebuild with coverage: 17 passed;
- full API suite: 275 files passed, with 4,337 tests passed, 1 skipped, and 0
  failed;
- API build, API lint, contracts lint, docs verification, and deterministic
  code-intelligence checks passed with zero errors;
- changed executable production lines relative to `origin/main`: 4/4 covered
  (100% diff line coverage); the complete pre-existing 500–700 line generator
  files are 71.08% line covered, with the remaining gaps concentrated in
  unchanged file-output failure branches;
- generation paths statically reject `fetch`, environment reads, API keys, and
  credential references;
- staged secret scans found no leaks.

The remaining repository verification and GitHub review results are recorded in
the pull request rather than hard-coded here.
