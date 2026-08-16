import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  contractsFinderCanaryMatrix,
  contractsFinderMatrixVerdict,
} from './verify-world-bank-procurement-persistent-funnel.support';

const verifier = fileURLToPath(new URL('./verify-world-bank-procurement-persistent-funnel.mts', import.meta.url));
const results: Array<{ id: string; status: 'PASS' | 'FAIL'; evidence?: unknown; error?: string }> = [];

for (const item of contractsFinderCanaryMatrix()) {
  const output = await runVerifier({
    ...process.env,
    ACQUISITION_CANARY: 'uk_contracts_finder',
    ACQUISITION_CANARY_REGION: item.region,
    ACQUISITION_CANARY_KEYWORD: item.keyword,
    ACQUISITION_CANARY_EXPECT: item.expect,
    ACQUISITION_CANARY_REQUIRE_PAGINATION: 'false',
  });
  if (output.code !== 0) {
    results.push({ id: item.id, status: 'FAIL', error: output.stderr || output.stdout });
    break;
  }
  try {
    const jsonStart = output.stdout.lastIndexOf('{\n  "verdict"');
    if (jsonStart < 0) throw new Error('canary JSON verdict not found');
    results.push({ id: item.id, status: 'PASS', evidence: JSON.parse(output.stdout.slice(jsonStart)) });
  } catch (error) {
    results.push({ id: item.id, status: 'FAIL', error: String(error) });
    break;
  }
}

const matrix = contractsFinderMatrixVerdict(results, contractsFinderCanaryMatrix().length);

console.log(JSON.stringify({
  verdict: matrix.verdict,
  scope: 'sequential isolated Contracts Finder canaries; not production or channel-quality proof',
  matrixPaginationProved: matrix.paginationProved,
  claimBoundary: {
    whenAllPass: [
      'one current buyer sample persisted for each of Wales, England and Northern Ireland',
      'each positive sample matched its own procurement title and exact constituent region',
      'one deterministic no-match query persisted no Raw, identity, canonical company or Lead and wrote a truthful zero-result ledger',
      'at least one matrix case evidenced live continuation by an accepted cursor URL or bounded max-page truncation',
    ],
    neverProves: [
      'production or remote-main deployment',
      'complete UK coverage, recall, precision or long-term provider stability',
      'authoritative legal identity when a row remains name-country only',
      'SaaS delivery or acknowledgement',
      'Find a Tender overlap or replay correctness',
    ],
    failureMeaning: matrix.paginationProved
      ? 'the live matrix is not accepted; it does not by itself identify a provider defect because live inventory may change'
      : 'the matrix has no live pagination proof and therefore fails even if every individual case passed',
  },
  results,
}, null, 2));

if (matrix.verdict !== 'PASS') {
  process.exitCode = 1;
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
