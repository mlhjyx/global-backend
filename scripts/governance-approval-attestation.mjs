import { basename, isAbsolute } from 'node:path';

import { deepFreeze } from './governance-approval-readback-common.mjs';
import {
  parseApprovalJson,
  sha256Prefixed,
} from './governance-approval-safe-json.mjs';
import {
  validateApprovalEvidenceManifest,
  validateApprovalReceipt,
} from './governance-approval-schema-validator.mjs';

const GH_PATH = '/opt/global/toolchains/gh/2.89.0/bin/gh';
const GH_VERSION = '2.89.0';
const REPOSITORY = 'mlhjyx/global-backend';
const SOURCE_REF = 'refs/heads/main';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const RUNNER_ENVIRONMENT = 'github-hosted';
const MAX_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 32_768;
const MAX_PATH_BYTES = 4_096;
const MAX_IDS = 64;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ID_PATTERN = /^[a-z][a-z0-9-]{7,127}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WORKFLOW_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/u;
const INPUT_KEYS = Object.freeze([
  'ghPath', 'receiptPath', 'receiptBytes', 'bundlePath', 'bundleBytes',
  'trustedRootPath', 'trustedRootBytes', 'manifest', 'expected', 'lifecycle',
]);
const EXPECTED_KEYS = Object.freeze([
  'repository', 'signerWorkflow', 'signerDigest', 'sourceRef', 'sourceDigest',
  'oidcIssuer', 'runnerEnvironment',
]);
const LIFECYCLE_KEYS = Object.freeze([
  'verifiedAt', 'validUntil', 'revokedReceiptIds', 'supersededReceiptIds',
]);
const EXEC_OPTIONS = Object.freeze({
  encoding: 'utf8',
  maxBuffer: MAX_BYTES,
  shell: false,
  windowsHide: true,
});

const approvalError = (code) => new Error(code);
const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);
const hasExactKeys = (value, keys) => (
  isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
);
const requireCondition = (condition, code) => {
  if (!condition) throw approvalError(code);
};
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const isBoundedString = (value, maximum = MAX_BYTES) => (
  typeof value === 'string'
  && !value.includes('\0')
  && byteLength(value) <= maximum
);
const isBytes = (value) => Buffer.isBuffer(value) && value.length > 0 && value.length <= MAX_BYTES;
const isAbsolutePath = (value) => (
  isBoundedString(value, MAX_PATH_BYTES)
  && isAbsolute(value)
  && basename(value).length > 0
);
const isCanonicalInstant = (value) => (
  typeof value === 'string'
  && INSTANT_PATTERN.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
);
const idsAreClosed = (values) => (
  Array.isArray(values)
  && values.length <= MAX_IDS
  && values.every((value) => typeof value === 'string' && ID_PATTERN.test(value))
  && new Set(values).size === values.length
);

const toolchainHold = (code) => deepFreeze({ status: 'HOLD', version: null, code });

export const inspectApprovalAttestationToolchain = (input) => {
  if (
    !hasExactKeys(input, ['ghPath', 'versionOutput', 'attestationHelpExitCode'])
    || input.ghPath !== GH_PATH
    || !isBoundedString(input.versionOutput, 4_096)
    || !Number.isSafeInteger(input.attestationHelpExitCode)
    || input.attestationHelpExitCode !== 0
  ) return toolchainHold('APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE');
  const version = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)(?: \([^\r\n]{1,256}\))?(?:\r?\n|$)/u.exec(
    input.versionOutput,
  )?.[1];
  if (version !== GH_VERSION) {
    return toolchainHold('APPROVAL_ATTESTATION_TOOLCHAIN_VERSION_MISMATCH');
  }
  return deepFreeze({ status: 'AVAILABLE', version: GH_VERSION, code: 'PASS' });
};

