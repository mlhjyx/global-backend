# Trusted Product / Privacy Approval Readback Specification

> 文档 ID：`GOV-APPROVAL-001`
> 层级：`L1 / Normative governance draft`
> 状态：`DRAFT`
> 评审状态：`READY_FOR_GATE_1_REVIEW`
> 事实 Owner：`OWN-DOC-GOV`
> 最后核验：2026-08-30
> 批准边界：用户已 documentary 批准下述精确 Product 选择和值，并批准本地只读设计/计划工作；Privacy、Legal、独立 trust root、实现、GitHub 外部动作、merge 与 Release 均未批准
>
> 文档状态：`SPEC_DRAFT / PRODUCT_DIRECTION_APPROVED / PRIVACY_LEGAL_TRUST_PENDING`
>
> 绑定 Backend main：`f1915d2ef22bba4ae26fc456531ed3a9405f0413`
>
> 绑定 Program C readiness head：`24c95ee713580d363bfe3a3ab4d332c8f93cba67`
>
> GitHub repository：`mlhjyx/global-backend`，repository ID `1291151138`，default branch `main`

## 1. Goal

Build a fail-closed approval control plane that can prove which authenticated
human approved which exact Product or Privacy decision, at which pull request
head and decision digest, and then preserve that proof as a cryptographically
attested, replay-resistant receipt.

The system exists to close the current gap between:

```text
documentary statement
and
trusted decision readback
```

It must never make these facts equivalent:

```text
PR body declaration
GitHub URL
CODEOWNER status
machine check
merge
workflow attestation
human Product approval
human Privacy approval
Legal input
Release authorization
```

## 2. Current documentary Product decisions and remaining authority gaps

The user has explicitly accepted these Product facts in the active Program C
task. This table is the only approved Product-value source for ADR-026/027
proposal rendering; prose summaries may not silently change it.

```text
ADR-027 selected strategy                       = WORKSPACE_COMPLIANCE_HOLD
ADR-026 CANDIDATE full snapshot                 = 180 days
ADR-026 CLOSED non-PII history                  = 730 days
ADR-026 CLOSED contact references               = 30 days
ADR-026 contact tombstone                       = earliest(closed+30 days,
                                                        candidate_created+180 days,
                                                        valid_until+30 days)
ADR-026 null valid_until fallback               = candidate_created+30 days
ADR-026 receipt/dedupe deletion                 = later(terminal+730 days,
                                                        source_non_replayable+90 days)
ADR-026 Legal hold review interval              <= 90 days
ADR-026 Workspace read-only closure grace       = 30 days
ADR-026 encrypted export artifact TTL           = 24 hours
ADR-026 quarantine raw payload persisted        = false
ADR-026 quarantine raw payload retention        = 0 days
ADR-026 quarantine metadata retention           = 90 days
ADR-026 admission default                       = DISABLED
ADR-026 existing Workspace automatic enablement = false
ADR-026 historical full replay                  = false
```

These remain documentary Product approvals because the repository cannot yet
bind the chat actor to an exact GitHub review, PR head, proposed-sidecar digest,
and trusted readback receipt. They are not Privacy approval, Legal advice,
merge authorization, implementation authorization, or Release authorization.

Current authority remains:

```text
OWN-PRODUCT        = ASSIGNED：当前产品负责人
OWN-DATA-PRIVACY   = UNASSIGNED
OWN-QA-EVIDENCE    = UNASSIGNED
OWN-SECURITY       = UNASSIGNED
Legal authority    = UNASSIGNED
MERGE-AUTHORIZER   = UNASSIGNED
Legal              = PENDING
Trusted verifier   = ABSENT
ADR-026             = ABSENT / HOLD
ADR-027             = ABSENT / HOLD
Program C admission= DISABLED
```

No implementation in this specification may invent the missing human
identities, Legal result, merge authorization, Release authorization, or
external system authority.

The effective decision record for both ADRs is therefore:

```text
product_decision       = DOCUMENTARY_APPROVED
privacy_decision       = PENDING_OWNER_UNASSIGNED
legal_input            = PENDING_AUTHORITY_UNASSIGNED
codeowner_review       = NOT_OBSERVED
qa_evidence_review     = PENDING_OWNER_UNASSIGNED
security_review        = PENDING_OWNER_UNASSIGNED
machine_checks                       = NOT_RUN
proposal_merge_grant                 = NOT_AUTHORIZED
proposal_merge_consumption           = NONE
acceptance_merge_grant               = NOT_AUTHORIZED
acceptance_merge_consumption         = NONE
release_authorization                = NOT_AUTHORIZED
policy_effective                     = false
Program C admission                  = DISABLED
```

## 3. Separate state axes and normative transition contract

Every policy revision carries three independent axes plus an immutable evidence
slot map. A renderer or UI must never collapse them into a single `approved`
boolean.

### 3.1 Policy workflow state

```text
OWNER_ASSIGNMENT_REQUIRED
PROPOSED
AWAITING_PRODUCT_REVIEW
AWAITING_PRIVACY_REVIEW
STALE_AFTER_PUSH
VERIFIED
ACCEPTED
REJECTED
REVOKED
```

### 3.2 Legal state

```text
NOT_ASSESSED
PENDING
NO_BLOCKER_RECORDED
CHANGES_REQUIRED
OUT_OF_SCOPE
STALE
REVOKED
```

### 3.3 Evidence trust state

```text
DOCUMENTARY_ONLY
EXTERNAL_UNVERIFIED
TRUSTED_BASE_VERIFIED
INDEPENDENT_EXTERNAL_VERIFIED
STALE
REJECTED
REVOKED
```

`TRUSTED_BASE_VERIFIED` means a trusted workflow from the subject repository's
already-merged default branch performed the readback. It is canary and
diagnostic evidence only. It cannot establish `VERIFIED` or `ACCEPTED` for
ADR-026, ADR-027, Capability admission, Release, Pilot, or GA.

`INDEPENDENT_EXTERNAL_VERIFIED` requires a verifier trust root that the subject
repository PR cannot modify and that is governed by a separate administrator,
repository, or detached signing authority. ADR-026/027 acceptance requires this
trust state; absence is `APPROVAL_INDEPENDENCE_NOT_PROVEN`.

### 3.4 Independent evidence slots

Every proposal and acceptance read model exposes all of these slots even when
their value is `UNASSIGNED`, `NOT_OBSERVED`, or `NOT_AUTHORIZED`:

```text
product_decision_review
privacy_decision_review
legal_input
codeowner_repository_review
qa_evidence_review
security_review
machine_checks
proposal_merge_authorization_grant
proposal_merge_authorization_consumption
acceptance_merge_authorization_grant
acceptance_merge_authorization_consumption
release_authorization
```

