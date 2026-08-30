import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  inspectApprovalAttestationToolchain,
  verifyApprovalAttestation,
} from './governance-approval-attestation.mjs';
import {
  buildApprovalReceiptArtifact,
  renderApprovalReceiptCore,
} from './governance-approval-safe-json.mjs';

const GH_PATH = '/opt/global/toolchains/gh/2.89.0/bin/gh';
const REPOSITORY = 'mlhjyx/global-backend';
const WORKFLOW = 'mlhjyx/global-governance-verifier/.github/workflows/approval-signer.yml';
const WORKFLOW_SHA = 'd'.repeat(40);
const SOURCE_SHA = 'e'.repeat(40);
const VERIFIED_AT = '2026-08-30T12:00:00.000Z';
const VALID_UNTIL = '2026-08-30T13:00:00.000Z';
const MAX_OUTPUT_BYTES = 1_048_576;
const EXEC_TIMEOUT_MS = 30_000;
const SAFE_EXEC_ENV = Object.freeze({
  GH_CONFIG_DIR: '/nonexistent',
  GH_PROMPT_DISABLED: '1',
  LANG: 'C',
  LC_ALL: 'C',
  NO_COLOR: '1',
});

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = (character) => `sha256:${character.repeat(64)}`;

const approvalCore = () => ({
  receipt_id: 'approval-receipt-task6-0001',
  repository: { id: 1291151138, full_name: REPOSITORY },
  authority_revision: 'approval-authorities/r1',
  authority_sha256: digest('a'),
  role: 'OWN-PRODUCT',
  actor_id: 42,
  actor_login: 'approval-owner',
  decision_adr: 'ADR-027',
  decision_revision: 'program-c/decision-r1',
  policy_revision: 'program-c/policy-r1',
  pr_number: 426,
  base_sha: 'b'.repeat(40),
  head_sha: 'c'.repeat(40),
  approved_at: '2026-08-30T11:30:00.000Z',
  trust_class: 'TRUSTED_BASE_VERIFIED',
  machine_check_evidence: [{
    github_app_id: 15368,
    github_app_slug: 'github-actions',
    check_run_id: 81001,
    check_suite_id: 71001,
    context: 'approval/readback',
    workflow_id: 61001,
    workflow_path: '.github/workflows/approval-readback.yml',
    trusted_base_workflow_blob_sha: 'd'.repeat(40),
    actions_run_id: 51001,
    actions_run_attempt: 1,
    actions_run_event: 'pull_request_target',
    actions_run_head_sha: 'c'.repeat(40),
    actions_run_conclusion: 'success',
    reusable_signer: null,
  }],
});

const verificationJson = (rawDigest, overrides = {}) => ({
  verificationResult: {
    signature: {
      certificate: {
        issuer: 'https://token.actions.githubusercontent.com',
        buildSignerUri: `https://github.com/${WORKFLOW}@refs/heads/main`,
        buildSignerDigest: WORKFLOW_SHA,
        runnerEnvironment: 'github-hosted',
        sourceRepositoryUri: `https://github.com/${REPOSITORY}`,
        sourceRepositoryDigest: SOURCE_SHA,
        sourceRepositoryRef: 'refs/heads/main',
        ...(overrides.certificate ?? {}),
      },
    },
    statement: {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{
        name: 'receipt.json',
        digest: { sha256: rawDigest.slice('sha256:'.length) },
      }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: { untrusted: 'must-never-be-projected' },
      ...(overrides.statement ?? {}),
    },
  },
});

