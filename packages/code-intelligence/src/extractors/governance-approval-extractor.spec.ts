import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GraphBuilder } from "../graph";
import { EvidenceRefV1 } from "../schema";
import { extractGovernance } from "./governance";

const EVIDENCE: EvidenceRefV1 = {
  schemaVersion: "evidence-ref/v1",
  repositoryRoot: "/repo",
  worktreePath: "/repo",
  branch: "main",
  commit: "a".repeat(40),
  commitTime: "2026-07-25T00:00:00Z",
  dirty: false,
  sourceHash: "b".repeat(64),
};

async function fixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "approval-contract-graph-test-"));
}

const REPOSITORY_ROOT = path.resolve(__dirname, "../../../..");
const APPROVAL_CONTRACT_PATHS = [
  "docs/governance/approval-authorities.json",
  "docs/governance/trusted-approval-readback.schema.json",
  "docs/governance/trusted-approval-evidence-manifest.schema.json",
  "docs/governance/program-c-merge-authorization-consumption.schema.json",
  "docs/governance/release-bundle.schema.json",
] as const;
const RECEIPT_ID =
  "governance-evidence:product-privacy-approval-readback-receipt/v1";
const APPROVAL_RELATIONS = new Set([
  "decision_approval_for",
  "qa_evidence_review_for",
  "security_review_for",
  "legal_input_for",
  "merge_authorization_for",
  "verified_by",
  "attested_by",
  "authorizes_provenance_for",
  "has_attestation_contract",
]);
const execFileAsync = promisify(execFile);

async function writeRealApprovalContracts(root: string): Promise<void> {
  await mkdir(path.join(root, "docs", "governance"), { recursive: true });
  for (const relative of APPROVAL_CONTRACT_PATHS) {
    await copyFile(
      path.join(REPOSITORY_ROOT, relative),
      path.join(root, relative),
    );
  }
}

async function approvalGraph(root: string) {
  const builder = new GraphBuilder();
  await extractGovernance(builder, root);
  return builder.finalize(EVIDENCE);
}

async function writeApprovalFixture(root: string): Promise<void> {
  await writeRealApprovalContracts(root);
  await writeFile(
    path.join(root, "docs", "governance", "capability-register.md"),
    [
      "| Capability ID | Outcome | Owner |",
      "|---|---|---|",
      "| `CAP-APPROVAL-STATIC-001` | preserved | `OWN-PRODUCT` |",
    ].join("\n"),
  );
}

function assertNoApprovalProjection(
  graph: ReturnType<GraphBuilder["finalize"]>,
) {
  assert.equal(
    graph.nodes.some((node) => node.id === RECEIPT_ID),
    false,
  );
  assert.equal(
    graph.edges.some((edge) =>
      APPROVAL_RELATIONS.has(String(edge.attributes.relation)),
    ),
    false,
  );
  assert.ok(
    graph.nodes.some(
      (node) => node.id === "governance:CAP-APPROVAL-STATIC-001",
    ),
  );
}