The slots are different facts. One ordinary GitHub review ID cannot populate
more than one Product/Privacy/Legal/QA/Security role slot. A CODEOWNER review may be
performed by a person who also has another admitted role, but it still requires
a separate evidence record and cannot create Product, Privacy, Legal, QA,
merge, or Release authority. Security review, QA evidence review, and machine
checks are never interchangeable. Proposal merge grant/consumption, Acceptance
merge grant/consumption, and Release authorization have different subjects and
cannot be reused. A grant is immutable authority; a consumption is a separate
append-only observation and cannot rewrite the grant.

### 3.5 Normative policy transitions

| From                                                   | Event and actor                                                                                                                                                      | Required guards                                                                                                                                                           | To                                                      | Invalidates                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| none                                                   | decision scope created by an authorized local writer                                                                                                                 | authority registry is present                                                                                                                                             | `OWNER_ASSIGNMENT_REQUIRED`                             | none                                                                                                                                      |
| `OWNER_ASSIGNMENT_REQUIRED`                            | required authority assignment is merged and read back                                                                                                                | Product, Privacy, QA and Security mappings are current; independent verifier is observed; ADR-026 additionally requires a current Legal authority before its Legal review | `PROPOSED`                                              | prior documentary-only actor guesses                                                                                                      |
| `PROPOSED`                                             | proposal manifest and proposed-sidecar bytes are rendered                                                                                                            | exact base/head, renderer version, raw-byte digest and semantic digest agree                                                                                              | `AWAITING_PRODUCT_REVIEW`                               | prior proposal revision reviews                                                                                                           |
| `AWAITING_PRODUCT_REVIEW`                              | exact-head Product Review is independently read back                                                                                                                 | Product actor/scope/digest match; review state is `APPROVED`                                                                                                              | `AWAITING_PRIVACY_REVIEW`                               | none                                                                                                                                      |
| `AWAITING_PRIVACY_REVIEW`                              | exact-head Privacy Review is independently read back                                                                                                                 | Privacy actor is distinct by default; ADR-026 Legal input is `NO_BLOCKER_RECORDED` and current; required CODEOWNER, QA, Security and machine evidence slots are satisfied | `VERIFIED`                                              | none                                                                                                                                      |
| any pre-merge state                                    | proposal head, base, decision bytes, authority, Legal input, verifier policy or ruleset changes                                                                      | any pre/post digest differs                                                                                                                                               | `STALE_AFTER_PUSH`                                      | all affected reviews, receipts and unconsumed merge-authorization grants                                                                  |
| `STALE_AFTER_PUSH`                                     | a new proposal revision is rendered                                                                                                                                  | new revision ID and new digests; no receipt/review reuse                                                                                                                  | `AWAITING_PRODUCT_REVIEW`                               | every prior-revision approval                                                                                                             |
| `VERIFIED`                                             | Product or Privacy submits `CHANGES_REQUESTED`, an authority is revoked, Legal becomes `CHANGES_REQUIRED/STALE/REVOKED`, receipt expires, or ruleset/verifier drifts | event is independently read back                                                                                                                                          | `STALE_AFTER_PUSH` or `REJECTED` according to the event | affected review, Legal, receipt, and unconsumed merge-authorization grant evidence                                                        |
| `AWAITING_PRODUCT_REVIEW` or `AWAITING_PRIVACY_REVIEW` | Product or Privacy rejects the revision                                                                                                                              | exact-head `CHANGES_REQUESTED` or closed rejection command                                                                                                                | `REJECTED`                                              | all approvals for that revision                                                                                                           |
| `REJECTED`                                             | corrected decision is proposed                                                                                                                                       | a new policy revision and new proposed-sidecar digest exist                                                                                                               | `PROPOSED`                                              | rejected revision remains immutable and cannot reopen                                                                                     |
| `VERIFIED`                                             | Proposal merge grant is issued, its nonce is durably CAS-reserved, merge result is independently read back, and a separate consumption is appended                   | current unexpired Proposal grant binds exact PR/head/digest; durable nonce ledger has one reservation; consumption binds grant digest/result commit/method/current-main   | `VERIFIED`                                              | grant stays immutable; consumption and ledger make the nonce permanently non-reusable                                                     |
| `VERIFIED`                                             | Acceptance PR is independently verified, an Acceptance grant is issued/CAS-reserved, merge result is revalidated, and consumption is appended                        | unexpired Acceptance revalidation receipt; Acceptance grant and consumption; allowed-file delta; exact accepted bytes; independent verifier/current-main readback         | `ACCEPTED`                                              | grant stays immutable; consumption and ledger make the nonce permanently non-reusable                                                     |
| `ACCEPTED`                                             | an authorized Product/Privacy/Legal revocation applicable to the policy is independently read back                                                                   | revocation scope and effective time are exact                                                                                                                             | `REVOKED`                                               | policy is no longer eligible for new admission; existing-data action follows the accepted retention/deletion policy and is never inferred |
| `REVOKED`                                              | replacement policy is proposed                                                                                                                                       | new policy revision; no resurrection of old receipts, grants, or consumptions                                                                                             | `PROPOSED`                                              | old revision stays revoked                                                                                                                |

`VERIFIED` is evidence readiness, not merge permission. `ACCEPTED` is policy
truth only after the Acceptance PR current-main revalidation succeeds. Neither
state implies implementation, admission, runtime, release, UAT, Pilot, or GA.

### 3.6 Current-state and user-copy contract

The status read model must return the exact current state, every independent
slot, the single highest-priority blocker, and an allowlisted recovery action.
Its user messages are stable Chinese copy:

| State/reason                | User message                                                   | Allowed action              |
| --------------------------- | -------------------------------------------------------------- | --------------------------- |
| `OWNER_ASSIGNMENT_REQUIRED` | `审批责任人尚未完成可信指派，当前决策不能进入评审。`           | `查看缺失角色`              |
| `AWAITING_PRODUCT_REVIEW`   | `等待产品负责人审核当前版本。任何新提交都会使本轮审核失效。`   | `打开精确版本`              |
| `AWAITING_PRIVACY_REVIEW`   | `产品方向已确认，正在等待隐私审核；当前政策尚未生效。`         | `查看隐私与 Legal 前置条件` |
| `STALE_AFTER_PUSH`          | `审批后内容或信任条件已变化，需要基于新版本重新审核。`         | `生成新修订并重新送审`      |
| `VERIFIED`                  | `独立验证已通过，但尚未取得本次合并授权。`                     | `查看证据并请求合并授权`    |
| `ACCEPTED`                  | `政策决策已被当前 main 接受；实现、准入和发布状态需单独查看。` | `查看剩余 HOLD`             |
| `REJECTED`                  | `本修订已被拒绝，不能重用其审批；请创建新修订。`               | `创建新修订`                |
| `REVOKED`                   | `该政策已撤销，新准入已停止；既有数据按已接受的数据政策处理。` | `查看撤销范围与替代政策`    |
| transient readback failure  | `暂时无法确认审批事实。系统不会重复合并或自动放行。`           | `安全重试只读核验`          |