const fixture = () => {
  const artifact = buildApprovalReceiptArtifact(approvalCore());
  const receiptCoreBytes = renderApprovalReceiptCore(artifact.envelope.core);
  const bundleBytes = Buffer.from('fixture-sigstore-bundle\n', 'utf8');
  const trustedRootBytes = Buffer.from('fixture-trusted-root\n', 'utf8');
  const rawHex = artifact.receiptRawSha256.slice('sha256:'.length);
  const manifest = {
    schema_version: 'trusted-approval-evidence-manifest/v1',
    path_bytes_bound: false,
    receipt_id: artifact.envelope.core.receipt_id,
    receipt_core_sha256: artifact.receiptCoreSha256,
    receipt_raw_sha256: artifact.receiptRawSha256,
    attestation_subject_sha256: artifact.receiptRawSha256,
    files: [
      { path: 'receipt-core.json', sha256: artifact.receiptCoreSha256 },
      { path: 'receipt.json', sha256: artifact.receiptRawSha256 },
    ],
    attestation_bundle: {
      path: `sha256-${rawHex}.jsonl`,
      sha256: sha256(bundleBytes),
    },
    trusted_root: {
      path: 'trusted_root.jsonl',
      sha256: sha256(trustedRootBytes),
      acquired_at: '2026-08-30T11:00:00.000Z',
      gh_path: GH_PATH,
      gh_version: '2.89.0',
      gh_binary_sha256: digest('9'),
      owner_uid: 0,
      owner_gid: 0,
      mode: '0755',
      file_identity: {
        device: '2049',
        inode: '427001',
        size: 48_000_000,
        mtime_ns: '1788087600000000000',
        ctime_ns: '1788087600000000000',
      },
      observed_at: '2026-08-30T11:05:00.000Z',
      tuf_source: 'GH_ATTESTATION_TRUSTED_ROOT',
    },
  };
  return {
    artifact,
    output: verificationJson(artifact.receiptRawSha256),
    input: {
      ghPath: GH_PATH,
      receiptCorePath: '/evidence/receipt-core.json',
      receiptCoreBytes,
      receiptPath: '/evidence/receipt.json',
      receiptBytes: artifact.bytes,
      bundlePath: `/evidence/${manifest.attestation_bundle.path}`,
      bundleBytes,
      trustedRootPath: '/evidence/trusted_root.jsonl',
      trustedRootBytes,
      manifest,
      expected: {
        repository: REPOSITORY,
        signerWorkflow: WORKFLOW,
        signerDigest: WORKFLOW_SHA,
        sourceRef: 'refs/heads/main',
        sourceDigest: SOURCE_SHA,
        oidcIssuer: 'https://token.actions.githubusercontent.com',
        runnerEnvironment: 'github-hosted',
      },
      lifecycle: {
        verifiedAt: VERIFIED_AT,
        validUntil: VALID_UNTIL,
        revokedReceiptIds: [],
        supersededReceiptIds: [],
      },
    },
  };
};

const runnerFor = (output, overrides = {}) => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args: [...args], options: { ...options } });
    if (args.length === 1 && args[0] === '--version') {
      if (overrides.versionThrow) throw new Error('sensitive-version-error');
      return {
        exitCode: overrides.versionExitCode ?? 0,
        stdout: overrides.versionOutput ?? 'gh version 2.89.0 (2026-08-26)\nhttps://github.com/cli/cli/releases/tag/v2.89.0\n',
        stderr: '',
      };
    }
    if (args.length === 3 && args.join(' ') === 'attestation verify --help') {
      if (overrides.helpThrow) throw new Error('sensitive-help-error');
      return { exitCode: overrides.helpExitCode ?? 0, stdout: 'Verify an artifact attestation\n', stderr: '' };
    }
    if (overrides.verifyThrow) throw new Error('sensitive-attestation-error');
    return {
      exitCode: overrides.verifyExitCode ?? 0,
      stdout: overrides.verifyStdout ?? JSON.stringify([output]),
      stderr: overrides.verifyStderr ?? '',
    };
  };
  return { calls, runner };
};

const expectCode = async (input, runner, code) => {
  await assert.rejects(
    () => verifyApprovalAttestation(input, runner),
    (error) => error.message === code,
  );
};

const rebindReceiptBytes = (state, bytes) => {
  const rawDigest = sha256(bytes);
  state.input.receiptBytes = bytes;
  state.input.manifest.receipt_raw_sha256 = rawDigest;
  state.input.manifest.attestation_subject_sha256 = rawDigest;
  state.input.manifest.files[1].sha256 = rawDigest;
  state.input.manifest.attestation_bundle.path = `sha256-${rawDigest.slice('sha256:'.length)}.jsonl`;
  state.input.bundlePath = `/evidence/${state.input.manifest.attestation_bundle.path}`;
  state.output = verificationJson(rawDigest);
};