const parseReceipt = (bytes) => {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw approvalError('APPROVAL_RECEIPT_REQUIRED');
  }
  let receipt;
  try {
    receipt = parseApprovalJson(text, 'approval-receipt');
  } catch (error) {
    if (error?.message === 'APPROVAL_JSON_CORE_DIGEST') {
      throw approvalError('APPROVAL_RECEIPT_CORE_DIGEST_MISMATCH');
    }
    throw approvalError('APPROVAL_RECEIPT_REQUIRED');
  }
  const validation = validateApprovalReceipt(receipt);
  if (!validation.valid) {
    const coreMismatch = validation.issues.some(
      ({ stable_code: stableCode }) => stableCode === 'APPROVAL_RECEIPT_CORE_DIGEST_MISMATCH',
    );
    throw approvalError(coreMismatch ? 'APPROVAL_RECEIPT_CORE_DIGEST_MISMATCH' : 'APPROVAL_RECEIPT_REQUIRED');
  }
  return receipt;
};

const validateExpected = (expected, receipt) => {
  requireCondition(
    hasExactKeys(expected, EXPECTED_KEYS)
      && expected.repository === REPOSITORY
      && receipt.core.repository?.full_name === expected.repository
      && WORKFLOW_PATTERN.test(expected.signerWorkflow)
      && GIT_SHA_PATTERN.test(expected.signerDigest)
      && expected.sourceRef === SOURCE_REF
      && GIT_SHA_PATTERN.test(expected.sourceDigest)
      && expected.oidcIssuer === OIDC_ISSUER
      && expected.runnerEnvironment === RUNNER_ENVIRONMENT,
    'APPROVAL_ATTESTATION_SIGNER_MISMATCH',
  );
};

const validateLifecycle = (lifecycle, receiptId) => {
  requireCondition(
    hasExactKeys(lifecycle, LIFECYCLE_KEYS)
      && isCanonicalInstant(lifecycle.verifiedAt)
      && isCanonicalInstant(lifecycle.validUntil)
      && idsAreClosed(lifecycle.revokedReceiptIds)
      && idsAreClosed(lifecycle.supersededReceiptIds)
      && lifecycle.revokedReceiptIds.every((id) => !lifecycle.supersededReceiptIds.includes(id)),
    'APPROVAL_RECEIPT_REQUIRED',
  );
  requireCondition(
    Date.parse(lifecycle.verifiedAt) < Date.parse(lifecycle.validUntil),
    'APPROVAL_RECEIPT_EXPIRED',
  );
  requireCondition(!lifecycle.revokedReceiptIds.includes(receiptId), 'APPROVAL_POLICY_REVOKED');
  requireCondition(
    !lifecycle.supersededReceiptIds.includes(receiptId),
    'APPROVAL_RECEIPT_SUPERSEDED',
  );
};

const validateManifest = (input, receipt, receiptRawSha256) => {
  const { manifest } = input;
  const rawHex = receiptRawSha256.slice('sha256:'.length);
  const expectedBundleName = `sha256-${rawHex}.jsonl`;
  requireCondition(
    isPlainObject(manifest)
      && manifest.attestation_bundle?.path === expectedBundleName
      && basename(input.bundlePath) === expectedBundleName,
    'APPROVAL_ATTESTATION_PATH_MISMATCH',
  );
  if (manifest.trusted_root?.gh_version !== GH_VERSION) {
    throw approvalError('APPROVAL_ATTESTATION_TOOLCHAIN_VERSION_MISMATCH');
  }
  requireCondition(
    validateApprovalEvidenceManifest(manifest).valid,
    'APPROVAL_EVIDENCE_BUNDLE_REQUIRED',
  );
  requireCondition(
    manifest.receipt_id === receipt.core.receipt_id
      && manifest.receipt_core_sha256 === receipt.receipt_core_sha256
      && manifest.receipt_raw_sha256 === receiptRawSha256
      && manifest.attestation_subject_sha256 === receiptRawSha256
      && manifest.files[0].sha256 === receipt.receipt_core_sha256
      && manifest.files[1].sha256 === receiptRawSha256,
    'APPROVAL_RECEIPT_DIGEST_MISMATCH',
  );
  requireCondition(
    manifest.attestation_bundle.sha256 === sha256Prefixed(input.bundleBytes),
    'APPROVAL_EVIDENCE_BUNDLE_REQUIRED',
  );
  requireCondition(
    manifest.trusted_root.path === 'trusted_root.jsonl'
      && basename(input.trustedRootPath) === 'trusted_root.jsonl'
      && manifest.trusted_root.sha256 === sha256Prefixed(input.trustedRootBytes)
      && manifest.trusted_root.gh_path === GH_PATH
      && manifest.trusted_root.tuf_source === 'GH_ATTESTATION_TRUSTED_ROOT'
      && Date.parse(manifest.trusted_root.acquired_at) <= Date.parse(input.lifecycle.verifiedAt),
    'APPROVAL_EVIDENCE_BUNDLE_REQUIRED',
  );
};