There is no `force accept` action. A transient readback retry may only repeat
bounded reads. A new push, rejected decision, expired/revoked evidence, actor
change, Legal change, or digest drift requires a new review and, where stated
above, a new policy revision.

## 4. Live GitHub facts and drift

The live `protect-main` ruleset is active and requires six status contexts,
strict up-to-date checks, review-thread resolution, deletion protection, and
non-fast-forward protection.

However, current live review enforcement is:

```text
required_approving_review_count = 0
require_code_owner_review       = false
dismiss_stale_reviews_on_push   = true
require_last_push_approval      = false
RepositoryRole bypass          = always
```

The repository declaration in `.github/required-contexts.json` requires at
least one approving review and CODEOWNER review. The declaration and live
enforcement therefore drift.

The verifier must fail with `APPROVAL_RULESET_DRIFT` until the live
ruleset and repository policy match. Repository JSON cannot prove live
enforcement.

Current GitHub Actions defaults are:

```text
default GITHUB_TOKEN permission = read
Actions may approve PRs         = false
allowed actions                 = all
platform SHA pin enforcement    = false
artifact/log retention          = 90 days
```

Repository governance must continue pinning every external action to an
officially resolved 40-character commit SHA even while platform-wide SHA pin
enforcement is absent.

## 5. Trust roots

### 5.1 Repository identity

Receipt identity binds both stable and readable fields:

```json
{
  "repository_id": 1291151138,
  "repository_full_name": "mlhjyx/global-backend",
  "default_branch": "main"
}
```

The numeric repository ID is primary. A name mismatch or repository transfer
requires a new authority policy revision.

### 5.2 Human role authority

Machine approval authority is separate from the human-readable role registry.
It is represented by `approval-authorities/v1` and binds:

```text
role
status
GitHub numeric user ID
GitHub node ID
canonical login for display/readback
effective interval
scope
assignment evidence
revocation state
```

Login alone is never the primary identity. A proposal cannot modify the role
authority used to approve itself; the verifier reads authority bytes from the
proposal base SHA.

The initial machine registry must keep `OWN-PRODUCT`,
`OWN-DATA-PRIVACY`, `OWN-QA-EVIDENCE`, `OWN-SECURITY`, `LEGAL-REVIEW`,
and `MERGE-AUTHORIZER` `UNASSIGNED`. This does not erase the human-readable
documentary Product owner; it records that no GitHub numeric actor mapping has
yet been independently admitted. Product/Privacy/QA/Security/Legal/
Merge-Authorizer assignment is a separate PR and cannot approve an ADR,
provide review evidence, or authorize a merge in the same PR.

### 5.3 Security authority and closed exact-head review evidence

`OWN-SECURITY` is a first-class `approval-authorities/v1` role whose initial
status is `UNASSIGNED`. Its admitted assignment must bind a GitHub numeric user
ID, node ID, canonical display login, finite effective interval, exact scope,
assignment evidence, authority revision/digest, and revocation state. Login,
repository membership, team membership, or CODEOWNERS presence alone is never
authority.

The Program C common precondition for both ADR-026 and ADR-027 requires:

```text
OWN-SECURITY status = ASSIGNED
numeric actor and node IDs = present and match trusted-base authority
effective interval = contains Security review submitted_at and verifier readback_at
scope = repository_id + decision_id + policy_revision + SECURITY_REVIEW
authority revision/digest = independently read back from proposal base/current main
revocation state = ACTIVE with no current revocation or superseding assignment
```

Missing, unassigned, stale, expired, superseded, revoked, out-of-scope, or
ambiguous Security authority returns HOLD before `VERIFIED`; it never falls
back to QA, CODEOWNER, Product, Privacy, Legal, repository administration, a bot,
GitHub App, check run, workflow, or machine status.

The closed `program-c-security-review-evidence/v1` object binds:

```text
evidence_id
repository_id and repository_full_name
decision_id and policy_revision
proposal_pull_request_number
exact_base_sha and exact_head_sha
decision_raw_sha256 and decision_semantic_sha256
proposed_sidecar_path and proposed_sidecar_raw_sha256
role = OWN-SECURITY
authority_revision and authority_digest
GitHub numeric actor ID, node ID and canonical login
review_id
review_state = APPROVED
review_commit_id = exact_head_sha
review_command_digest
submitted_at and independently_read_at
scope = SECURITY_REVIEW
revocation_status = ACTIVE
supersedes_evidence_id or null
```

It is strict UTF-8, `additionalProperties:false`, and contains no free-form
review body, finding text, customer data, PII, secret, token, or credential. The
review command is parsed as untrusted input; only its digest and allowlisted
identity fields are retained. A new head, base, decision/sidecar byte, policy
revision, actor assignment, authority interval/scope, revocation, later
`CHANGES_REQUESTED`, dismissal, or superseding evidence makes the Security
evidence stale and requires a new exact-head Security review.

Schema/readback/state mutation tests must independently reject:

```text
missing Security evidence
OWN-SECURITY UNASSIGNED
stale/expired authority interval
revoked or superseded Security authority
wrong numeric actor or login-only identity
out-of-scope authority
QA, CODEOWNER, Product, Privacy or Legal review substituted as Security
bot, GitHub App, workflow or check run substituted as Security
one review ID reused for Security and another evidence slot
review state other than APPROVED
review commit/head mismatch
proposal head/base or decision/proposed-sidecar digest drift
dismissed review or later CHANGES_REQUESTED
unknown fields, free-form content, PII or secret-bearing evidence
```

### 5.4 Legal authority and closed Legal input

The Legal actor is not inferred from `OWN-DATA-PRIVACY`,
`OWN-SEC-COMMERCIAL`, CODEOWNERS, a PR participant, organization membership, or
the user. The authority registry models a distinct `LEGAL-REVIEW` role with
initial status `UNASSIGNED`; this is a role identifier, not an assignment of a
real person or a claim that Legal advice has occurred.

The closed `program-c-legal-input/v1` object binds:

```text
repository_id
decision_id
policy_revision
decision_raw_sha256
decision_semantic_sha256
scope enum = RETENTION | DATA_RIGHTS | LEGAL_HOLD | WORKSPACE_CLOSURE
status enum = PENDING | NO_BLOCKER_RECORDED | CHANGES_REQUIRED | OUT_OF_SCOPE
authority_revision and authority_digest
GitHub numeric actor ID, node ID, canonical login
review ID, reviewed head SHA, reviewed_at
effective_at, finite valid_until
supersedes_input_id or null
revocation_status enum = ACTIVE | REVOKED
revocation_ref or null
```

Unknown fields and free-form Legal case text are forbidden. The object stores
no customer data, Contact facts, email, phone, raw domain, credentials, secrets,
or legal correspondence. Any change to decision bytes, scope, actor authority,
review head, expiry, or revocation makes the Legal axis `STALE` and requires a
new Legal input; an executor may never rewrite `PENDING` into
`NO_BLOCKER_RECORDED` by inference.

