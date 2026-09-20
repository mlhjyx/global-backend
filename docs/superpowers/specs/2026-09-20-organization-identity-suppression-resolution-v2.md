# Exact suppression-conflict admission amendment v2

Status: ACCEPTED_FOR_LOCAL_IMPLEMENTATION in this task after independent review and the user continuation following the exact v2 decision request.
Reviewed proposal SHA-256: `fe581587f32725c1a8b2e9e01cf320a795f48e600968279adf90e81f7250716f`.
This proposal grants no execution, controller, credential, refresh or merge authority.
It amends only the two suppression-lock conflicts described below.

## Existing authority and rejected candidate

The 2026-09-01 writer-ban plan Task0C Step6 (line3745) and StopCondition8
reject every non-Copy conflict. The previous refresh 3fb9e677 and its descendants
were produced before formal Task0B completion; they remain unadmitted candidates.
They cannot be retroactively accepted or become the parent of a valid admission
child. Preserve their Git/PR history. A future accepted pair must be recreated
from a separately frozen pre-refresh subject after all prerequisite gates.

## Closed schemas

The following are exact-key JSON records. Unknown/missing keys, duplicate keys,
non-NFC text, proxy/accessor inputs, invalid or unavailable Git objects, symlinks,
size overflow, duplicate rows, or any HOLD fail validation. All SHAs are lowercase:
Git object IDs have40hex digits and SHA256 fields64. Canonical bytes recursively
sort object keys, preserve array order, use JSON scalar encoding, UTF-8 and one
trailing LF. A digest never includes the record containing its own digest.

`organization-identity-suppression-resolution-candidate/v1` fields:
- schemaVersion: the literal version above.
- repository: literal `mlhjyx/global-backend`.
- branchPreRefreshCommit, liveMainCommit, mergeBaseCommit: exact Git commits.
- resultSourceCommit: exact preserved candidate commit containing result blobs;
  this is a bytes source, not an admitted implementation.
- entries: exactly two rows, sorted by UTF-8 path bytes, with these exact paths:
  `apps/api/src/discovery/suppression-policy-lock.spec.ts` and
  `apps/api/src/discovery/suppression-policy-lock.ts`.
- Each entry has exactly path, baseBlobId, branchBlobId, mainBlobId, resultBlobId,
  resultSha256, hunkCount, deltaSha256 and intent.
- All four blobIDs are non-null readable regular-file Git blobs. They must equal
  their corresponding commit:path lookup; result uses resultSourceCommit.
  hunkCount is an integer1..64 derived from the same verified unique merge base.
  deltaSha256 hashes the exact no-ext-diff/no-textconv binary diff bytes from
  branchPreRefreshCommit to resultSourceCommit restricted to this path.
- intent is exactly `PRESERVE_TX_SCALAR_VOID_CAST` for the .ts file and
  `PRESERVE_TX_SCALAR_WORKSPACE_NEGATIVES` for the .spec.ts file.
- testEvidence: exact record with subjectCommit=resultSourceCommit, command,
  exitCode=0, reportSha256. command is the one reviewed suppression-policy-lock
  suite command; report must be the actual persisted execution output. This
  does not replace source review or hosted checks.

`organization-identity-suppression-resolution-review/v1` fields:
schemaVersion, candidateSha256, reportSha256, counterexampleSetSha256,
reviewerClass=`INDEPENDENT_ADMISSION_RESOLUTION_REVIEW`, critical=0,
important=0, verdict=`PASS`. The existing trusted independent-review validation
must bind actual report/counterexample bytes and reviewer provenance; author
JSON, agent success claims or a shape-valid record alone are insufficient.

Extend audit packet with exactly `suppressionResolution` equal to null if no
exception is used, or an exact record {candidateSha256, reviewReceiptSha256}.
Both referenced artifacts must be available in the reviewed evidence root and
independently verified. Audit records the actual complete conflict set as before.

Use `organization-identity-current-main-audit-review/v2`: retain all original
AuditReviewReceipt keys and add suppressionResolutionCandidateSha256 and
suppressionResolutionReviewReceiptSha256. Both are null without an exception,
otherwise they must equal the verified packet references. Version1 cannot carry
this exception. Preserve all original independent controller/receipt/digest gates.