const expectedSyntheticHold = (state) => ({
  schemaVersion: 'approval-attestation-contract-result/v1',
  contractStatus: 'PASS',
  verificationStatus: 'HOLD',
  evidenceTrustState: 'EXTERNAL_UNVERIFIED',
  trustEligible: false,
  pathBytesBound: false,
  toolchainIdentityBound: false,
  signerAuthorityBound: false,
  lifecycleAuthorityBound: false,
  blockingCodes: ['APPROVAL_INDEPENDENCE_NOT_PROVEN'],
  syntheticComparison: {
    receiptId: state.artifact.envelope.core.receipt_id,
    receiptCoreSha256: state.artifact.receiptCoreSha256,
    receiptRawSha256: state.artifact.receiptRawSha256,
    repository: state.input.expected.repository,
    signerWorkflow: state.input.expected.signerWorkflow,
    signerDigest: state.input.expected.signerDigest,
    sourceRef: state.input.expected.sourceRef,
    sourceDigest: state.input.expected.sourceDigest,
    oidcIssuer: state.input.expected.oidcIssuer,
    runnerEnvironment: state.input.expected.runnerEnvironment,
    observedAt: state.input.lifecycle.verifiedAt,
    toolchainPath: GH_PATH,
    toolchainVersion: '2.89.0',
  },
});

test('toolchain inspection can only report synthetic contract pass and HOLD', () => {
  assert.deepEqual(inspectApprovalAttestationToolchain({
    ghPath: GH_PATH,
    versionOutput: 'gh version 2.89.0\nTHIS IS CALLER-SUPPLIED, NOT A BINARY IDENTITY\n',
    attestationHelpExitCode: 0,
  }), {
    status: 'HOLD',
    version: null,
    contractStatus: 'SYNTHETIC_CONTRACT_PASS',
    syntheticVersion: '2.89.0',
    code: 'APPROVAL_INDEPENDENCE_NOT_PROVEN',
  });

  for (const [name, input, expected] of [
    ['current host lacks attestation', { ghPath: '/usr/bin/gh', versionOutput: 'gh version 2.46.0 (2024-02-28 Ubuntu 2.46.0-1ubuntu0.3)\n', attestationHelpExitCode: 1 }, 'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE'],
    ['relative path', { ghPath: 'gh', versionOutput: 'gh version 2.89.0\n', attestationHelpExitCode: 0 }, 'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE'],
    ['other version', { ghPath: GH_PATH, versionOutput: 'gh version 2.88.1\n', attestationHelpExitCode: 0 }, 'APPROVAL_ATTESTATION_TOOLCHAIN_VERSION_MISMATCH'],
    ['version suffix', { ghPath: GH_PATH, versionOutput: 'gh version 2.89.0-evil\n', attestationHelpExitCode: 0 }, 'APPROVAL_ATTESTATION_TOOLCHAIN_VERSION_MISMATCH'],
  ]) {
    const result = inspectApprovalAttestationToolchain(input);
    assert.equal(result.status, 'HOLD', name);
    assert.equal(result.version, null, name);
    assert.equal(result.contractStatus, 'FAIL', name);
    assert.equal(result.syntheticVersion, null, name);
    assert.equal(result.code, expected, name);
    assert.equal(Object.isFrozen(result), true, name);
  }
});

test('verification uses exact hardened execFile options but returns only a synthetic typed HOLD', async () => {
  const state = fixture();
  const injected = runnerFor(state.output);
  const result = await verifyApprovalAttestation(state.input, injected.runner);
  const expectedArgv = [
    'attestation', 'verify', state.input.receiptPath,
    '--bundle', state.input.bundlePath,
    '--custom-trusted-root', state.input.trustedRootPath,
    '--repo', REPOSITORY,
    '--signer-workflow', WORKFLOW,
    '--signer-digest', WORKFLOW_SHA,
    '--source-ref', 'refs/heads/main',
    '--source-digest', SOURCE_SHA,
    '--deny-self-hosted-runners',
    '--format', 'json',
  ];
  assert.deepEqual(injected.calls.map(({ file, args }) => [file, args]), [
    [GH_PATH, ['--version']],
    [GH_PATH, ['attestation', 'verify', '--help']],
    [GH_PATH, expectedArgv],
  ]);
  for (const { options } of injected.calls) {
    assert.deepEqual(Object.keys(options).sort(), [
      'encoding', 'env', 'killSignal', 'maxBuffer', 'shell', 'signal', 'timeout', 'windowsHide',
    ]);
    assert.equal(options.shell, false);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.maxBuffer, MAX_OUTPUT_BYTES);
    assert.equal(options.timeout, EXEC_TIMEOUT_MS);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.signal instanceof AbortSignal, true);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(options.env, SAFE_EXEC_ENV);
    assert.deepEqual(Object.keys(options.env).sort(), Object.keys(SAFE_EXEC_ENV).sort());
  }
  assert.deepEqual(result, expectedSyntheticHold(state));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.syntheticComparison), true);
  assert.equal(Object.isFrozen(result.blockingCodes), true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 32_768);
  assert.equal(JSON.stringify(result).includes('must-never-be-projected'), false);
  assert.equal(JSON.stringify(result).includes('"status":"VERIFIED"'), false);
  assert.equal(JSON.stringify(result).includes('TRUSTED_BASE_VERIFIED'), false);
});