ADR-026 final Privacy review requires all applicable scopes to be current
`NO_BLOCKER_RECORDED`. ADR-027 is not blocked by ADR-026 Legal `PENDING`; if a
future explicit decision requires Legal input for ADR-027, that requirement is
introduced as a separately approved scope change rather than inferred here.

### 5.5 Merge authorizer, immutable grant, append-only consumption, and nonce ledger

The authority registry models a distinct `MERGE-AUTHORIZER` role with initial
status `UNASSIGNED`. It is not inferred from Product, Privacy, Legal,
CODEOWNERS, QA, Security, repository administration, the PR author, a merge
event, or the user. Assigning a real actor requires its own separately accepted
authority revision.

Merge authority and merge-result observation are different immutable facts:

```text
program-c-merge-authorization-grant/v1
program-c-merge-authorization-consumption/v1
```

The exact schema files and public validators are:

```text
docs/governance/program-c-merge-authorization-grant.schema.json
validateProgramCMergeAuthorizationGrant(value)

docs/governance/program-c-merge-authorization-consumption.schema.json
validateProgramCMergeAuthorizationConsumption(value)
```

The singular `program-c-merge-authorization/v1` schema/type/function and any
compatibility alias are forbidden.

The immutable grant binds:

```text
grant_id
repository_id and repository_full_name
decision_id and policy_revision
stage enum = PROPOSAL_MERGE | ACCEPTANCE_MERGE
pull_request_number
exact_head_sha and exact_base_sha
decision_raw_sha256 and decision_semantic_sha256
allowed_merge_method
authorizing_actor numeric identity
merge_authorizer_authority_revision and authority_digest
authorized_at and finite valid_until
single_use_nonce
```

`grant_raw_sha256` is the SHA-256 of the following repository-local normative
canonical bytes; it is not a schema-order rendering:

```text
program-c-merge-authorization-grant/v1 normative digest bytes:
- recursively sort every object key with the repository lexicographic comparator;
- preserve array order;
- serialize JSON primitives with JSON.stringify semantics;
- emit no whitespace and no trailing newline;
- hash the resulting UTF-8 bytes with SHA-256.
```

This canonical digest binds the immutable grant to its revocation, consumption,
ledger, and receipt-reference admission. It is not evidence that an
independently governed service observed an external file. External raw-artifact
provenance remains a separate hosted-admission HOLD.

The grant contains no merge-result commit, consumed timestamp, mutable status,
revocation status/ref, ledger revision, verifier result, or current-main
assertion. Once issued, its bytes are never modified. Expiry is evaluated from
its immutable timestamps; later revocation is an append-only authority/ledger
fact bound to `grant_id + grant_raw_sha256`, never a grant edit.

The append-only consumption binds:

```text
consumption_id
grant_id and grant_raw_sha256
single_use_nonce
repository_id, decision_id, policy_revision and stage
pull_request_number and exact authorized head SHA
observed_result_commit
observed_merge_method
consumed_at
nonce_ledger_key and reserved_ledger_revision
independent_verifier repository/path/SHA/run/attempt/identity
current_main_ref, current_main_sha and readback_at
pre_read and post_read digests
```

Consumption is created only after the independent verifier proves that the
merge result matches the grant and is reachable from current `main`. It is
never written into or appended inside the grant file. The later receipt and
evidence manifest bind/attest the consumption raw digest; the consumption does
not contain a receipt or attestation digest that would create a hash cycle.

The independent verifier owns a durable, externally governed unique-nonce CAS
ledger keyed by `repository_id + single_use_nonce`; stage is bound inside the
record but is not part of the uniqueness key, so a nonce cannot be reused across
Proposal, Acceptance, another ADR, or another PR in the same repository. Before
any physical merge attempt, it atomically appends `NONCE_RESERVED` only when the
key is absent, binding grant digest, stage, PR, exact head, requested method,
reservation ID, request ID, and ledger revision. Concurrent reservations allow
exactly one winner; every loser returns
`APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT` without attempting a merge.

An authorized revoker may append `GRANT_REVOKED` before reservation, bound to
the grant digest and a bounded reason code. CAS reservation fails if that event
already exists. Revocation after reservation never releases the nonce or permits
a second merge; it forces reconciliation/HOLD and remains append-only.

After reservation:

1. the authorized merger may make at most one physical merge request;
2. response loss or timeout records `MERGE_ACK_UNKNOWN` and forbids another
   physical merge request;
3. reconciliation reads the PR, associated commits, result method, and current
   main until it can append either `MERGE_RESULT_OBSERVED` or a bounded HOLD;
4. successful current-main readback appends `CONSUMPTION_RECORDED` and emits the
   separate consumption object;
5. every retry with the same grant/request identity returns the existing
   reservation/consumption and never creates a second ledger stream;
6. a reserved or consumed nonce is never released for reuse, including after
   verifier restart, response loss, rejection, revocation, or receipt expiry.

Schema and mutation tests must cover two concurrent callers, identical retry,
different request identity, response loss before and after the physical merge,
process restart, stale head/base, wrong method, wrong result commit, current-main
lag, grant digest substitution, consumption substitution, stage/PR reuse, nonce
replay, ledger CAS conflict, and attempts to mutate the original grant. The
grant, ledger events, and consumption are bounded and contain no free-form body,
secret, credential, or customer PII.

Documentary grant text cannot satisfy a merge gate. Proposal grant/consumption
cannot authorize or prove Acceptance; Acceptance grant/consumption cannot prove
Release. Release authorization remains a separate fact.

### 5.6 Verifier workflow identity

The production trust target is an independently governed reusable workflow in
the recommended repository:

```text
mlhjyx/global-governance-verifier
```

Creating that repository, assigning administrators, installing a GitHub App,
or changing its settings is an external action and is not authorized by this
specification.

Until the independent repository exists, a same-repository implementation may
only emit `TRUSTED_BASE_VERIFIED`, never
`INDEPENDENT_EXTERNAL_VERIFIED`.

### 5.6.1 Current source admission HOLD

The current repository source does not implement a hosted admission boundary.
Structural validation and pure-kernel planning are diagnostic only. Until an
independently governed hosted boundary supplies a non-forgeable admission
capability, both privileged public source paths fail closed after their own
specific diagnostics:

```text
public RECEIPT_VERIFIED append
  -> APPROVAL_INDEPENDENCE_NOT_PROVEN
  -> cannot enter VERIFIED

public current-main reconciliation
  -> preserves a specific diagnostic APPROVAL_* HOLD when validation fails
  -> otherwise APPROVAL_CURRENT_MAIN_READBACK_REQUIRED
  -> cannot append MERGE_RESULT_OBSERVED or CONSUMPTION_RECORDED
```

There is deliberately no local `WeakSet`, capability argument, mint parameter,
factory, test hook, environment/config switch, or fixture bridge that can turn
either public HOLD into an admission. A hosted issuer is a separately governed
future boundary, not an unexercised source-mode option.