test("governance extraction maps trusted approval contracts without promoting hosted trust", async () => {
  const root = await fixture();
  try {
    const governanceRoot = path.join(root, "docs", "governance");
    await mkdir(governanceRoot, { recursive: true });
    await mkdir(path.join(root, "docs", "evidence", "governance-readback"), {
      recursive: true,
    });
    await writeFile(
      path.join(governanceRoot, "approval-authorities.json"),
      JSON.stringify({
        schema_version: "approval-authorities/v1",
        revision: "approval-authorities/initial-unassigned",
        actor_policy: "DISTINCT_ACTORS_REQUIRED",
        roles: [
          { role: "OWN-PRODUCT", status: "UNASSIGNED" },
          { role: "OWN-DATA-PRIVACY", status: "UNASSIGNED" },
          { role: "OWN-QA-EVIDENCE", status: "UNASSIGNED" },
          { role: "OWN-SECURITY", status: "UNASSIGNED" },
          { role: "LEGAL-REVIEW", status: "UNASSIGNED" },
          { role: "MERGE-AUTHORIZER", status: "UNASSIGNED" },
        ],
      }),
    );
    await writeFile(
      path.join(governanceRoot, "trusted-approval-readback.schema.json"),
      JSON.stringify({
        properties: {
          schema_version: {
            const: "product-privacy-approval-readback-receipt/v1",
          },
        },
        $defs: {
          core: {
            properties: {
              role: {
                enum: [
                  "OWN-PRODUCT",
                  "OWN-DATA-PRIVACY",
                  "OWN-QA-EVIDENCE",
                  "OWN-SECURITY",
                  "LEGAL-REVIEW",
                  "MERGE-AUTHORIZER",
                ],
              },
              decision_adr: { enum: ["ADR-026", "ADR-027"] },
            },
          },
        },
      }),
    );
    await writeFile(
      path.join(
        governanceRoot,
        "trusted-approval-evidence-manifest.schema.json",
      ),
      JSON.stringify({
        properties: {
          schema_version: {
            const: "trusted-approval-evidence-manifest/v1",
          },
          attestation_bundle: { type: "object" },
          trusted_root: { type: "object" },
        },
      }),
    );
    await writeFile(
      path.join(
        governanceRoot,
        "program-c-merge-authorization-consumption.schema.json",
      ),
      JSON.stringify({
        properties: {
          schema_version: {
            const: "program-c-merge-authorization-consumption/v1",
          },
          decision_adr: { enum: ["ADR-026", "ADR-027"] },
          independent_verifier: { $ref: "#/$defs/verifier" },
        },
        $defs: {
          verifier: {
            properties: {
              path: {
                pattern: "^\\.github/workflows/[a-zA-Z0-9._-]+\\.ya?ml$",
              },
            },
          },
        },
      }),
    );
    await writeFile(
      path.join(governanceRoot, "release-bundle.schema.json"),
      JSON.stringify({
        properties: { schema_version: { const: "release-bundle/v1" } },
      }),
    );
    await writeRealApprovalContracts(root);
    await writeFile(
      path.join(
        root,
        "docs",
        "evidence",
        "governance-readback",
        "receipt.json",
      ),
      JSON.stringify({
        verificationStatus: "PASS",
        trust_class: "INDEPENDENT_EXTERNAL_VERIFIED",
      }),
    );

    const builder = new GraphBuilder();
    await extractGovernance(builder, root);
    const graph = builder.finalize(EVIDENCE);
    const receiptId =
      "governance-evidence:product-privacy-approval-readback-receipt/v1";
    const attestationId =
      "governance-evidence:trusted-approval-evidence-manifest/v1";
    const verifierId = "governance-verifier:independent-external-workflow";
    const releaseId = "governance-consumer:release-bundle/v1";
    const expectedEdges = [
      ["governance:OWN-PRODUCT", "governance:ADR-026", "decision_approval_for"],
      ["governance:ADR-026", receiptId, "verified_by"],
      [receiptId, verifierId, "attested_by"],
      [receiptId, "governance:ADR-026", "authorizes_provenance_for"],
      [receiptId, releaseId, "authorizes_provenance_for"],
      [receiptId, attestationId, "has_attestation_contract"],
    ];
    const expectedRoleEdges = [
      ["governance:OWN-PRODUCT", "governance:ADR-026", "decision_approval_for"],
      ["governance:OWN-PRODUCT", "governance:ADR-027", "decision_approval_for"],
      [
        "governance:OWN-DATA-PRIVACY",
        "governance:ADR-026",
        "decision_approval_for",
      ],
      [
        "governance:OWN-DATA-PRIVACY",
        "governance:ADR-027",
        "decision_approval_for",
      ],
      [
        "governance:OWN-QA-EVIDENCE",
        "governance:ADR-026",
        "qa_evidence_review_for",
      ],
      [
        "governance:OWN-QA-EVIDENCE",
        "governance:ADR-027",
        "qa_evidence_review_for",
      ],
      ["governance:OWN-SECURITY", "governance:ADR-026", "security_review_for"],
      ["governance:OWN-SECURITY", "governance:ADR-027", "security_review_for"],
      ["governance:LEGAL-REVIEW", "governance:ADR-026", "legal_input_for"],
      [
        "governance:MERGE-AUTHORIZER",
        "governance:ADR-026",
        "merge_authorization_for",
      ],
      [
        "governance:MERGE-AUTHORIZER",
        "governance:ADR-027",
        "merge_authorization_for",
      ],
    ].sort();

    for (const nodeId of [
      "governance:OWN-PRODUCT",
      "governance:ADR-026",
      "governance:ADR-027",
      receiptId,
      attestationId,
      verifierId,
      releaseId,
    ]) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      assert.ok(node, `missing trusted approval node ${nodeId}`);
      assert.equal(node.attributes.evidenceClass, "STATIC_CONTRACT");
      assert.equal(node.attributes.hostedReadback, "EXTERNAL_UNOBSERVED");
      assert.equal(node.attributes.runtimeEvidence, false);
      assert.equal(node.attributes.acceptance, false);
    }
    for (const [from, to, relation] of expectedEdges) {
      assert.equal(
        graph.edges.some(
          (edge) =>
            edge.kind === "references" &&
            edge.from === from &&
            edge.to === to &&
            edge.attributes.relation === relation &&
            edge.attributes.evidenceClass === "STATIC_CONTRACT" &&
            edge.attributes.hostedReadback === "EXTERNAL_UNOBSERVED" &&
            edge.attributes.runtimeEvidence === false &&
            edge.attributes.acceptance === false,
        ),
        true,
        `missing static trusted approval relationship ${from} ${relation} ${to}`,
      );
    }
    const roleRelations = new Set([
      "decision_approval_for",
      "qa_evidence_review_for",
      "security_review_for",
      "legal_input_for",
      "merge_authorization_for",
      "approves",
    ]);
    assert.deepEqual(
      graph.edges
        .filter(
          (edge) =>
            edge.from.startsWith("governance:") &&
            edge.to.startsWith("governance:ADR-") &&
            roleRelations.has(String(edge.attributes.relation)),
        )
        .map((edge) => [edge.from, edge.to, edge.attributes.relation])
        .sort(),
      expectedRoleEdges,
    );
    assert.equal(
      graph.edges.filter((edge) => edge.attributes.relation === "approves")
        .length,
      0,
    );
    assert.equal(
      graph.nodes.some((node) =>
        JSON.stringify(node).includes("INDEPENDENT_EXTERNAL_VERIFIED"),
      ),
      false,
    );
    assert.equal(
      graph.nodes.some((node) => node.id.startsWith("runtime:")),
      false,
    );

    await writeFile(
      path.join(governanceRoot, "approval-authorities.json"),
      JSON.stringify({
        schema_version: "approval-authorities/v1",
        repository: { id: 1291151138, full_name: "mlhjyx/global-backend" },
        revision: "approval-authorities/r2",
        actor_policy: "DISTINCT_ACTORS_REQUIRED",
        roles: [
          {
            role: "OWN-PRODUCT",
            status: "ASSIGNED",
            actor_login: "private-user-must-not-enter-graph",
          },
          { role: "OWN-DATA-PRIVACY", status: "UNASSIGNED" },
          { role: "OWN-QA-EVIDENCE", status: "UNASSIGNED" },
          { role: "OWN-SECURITY", status: "UNASSIGNED" },
          { role: "LEGAL-REVIEW", status: "UNASSIGNED" },
          { role: "MERGE-AUTHORIZER", status: "UNASSIGNED" },
        ],
      }),
    );
    const assignedBuilder = new GraphBuilder();
    await extractGovernance(assignedBuilder, root);
    const assignedGraph = assignedBuilder.finalize(EVIDENCE);
    assert.equal(
      assignedGraph.nodes.some((node) => node.id === receiptId),
      false,
    );
    assert.equal(
      JSON.stringify(assignedGraph).includes(
        "private-user-must-not-enter-graph",
      ),
      false,
    );

    await writeFile(
      path.join(governanceRoot, "approval-authorities.json"),
      JSON.stringify({
        schema_version: "approval-authorities/v1",
        roles: [
          { role: "OWN-ATTACKER", status: "ASSIGNED" },
          { role: "OWN-DATA-PRIVACY", status: "UNASSIGNED" },
          { role: "OWN-QA-EVIDENCE", status: "UNASSIGNED" },
          { role: "OWN-SECURITY", status: "UNASSIGNED" },
          { role: "LEGAL-REVIEW", status: "UNASSIGNED" },
          { role: "MERGE-AUTHORIZER", status: "UNASSIGNED" },
        ],
      }),
    );
    const unrecognizedRoleBuilder = new GraphBuilder();
    await extractGovernance(unrecognizedRoleBuilder, root);
    const unrecognizedRoleGraph = unrecognizedRoleBuilder.finalize(EVIDENCE);
    assert.equal(
      unrecognizedRoleGraph.nodes.some(
        (node) => node.id === "governance:OWN-ATTACKER",
      ),
      false,
    );
    assert.equal(
      unrecognizedRoleGraph.nodes.some((node) => node.id === receiptId),
      false,
    );

    for (const invalidAuthority of ["[]", "{", "x".repeat(64 * 1024 + 1)]) {
      await writeFile(
        path.join(governanceRoot, "approval-authorities.json"),
        invalidAuthority,
      );
      const invalidBuilder = new GraphBuilder();
      await extractGovernance(invalidBuilder, root);
      const invalidGraph = invalidBuilder.finalize(EVIDENCE);
      assert.equal(
        invalidGraph.nodes.some((node) => node.id === receiptId),
        false,
      );
    }

    await writeRealApprovalContracts(root);
    const consumptionPath = path.join(
      governanceRoot,
      "program-c-merge-authorization-consumption.schema.json",
    );
    const invalidConsumption = JSON.parse(
      await readFile(consumptionPath, "utf8"),
    );
    invalidConsumption.$defs.verifier = {};
    await writeFile(consumptionPath, JSON.stringify(invalidConsumption));
    const incompleteBuilder = new GraphBuilder();
    await extractGovernance(incompleteBuilder, root);
    const incompleteGraph = incompleteBuilder.finalize(EVIDENCE);
    assert.equal(
      incompleteGraph.nodes.some((node) => node.id === receiptId),
      false,
    );
    assert.equal(
      incompleteGraph.nodes.some((node) => node.id === "governance:ADR-026"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema-invalid approval inputs preserve Markdown governance and emit zero approval projection", async (t) => {
  const mutations: Array<{
    name: string;
    mutate: (root: string) => Promise<void>;
  }> = [
    {
      name: "ASSIGNED authority missing actor_id",
      mutate: async (root) => {
        const authorityPath = path.join(
          root,
          "docs/governance/approval-authorities.json",
        );
        const authority = JSON.parse(await readFile(authorityPath, "utf8"));
        authority.revision = "approval-authorities/r2";
        authority.roles = authority.roles.map(
          ({ role }: { role: string }, index: number) => ({
            role,
            status: "ASSIGNED",
            actor_id: index + 1,
            actor_node_id: `node-${index + 1}`,
            actor_login: `actor-${index + 1}`,
            effective_from: "2026-08-30T00:00:00.000Z",
            effective_until: "2026-08-31T00:00:00.000Z",
            scope: { repository_id: 1291151138 },
            assignment_evidence: { kind: "EXTERNAL_UNOBSERVED" },
            revocation_status: "ACTIVE",
            superseded_by: null,
          }),
        );
        delete authority.roles[0].actor_id;
        await writeFile(authorityPath, JSON.stringify(authority));
      },
    },
    {
      name: "empty verifier definition",
      mutate: async (root) => {
        const contractPath = path.join(
          root,
          "docs/governance/program-c-merge-authorization-consumption.schema.json",
        );
        const contract = JSON.parse(await readFile(contractPath, "utf8"));
        contract.$defs.verifier = {};
        await writeFile(contractPath, JSON.stringify(contract));
      },
    },
    {
      name: "receipt required contract drift",
      mutate: async (root) => {
        const contractPath = path.join(
          root,
          "docs/governance/trusted-approval-readback.schema.json",
        );
        const contract = JSON.parse(await readFile(contractPath, "utf8"));
        contract.required = ["schema_version"];
        await writeFile(contractPath, JSON.stringify(contract));
      },
    },
    {
      name: "attestation closed-shape drift",
      mutate: async (root) => {
        const contractPath = path.join(
          root,
          "docs/governance/trusted-approval-evidence-manifest.schema.json",
        );
        const contract = JSON.parse(await readFile(contractPath, "utf8"));
        contract.properties.trusted_root.additionalProperties = true;
        await writeFile(contractPath, JSON.stringify(contract));
      },
    },
    {
      name: "consumption ADR enum drift",
      mutate: async (root) => {
        const contractPath = path.join(
          root,
          "docs/governance/program-c-merge-authorization-consumption.schema.json",
        );
        const contract = JSON.parse(await readFile(contractPath, "utf8"));
        contract.properties.decision_adr.enum[1] = "ADR-042";
        await writeFile(contractPath, JSON.stringify(contract));
      },
    },
    {
      name: "Release additionalProperties drift",
      mutate: async (root) => {
        const contractPath = path.join(
          root,
          "docs/governance/release-bundle.schema.json",
        );
        const contract = JSON.parse(await readFile(contractPath, "utf8"));
        contract.additionalProperties = true;
        await writeFile(contractPath, JSON.stringify(contract));
      },
    },
    {
      name: "duplicate authority key",
      mutate: async (root) => {
        const authorityPath = path.join(
          root,
          "docs/governance/approval-authorities.json",
        );
        const text = await readFile(authorityPath, "utf8");
        await writeFile(
          authorityPath,
          text.replace(
            '"schema_version": "approval-authorities/v1",',
            '"schema_version": "approval-authorities/v1",\n  "schema_version": "approval-authorities/v1",',
          ),
        );
      },
    },
    {
      name: "fatal UTF-8",
      mutate: async (root) => {
        await writeFile(
          path.join(root, "docs/governance/approval-authorities.json"),
          Buffer.from([0xff]),
        );
      },
    },
    {
      name: "symlink",
      mutate: async (root) => {
        const authorityPath = path.join(
          root,
          "docs/governance/approval-authorities.json",
        );
        await rm(authorityPath);
        await symlink(
          path.join(
            REPOSITORY_ROOT,
            "docs/governance/approval-authorities.json",
          ),
          authorityPath,
        );
      },
    },
    {
      name: "directory",
      mutate: async (root) => {
        const authorityPath = path.join(
          root,
          "docs/governance/approval-authorities.json",
        );
        await rm(authorityPath);
        await mkdir(authorityPath);
      },
    },
    {
      name: "oversized",
      mutate: async (root) => {
        await writeFile(
          path.join(root, "docs/governance/approval-authorities.json"),
          "x".repeat(64 * 1024 + 1),
        );
      },
    },
    {
      name: "missing",
      mutate: async (root) => {
        await rm(path.join(root, "docs/governance/approval-authorities.json"));
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const root = await fixture();
      try {
        await writeApprovalFixture(root);
        await mutation.mutate(root);
        assertNoApprovalProjection(await approvalGraph(root));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test(
  "FIFO approval input fails quickly without blocking Markdown extraction",
  { timeout: 2_000 },
  async () => {
    const root = await fixture();
    try {
      await writeApprovalFixture(root);
      const authorityPath = path.join(
        root,
        "docs/governance/approval-authorities.json",
      );
      await rm(authorityPath);
      await execFileAsync("/usr/bin/mkfifo", [authorityPath]);
      const startedAt = Date.now();
      assertNoApprovalProjection(await approvalGraph(root));
      assert.ok(Date.now() - startedAt < 1_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
