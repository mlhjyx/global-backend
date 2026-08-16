import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  worldBankCanaryMatrix,
  worldBankMatrixVerdict,
} from './verify-world-bank-procurement-persistent-funnel.support';

const verifier = fileURLToPath(new URL('./verify-world-bank-procurement-persistent-funnel.mts', import.meta.url));
const cases = worldBankCanaryMatrix(process.env);
const results: Array<{ id: string; status: 'PASS' | 'FAIL'; evidence?: unknown; error?: string }> = [];

for (const item of cases) {
  const output = await runVerifier({
    ...process.env,
    ACQUISITION_CANARY: 'world_bank',
    ACQUISITION_CANARY_COUNTRY: item.country,
    ACQUISITION_CANARY_KEYWORD: item.keyword,
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

const matrix = worldBankMatrixVerdict(results, cases.length);

console.log(JSON.stringify({
  verdict: matrix.verdict,
  scope: 'sequential isolated World Bank procurement canaries; not production or channel-quality proof',
  configuredCases: cases,
  matrixPaginationProved: matrix.paginationProved,
  positiveDiversityProved: matrix.positiveDiversityProved,
  claimBoundary: {
    whenAllPass: [
      'at least two configured country-and-keyword probes persisted distinct official buyer or implementing-agency notice chains',
      'each positive probe persisted official Raw provenance, ACTIVE identity links, root canonical companies and ICP-scoped Leads',
      'the quality ledger exactly accounted for accepted and bound records without identity conflicts',
      'one high-entropy control persisted a truthful successful zero result without Raw, identity, company or Lead rows',
      'at least one accepted Raw record came from an official World Bank continuation URL with os greater than zero',
      'no authority identifier or organization domain was inferred from World Bank notice data',
    ],
    neverProves: [
      'production or remote-main deployment',
      'complete World Bank inventory coverage, precision, recall or long-term source stability',
      'authoritative legal identity; the accepted projection remains name-country based',
      'that the default live queries will remain non-empty after the recorded run',
      'SaaS delivery, acknowledgement or commercial conversion',
    ],
    inventoryPolicy: process.env.ACQUISITION_WORLD_BANK_MATRIX_CASES
      ? 'operator-configured bounded live queries; configuration passed structural controls but results still depend on live inventory'
      : 'repository defaults are live probes, not fixtures; a zero positive result fails honestly and may require a newly observed bounded configuration',
    failureMeaning: matrix.paginationProved
      ? 'the live matrix is not accepted; failure alone does not distinguish inventory drift, source outage or implementation defect'
      : 'the matrix lacks accepted continuation-page evidence and fails even if earlier individual cases passed',
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