`planApprovalStateTransition()` and
`planMergeAuthorizationReconciliation()` return diagnostic, side-effect-free
plans only. A kernel output is neither an approval state, receipt, admission,
ledger fact, external observation, nor evidence that a hosted verifier or raw
external artifact was observed. Fixtures remain synthetic test inputs and may
exercise pure kernels or tests, but cannot regain provenance or enter either
public admission path.

Attestation verification must bind:

```text
repository or owner
signer workflow path
signer workflow digest
source repository digest
source ref
OIDC issuer
GitHub-hosted runner
receipt subject digest
```

Attestation predicate content is not trusted merely because it is signed. The
receipt bytes are the attested subject and are independently schema-validated.

### 5.7 Sigstore and durable evidence

`mlhjyx/global-backend` is public, so GitHub Artifact Attestations use the
Sigstore public-good instance and a public transparency log.

Every accepted receipt evidence package contains:

```text
approval-receipt.json
approval-receipt-core.sha256
approval-receipt-raw.sha256
sha256-<receipt-raw-sha256-hex>.jsonl
trusted_root.jsonl
verification-command.json
evidence-manifest.json
```

`sha256-<receipt-raw-sha256-hex>.jsonl` is the Sigstore bundle and is named from
the final raw receipt SHA-256 with the literal `sha256:` prefix removed. It is
never named from `receipt_core_sha256`. `trusted_root.jsonl` is mandatory and
its path, SHA-256, acquisition time, TUF/Sigstore source, verifier tool path,
tool version, and binary digest are bound by `evidence-manifest.json`. Missing
or mismatched trusted-root bytes fail with
`APPROVAL_EVIDENCE_BUNDLE_REQUIRED`.

Workflow artifacts are only a transport convenience and may expire after the
repository's current 90-day retention. The attestation service and committed
evidence package carry durable provenance; a workflow artifact URL alone is
never sufficient.

## 6. Human approval command

Each role submits a distinct GitHub Pull Request Review with state
`APPROVED`. The review body contains exactly one machine line:

```text
APPROVE DECISION <ADR-ID> REV <POLICY-REVISION> ROLE <OWNER-ROLE> DIGEST sha256:<64-lowercase-hex>
```

The parser rejects:

- additional lines or fields;
- comments before or after the command;
- Unicode confusables or bidi controls;
- non-canonical whitespace;
- uppercase digest;
- unsupported ADR, role, or revision syntax;
- Markdown links, HTML, mentions, shell syntax, and `${{ ... }}` fragments.

Review body text is parsed as untrusted data and never passed to a shell.

## 7. Approval actor policy

### 7.1 Production default

```text
DISTINCT_ACTORS_REQUIRED
```

Product and Privacy must have distinct GitHub numeric actor IDs, distinct
review IDs, and distinct role receipts.

### 7.2 Optional internal-only dual-role exception

The implementation supports but does not enable:

```text
DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER
```

This mode requires an explicit, time-bounded policy with:

```text
scope = ADR-026 and/or ADR-027 only
validity <= 30 days
two separate role reviews
one distinct Legal or OWN-QA-EVIDENCE human actor
minimum distinct human actors = 2
Legal state = NO_BLOCKER_RECORDED
cannot authorize own merge
cannot authorize Release, Pilot, or GA
```

One ordinary review can never count as both Product and Privacy approval.
Actions, Apps, bots, verifier identities, check runs, and PR authors cannot
substitute for required human roles.

## 8. Trusted approval receipt, core digest, and evidence manifest

The closed receipt schema is
`product-privacy-approval-readback-receipt/v1`.

The receipt binds:

```text
repository numeric identity
decision ID and policy revision
decision raw-byte and canonical digest
proposal PR, base SHA, head SHA, and merge base
trusted-base authority revision and digest
Product and Privacy review IDs
Legal input ID/status/scope/digests/expiry/revocation when applicable
separate CODEOWNER, QA, and Security evidence records
GitHub numeric actors, node IDs, review states, commit IDs, and timestamps
required machine check run IDs, workflow paths, apps, heads, and conclusions
stage-specific immutable merge grant ID/raw digest/nonce when applicable
separate append-only merge consumption ID/raw digest/result/current-main readback when applicable
Release authorization status, which remains NOT_AUTHORIZED for ADR receipts
live ruleset normalized digest and bypass actors
verifier workflow repository/path/SHA/run/attempt/event/runner/API version
pre-read and post-read head/base/ruleset digests
issued-at and finite valid-until
receipt_id
receipt_core_sha256
```

`receipt_id` is a stable opaque identity derived from the receipt type,
repository ID, decision ID, policy revision, phase, proposal PR, and head SHA.
It is not the digest of the complete JSON object.

`receipt_core_sha256` is computed over schema-ordered canonical bytes of the
receipt core. The core includes `receipt_id` but excludes
`receipt_core_sha256`; the final receipt object then adds the computed
`receipt_core_sha256`. There is no self-referential whole-object digest field.
The renderer must expose `renderApprovalReceiptCore()` and test one-byte drift.
The final raw-file SHA-256 is computed outside the receipt and stored only in
`evidence-manifest.json` together with byte length and artifact name. The
attestation subject is the final raw receipt file; offline verification checks
both the external raw-file digest and the internal core digest.

Receipt JSON is strict UTF-8 with duplicate keys rejected,
`additionalProperties:false`, canonical timestamps, lowercase digests, and a
1 MiB maximum. It stores no PR body, customer data, Contact facts, Suppression
values, credentials, tokens, Legal case text, or free-form incident content.

## 9. Proposed-sidecar subject and exact-head readback algorithm

### 9.1 Proposed-sidecar bytes

Every Decision Proposal PR contains both a closed proposal manifest and the
complete proposed ADR sidecar bytes under `docs/governance/decisions/`. The
approved subject is not a prose fragment reconstructed later.

A pure renderer accepts only the closed Product-value object, decision ID,
policy revision, alternatives, constraints, non-goals, independent evidence
slot requirements, and HOLD transitions. It emits canonical UTF-8 Markdown
with LF line endings and one terminal newline. The proposal manifest binds:

```text
renderer_schema_version
renderer_source_sha256
proposed_sidecar_path
proposed_sidecar_byte_length
proposed_sidecar_raw_sha256
decision_semantic_sha256
```

The renderer has byte fixtures and one-byte mutation tests. The Acceptance PR
copies those exact proposed-sidecar bytes into the final `docs/adr/` path; it
does not re-render from prose, normalize whitespace, or change the approved
subject. A different byte requires a new policy revision and new reviews.

### 9.2 Exact-head collection

For every verification attempt:

1. Read repository identity and default branch.
2. Read the proposal PR identity, current base SHA, head SHA, merge base, draft,
   state, and author.
3. Read the authority registry from the trusted base SHA.
4. Read decision bytes from the proposal head through the GitHub Blob/Contents
   API as bounded, untrusted bytes; the trusted policy must allowlist both the
   closed proposal manifest and its exact proposed-sidecar path; do not checkout
   or execute the head.
