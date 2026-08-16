import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  boundedCanaryDiagnostic,
  brazilPncpCanaryMatrix,
  brazilPncpMatrixCaseEvidenceIsValid,
  brazilPncpMatrixVerdict,
} from './verify-world-bank-procurement-persistent-funnel.support';

const verifier = fileURLToPath(new URL('./verify-world-bank-procurement-persistent-funnel.mts', import.meta.url));
const apiTsconfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
const cases = brazilPncpCanaryMatrix(process.env);
const results: Array<{ id: string; status: 'PASS' | 'FAIL'; evidence?: unknown; error?: string }> = [];

for (const item of cases) {
  const output = await runVerifier({
    ...process.env,
    TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH ?? apiTsconfig,
    ACQUISITION_CANARY: 'brazil_pncp',
    ACQUISITION_CANARY_CASE_ID: item.id,
    ACQUISITION_CANARY_COUNTRY: 'BR',
    ACQUISITION_CANARY_KEYWORD: item.keyword,
    ACQUISITION_CANARY_LIMIT: String(item.limit),
    ACQUISITION_CANARY_EXPECT: item.expect,
    ...(item.state ? { ACQUISITION_CANARY_STATE: item.state } : { ACQUISITION_CANARY_STATE: '' }),
  });
  if (output.code !== 0) {
    results.push({ id: item.id, status: 'FAIL', error: boundedCanaryDiagnostic(output.stderr || output.stdout) });
    break;
  }
  try {
    const jsonStart = output.stdout.lastIndexOf('{\n  "verdict"');
    if (jsonStart < 0) throw new Error('canary JSON verdict not found');
    const evidence: unknown = JSON.parse(output.stdout.slice(jsonStart));
    if (!brazilPncpMatrixCaseEvidenceIsValid(evidence, item)) {
      throw new Error(`canary evidence contract mismatch for ${item.id}`);
    }
    results.push({ id: item.id, status: 'PASS', evidence });
  } catch (error) {
    results.push({ id: item.id, status: 'FAIL', error: boundedCanaryDiagnostic(String(error)) });
    break;
  }
}

const matrix = brazilPncpMatrixVerdict(results, cases.length);
console.log(JSON.stringify({
  verdict: matrix.verdict,
  scope: 'sequential isolated Brazil PNCP current-buyer canaries; not production or bid-eligibility proof',
  configuredCases: cases,
  matrixPaginationProved: matrix.paginationProved,
  positiveDiversityProved: matrix.positiveDiversityProved,
  authorityIdentityProved: matrix.authorityIdentityProved,
  positiveChannelProved: matrix.verdict === 'PASS',
  sourceDataMode: 'live-official-http',
  modelMode: 'stub',
  modelScoringProved: false,
  claimBoundary: {
    whenAllPass: [
      'two distinct Portuguese keyword probes persisted current PNCP buyer opportunities',
      'accepted Raw facts retained a sanitized title, future deadline and frozen query provenance',
      'at least one accepted Raw fact came from a real continuation page',
      'one state-scoped high-entropy query fully exhausted to a truthful zero result',
      'each positive probe reached exactly one ACTIVE identity link per Raw, a root company and a needs-review Lead',
      'at least one accepted Raw retained a checksum-valid prefix-matched CNPJ and the same ACTIVE br-cnpj authority identifier on its Canonical Company',
      'each admitted buyer CNPJ was checksum-valid, matched the PNCP control prefix and had the same ACTIVE br-cnpj authority identifier',
      'rows without a validated CNPJ retained neither a CNPJ claim nor a br-cnpj identifier',
    ],
    neverProves: [
      'that an opportunity remains open after its persisted deadline',
      'authoritative identity for buyers whose accepted PNCP row had no validated CNPJ, bid eligibility or nationwide inventory coverage',
      'production deployment, SaaS delivery or commercial conversion',
      'real-model fit scoring; this channel acceptance uses the deterministic stub model and proves only the data and persistence path',
      'long-term source stability, precision or recall',
    ],
  },
  results,
}, null, 2));

if (matrix.verdict !== 'PASS') process.exitCode = 1;

function runVerifier(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', verifier], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