test('caller-selected signer and omitted lifecycle horizon stay synthetic and trust-ineligible', async () => {
  const state = fixture();
  state.input.expected.signerWorkflow = 'attacker/untrusted/.github/workflows/self-signed.yml';
  state.input.expected.signerDigest = 'f'.repeat(40);
  state.output.verificationResult.signature.certificate.buildSignerUri =
    `https://github.com/${state.input.expected.signerWorkflow}@refs/heads/main`;
  state.output.verificationResult.signature.certificate.buildSignerDigest =
    state.input.expected.signerDigest;
  state.input.lifecycle.revokedReceiptIds = [];
  state.input.lifecycle.supersededReceiptIds = [];

  const result = await verifyApprovalAttestation(state.input, runnerFor(state.output).runner);
  assert.deepEqual(result, expectedSyntheticHold(state));
  assert.equal(result.signerAuthorityBound, false);
  assert.equal(result.lifecycleAuthorityBound, false);
  assert.equal(result.trustEligible, false);
});

test('missing command paths cannot become path-bound evidence even when injected execution matches', async () => {
  const state = fixture();
  state.input.receiptPath = '/__task6_missing__/receipt.json';
  state.input.bundlePath = `/__task6_missing__/${state.input.manifest.attestation_bundle.path}`;
  state.input.trustedRootPath = '/__task6_missing__/trusted_root.jsonl';
  const result = await verifyApprovalAttestation(state.input, runnerFor(state.output).runner);
  assert.deepEqual(result, expectedSyntheticHold(state));
  assert.equal(result.pathBytesBound, false);
  assert.equal(result.verificationStatus, 'HOLD');
});

test('the local contract requires receipt-core path and bytes but never claims those paths are bound', async () => {
  const state = fixture();
  state.input.receiptCorePath = '/__task6_missing__/receipt-core.json';
  state.input.receiptCoreBytes = renderApprovalReceiptCore(state.artifact.envelope.core);
  const result = await verifyApprovalAttestation(state.input, runnerFor(state.output).runner);
  assert.equal(result.pathBytesBound, false);
  assert.equal(result.verificationStatus, 'HOLD');
  assert.equal(result.syntheticComparison.receiptCoreSha256, sha256(state.input.receiptCoreBytes));
});

test('verification snapshots all caller-owned input before the first awaited command', async () => {
  const state = fixture();
  const injected = runnerFor(state.output);
  let invoked = false;
  const mutatingRunner = async (...args) => {
    if (!invoked) {
      invoked = true;
      state.input.expected.repository = 'attacker/repository';
      state.input.expected.signerWorkflow = 'attacker/repository/.github/workflows/attacker.yml';
      state.input.bundlePath = '/evidence/caller-mutated.jsonl';
      state.input.lifecycle.verifiedAt = '2026-08-30T12:59:59.999Z';
    }
    return injected.runner(...args);
  };
  const result = await verifyApprovalAttestation(state.input, mutatingRunner);
  assert.equal(result.syntheticComparison.repository, REPOSITORY);
  assert.equal(result.syntheticComparison.signerWorkflow, WORKFLOW);
  assert.equal(result.syntheticComparison.observedAt, VERIFIED_AT);
  assert.ok(injected.calls[2].args.includes(`/evidence/sha256-${result.syntheticComparison.receiptRawSha256.slice('sha256:'.length)}.jsonl`));
  assert.equal(injected.calls[2].args.includes('/evidence/caller-mutated.jsonl'), false);
});