5. Page through every PR review and prove pagination completeness.
6. For each review-backed role, including Product, Privacy, QA, and Security,
   select a distinct valid `APPROVED` review whose `commit_id` equals the
   current head and whose numeric actor, effective interval, scope, and
   revocation state match trusted-base authority. CODEOWNER evidence and Legal
   input remain their own shapes and cannot substitute.
7. Reject any selected review that is dismissed, superseded by a later
   `CHANGES_REQUESTED`, stale, duplicated, or reused for another role.
8. Read exact-head machine check runs and their Actions workflow/run identity.
9. Read the live ruleset and compare it with repository policy.
10. Re-read PR head/base, authority digest, and ruleset after collecting all
    facts.
11. If any pre/post value differs, return `APPROVAL_TOCTOU_DETECTED`.
12. Render canonical receipt bytes.
13. Attest the receipt bytes with a pinned trusted workflow.
14. Re-verify the receipt and attestation before publishing an evidence
    package.

GitHub/API unavailability, pagination truncation, rate limiting, ambiguity, or
schema drift returns HOLD. It never falls back to URLs or documentary text.

### 9.3 Acceptance-time live revalidation

Before an Acceptance PR may be authorized for merge, the independent verifier
must issue a new `ACCEPTANCE_REVALIDATION` receipt. It re-runs the complete
algorithm against the current Acceptance PR head and additionally proves:

```text
proposal receipt and post-merge receipt are current and unexpired
proposal bytes on main equal independently approved proposed-sidecar bytes
authority, Legal input, ruleset and verifier policy have not drifted
Product/Privacy/Legal/CODEOWNER/QA/Security/machine evidence slots are distinct
Acceptance PR changes only the acceptance allowlist
Acceptance PR contains the exact final ADR sidecar bytes
decision and machine-contract HOLDs are not collapsed
release_authorization remains NOT_AUTHORIZED
Acceptance merge grant is absent before the admitted MERGE-AUTHORIZER issues it
Acceptance merge consumption is absent before current-main result readback
```

After a separate Acceptance grant, durable nonce reservation, and one physical
merge attempt, the independent current-main workflow performs one more readback
and appends the exact Acceptance consumption. A pre-merge receipt, grant without
consumption, expired/revoked grant, same-repository receipt, or Proposal-stage
grant/consumption cannot satisfy this gate.

## 10. Two-stage decision acceptance

### 10.1 Decision Proposal PR

The proposal contains a proposal manifest and exact policy bytes. It remains:

```text
PROPOSED
EXTERNAL_UNVERIFIED
HOLD open
Program C DISABLED
```

Product and Privacy review the exact proposal head and proposed-sidecar bytes.
The proposal carries separate evidence slots for Legal, CODEOWNER, QA,
Security, machine checks, Proposal grant/consumption, Acceptance
grant/consumption, and Release authorization; absent facts remain explicit.

### 10.2 Post-merge verified receipt

After a Proposal grant is separately issued, durably CAS-reserved, and used for
at most one physical merge attempt, the independently governed workflow:

- resolves the merged PR associated with the main commit;
- verifies Product/Privacy reviews against the proposal head;
- proves decision bytes in main match approved bytes;
- appends the Proposal consumption after current-main readback;
- generates an attested `POST_MERGE` receipt bound to both immutable objects.

Only `INDEPENDENT_EXTERNAL_VERIFIED` establishes `VERIFIED`; a same-repository
`TRUSTED_BASE_VERIFIED` receipt remains canary evidence and cannot be consumed
by ADR acceptance. The receipt does not mutate the registry.

### 10.3 Decision Acceptance PR

The acceptance PR may:

- add the receipt evidence package;
- add the final ADR sidecar if its bytes equal the approved proposal subject;
- change registry `PROPOSED` to `ACCEPTED`;
- replace only the exact HOLD allowed by the accepted policy.

It may not change approved policy bytes, actor authority, verifier code,
machine contract implementation, runtime, or Release state.

Before merge it must consume a current `ACCEPTANCE_REVALIDATION` receipt and a
separate immutable Acceptance grant, then durably CAS-reserve that grant's
nonce. After the single physical merge attempt, independent current-main
readback must append the Acceptance consumption and prove registry, sidecar,
proposal and acceptance receipts, attestations, Proposal and Acceptance grants
and consumptions, and proposal identity are exact. Only then is the policy
`ACCEPTED`.

ADR acceptance closes only its decision/policy HOLD. ADR-027 Acceptance closes
`HOLD_SUPPRESSION_DECISION` and must keep
`HOLD_SUPPRESSION_MACHINE_CONTRACT` open. That contract HOLD closes only after
the selected schema/fixture/registry contract is separately merged and read
back. ADR-026 Acceptance may close `HOLD_PROGRAM_C_RETENTION_POLICY` and the
documentary `HOLD_CAPABILITY_ADMISSION_POLICY`; it must keep
`HOLD_CAPABILITY_ADMISSION_RUNTIME`, `HOLD_SOURCE_REPLAY_HORIZON`,
`HOLD_WORKSPACE_CLOSURE_CONTRACT`, `HOLD_OWNER_UNASSIGNED`, Builder, remote CI,
Runtime, Release, UAT, Pilot, and GA gates open.

## 11. Bootstrap protocol

### 11.1 Foundation PR

First merge schemas, pure validators, API fixture adapter, offline verifier,
status read model/CLI, and tests. Do not change the live ruleset or accept an
ADR.

### 11.2 Trusted workflow PR

Merge the trusted-base workflow after separate bootstrap review. The new
workflow cannot verify the PR that introduces itself.

### 11.3 Hosted canary

Canary verifies workflow event association, API permissions, attestation
creation, bundle download, offline verification, context naming, and no head
execution. It remains non-required.

The canary can emit only `TRUSTED_BASE_VERIFIED`. It cannot verify or accept
ADR-026/027, cannot close a Program C HOLD, and cannot be used as the
independent prerequisite of the Program C decision plan.

### 11.4 Live ruleset parity

Only after canary success may a separately authorized external action:

- require approving reviews;
- enable CODEOWNER review after a viable second reviewer exists;
- require last-push approval;
- set the complete live ruleset `bypass_actors=[]` with no emergency,
  repository-role, App, team, or individual bypass entry;
- add a stable verifier context if it is already emitted from main.

The ruleset must be read back after mutation. Any non-empty or unreadable
`bypass_actors` is `APPROVAL_RULESET_BYPASS_PRESENT` and keeps every approval
consumer disabled. No repository file can self-attest that change.

### 11.5 Acceptance gate enablement

A second PR enables fail-closed ADR/Release acceptance consumers after the
independent workflow and ruleset are current and observed. A same-repository
workflow alone is insufficient.

## 12. Workflow security boundary

Privileged readback workflows must:

