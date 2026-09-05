import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  canonicalJsonBytes,
  APPROVED_PLAN,
  APPROVED_SPEC,
  renderRootWrapper,
} from "./governance-organization-identity-launcher.mjs";
import {
  observeMaterializationBytes,
  materializationGit,
  materializationGitSource,
  verifyMaterializationGitIdentity,
  inspectMaterializationPacketFacts,
  verifyMaterializationDestinations,
  verifyMaterializationOutput,
  writeExclusiveMaterializationOutput,
  MATERIALIZATION_RUNNING_ROOT as REPO,
} from "./governance-organization-identity-materialization-preflight.mjs";
import {
  buildDiagnosticLauncherMaterializationPacket,
  buildDiagnosticLauncherMaterializationPacketReviewReceipt,
  buildDiagnosticLauncherRootMaterializationRequest,
  validateLauncherMaterializationPacketStructure,
  validateLauncherMaterializationPacketReviewReceiptStructure,
  validateLauncherRootMaterializationRequestStructure,
} from "./governance-organization-identity-root-materialization-packet.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => hash(canonicalJsonBytes(value));
const equal = (a, b) => digest(a) === digest(b);
const fail = (code) => {
  throw Error(code);
};
const requireFact = (ok, code) => {
  if (!ok) fail(code);
};
const safe = (fn) => {
  try {
    return fn();
  } catch (error) {
    return {
      status: "HOLD",
      code: /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "INPUT_UNAVAILABLE_OR_UNSAFE",
    };
  }
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const commit = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const script = (name) => `scripts/governance-organization-identity-${name}`;
const A_PATHS = [
  "root-materialization-packet.mjs",
  "root-materialization-packet.spec.mjs",
  "materialization-preflight.mjs",
  "materialization-preflight.spec.mjs",
  "materialization-handoff.mjs",
  "materialization-handoff.spec.mjs",
].map(script);
const CLOSURE = [
  ...A_PATHS,
  script("launcher.mjs"),
  ...[
    "launcher-execution.spec.mjs",
    "launcher-trust.spec.mjs",
    "launcher-request.spec.mjs",
    "test-fixtures.mjs",
  ].map(script),
];
const B_PATHS = [
  script("bootstrap.mjs"),
  script("bootstrap.spec.mjs"),
  script("bootstrap-supplemental.spec.mjs"),
  "docs/governance/organization-identity-bootstrap-contract.json",
];
const ROLES = [
  "ENV",
  "NODE",
  "GIT",
  "COREPACK_SHIM",
  "COREPACK_LIB_COREPACK_CJS",
  "PNPM_SHIM",
  "PNPM_ENTRYPOINT",
];
const KEYS = [
  "schemaVersion",
  "phaseABaseCommit",
  "phaseACommit",
  "phaseBCommit",
  "approvedPlan",
  "approvedSpec",
  "sourceRoots",
  "sources",
  "reviewRoots",
  "reviews",
];
const git = (args) => materializationGit(REPO, args);
const textGit = (args) => git(args).toString().trim();
const startedBytes = Object.fromEntries(
  CLOSURE.map((file) => {
    try {
      return [
        file,
        observeMaterializationBytes(path.join(REPO, file), [REPO]).sha256,
      ];
    } catch {
      return [file, null];
    }
  }),
);
function identity(at, file) {
  requireFact(commit(at), "COMMIT_INVALID");
  const object = `${at}:${file}`;
  const bytes = git(["cat-file", "blob", object]);
  return {
    commit: at,
    blobId: textGit(["rev-parse", "--verify", object]),
    sha256: hash(bytes),
    size: bytes.length,
  };
}
function checkDisk(at, file) {
  const id = identity(at, file);
  requireFact(
    verifyMaterializationGitIdentity(REPO, file, id).status ===
      "LOCAL_FACTS_VERIFIED",
    "CODE_DISK_OR_STATUS_MISMATCH",
  );
  if (CLOSURE.includes(file))
    requireFact(
      startedBytes[file] === id.sha256,
      "RESTART_FROM_COMMITTED_PHASE_A_REQUIRED",
    );
  return id;
}
function checkRange(base, head, allowed, code) {
  git(["merge-base", "--is-ancestor", base, head]);
  const commits = textGit(["rev-list", "--reverse", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
  requireFact(commits.length > 0, code);
  for (const at of commits) {
    const changed = textGit([
      "diff-tree",
      "--root",
      "-m",
      "--no-commit-id",
      "--name-only",
      "-r",
      at,
    ])
      .split("\n")
      .filter(Boolean);
    requireFact(
      changed.every((file) => allowed.includes(file)),
      code,
    );
  }
}
function rootsValid(roots) {
  return (
    Array.isArray(roots) &&
    roots.length > 0 &&
    new Set(roots).size === roots.length &&
    roots.every(
      (root) =>
        typeof root === "string" &&
        path.isAbsolute(root) &&
        root !== "/" &&
        path.normalize(root) === root &&
        realpathSync(root) === root &&
        lstatSync(root).isDirectory(),
    )
  );
}
export function observeMaterializationSource(source, roots) {
  return safe(() => {
    requireFact(
      exact(source, ["role", "path"]) &&
        ROLES.includes(source.role) &&
        rootsValid(roots),
      "SOURCE_SELECTION_INVALID",
    );
    const observed = observeMaterializationBytes(
      source.path,
      roots,
      source.role,
    );
    return {
      role: source.role,
      path: source.path,
      observation: {
        ...observed.observation,
        sha256: observed.sha256,
      },
    };
  });
}
function inspectHandoff(handoff, phaseB) {
  requireFact(
    exact(handoff, KEYS) &&
      handoff.schemaVersion ===
        "organization-identity-materialization-handoff/v1",
    "HANDOFF_INVALID",
  );
  requireFact(
    commit(handoff.phaseABaseCommit) &&
      commit(handoff.phaseACommit) &&
      (handoff.phaseBCommit === null || commit(handoff.phaseBCommit)),
    "HANDOFF_COMMIT_INVALID",
  );
  requireFact(
    equal(handoff.approvedPlan, APPROVED_PLAN) &&
      equal(handoff.approvedSpec, APPROVED_SPEC),
    "APPROVED_PLAN_SPEC_MISMATCH",
  );
  requireFact(
    rootsValid(handoff.sourceRoots) && rootsValid(handoff.reviewRoots),
    "HANDOFF_ROOTS_INVALID",
  );
  requireFact(
    exact(handoff.reviews, ["plan", "phaseA", "phaseB"]),
    "PREREQUISITE_REVIEW_KEYS_INVALID",
  );
  requireFact(
    Array.isArray(handoff.sources) &&
      equal(handoff.sources[2], materializationGitSource()),
    "GIT_SOURCE_BINDING_MISMATCH",
  );
  const head = textGit(["rev-parse", "HEAD"]);
  requireFact(
    head === (phaseB ? handoff.phaseBCommit : handoff.phaseACommit),
    "HEAD_MISMATCH",
  );
  checkRange(
    handoff.phaseABaseCommit,
    handoff.phaseACommit,
    A_PATHS,
    "PHASE_A_SCOPE_INVALID",
  );
  const closure = Object.fromEntries(
    CLOSURE.map((file) => [file, checkDisk(handoff.phaseACommit, file)]),
  );
  for (const tuple of [APPROVED_PLAN, APPROVED_SPEC]) {
    const id = checkDisk(tuple.commit, tuple.path);
    requireFact(
      id.blobId === tuple.blobId && id.sha256 === tuple.sha256,
      "APPROVED_GIT_IDENTITY_MISMATCH",
    );
  }
  if (phaseB) {
    requireFact(
      handoff.phaseBCommit !== handoff.phaseACommit,
      "PHASE_B_REQUIRED",
    );
    checkRange(
      handoff.phaseACommit,
      handoff.phaseBCommit,
      B_PATHS,
      "PHASE_B_SCOPE_INVALID",
    );
    for (const file of B_PATHS) checkDisk(handoff.phaseBCommit, file);
  }
  requireFact(
    Array.isArray(handoff.sources) && handoff.sources.length === 7,
    "SOURCE_CLOSURE_INVALID",
  );
  const sources = handoff.sources.map((source, index) => {
    requireFact(
      exact(source, ["role", "path", "observation"]) &&
        source.role === ROLES[index],
      "SOURCE_ROLE_INVALID",
    );
    const observed = observeMaterializationSource(
      { role: source.role, path: source.path },
      handoff.sourceRoots,
    );
    requireFact(
      observed.status !== "HOLD" && equal(source, observed),
      "SOURCE_OBSERVATION_DRIFT",
    );
    const stat = source.observation;
    return {
      role: source.role,
      logicalIdentity: `${source.role.toLowerCase()}@resolved`,
      sourceExecutablePath: source.path,
      sourceExecutablePathSha256: hash(source.path),
      sourceRealpathSha256: hash(source.path),
      sourceSha256: stat.sha256,
      sourceSize: Number(stat.size),
      sourceMode: Number(BigInt(stat.mode) & 0o7777n),
      sourcePathPolicy: "RESOLVED_REGULAR_FILE_ONLY",
      sourcePathKind: "REGULAR_FILE",
    };
  });
  return { sources, codeClosureSha256: digest(closure) };
}
function artifactFields(prefix, id) {
  return Object.fromEntries(
    Object.entries(id).map(([key, value]) => [
      `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
      value,
    ]),
  );
}
function artifacts(handoff, phaseB) {
  const records = [
    ["plan", APPROVED_PLAN.commit, APPROVED_PLAN.path],
    ["spec", APPROVED_SPEC.commit, APPROVED_SPEC.path],
    ["launcher", handoff.phaseACommit, script("launcher.mjs")],
    ["generator", handoff.phaseACommit, A_PATHS[0]],
    ["generatorSpec", handoff.phaseACommit, A_PATHS[1]],
  ];
  if (phaseB)
    records.push(
      ["bootstrap", handoff.phaseBCommit, B_PATHS[0]],
      ["bootstrapContract", handoff.phaseBCommit, B_PATHS[3]],
    );
  return Object.assign(
    {},
    ...records.map(([prefix, at, file]) =>
      artifactFields(prefix, identity(at, file)),
    ),
  );
}
function construct(handoff, phaseB) {
  const facts = inspectHandoff(handoff, phaseB);
  const approvedArtifacts = artifacts(handoff, phaseB);
  const template = buildDiagnosticLauncherMaterializationPacket({
    phaseASubjectCommit: handoff.phaseACommit,
    phaseBSubjectCommit: handoff.phaseBCommit,
    sourceToolClosure: facts.sources,
    overrides: { approvedArtifacts },
  });
  const wrapper = Buffer.from(
    renderRootWrapper({
      envPath: `${template.toolRoot}/bin/env`,
      environment: template.runtimeEnvironment,
      nodePath: `${template.toolRoot}/bin/node`,
      launcherPath: `${template.launcherRoot}/identity-writer-launch.mjs`,
    }),
  );
  const launcher = git([
    "cat-file",
    "blob",
    `${handoff.phaseACommit}:${script("launcher.mjs")}`,
  ]);
  const launcherFilePlan = template.launcherFilePlan.map((plan, i) => ({
    ...plan,
    sha256: hash(i === 0 ? wrapper : launcher),
    size: (i === 0 ? wrapper : launcher).length,
  }));
  const launcherContract = {
    ...template.launcherContract,
    approvedLauncher: {
      path: script("launcher.mjs"),
      commit: approvedArtifacts.launcherCommit,
      blobId: approvedArtifacts.launcherBlobId,
      sha256: approvedArtifacts.launcherSha256,
    },
    launcherFilePlan,
  };
  const bytes = canonicalJsonBytes(launcherContract);
  const launcherContractSha256 = hash(bytes);
  const packet = {
    ...template,
    launcherContract,
    launcherContractSha256,
    launcherFilePlan,
    contractFilePlan: {
      ...template.contractFilePlan,
      sha256: launcherContractSha256,
      size: bytes.length,
    },
  };
  return { packet, ...facts };
}
export function prepareLauncherMaterialization(handoff) {
  return safe(() => {
    const { packet, codeClosureSha256 } = construct(handoff, false);
    return {
      status: "PHASE_A_PREPARED_NOT_AUTHORIZED",
      launcherContract: packet.launcherContract,
      launcherContractSha256: packet.launcherContractSha256,
      sourceToolClosure: packet.sourceToolClosure,
      codeClosureSha256,
    };
  });
}
const SCOPES = {
  plan: ["AUTHORITY_MODEL", "PLAN_SPEC"],
  phaseA: [
    "PHASE_A_SCOPE",
    "SOURCE_BYTES",
    "GENERATOR_CLOSURE",
    "TESTS",
    "ACYCLIC_CONTRACT",
  ],
  phaseB: [
    "PHASE_B_SCOPE",
    "BOOTSTRAP_BYTES",
    "BOOTSTRAP_CONTRACT",
    "CONTRACT_REBIND",
    "TESTS",
  ],
  whole: [
    "SOURCE_BYTES",
    "GENERATOR_CLOSURE",
    "PLANNED_BYTES",
    "ROOT_DESTINATIONS",
    "WHOLE_PACKET",
    "ACYCLIC_CONTRACT",
    "SOURCE_DESTINATION_SEPARATION",
    "EXCLUSIVE_OUTPUT",
    "DRIFT",
    "HISTORICAL_HOLD",
  ],
};
function readDescriptor(descriptor, roots) {
  requireFact(
    exact(descriptor, ["path", "sha256", "size", "mode"]),
    "BYTE_DESCRIPTOR_INVALID",
  );
  const observed = observeMaterializationBytes(descriptor.path, roots);
  requireFact(
    observed.sha256 === descriptor.sha256 &&
      observed.size === descriptor.size &&
      observed.mode === descriptor.mode,
    "DESCRIPTOR_BYTES_MISMATCH",
  );
  return observed.bytes;
}
function review(descriptor, kind, subjects, roots) {
  requireFact(
    exact(descriptor, ["report", "counterexamples"]),
    "REVIEW_DESCRIPTOR_REQUIRED",
  );
  const report = readDescriptor(descriptor.report, roots).toString("utf8");
  readDescriptor(descriptor.counterexamples, roots);
  requireFact(
    descriptor.report.sha256 !== descriptor.counterexamples.sha256,
    "REVIEW_COUNTEREXAMPLES_INVALID",
  );
  for (const [key, value] of [
    ["Critical", "0"],
    ["Important", "0"],
    ["Verdict", "PASS"],
  ]) {
    const lines = report
      .split("\n")
      .filter((line) => line.startsWith(`${key}:`));
    requireFact(
      lines.length === 1 && lines[0] === `${key}: ${value}`,
      "REVIEW_VERDICT_INVALID",
    );
  }
  const bindings = report
    .split("\n")
    .filter((line) => line.startsWith("Materialization-Binding: "));
  requireFact(bindings.length === 1, "REVIEW_BINDING_REQUIRED");
  const binding = JSON.parse(
    bindings[0].slice("Materialization-Binding: ".length),
  );
  requireFact(
    exact(binding, [
      "schemaVersion",
      "kind",
      "scope",
      "subjects",
      "counterexampleSetSha256",
    ]) &&
      binding.schemaVersion ===
        "organization-identity-materialization-review-binding/v1" &&
      binding.kind === kind &&
      equal(binding.scope, SCOPES[kind]) &&
      equal(binding.subjects, subjects) &&
      binding.counterexampleSetSha256 === descriptor.counterexamples.sha256,
    "REVIEW_SCOPE_OR_SUBJECT_MISMATCH",
  );
  return descriptor.report.sha256;
}
function subjectsFor(handoff, built) {
  const plan = {
    approvedPlan: handoff.approvedPlan,
    approvedSpec: handoff.approvedSpec,
  };
  const phaseA = {
    ...plan,
    phaseABaseCommit: handoff.phaseABaseCommit,
    phaseACommit: handoff.phaseACommit,
    codeClosureSha256: built.codeClosureSha256,
  };
  const phaseB = {
    ...phaseA,
    phaseBCommit: handoff.phaseBCommit,
    launcherContractSha256: built.packet.launcherContractSha256,
    bootstrapSha256: built.packet.approvedArtifacts.bootstrapSha256,
    bootstrapContractSha256:
      built.packet.approvedArtifacts.bootstrapContractSha256,
  };
  return { plan, phaseA, phaseB };
}
function candidate(handoff) {
  const built = construct(handoff, true);
  const subjects = subjectsFor(handoff, built);
  const reviews = Object.fromEntries(
    ["plan", "phaseA", "phaseB"].map((kind) => [
      kind,
      review(handoff.reviews[kind], kind, subjects[kind], handoff.reviewRoots),
    ]),
  );
  const contract = JSON.parse(
    git(["cat-file", "blob", `${handoff.phaseBCommit}:${B_PATHS[3]}`]),
  );
  const bootstrap = git([
    "cat-file",
    "blob",
    `${handoff.phaseBCommit}:${B_PATHS[0]}`,
  ]).toString();
  const matches = [
    ...bootstrap.matchAll(
      /const ACCEPTED_LAUNCHER_CONTRACT_SHA256\s*=\s*"([a-f0-9]{64})";/g,
    ),
  ];
  requireFact(
    contract.launcherContractSha256 === built.packet.launcherContractSha256 &&
      matches.length === 1 &&
      matches[0][1] === built.packet.launcherContractSha256,
    "BOOTSTRAP_CONTRACT_REBIND_REQUIRED",
  );
  const packet = {
    ...built.packet,
    bootstrapFilePlan: {
      ...built.packet.bootstrapFilePlan,
      sha256: built.packet.approvedArtifacts.bootstrapSha256,
      size: built.packet.approvedArtifacts.bootstrapSize,
    },
    reviewIdentities: {
      authorityModelPlanReviewSha256: reviews.plan,
      task0LFinalCodeReviewSha256: reviews.phaseA,
      task0PFinalReviewSha256: reviews.phaseB,
    },
  };
  requireFact(
    validateLauncherMaterializationPacketStructure(packet).status === "PASS",
    "CANDIDATE_STRUCTURE_INVALID",
  );
  const targets = [
    packet.launcherRoot,
    packet.toolRoot,
    packet.runtimeRoot,
    packet.requestRoot,
    packet.outputRoot,
  ];
  requireFact(
    verifyMaterializationDestinations(targets).status ===
      "LOCAL_FACTS_VERIFIED",
    "ROOT_DESTINATIONS_UNAVAILABLE",
  );
  return {
    status: "CANDIDATE_READY_NOT_AUTHORIZED",
    packet,
    launcherMaterializationPacketSha256: digest(packet),
    wholeReviewSubjects: {
      ...subjects.phaseB,
      launcherMaterializationPacketSha256: digest(packet),
      sourceObservationSha256: digest(handoff.sources),
      sourceRootsSha256: digest(handoff.sourceRoots),
    },
  };
}
export function buildLauncherMaterializationPacket(options = {}) {
  if (!options.handoff)
    return { status: "HOLD", code: "SOURCE_FACTS_REQUIRED" };
  return safe(() => {
    requireFact(
      exact(options, ["handoff", "outputPath"]),
      "GENERATION_OPTIONS_INVALID",
    );
    requireFact(
      verifyMaterializationOutput(REPO, options.outputPath).status ===
        "LOCAL_FACTS_VERIFIED",
      "OUTPUT_NOT_ABSENT_IGNORED",
    );
    return candidate(options.handoff);
  });
}
export function validateLauncherMaterializationPacket(packet, handoff) {
  return safe(() => {
    const structure = validateLauncherMaterializationPacketStructure(packet);
    if (structure.status !== "PASS") return structure;
    if (!handoff) return inspectMaterializationPacketFacts(packet);
    const rebuilt = candidate(handoff);
    requireFact(equal(rebuilt.packet, packet), "PACKET_REOBSERVATION_MISMATCH");
    return rebuilt;
  });
}
function exclusive(outputPath, value, revalidate) {
  return writeExclusiveMaterializationOutput(
    REPO,
    outputPath,
    value,
    revalidate,
  );
}
export function writeLauncherMaterializationPacketFile({
  outputPath,
  packet,
  handoff,
}) {
  if (
    typeof outputPath !== "string" ||
    !path.isAbsolute(outputPath) ||
    path.normalize(outputPath) !== outputPath
  )
    return { status: "INTEGRITY_ERROR", code: "PACKET_OUTPUT_PATH_INVALID" };
  return safe(() => {
    const verify = () => {
      const result = validateLauncherMaterializationPacket(packet, handoff);
      requireFact(
        result.status === "CANDIDATE_READY_NOT_AUTHORIZED",
        result.code ?? "CANDIDATE_NOT_READY",
      );
    };
    verify();
    return {
      status: "CANDIDATE_WRITTEN_NOT_AUTHORIZED",
      ...exclusive(outputPath, packet, verify),
    };
  });
}
function requestFields(fields) {
  requireFact(
    exact(fields, ["handoff", "candidate", "wholeReview", "reviewReceiptPath"]),
    "REQUEST_FIELDS_INVALID",
  );
  const receiptPath = fields.reviewReceiptPath;
  requireFact(
    typeof receiptPath === "string" &&
      path.isAbsolute(receiptPath) &&
      path.normalize(receiptPath) === receiptPath &&
      receiptPath.startsWith(`${REPO}/`) &&
      receiptPath !== fields.candidate?.path &&
      realpathSync(path.dirname(receiptPath)) === path.dirname(receiptPath),
    "REVIEW_RECEIPT_PATH_INVALID",
  );
  const built = candidate(fields.handoff);
  const bytes = readDescriptor(fields.candidate, [REPO]);
  requireFact(
    bytes.equals(canonicalJsonBytes(built.packet)),
    "CANDIDATE_FILE_MISMATCH",
  );
  review(
    fields.wholeReview,
    "whole",
    built.wholeReviewSubjects,
    fields.handoff.reviewRoots,
  );
  const a = built.packet.approvedArtifacts;
  const receipt = buildDiagnosticLauncherMaterializationPacketReviewReceipt({
    launcherMaterializationPacketSha256: digest(built.packet),
    generatorCommit: a.generatorCommit,
    generatorBlobId: a.generatorBlobId,
    generatorSha256: a.generatorSha256,
    generatorSpecCommit: a.generatorSpecCommit,
    generatorSpecBlobId: a.generatorSpecBlobId,
    generatorSpecSha256: a.generatorSpecSha256,
    reportSha256: fields.wholeReview.report.sha256,
    counterexampleSetSha256: fields.wholeReview.counterexamples.sha256,
  });
  requireFact(
    validateLauncherMaterializationPacketReviewReceiptStructure(
      receipt,
      built.packet,
    ).status === "PASS",
    "REVIEW_RECEIPT_INVALID",
  );
  const request = buildDiagnosticLauncherRootMaterializationRequest({
    launcherMaterializationPacket: built.packet,
    launcherMaterializationPacketPath: fields.candidate.path,
    launcherMaterializationPacketReviewReceiptPath: fields.reviewReceiptPath,
    launcherMaterializationPacketReviewReceiptSha256: digest(receipt),
    ...Object.fromEntries(
      [
        "launcherRoot",
        "toolRoot",
        "runtimeRoot",
        "requestRoot",
        "outputRoot",
      ].map((key) => [key, built.packet[key]]),
    ),
  });
  requireFact(
    validateLauncherRootMaterializationRequestStructure(request, built.packet)
      .status === "PASS",
    "REQUEST_STRUCTURE_INVALID",
  );
  return { status: "READY_FOR_EXACT_AUTHORIZATION", request, receipt };
}
export function buildLauncherRootMaterializationRequest(fields) {
  return safe(() => requestFields(fields));
}
export function validateLauncherRootMaterializationRequest(
  request,
  packet,
  fields,
) {
  return safe(() => {
    requireFact(
      validateLauncherRootMaterializationRequestStructure(request, packet)
        .status === "PASS",
      "REQUEST_STRUCTURE_INVALID",
    );
    const built = requestFields(fields);
    requireFact(
      equal(request, built.request),
      "REQUEST_REOBSERVATION_MISMATCH",
    );
    return built;
  });
}
export function writeLauncherRootMaterializationRequestFile({
  outputPath,
  fields,
}) {
  return safe(() => {
    const built = requestFields(fields);
    // Check both exclusive outputs before writing either; retain evidence on later I/O failure.
    requireFact(
      outputPath !== fields.reviewReceiptPath &&
        verifyMaterializationOutput(REPO, outputPath).status ===
          "LOCAL_FACTS_VERIFIED" &&
        verifyMaterializationOutput(REPO, fields.reviewReceiptPath).status ===
          "LOCAL_FACTS_VERIFIED",
      "REQUEST_OUTPUTS_INVALID",
    );
    const verify = () =>
      requireFact(equal(requestFields(fields), built), "REQUEST_INPUT_DRIFT");
    const receiptFile = exclusive(
      fields.reviewReceiptPath,
      built.receipt,
      verify,
    );
    const requestFile = exclusive(outputPath, built.request, () => {
      verify();
      readDescriptor(
        {
          path: receiptFile.outputPath,
          sha256: receiptFile.sha256,
          size: receiptFile.size,
          mode: receiptFile.mode,
        },
        [REPO],
      );
    });
    return {
      ...built,
      requestFile,
      receiptFile,
      authority: "USER_EXACT_ROOT_AUTHORIZATION_STILL_REQUIRED",
    };
  });
}
