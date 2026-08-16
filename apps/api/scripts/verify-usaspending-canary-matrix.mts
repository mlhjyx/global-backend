import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  usaSpendingCanaryMatrix,
  usaSpendingMatrixVerdict,
} from './verify-world-bank-procurement-persistent-funnel.support';

const verifier = fileURLToPath(new URL('./verify-world-bank-procurement-persistent-funnel.mts', import.meta.url));
const cases = usaSpendingCanaryMatrix(process.env);
const results: Array<{ id: string; status: 'PASS' | 'FAIL'; evidence?: unknown; error?: string }> = [];

for (const item of cases) {
  const output = await runVerifier({
    ...process.env,
    ACQUISITION_CANARY: 'usaspending',
    ACQUISITION_CANARY_COUNTRY: 'US',
    ACQUISITION_CANARY_KEYWORD: item.keyword,
    ACQUISITION_CANARY_SINCE_DAYS: String(item.sinceDays),
    ACQUISITION_CANARY_LIMIT: String(item.limit),
    ACQUISITION_CANARY_EXPECT: item.expect,
  });
  if (output.code !== 0) {
    results.push({ id: item.id, status: 'FAIL', error: boundedDiagnostic(output.stderr || output.stdout) });
    break;
  }
  try {
    const jsonStart = output.stdout.lastIndexOf('{\n  "verdict"');
    if (jsonStart < 0) throw new Error('canary JSON verdict not found');
    results.push({ id: item.id, status: 'PASS', evidence: JSON.parse(output.stdout.slice(jsonStart)) });
  } catch (error) {
    results.push({ id: item.id, status: 'FAIL', error: boundedDiagnostic(String(error)) });
    break;
  }
}

const matrix = usaSpendingMatrixVerdict(results, cases.length);
console.log(JSON.stringify({
  verdict: matrix.verdict,
  scope: 'sequential isolated USAspending historical-buyer canaries; not production or current-opportunity proof',
  configuredCases: cases,
  matrixPaginationProved: matrix.paginationProved,
  positiveDiversityProved: matrix.positiveDiversityProved,
  claimBoundary: {
    whenAllPass: [
      'two distinct official USAspending keyword probes persisted historical federal buyer chains',
      'each positive probe persisted Raw provenance, ACTIVE identity links, root companies and needs-review Leads',
      'the quality ledger exactly accounted for accepted and bound records without conflicts',
      'one accepted Raw record retained source_page greater than one under a frozen query fingerprint',
      'one high-entropy control persisted a truthful successful zero result without downstream rows',
      'recipient names and award IDs were not promoted to organization identity',
    ],
    neverProves: [
      'current procurement demand, an open opportunity or an active tender',
      'authoritative federal organization identity or complete inventory coverage',
      'production deployment, SaaS delivery or commercial conversion',
      'long-term source stability, precision or recall',
    ],
  },
  results,
}, null, 2));

if (matrix.verdict !== 'PASS') process.exitCode = 1;

function boundedDiagnostic(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim().slice(0, 2_000);
}

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