- run trusted default-branch workflow code;
- checkout only the exact trusted base SHA with credentials disabled;
- never checkout, fetch, or execute PR head or merge refs;
- never download and execute PR artifacts;
- never run PR-controlled package managers, scripts, Makefiles, workflow files,
  config, or dependencies;
- read allowlisted PR files only through GitHub APIs as bounded bytes;
- use GitHub-hosted ephemeral runners;
- use minimal permissions;
- pin all external actions to official 40-character SHAs;
- avoid shell interpolation of PR data;
- avoid secrets beyond the minimal GitHub App installation credential when a
  separate verifier repository is introduced.

The current official action pins selected for the plan are:

```text
actions/checkout v7
3d3c42e5aac5ba805825da76410c181273ba90b1

actions/setup-node v7
820762786026740c76f36085b0efc47a31fe5020

actions/attest v4.2.2
1e69f48acb82d1966a394da916b4c1698aa569d6

actions/upload-artifact v4.6.2
ea165f8d65b6e75b540449e92b4886f43607fa02
```

## 13. Required stop codes

At minimum:

```text
APPROVAL_OWNER_UNASSIGNED
APPROVAL_ROLE_AUTHORITY_STALE
APPROVAL_MERGE_AUTHORIZER_UNASSIGNED
APPROVAL_EXECUTION_BASE_NOT_PINNED
APPROVAL_WRITER_COLLISION
APPROVAL_LEGAL_AUTHORITY_UNASSIGNED
APPROVAL_LEGAL_INPUT_REQUIRED
APPROVAL_LEGAL_INPUT_STALE
APPROVAL_LEGAL_INPUT_REVOKED
APPROVAL_REPOSITORY_MISMATCH
APPROVAL_PR_NOT_ELIGIBLE
APPROVAL_HEAD_MISMATCH
APPROVAL_BASE_MISMATCH
APPROVAL_PROPOSED_SIDECAR_REQUIRED
APPROVAL_PROPOSED_SIDECAR_DIGEST_MISMATCH
APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH
APPROVAL_REVIEW_REQUIRED
APPROVAL_REVIEW_STALE
APPROVAL_REVIEW_DISMISSED
APPROVAL_REVIEW_ROLE_MISMATCH
APPROVAL_REVIEW_ACTOR_MISMATCH
APPROVAL_REVIEW_COMMAND_INVALID
APPROVAL_DISTINCT_ACTORS_REQUIRED
APPROVAL_EVIDENCE_SLOT_REUSE
APPROVAL_CODEOWNER_REVIEW_REQUIRED
APPROVAL_QA_REVIEW_REQUIRED
APPROVAL_SECURITY_OWNER_UNASSIGNED
APPROVAL_SECURITY_AUTHORITY_STALE
APPROVAL_SECURITY_AUTHORITY_REVOKED
APPROVAL_SECURITY_REVIEW_REQUIRED
APPROVAL_SECURITY_REVIEW_ACTOR_MISMATCH
APPROVAL_SECURITY_REVIEW_REUSED
APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH
APPROVAL_CHECK_REQUIRED
APPROVAL_CHECK_AMBIGUOUS
APPROVAL_CHECK_WORKFLOW_MISMATCH
APPROVAL_RULESET_DRIFT
APPROVAL_RULESET_BYPASS_PRESENT
APPROVAL_PAGINATION_INCOMPLETE
APPROVAL_TOCTOU_DETECTED
APPROVAL_RECEIPT_REQUIRED
APPROVAL_RECEIPT_EXPIRED
APPROVAL_RECEIPT_REPLAYED
APPROVAL_RECEIPT_DIGEST_MISMATCH
APPROVAL_RECEIPT_CORE_DIGEST_MISMATCH
APPROVAL_RECEIPT_RAW_DIGEST_MISMATCH
APPROVAL_ATTESTATION_REQUIRED
APPROVAL_ATTESTATION_SUBJECT_MISMATCH
APPROVAL_ATTESTATION_SIGNER_MISMATCH
APPROVAL_ATTESTATION_SELF_HOSTED_DENIED
APPROVAL_EVIDENCE_BUNDLE_REQUIRED
APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED
APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE
APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH
APPROVAL_MERGE_AUTHORIZATION_STAGE_MISMATCH
APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED
APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH
APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT
APPROVAL_MERGE_AUTHORIZATION_REPLAYED
APPROVAL_MERGE_ACK_UNKNOWN
APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED
APPROVAL_ACCEPTANCE_REVALIDATION_STALE
APPROVAL_CURRENT_MAIN_READBACK_REQUIRED
APPROVAL_INDEPENDENCE_NOT_PROVEN
APPROVAL_POLICY_REVOKED
```

All approval-control-plane errors use the `APPROVAL_*` namespace. Workflow,
CLI, schema tests, Ops read models, receipts, and user-copy mapping may not
invent aliases such as `READBACK_*`, `RULESET_*`, or bare `HOLD_*` error codes.
Program C governance HOLD IDs remain policy-state identifiers, not thrown error
codes.

### 13.1 Stop-code recovery matrix