const validateStaticInput = (input) => {
  requireCondition(hasExactKeys(input, INPUT_KEYS), 'APPROVAL_ATTESTATION_REQUIRED');
  requireCondition(
    input.ghPath === GH_PATH,
    'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE',
  );
  requireCondition(
    isAbsolutePath(input.receiptPath)
      && basename(input.receiptPath) === 'receipt.json'
      && isAbsolutePath(input.bundlePath)
      && isAbsolutePath(input.trustedRootPath)
      && isBytes(input.receiptBytes)
      && isBytes(input.bundleBytes)
      && isBytes(input.trustedRootBytes),
    'APPROVAL_EVIDENCE_BUNDLE_REQUIRED',
  );
  requireCondition(isPlainObject(input.manifest), 'APPROVAL_EVIDENCE_BUNDLE_REQUIRED');
  const receiptRawSha256 = sha256Prefixed(input.receiptBytes);
  requireCondition(
    DIGEST_PATTERN.test(input.manifest.receipt_raw_sha256)
      && input.manifest.receipt_raw_sha256 === receiptRawSha256,
    'APPROVAL_RECEIPT_RAW_DIGEST_MISMATCH',
  );
  const receipt = parseReceipt(input.receiptBytes);
  validateExpected(input.expected, receipt);
  validateLifecycle(input.lifecycle, receipt.core.receipt_id);
  validateManifest(input, receipt, receiptRawSha256);
  return { receipt, receiptRawSha256 };
};

const snapshotInput = (input) => {
  requireCondition(hasExactKeys(input, INPUT_KEYS), 'APPROVAL_ATTESTATION_REQUIRED');
  try {
    return {
      ghPath: input.ghPath,
      receiptPath: input.receiptPath,
      receiptBytes: Buffer.isBuffer(input.receiptBytes)
        ? Buffer.from(input.receiptBytes)
        : input.receiptBytes,
      bundlePath: input.bundlePath,
      bundleBytes: Buffer.isBuffer(input.bundleBytes)
        ? Buffer.from(input.bundleBytes)
        : input.bundleBytes,
      trustedRootPath: input.trustedRootPath,
      trustedRootBytes: Buffer.isBuffer(input.trustedRootBytes)
        ? Buffer.from(input.trustedRootBytes)
        : input.trustedRootBytes,
      manifest: structuredClone(input.manifest),
      expected: structuredClone(input.expected),
      lifecycle: structuredClone(input.lifecycle),
    };
  } catch {
    throw approvalError('APPROVAL_ATTESTATION_REQUIRED');
  }
};

const runCommand = async (commandRunner, args, failureCode) => {
  requireCondition(typeof commandRunner === 'function', failureCode);
  let result;
  try {
    result = await commandRunner(GH_PATH, Object.freeze([...args]), EXEC_OPTIONS);
  } catch {
    throw approvalError(failureCode);
  }
  requireCondition(
    hasExactKeys(result, ['exitCode', 'stdout', 'stderr'])
      && Number.isSafeInteger(result.exitCode)
      && isBoundedString(result.stdout)
      && isBoundedString(result.stderr),
    failureCode,
  );
  return result;
};

const verifyToolchain = async (commandRunner) => {
  const version = await runCommand(
    commandRunner,
    ['--version'],
    'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE',
  );
  if (version.exitCode !== 0) throw approvalError('APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE');
  const parsedVersion = inspectApprovalAttestationToolchain({
    ghPath: GH_PATH,
    versionOutput: version.stdout,
    attestationHelpExitCode: 0,
  });
  if (parsedVersion.status !== 'AVAILABLE') throw approvalError(parsedVersion.code);
  const help = await runCommand(
    commandRunner,
    ['attestation', 'verify', '--help'],
    'APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE',
  );
  const inspection = inspectApprovalAttestationToolchain({
    ghPath: GH_PATH,
    versionOutput: version.stdout,
    attestationHelpExitCode: help.exitCode,
  });
  if (inspection.status !== 'AVAILABLE') throw approvalError(inspection.code);
};

