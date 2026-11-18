# Development candidate admission

> 生命周期：`GUIDE`
> 生命周期依据：2026-11-15 产品负责人确认经独立评阅的工业泵开发候选准入方向。此页描述源码合同，不证明任何制品已发布或实例已就绪。

## Trust and integration

The separately protected main workflow `publish-development-candidate.yml` builds an exact unmerged business commit. Trusted workflow commit, candidate commit/tree, owner approval, image/artifact digest and isolated instance are different identities. The ordinary `publish-runtime-image.yml` stays main-only and never accepts candidate provenance.

The candidate must contain the approved trusted bootstrap baseline and cannot modify protected publishing, runtime, identity, budget, DB or dependency files. The operator exports the committed tree with `git archive`; ignored/local checkout bytes are not Docker context. Only the declared build marker is added, before the ordinary artifact manifest and digest are calculated.

The workflow separates a build job without signing/registry privileges from its trusted publisher. Before registry credentials are present, that publisher checks revision/user/entrypoint, validates extracted filesystem bytes with protected main code, and compares the actual marker to the owner-approved marker. It publishes only to `ghcr.io/mlhjyx/global-backend-development-candidate`, reads back the exact config digest, and stores a custom attestation in GitHub's attestation storage. The deployment CLI runs `gh attestation verify` itself, fixing repo, workflow, trusted commit, main source-ref and predicate. A JSON string saying VERIFIED is not proof.

Owner approval is a real detached SSH signature in the distinct `development-candidate-authorization` namespace, verified against the protected owner-key registry. It binds source/tree, trusted builder, instance manifest digest, two workspaces, development, validity of at most 24 hours and USD 5/2.50 caps. Direction approval does not replace an exact-source receipt. Agents do not inspect private keys or sign with substitute owner identities.

The integration units are operator tools, runtime enforcement and publication. The complete bootstrap must first exist on protected main. Locally prepared code, tested contracts, CI-signed OCI bytes, runtime readiness and business acceptance remain separate evidence.

## Guard dependencies

The compliance extension, Prisma tenant transaction, model gateway and ToolBroker/budget store call the candidate guards directly. G16 explicitly records `compliance -> runtime`, `prisma -> runtime`, `model-gateway -> runtime` and `tools -> runtime`. The guard files import only Node builtins, the dependency-free execution-budget error/types module and each other; they do not import the callers or a composition root. The module-level edges enforce the tenant and physical-execution restrictions below and do not establish a file-level import cycle.

## Isolated normal runtime

Prefer an independent approved development DB and native Temporal instance, retaining `default/understanding` inside that instance. Normal machine-token bootstrap, TLS authorizer, target/configuration binding, JWKS, app_user FORCE RLS, restricted lease writers, ToolBroker, artifact storage, Redis and other hard readiness checks remain mandatory. `configurationRevision` is the real machine client's **64-lowercase-hex digest**, not a version label.

The instance validator checks public structure and isolated endpoints. Dependency-proof hashes are references, not proof that provisioning or readiness passed. Never replace those checks with CLI Temporal, APP_ENVIRONMENT=test, fabricated READY leases or a fast-lane variable on an attested candidate.

After actual owner and CI verification, the trusted host verifier emits an admission cache. A separately authorized operator installs it as `/run/secrets/development-candidate/admission.json` in a root-owned, read-only **directory mount**. The runtime refuses unbounded files, symlinks, hardlink substitutions, non-root ownership and group/world writable caches. The directory mount also allows atomic filename updates of allocation snapshots; binding a single old inode would hide replacements.

Startup begins pending-denied and checks immutable marker/build/image/source identities, expiry, instance/workspaces and actual DB, lease-writer, Temporal TLS, machine subject/configuration and user-JWKS settings before readiness. Candidate scope cannot reopen ordinary tenant access when build/image/cache validation fails. Explicit pilot/production mode is rejected even if environment fields disagree.

Scope checks run in the actual PII-extended `PrismaService.withWorkspace`, the identity guard, owner relay queries/events, HTTP/activity entry and budget reservation. Set `SWEEP_SCHEDULER_ENABLED=off` for the bounded experiment. Expiry rejects new work and requests graceful shutdown. Already admitted operations may persist results/settlement during a bounded 15-minute drain; that permission closes on completion/cancellation and cannot leak to asynchronous descendants. It never permits a new external reservation after expiry.

## Conservative USD 5 allocation