Use `organization-identity-current-main-admission/v2`: retain all original
CurrentMainAdmission keys and add suppressionResolution as above. Add the closed
resolutionSource `REVIEWED_EXACT_SUPPRESSION_BLOB`, allowed only on exactly those
two paths when the complete candidate/review binding is valid. Every recorded
base/branch/main/result blob and hunkCount must match the corresponding manifest
row; result bytes must match resultSha256. It is never accepted on an arbitrary
path or based solely on the source enum. Original v1 remains Copy-only.

## Noncircular ordering and exact authorization

1. Collect pre-refresh/main/base facts without performing a merge. Freeze actual
   candidate result bytes, test output and the candidate manifest, then hash it.
2. An independent reviewer checks semantics and hostile substitutions against
   that immutable subject and produces the separate report/review receipt.
3. Task0B audit includes the candidate/review digests and all original controller,
   local command, owner, path, migration, build/raw/schema/caller facts.
4. Build an exact Task0C authorization-request core containing action, repository,
   branchPreRefreshCommit, liveMainCommit, auditPacketSha256,
   suppressionResolutionCandidateSha256 and suppressionResolutionReviewReceiptSha256.
   This core does not contain its future audit-review digest.
5. The independent audit review binds the packet and authorization-request core
   digest. The user's later grant binds the core AND the resulting audit-review
   digest and immediately refreshed protected-main receipt. This closes the
   loop without embedding a future review digest in its own subject.
6. Immediately before the refresh command and again before admission generation,
   rehash all inputs and re-read exact live/main/preimage/unique-base facts.
   Any drift invalidates the grant and returns to full Task0B.
7. The isolated resolver accepts no free-form edit. It stages only the two exact
   result blobs named by the accepted manifest, then proves the expected path
   set, blob identities, modes, contents and actual conflict hunks. Copy paths
   still use the existing approved generation path, including fresh fingerprint
   and human citation readback. Any additional conflict remains HOLD.
8. The accepted refresh has ordered parents [preRefresh,liveMain]. Its one-parent
   admission child is the sole next commit. Post-refresh findings abandon and
   preserve the pair; no forward-fix child, amended acceptance or reused grant.

## Exact original-plan modifications after user acceptance

- Locked Machine Interfaces: add the candidate/review schemas and v2 audit/
  admission fields above. Keep v1 readers diagnostic/Copy-only, never silently
  upgrade a v1 artifact to v2 or fill missing provenance with constants.
- Task0A: implement TDD validation/generation of v2 records and actual observed
  bindings; preserve distinct controller and bootstrap authority gates.
- Task0B Steps6–10: collect all conflicts; only a complete two-path manifest,
  independent review and unchanged exact objects can propose the exception.
  Bind these digests to packet, audit-review and authorization-request core.
- Task0C Step6: replace the unconditional non-Copy HOLD only for the exact two
  paths under the fully verified v2 exception. No generic semantic merge.
- Task0C Step7: rederive final blob/path/mode/hunk sets and reject any other change;
  retain the immutable migration directory check and Copy generator checks.
- StopCondition8: HOLD on non-Copy conflicts except the exact reviewed v2 pair;
  HOLD on absent/mismatched grant or any snapshot/result/evidence drift.
- StopCondition9 and Task0C recovery remain unchanged: preserve rejected pairs
  and recreate from a newly audited clean pre-refresh subject.

## Source behavior and verification

The .ts result preserves the transaction-bound branded receipt, strict one-row
empty-string database scalar check, fixed advisory key, ::text cast and bounded
resolver errors. The spec result must cover BOTH public assertion overloads:
valid workspace accepted; different workspace rejected; absent/forged receipts
rejected; a different transaction rejected; malformed scalar/accessor rows refused.
The updated candidate is a review subject only. Raw/Canonical/Identity writers,
RLS and provider/budget behavior are unchanged by this amendment proposal.

Required negative tests: wrong path/blob/main/base/preimage; omitted/extra row;
wrong review provenance; mismatched test subject; duplicate or stale authorization;
result content/mode change after review; new conflict/hunk; changed migrations;
Copy fingerprint or citation drift; old v1 with attempted exception. Each fails
before a shared-state write. Exact exception success must be shown using local
Git fixtures, followed by true independent review and authorized real readback.

## Separate unsatisfied prerequisites

The GitHub controller still lacks its executable observation/materialization CLI,
and its current invocation builder lacks the protected-branch + advertisement
pair. Those are implementation gaps to repair and review before presenting an
exact root/credential materialization packet. This proposal does not deem the
existing metadata-only request executable. Credentials, root writes, refresh,
retained/disposable migration, push, PR merge, source deletion and provider calls
retain their original precise gates. Necessary successors remain incomplete.
