import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import * as core from "./governed-subject-relation-append-attest.support.mjs";

const { CONTAINER, DATABASE, APPEND, ATTEST, WS_A, WS_B, AUTH_A, AUTH_B, ACCOUNT_A, ACCOUNT_B, OP_A, OP_A2, OP_B, AUTH_H, ACCOUNT_H, OP_H, OP_RESERVED, OP_RECEIPT, OP_ARTIFACT, ARTIFACT_ID, CHILD_A, CHILD_B, SOURCE_A, SOURCE_B, CONTRACT_A, CONTRACT_B, MANAGED_ROLES, TABLES, ARGUMENTS, IDENTITY_TYPES, requireContainer, dockerArgs, rawPsql, psql, asApp, compact, functionCatalog, assertExactFunctionCatalog, assertExactHelperPolicy, createExactMutationBaseline, probeInvalidFunctionCatalog, resetDatabase, seedAuthority, seedOperation, seedReservedOperation, seedArtifactOperation, cloneAckWithDrift, seedDirectRelationForAck, invocation, selectCall, canonicalSnapshot, lifecycleSnapshot, governedGraphSnapshot, captureFailure, parseRow } = core;
const { state } = core;

describe("governed relation append/attest lifecycle and graph contract", () => {
  before(() => {
    assert.equal(psql("SELECT current_database()||':'||current_user;"), "gsr_task2:global");
  });

  beforeEach(() => {
    resetDatabase();
    state.factsA = seedAuthority({
      workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
      operationId: OP_A, suffix: "01",
    });
    state.factsB = seedAuthority({
      workspaceId: WS_B, authorityId: AUTH_B, accountId: ACCOUNT_B,
      operationId: OP_B, suffix: "02",
    });
    const snapshot = JSON.parse(canonicalSnapshot());
    assert.equal(snapshot.authority.length, 2);
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(snapshot.operations.length, 2);
    assert.equal(snapshot.acks.length, 2);
    assert.equal(snapshot.subjects, null);
    assert.equal(snapshot.relations, null);
  });
  it("rejects a non-settled stored operation and cross-operation ACK tuples", () => {
    const reserved = seedReservedOperation();
    const otherSettled = seedOperation({
      workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
      operationId: OP_RECEIPT, suffix: "05",
    });
    for (const fn of [APPEND, ATTEST]) {
      captureFailure(fn, reserved, { ackId: state.factsA.ackId }, "GOVERNED_OPERATION_SUBJECT_INVALID");
      captureFailure(fn, otherSettled, { ackId: state.factsA.ackId }, "GOVERNED_OPERATION_SUBJECT_INVALID");
      captureFailure(fn, state.factsA, { ackId: otherSettled.ackId }, "GOVERNED_OPERATION_SUBJECT_INVALID");
    }
  });

  it("binds operation key, result schema, receipt usage, cost basis and result strategy", () => {
    const drifts = [
      ["operationKey", "7"], ["resultSchema", "8"], ["usage", "9"],
      ["costBasis", "a"], ["strategy", "b"],
    ];
    for (const [kind, suffix] of drifts) {
      let ackId = cloneAckWithDrift(kind, suffix);
      captureFailure(APPEND, state.factsA, { ackId }, "GOVERNED_OPERATION_SUBJECT_INVALID");
      resetDatabase();
      state.factsA = seedAuthority({ workspaceId: WS_A, authorityId: AUTH_A,
        accountId: ACCOUNT_A, operationId: OP_A, suffix: "01" });
      state.factsB = seedAuthority({ workspaceId: WS_B, authorityId: AUTH_B,
        accountId: ACCOUNT_B, operationId: OP_B, suffix: "02" });
      ackId = cloneAckWithDrift(kind, suffix);
      seedDirectRelationForAck(ackId);
      captureFailure(ATTEST, state.factsA, { ackId }, "GOVERNED_OPERATION_SUBJECT_INVALID");
    }
  });

  it("derives typed and artifact strategies from schema version and binds artifact identity", () => {
    const artifactFacts = seedArtifactOperation();
    const first = parseRow(psql(asApp(selectCall(APPEND, artifactFacts, {
      childId: "51000000-0000-4000-8000-0000000000a7", relationKey: "artifact:result",
    }), WS_A)));
    assert.equal(first[4], "f");
    const replay = parseRow(psql(asApp(selectCall(APPEND, artifactFacts, {
      childId: "51000000-0000-4000-8000-0000000000a7", relationKey: "artifact:result",
    }), WS_A)));
    assert.equal(replay[4], "t");
    parseRow(psql(asApp(selectCall(ATTEST, artifactFacts, {
      childId: "51000000-0000-4000-8000-0000000000a7", relationKey: "artifact:result",
    }), WS_A, true)));

    resetDatabase();
    state.factsA = seedAuthority({ workspaceId: WS_A, authorityId: AUTH_A,
      accountId: ACCOUNT_A, operationId: OP_A, suffix: "01" });
    state.factsB = seedAuthority({ workspaceId: WS_B, authorityId: AUTH_B,
      accountId: ACCOUNT_B, operationId: OP_B, suffix: "02" });
    const driftFacts = seedArtifactOperation();
    const driftAck = cloneAckWithDrift("artifactId", "e", driftFacts.ackId);
    captureFailure(APPEND, driftFacts, { ackId: driftAck },
      "GOVERNED_OPERATION_SUBJECT_INVALID");
    seedDirectRelationForAck(driftAck, driftFacts);
    captureFailure(ATTEST, driftFacts, { ackId: driftAck },
      "GOVERNED_OPERATION_SUBJECT_INVALID");
  });

  it("returns a stable conflict for any post-append tuple drift in append and attest", () => {
    const parentSeed = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
      childId: "51000000-0000-4000-8000-000000000099",
      relationKey: "parent:seed", sourceUuid: SOURCE_B,
    }), WS_A)));
    const baseline = {
      childDataClass: "PERSONAL", childDsrSubjectType: "company",
      childDsrSubjectId: "71000000-0000-4000-8000-000000000002",
    };
    psql(asApp(selectCall(APPEND, state.factsA, baseline), WS_A));
    const conflicts = [
      { parentId: parentSeed[2] },
      { childType: "derived_record" },
      { childId: CHILD_B },
      { childDataClass: "NON_PERSONAL", childDsrSubjectType: null, childDsrSubjectId: null },
      { childDsrSubjectType: "person" },
      { childDsrSubjectId: "71000000-0000-4000-8000-000000000012" },
      { relationKind: "DERIVED_FROM" },
      { sourceNamespace: "alternate_source" },
      { sourceUuid: SOURCE_B },
      { sourceUuid: null, sourceSha256: CONTRACT_B },
      { contractSha256: CONTRACT_B },
    ];
    for (const fn of [APPEND, ATTEST]) {
      for (const override of conflicts) {
        captureFailure(fn, state.factsA, { ...baseline, ...override }, "GOVERNED_SUBJECT_RELATION_CONFLICT");
      }
    }
    const shaBaseline = {
      relationKey: "record:sha", childId: CHILD_B,
      sourceUuid: null, sourceSha256: CONTRACT_A,
    };
    psql(asApp(selectCall(APPEND, state.factsA, shaBaseline), WS_A));
    for (const fn of [APPEND, ATTEST]) {
      captureFailure(fn, state.factsA, { ...shaBaseline, sourceSha256: CONTRACT_B },
        "GOVERNED_SUBJECT_RELATION_CONFLICT");
    }
  });

  it("keeps revocation isolated and never resurrects the same authority", () => {
    psql(asApp(`INSERT INTO execution_budget_authority_revocation(scope_key,authority_id,reason,revoked_at)
      VALUES ('${WS_A}','${AUTH_A}','task2-revoked',now());`, WS_A));
    captureFailure(APPEND, state.factsA, {}, "GOVERNED_SUBJECT_AUTHORITY_REVOKED");
    captureFailure(ATTEST, state.factsA, {}, "GOVERNED_SUBJECT_AUTHORITY_REVOKED");
    assert.equal(psql(`SELECT count(*) FROM execution_budget_authority_revocation
      WHERE authority_id='${AUTH_A}';`), "1");
  });

  it("enforces basic reachable parent, self, cycle and other-operation parent rules", () => {
    const first = parseRow(psql(asApp(selectCall(APPEND, state.factsA), WS_A)));
    const childInternal = first[2];
    const second = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
      parentId: childInternal, childId: CHILD_B, relationKey: "record:1",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
      contractSha256: CONTRACT_B,
    }), WS_A)));
    assert.equal(second[1], childInternal);
    const otherFacts = seedOperation({
      workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
      operationId: OP_A2, suffix: "11",
    });
    const explicitRoot = psql(`INSERT INTO governed_subject(
        scope_key,workspace_id,subject_type,subject_id,data_class
      ) VALUES ('${WS_A}','${WS_A}','tool_operation','${OP_A2}','NON_PERSONAL')
      RETURNING id;`);
    for (const fn of [APPEND, ATTEST]) {
      captureFailure(fn, otherFacts, { parentId: explicitRoot },
        "GOVERNED_SUBJECT_RELATION_INVALID");
    }
    const other = parseRow(psql(asApp(selectCall(APPEND, otherFacts, {
      childId: "51000000-0000-4000-8000-000000000011", relationKey: "other:0",
    }), WS_A)));
    assert.equal(other[0], explicitRoot);
    for (const fn of [APPEND, ATTEST]) {
      captureFailure(fn, otherFacts, { parentId: explicitRoot },
        "GOVERNED_SUBJECT_RELATION_INVALID");
    }
    captureFailure(APPEND, state.factsA, { parentId: other[2], relationKey: "bad:other" }, "GOVERNED_SUBJECT_RELATION_INVALID");
    captureFailure(APPEND, state.factsA, { parentId: childInternal, relationKey: "bad:self" }, "GOVERNED_SUBJECT_RELATION_INVALID");
    captureFailure(APPEND, state.factsA, {
      parentId: second[2], childId: CHILD_A, relationKey: "bad:cycle",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
    }, "GOVERNED_SUBJECT_RELATION_INVALID");
  });

  it("blocks root/parent/child Task1 tombstones and PERSONAL artifact tombstones", () => {
    const first = parseRow(psql(asApp(selectCall(APPEND, state.factsA), WS_A)));
    assert.equal(first[0], first[1]);
    for (const governedSubjectId of [first[0], first[2]]) {
      psql(`INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id)
        VALUES ('${WS_A}','${governedSubjectId}');`);
      for (const fn of [APPEND, ATTEST]) {
        captureFailure(fn, state.factsA, {}, "GOVERNED_SUBJECT_TOMBSTONED");
      }
      psql(`DELETE FROM governed_subject_tombstone
        WHERE workspace_id='${WS_A}' AND governed_subject_id='${governedSubjectId}';`);
    }
    psql(asApp(selectCall(APPEND, state.factsA, {
      parentId: first[2], childId: CHILD_B, relationKey: "record:parent",
      relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
    }), WS_A));
    psql(`INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id)
      VALUES ('${WS_A}','${first[2]}');`);
    for (const fn of [APPEND, ATTEST]) {
      captureFailure(fn, state.factsA, {
        parentId: first[2], childId: CHILD_B, relationKey: "record:parent",
        relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
      }, "GOVERNED_SUBJECT_TOMBSTONED");
    }
    resetDatabase();
    state.factsA = seedAuthority({ workspaceId: WS_A, authorityId: AUTH_A,
      accountId: ACCOUNT_A, operationId: OP_A, suffix: "01" });
    state.factsB = seedAuthority({ workspaceId: WS_B, authorityId: AUTH_B,
      accountId: ACCOUNT_B, operationId: OP_B, suffix: "02" });
    psql(`INSERT INTO generic_operation_artifact_subject_tombstone(
      workspace_id,subject_type,subject_id,tombstoned_at
    ) VALUES ('${WS_A}','company','71000000-0000-4000-8000-000000000001',now());`);
    captureFailure(APPEND, state.factsA, {
      childDataClass: "PERSONAL", childDsrSubjectType: "company",
      childDsrSubjectId: "71000000-0000-4000-8000-000000000001",
    }, "GOVERNED_SUBJECT_TOMBSTONED");
  });
});