Each arm has USD 2.50; A+B combined has USD 5, including profile/understanding, planning, sources/extraction, website enrichment, judging/panels, verification and retries. Existing product SQL remains account-scoped; platform campaign authority is not reused.

`CandidateBudgetLedger` is an operator-only private SQLite ledger. `BEGIN IMMEDIATE` transactions allocate the entire upper bound of each normal SaaS Grant **before** requesting it. Slices are non-reclaimable in this campaign, including unused, failed, expired or UNKNOWN issuance. Duplicate identities are idempotent; conflicting reuse fails. A crash after issuance intent does not authorize another issuer request. Never reset the ledger or open another campaign to make occupied capacity disappear.

After the normal cryptographic Grant verifier confirms workspace, purpose, request digest and cap, bind only its digest/account metadata, never the raw token. The trusted `export-budget` CLI checks the signed instance and exports all slices, including unbound/UNKNOWN exposure. The operator installs the snapshot as `/run/secrets/development-candidate/budget-allocations.json` in the same root-owned read-only directory mount. The private writable SQLite DB is not exposed to the runtime.

Both normal Grant consumption methods require the exact verified token's allocated slice **before** SQL consumption. Account open/reserve also require registration. Another otherwise valid SaaS Grant for that workspace is not additional funding. Unregistered retry accounts are refused, rather than silently allocated more cap; recovery retains stable identities and needs an explicitly allocated normal authorization when necessary. Non-candidate requests keep the ordinary implementation.

These are upper-bound accounting controls, not vendor invoices. Before real dispatch, freeze actual aliases/protocol/credential scope and prices, and independently establish physical-call input/output/repair upper bounds. Do not trust an understated estimate, reclaim UNKNOWN exposure or claim that a local ledger alone proves the actual USD 5 fee limit. If quote/provable exposure does not fit, shrink the bounded sample or mark that scene 未测.

**Current hard hold:** the ordinary acquisition gateway uses task estimates and a generic token conversion when the supplier does not return cost. Source tools also have estimated prices. Those values have not been established as supplier upper bounds. The candidate's physical-execution resource quota is therefore zero: ModelGateway rejects before routing/reserving, and ToolBroker rejects external, estimated-paid or physical-result tools before reserving/executing, including zero-price estimates. The stable error is `EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE`. There is no environment flag or self-issued proof that opens this hold. Ordinary releases retain their existing behavior; this work does not claim to repair their pricing debt. A reviewed actual physical-wire price/reservation implementation and its negative/concurrency/retry evidence are still required before this candidate can conduct A/B. Grant allocation or successful startup alone cannot open it.

## Operator boundary

Run `node scripts/development-candidate.mjs` from a clean, exact protected checkout. Commands are `validate-inputs`, `prepare-build`, `make-predicate`, `verify-image` and `export-budget`; each uses the same signed approval and public manifest. `make-predicate` requires both build receipt and actual marker. `verify-image` performs real external verification. Outputs are created exclusively, preserving previous evidence.

Only after exact-source approval may the owner use their existing signing mechanism. A normal invocation is `ssh-keygen -Y sign -f <approved-owner-key-or-agent-public-key> -n development-candidate-authorization authorization.json`; the operator does not inspect private key contents. Do not manufacture signatures or replace the key registry.

For a separately authorized workflow dispatch, preserve exact signed bytes including trailing newlines. Create JSON inputs containing complete file contents and invoke `gh workflow run publish-development-candidate.yml --ref main --json < dispatch-input.json`. Command substitution of a signed file strips trailing newlines and may invalidate it. Inputs contain public metadata/signature only, never registry, DB, model or identity credentials.

Publication also needs the separate `development-candidate-publication` environment and a registry credential restricted to the candidate package. Creating it, dispatching CI, registering machine/control-plane targets, provisioning DB/Temporal, installing root caches and deploying are explicit external/shared-state actions. This guide and direction confirmation do not execute them. Existing provider routing and production data/credentials are not changed.

Before paid A/B, read back real API/Worker identities, hard readiness, equal initial pools, source/reference fingerprints, confirmed profiles/rules/plans, actual quotes and request-bound Grants. Require real CANONICALIZED receipts; keep historical H and prior manual work separate. Retain the original thresholds and label every unexecuted scene 未测.

Rollback drains only the authorized candidate instance and preserves all cap/UNKNOWN/result evidence. Stop exact named processes; never stop the shared runtime, delete retained volumes/worktrees, rotate keys or erase the allocation ledger as cleanup.