| Error family                                                                                                                                  | State                                                          | Message key                                 | Recovery                                                                                            | New review/revision?                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `APPROVAL_EXECUTION_BASE_*`, `APPROVAL_WRITER_*`                                                                                              | no decision transition                                         | `approval.execution_precondition_failed`    | pin one clean current-main base or resolve writer ownership without touching another writer's state | no review exists yet                                                   |
| `APPROVAL_OWNER_*`, `APPROVAL_LEGAL_AUTHORITY_*`, `APPROVAL_SECURITY_OWNER_*`, `APPROVAL_SECURITY_AUTHORITY_*`, `APPROVAL_MERGE_AUTHORIZER_*` | `OWNER_ASSIGNMENT_REQUIRED`                                    | `approval.owner_required`                   | merge and independently read back a separate authority assignment                                   | new reviews required; decision revision unchanged if bytes unchanged   |
| `APPROVAL_LEGAL_INPUT_*`                                                                                                                      | `AWAITING_PRIVACY_REVIEW` or `STALE_AFTER_PUSH`                | `approval.legal_required`                   | obtain a current closed Legal input from the admitted Legal authority                               | new Privacy review; new decision revision when decision/scope changed  |
| `APPROVAL_PROPOSED_SIDECAR_*`, `APPROVAL_DECISION_SEMANTIC_*`                                                                                 | `STALE_AFTER_PUSH`                                             | `approval.decision_bytes_changed`           | render a new proposed-sidecar and policy revision                                                   | Product and Privacy reviews required                                   |
| `APPROVAL_REVIEW_*`, `APPROVAL_DISTINCT_*`, `APPROVAL_EVIDENCE_SLOT_REUSE`                                                                    | current awaiting state                                         | `approval.review_invalid`                   | submit a new exact-head role-specific GitHub Review                                                 | affected role review required; new revision only if bytes changed      |
| `APPROVAL_CODEOWNER_*`, `APPROVAL_QA_*`, `APPROVAL_SECURITY_REVIEW_*`, `APPROVAL_CHECK_*`                                                     | `AWAITING_PRIVACY_REVIEW`                                      | `approval.assurance_incomplete`             | satisfy the missing independent evidence slot on the same exact head                                | no Product/Privacy re-review unless head changes                       |
| `APPROVAL_RULESET_*`, `APPROVAL_PAGINATION_*`, `APPROVAL_TOCTOU_*`                                                                            | `STALE_AFTER_PUSH` for drift, otherwise current awaiting state | `approval.readback_unconfirmed`             | bounded read-only retry; ruleset mutation requires separate authorization                           | new reviews after drift/push; none for a transient identical retry     |
| `APPROVAL_RECEIPT_*`, `APPROVAL_ATTESTATION_*`, `APPROVAL_INDEPENDENCE_*`                                                                     | `STALE_AFTER_PUSH`                                             | `approval.trust_unverified`                 | repair independent verifier evidence outside the decision PR, then issue a new receipt              | new receipt always; new reviews if head/authority/ruleset changed      |
| `APPROVAL_MERGE_AUTHORIZATION_GRANT_*`                                                                                                        | `VERIFIED`                                                     | `approval.merge_grant_required`             | obtain a fresh stage-specific exact-head grant from the admitted MERGE-AUTHORIZER                   | no review if all evidence remains current; never mutate or reuse grant |
| `APPROVAL_MERGE_AUTHORIZATION_NONCE_*`, `APPROVAL_MERGE_AUTHORIZATION_REPLAYED`                                                               | `VERIFIED`                                                     | `approval.merge_nonce_unavailable`          | read the durable ledger; use the existing reservation/consumption or stop                           | never issue a second physical merge for the same nonce                 |
| `APPROVAL_MERGE_ACK_UNKNOWN`                                                                                                                  | `VERIFIED`                                                     | `approval.merge_result_unknown`             | reconcile PR/result/current-main read-only; do not repeat the physical merge                        | no new review unless facts drift; no new merge attempt                 |
| `APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_*`                                                                                                  | `VERIFIED`                                                     | `approval.merge_consumption_required`       | independently read back result/current-main and append a separate consumption bound to the grant    | never edit the grant; no Acceptance without consumption                |
| `APPROVAL_ACCEPTANCE_REVALIDATION_*`                                                                                                          | `VERIFIED` or `STALE_AFTER_PUSH`                               | `approval.acceptance_revalidation_required` | run independent Acceptance-time live revalidation                                                   | new receipt; new reviews on any drift                                  |
| `APPROVAL_CURRENT_MAIN_READBACK_REQUIRED`                                                                                                     | `VERIFIED`                                                     | `approval.main_readback_required`           | independently read back the merged result; never re-merge automatically                             | no unless result bytes differ                                          |
| `APPROVAL_POLICY_REVOKED`                                                                                                                     | `REVOKED`                                                      | `approval.policy_revoked`                   | create a new replacement policy revision                                                            | always new revision and all approvals                                  |

Transient GitHub/API failure is retryable only when request inputs, repository,
PR head/base, authority, ruleset, decision bytes, and prior results are
unchanged. The system must show `不会重复合并或自动放行` and must not submit a
second physical merge, review, grant, or consumption. A retry reads the durable
nonce ledger and returns the existing reservation/consumption.

## 14. Consumers

### 14.1 ADR-026/027 governance

Current Program C RED tests remain fail closed until a verified receipt context
exists. File presence, digest strings, and URLs are insufficient.

### 14.2 Release Bundle

`validateReleaseBundle()` must receive an externally verified receipt map in
its validation context. Raw bundle fields cannot introduce trust. The existing
`EXTERNAL_UNVERIFIED/NONE/NONE` state remains valid for non-promoted bundles.

### 14.3 memoryctl

Merged PR verification may consume a structured merged/readback receipt, but it
must continue rejecting arbitrary PR body, comment, model summary, relation, or
observation promotion.

### 14.4 ContractGraph

Static extraction must expose authority role → approval → receipt → verifier →
ADR/Release relationships, while marking hosted readback as external and not
runtime evidence.

### 14.5 Approval status CLI and Ops read model

The local foundation exposes a pure read model and CLI:

```text
renderApprovalStatusReadModel(state): ApprovalStatusReadModel
node scripts/governance-approval-status.mjs --decision ADR-027 --format json
node scripts/governance-approval-status.mjs --decision ADR-027 --format text
```

It performs no network or mutation. Hosted adapters inject independently read
facts. JSON output is closed and includes repository, decision/revision,
policy/Legal/trust axes, every evidence slot, exact head/digests, freshness,
effective status, Program C admission status, highest-priority blocker,
message key/Chinese message, and allowlisted recovery action. Text output is a
deterministic projection. Tests cover every state, stop-code family, redaction,
missing/expired/revoked evidence, push drift, distinct evidence slots, and the
absence of `force accept`.

## 15. No-go

- Do not accept the user's documentary approval as a trusted GitHub receipt.
- Do not assign Privacy, QA, Security, Legal, or MERGE-AUTHORIZER identity from
  a branch, CODEOWNERS, repository power, or login guess.
- Do not modify role authority and approve a decision in the same PR.
- Do not introduce, verify, and consume a verifier in the same PR.
- Do not make a new required context before its workflow is merged and canary
  observed.
- Do not trust review count, CODEOWNERS, or merge as Product/Privacy approval.
- Do not use a same-repository `TRUSTED_BASE_VERIFIED` receipt to verify or
  accept ADR-026/027.
- Do not verify a Program C decision from the proposal manifest alone; the
  verifier policy must admit and digest the matching proposed-sidecar bytes.
- Do not reuse Product, Privacy, Legal, CODEOWNER, QA, Security, machine, merge
  grant, merge consumption, or Release evidence slots.
- Do not mutate a merge grant to record result/consumption, release a reserved
  nonce, or retry a physical merge after response loss.
- Do not accept a policy without stage-specific immutable Proposal/Acceptance
  grants, their separate append-only consumptions, durable ledger proof, and
  Acceptance-time live revalidation.
- Do not trust attestation predicate content without validating the receipt
  subject and signer identity.
- Do not call a same-admin same-repository workflow independent external
  readback.
- Do not let `VERIFIED` automatically become `ACCEPTED`.
- Do not let `ACCEPTED` imply implementation, Runtime, Release, UAT, Pilot, or
  GA.
- Do not auto-merge, deploy, mutate the ruleset, create external repositories,
  install Apps, or change credentials without explicit separate authorization.

## 16. Official references

- [Securely using `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
- [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Pull Request Reviews REST API](https://docs.github.com/en/rest/pulls/reviews)
- [Rulesets and protected-branch reviews](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [Generate artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [Offline attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
- [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify)
- [List pull requests associated with a commit](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit)
- [Workflow artifact retention](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