test('toolchain failure is stable and prevents attestation execution', async () => {
  {
    const state = fixture();
    state.input.ghPath = '/usr/bin/gh';
    const injected = runnerFor(state.output);
    await expectCode(
      state.input,
      injected.runner,
      'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE',
    );
    assert.equal(injected.calls.length, 0);
  }
  for (const [name, overrides, code, expectedCalls] of [
    ['missing executable', { versionThrow: true }, 'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE', 1],
    ['wrong version', { versionOutput: 'gh version 2.88.1\n' }, 'APPROVAL_ATTESTATION_TOOLCHAIN_VERSION_MISMATCH', 1],
    ['missing command', { helpExitCode: 1 }, 'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE', 2],
    ['help error', { helpThrow: true }, 'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE', 2],
  ]) {
    const state = fixture();
    const injected = runnerFor(state.output, overrides);
    await expectCode(state.input, injected.runner, code);
    assert.equal(injected.calls.length, expectedCalls, name);
  }
});

test('nonzero, thrown, malformed, oversized, empty, and ambiguous verification output fail closed', async () => {
  const cases = [
    ['nonzero', { verifyExitCode: 1 }],
    ['throw', { verifyThrow: true }],
    ['malformed', { verifyStdout: '{"verificationResult":' }],
    ['oversized', { verifyStdout: 'x'.repeat(MAX_OUTPUT_BYTES + 1) }],
    ['not-array', { verifyStdout: JSON.stringify({ verificationResult: {} }) }],
    ['empty', { verifyStdout: '[]' }],
    ['ambiguous', { verifyStdout: JSON.stringify([fixture().output, fixture().output]) }],
  ];
  for (const [name, overrides] of cases) {
    const state = fixture();
    const injected = runnerFor(state.output, overrides);
    await expectCode(state.input, injected.runner, 'APPROVAL_ATTESTATION_REQUIRED');
    assert.equal(injected.calls.length, 3, name);
  }
});

