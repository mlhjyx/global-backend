# Development candidate admission for the pump A/B experiment

> 生命周期：`APPROVED`
> 批准范围：2026-11-15 用户确认已独立复核的开发候选准入方向；本文件落实本地实现，不代表推送、CI 发布、凭据变更、实例创建或部署已获授权或完成。

## Outcome and ownership

Keep `claude/buyer-procurement-scenarios` and its inherited business changes. Prepare a locally verified candidate admission toolchain so an exact unmerged commit can eventually run the normal API and Worker implementation in an isolated development instance. The primary executor owns all writes; `scenario_review` independently reviews contracts and final evidence. Preserve the main-only release workflow and all previous experiment evidence.

Approved direction: `task-artifacts/procurement-ab-20261115/budget-usd5/开发候选制品准入规格.md`, independently reread after its three required clarifications; user response “确认”. Financial authorization: A+B combined USD 5, including profile, planning, search, extraction, website profiling, judgment, panel and retries. Each arm has a maximum of USD 2.50. Source, implementation, CI artifact, runtime adoption and business acceptance remain separate claims.

## Contracts and implementation boundaries

1. **Candidate trust.** A protected, exact trusted workflow/verifier version is distinct from the candidate source commit. An external trusted CI statement must bind image digest, source commit/tree, artifact digest, approved environment/instance/workspaces, expiry and approval identity. A candidate cannot modify trusted publishing/verification inputs, obtain release credentials or publish to the normal release namespace. A local JSON file never substitutes for a verified external signature.
2. **Instance isolation.** Prefer independent approved PostgreSQL and native Temporal instances, retaining `default/understanding` inside the latter. Normal TLS, SaaS machine bootstrap, target/configuration binding, JWKS, RLS, lease writers, artifact storage, Redis and hard readiness dependencies remain required. A naked Temporal CLI endpoint, fake READY lease or `APP_ENVIRONMENT=test` is not an alternative. The implementation validates a concrete manifest and its proof references before generating any launch action; missing registration or secrets remain explicit runtime prerequisites.
3. **Budget without a product DB migration.** Use a private, persistent, atomic operator allocation ledger to reserve the **entire** upper bound of every normal SaaS Grant before requesting it. Upper bounds are non-reclaimable for this campaign, including failed/expired/unused and UNKNOWN cases. All allocated slice caps remain ≤USD 2.50 per arm and ≤USD 5 in total. Each product account still uses existing `PostgresBudgetStore` and normal SaaS signing/verification. This bounds internal Grant exposure; it proves supplier exposure only after each physical-call upper bound is established. Unused slice capacity is not reused. It needs no changes to product SQL, identity, provider routing or settlement. Atomicity is provided by a private SQLite database with immediate transactions, not a JSON sum or process-local mutex. Never issue a second Grant after a possibly issued request without restoring its real identity.
4. **Promotion and execution.** Candidate namespaces and trusted statement types are rejected for pilot/production. Runtime and deployment admission must reject wrong environment/instance, expired or mismatched identities before writes/polling. Normal release admission stays pinned to its main workflow. Do not describe a locally tested verifier or launch manifest as a published image or live runtime.

## Local work and dependencies

| Unit | Deliverable                                                                                      | Dependency                                                   | Evidence                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| L1   | Persistent, fail-closed conservative Grant allocator                                             | Approved USD 5 envelope                                      | RED/GREEN: parallel allocation, crash/reopen, duplicate identities, expiry, cross-arm/workspace misuse, UNKNOWN exposure         |
| L2   | Candidate statement / instance manifest validators and trusted verification CLI                  | Existing build/provenance formats; explicit trust policy     | RED/GREEN: self-asserted metadata, wrong signer/source/digest, production, expiry, incomplete normal runtime dependencies        |
| L3   | Protected candidate publication/bootstrap contract and development launch preparation            | L2; exact future trusted policy commit                       | Source/contract checks proving candidate code never controls privileged publishing; no publication claim until actual CI receipt |
| L4   | Connect admission to immutable runtime classification while preserving ordinary release behavior | L2/L3 trusted proof path                                     | Negative startup/readiness tests and existing artifact tests; no synthetic or test runtime bypass                                |
| L5   | Reviewed local delivery and exact external action packet                                         | Relevant checks pass; unresolved baseline failures disclosed | Independent review, docs/governance, source fingerprints, concrete target/permissions and remaining gates                        |

Trusted CI bootstrap and candidate source are separate logical integration units even though local preparation stays in the requested worktree. A future candidate must include the approved bootstrap baseline so protected runtime files match it; silently overlaying different trusted files onto another source commit would invalidate exact-source provenance.

## Acceptance and rollback

Complete relevant tests and scoped 80%+ coverage; exercise genuine persistence and concurrent subprocesses for the allocator. Validate actual side effects before any integration test. No networked dispatch is needed for local RED/GREEN checks. Reuse previous business verification only while its relevant source/configuration/dependencies remain the same.

Before paid A/B: exact authorized source and trusted policy versions, real CI-signed candidate statement, normal runtime admission, isolated DB/Temporal/control-plane bindings, equal pool/taxonomy/source snapshots, confirmed profiles/rules/plans, real CANONICALIZED receipts and valid request-bound Grants are required. Keep historical H separate, retain the original improvement thresholds, and mark every unexecuted scene 未测.

Implementation review identified a prerequisite not satisfied by Grant slices: acquisition's generic token conversion and source price estimates are not proven supplier upper bounds. The local bootstrap therefore holds candidate model and physical/external tool execution at zero using a stable control error; no configuration switch can self-certify prices. Physical-wire pricing and conservative durable reservation remain unfinished, and A/B is 未测. This hold is a resource boundary, not an alternative business/provider implementation.

Rollback for local changes is a reviewed diff; no reset/clean or removal of inherited work. Runtime rollback, when separately authorized, drains only the named candidate instance and preserves budget/UNKNOWN evidence. Do not change or stop shared API/Worker, delete retained data or revoke credentials as cleanup.