const parseVerificationOutput = (stdout) => {
  let value;
  try {
    value = parseApprovalJson(stdout, 'approval-attestation');
  } catch {
    throw approvalError('APPROVAL_ATTESTATION_REQUIRED');
  }
  requireCondition(Array.isArray(value) && value.length === 1, 'APPROVAL_ATTESTATION_REQUIRED');
  return value[0];
};

const validateVerificationIdentity = (attestation, input, receiptRawSha256) => {
  const result = attestation?.verificationResult;
  const certificate = result?.signature?.certificate;
  const subjects = result?.statement?.subject;
  const expectedSubject = receiptRawSha256.slice('sha256:'.length);
  requireCondition(
    Array.isArray(subjects)
      && subjects.length === 1
      && hasExactKeys(subjects[0], ['name', 'digest'])
      && subjects[0].name === 'receipt.json'
      && hasExactKeys(subjects[0].digest, ['sha256'])
      && subjects[0].digest.sha256 === expectedSubject,
    'APPROVAL_ATTESTATION_SUBJECT_MISMATCH',
  );
  requireCondition(isPlainObject(certificate), 'APPROVAL_ATTESTATION_SIGNER_MISMATCH');
  requireCondition(
    certificate.runnerEnvironment === RUNNER_ENVIRONMENT,
    'APPROVAL_ATTESTATION_SELF_HOSTED_DENIED',
  );
  requireCondition(
    certificate.issuer === input.expected.oidcIssuer
      && certificate.buildSignerUri === `https://github.com/${input.expected.signerWorkflow}@${SOURCE_REF}`
      && certificate.buildSignerDigest === input.expected.signerDigest
      && certificate.sourceRepositoryUri === `https://github.com/${input.expected.repository}`
      && certificate.sourceRepositoryDigest === input.expected.sourceDigest
      && certificate.sourceRepositoryRef === input.expected.sourceRef,
    'APPROVAL_ATTESTATION_SIGNER_MISMATCH',
  );
};

const verificationArgs = (input) => Object.freeze([
  'attestation', 'verify', input.receiptPath,
  '--bundle', input.bundlePath,
  '--custom-trusted-root', input.trustedRootPath,
  '--repo', input.expected.repository,
  '--signer-workflow', input.expected.signerWorkflow,
  '--signer-digest', input.expected.signerDigest,
  '--source-ref', SOURCE_REF,
  '--source-digest', input.expected.sourceDigest,
  '--deny-self-hosted-runners',
  '--format', 'json',
]);

export const verifyApprovalAttestation = async (input, commandRunner) => {
  const snapshot = snapshotInput(input);
  const { receipt, receiptRawSha256 } = validateStaticInput(snapshot);
  await verifyToolchain(commandRunner);
  const verification = await runCommand(
    commandRunner,
    verificationArgs(snapshot),
    'APPROVAL_ATTESTATION_REQUIRED',
  );
  requireCondition(verification.exitCode === 0, 'APPROVAL_ATTESTATION_REQUIRED');
  const attestation = parseVerificationOutput(verification.stdout);
  validateVerificationIdentity(attestation, snapshot, receiptRawSha256);
  const output = deepFreeze({
    schemaVersion: 'approval-attestation-verification/v1',
    status: 'VERIFIED',
    trustClass: 'TRUSTED_BASE_VERIFIED',
    receiptId: receipt.core.receipt_id,
    receiptCoreSha256: receipt.receipt_core_sha256,
    receiptRawSha256,
    repository: snapshot.expected.repository,
    signerWorkflow: snapshot.expected.signerWorkflow,
    signerDigest: snapshot.expected.signerDigest,
    sourceRef: snapshot.expected.sourceRef,
    sourceDigest: snapshot.expected.sourceDigest,
    oidcIssuer: snapshot.expected.oidcIssuer,
    runnerEnvironment: snapshot.expected.runnerEnvironment,
    verifiedAt: snapshot.lifecycle.verifiedAt,
    toolchain: { path: GH_PATH, version: GH_VERSION },
  });
  requireCondition(
    byteLength(JSON.stringify(output)) <= MAX_RESULT_BYTES,
    'APPROVAL_ATTESTATION_REQUIRED',
  );
  return output;
};