test('receipt raw bytes, internal core digest, bundle bytes, and raw-SHA filename are independent gates', async () => {
  {
    const state = fixture();
    state.input.receiptBytes = Buffer.concat([state.input.receiptBytes, Buffer.from(' ')]);
    const injected = runnerFor(state.output);
    await expectCode(state.input, injected.runner, 'APPROVAL_RECEIPT_RAW_DIGEST_MISMATCH');
    assert.equal(injected.calls.length, 0);
  }
  {
    const state = fixture();
    const receipt = structuredClone(state.artifact.envelope);
    receipt.receipt_core_sha256 = digest('f');
    rebindReceiptBytes(state, Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8'));
    const injected = runnerFor(state.output);
    await expectCode(state.input, injected.runner, 'APPROVAL_RECEIPT_CORE_DIGEST_MISMATCH');
    assert.equal(injected.calls.length, 0);
  }
  {
    const state = fixture();
    state.input.bundleBytes[0] ^= 0x01;
    await expectCode(state.input, runnerFor(state.output).runner, 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED');
  }
  for (const [name, path] of [
    ['core digest', `sha256-${fixture().artifact.receiptCoreSha256.slice('sha256:'.length)}.jsonl`],
    ['receipt id', 'approval-receipt-task6-0001.jsonl'],
    ['run id', 'sha256-51001.jsonl'],
    ['caller text', `sha256-${'f'.repeat(64)}.jsonl`],
  ]) {
    const state = fixture();
    state.input.manifest.attestation_bundle.path = path;
    state.input.bundlePath = `/evidence/${path}`;
    await expectCode(state.input, runnerFor(state.output).runner, 'APPROVAL_ATTESTATION_PATH_MISMATCH');
    assert.ok(name.length > 0);
  }
});

test('trusted root bytes, fixed filename, acquisition, TUF source, and pinned toolchain are all bound', async () => {
  const cases = [
    ['root byte drift', (state) => { state.input.trustedRootBytes[0] ^= 0x01; }, 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED'],
    ['receipt-derived alias', (state) => {
      const alias = `trusted_root-${state.artifact.receiptRawSha256.slice('sha256:'.length)}.jsonl`;
      state.input.trustedRootPath = `/evidence/${alias}`;
      state.input.manifest.trusted_root.path = alias;
    }, 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED'],
    ['digest', (state) => { state.input.manifest.trusted_root.sha256 = digest('f'); }, 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED'],
    ['acquired', (state) => { state.input.manifest.trusted_root.acquired_at = '2026-08-30T11:00:00Z'; }, 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED'],
    ['TUF source', (state) => { state.input.manifest.trusted_root.tuf_source = 'CALLER_ASSERTED'; }, 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED'],
    ['gh path', (state) => { state.input.manifest.trusted_root.gh_path = '/usr/bin/gh'; }, 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED'],
    ['gh version', (state) => { state.input.manifest.trusted_root.gh_version = '2.88.1'; }, 'APPROVAL_ATTESTATION_TOOLCHAIN_VERSION_MISMATCH'],
  ];
  for (const [name, mutate, code] of cases) {
    const state = fixture();
    mutate(state);
    const injected = runnerFor(state.output);
    await expectCode(state.input, injected.runner, code);
    assert.equal(injected.calls.length, 0, name);
  }
});

test('the attested subject and every signer/source identity field are independently compared', async () => {
  const state = fixture();
  state.output.verificationResult.statement.subject[0].digest.sha256 = 'f'.repeat(64);
  await expectCode(state.input, runnerFor(state.output).runner, 'APPROVAL_ATTESTATION_SUBJECT_MISMATCH');

  for (const [name, mutate, code] of [
    ['subject name', (value) => { value.verificationResult.statement.subject[0].name = 'caller.json'; }, 'APPROVAL_ATTESTATION_SUBJECT_MISMATCH'],
    ['multiple subjects', (value) => { value.verificationResult.statement.subject.push(value.verificationResult.statement.subject[0]); }, 'APPROVAL_ATTESTATION_SUBJECT_MISMATCH'],
    ['issuer', (value) => { value.verificationResult.signature.certificate.issuer = 'https://issuer.invalid'; }, 'APPROVAL_ATTESTATION_SIGNER_MISMATCH'],
    ['workflow', (value) => { value.verificationResult.signature.certificate.buildSignerUri = 'https://github.com/attacker/repo/.github/workflows/approval.yml@refs/heads/main'; }, 'APPROVAL_ATTESTATION_SIGNER_MISMATCH'],
    ['workflow digest', (value) => { value.verificationResult.signature.certificate.buildSignerDigest = 'f'.repeat(40); }, 'APPROVAL_ATTESTATION_SIGNER_MISMATCH'],
    ['repository', (value) => { value.verificationResult.signature.certificate.sourceRepositoryUri = 'https://github.com/attacker/repo'; }, 'APPROVAL_ATTESTATION_SIGNER_MISMATCH'],
    ['source ref', (value) => { value.verificationResult.signature.certificate.sourceRepositoryRef = 'refs/pull/1/merge'; }, 'APPROVAL_ATTESTATION_SIGNER_MISMATCH'],
    ['source digest', (value) => { value.verificationResult.signature.certificate.sourceRepositoryDigest = 'f'.repeat(40); }, 'APPROVAL_ATTESTATION_SIGNER_MISMATCH'],
    ['self hosted', (value) => { value.verificationResult.signature.certificate.runnerEnvironment = 'self-hosted'; }, 'APPROVAL_ATTESTATION_SELF_HOSTED_DENIED'],
  ]) {
    const candidate = fixture();
    mutate(candidate.output);
    await expectCode(candidate.input, runnerFor(candidate.output).runner, code);
    assert.ok(name.length > 0);
  }
});

test('expired, revoked, superseded, and malformed lifecycle context never verifies', async () => {
  const cases = [
    ['expired', (state) => { state.input.lifecycle.verifiedAt = VALID_UNTIL; }, 'APPROVAL_RECEIPT_EXPIRED'],
    ['revoked', (state) => { state.input.lifecycle.revokedReceiptIds.push(state.artifact.envelope.core.receipt_id); }, 'APPROVAL_POLICY_REVOKED'],
    ['superseded', (state) => { state.input.lifecycle.supersededReceiptIds.push(state.artifact.envelope.core.receipt_id); }, 'APPROVAL_RECEIPT_SUPERSEDED'],
    ['ambiguous lifecycle', (state) => { state.input.lifecycle.revokedReceiptIds.push(state.artifact.envelope.core.receipt_id, state.artifact.envelope.core.receipt_id); }, 'APPROVAL_RECEIPT_REQUIRED'],
  ];
  for (const [name, mutate, code] of cases) {
    const state = fixture();
    mutate(state);
    const injected = runnerFor(state.output);
    await expectCode(state.input, injected.runner, code);
    assert.equal(injected.calls.length, 0, name);
  }
});
