import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Temporal API startup contract', () => {
  it('makes temporal-dev.service a hard systemd dependency', () => {
    const service = readFileSync(
      resolve(process.cwd(), '../../infra/systemd/global-api.service'),
      'utf8',
    );
    expect(service).toMatch(
      /^Requires=.*\btemporal-dev\.service\b/mu,
    );
    expect(service).toContain('Restart=on-failure');
  });

  it('documents cold-start failure separately from post-start readiness loss', () => {
    const runbook = readFileSync(
      resolve(process.cwd(), '../../docs/backend/api-runtime-admission.md'),
      'utf8',
    );
    expect(runbook).toMatch(/Temporal.*hard startup dependency/is);
    expect(runbook).toMatch(/does not bind|no listener/i);
    expect(runbook).toMatch(/after startup.*503|post-start.*503/is);
  });
});
