import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { RuntimeWorkAdmissionGuard } from './runtime-work-admission.guard';

const readySnapshot = Object.freeze({ status: 'ready' as const });

function context(method: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
}

describe('RuntimeWorkAdmissionGuard', () => {
  it('keeps diagnostics readable but rejects every HTTP mutation while managed admission is closed', () => {
    const guard = new RuntimeWorkAdmissionGuard({
      current: () => ({ admitted: false }),
    } as never, { current: () => readySnapshot } as never);

    expect(guard.canActivate(context('GET'))).toBe(true);
    expect(guard.canActivate(context('HEAD'))).toBe(true);
    expect(guard.canActivate(context('OPTIONS'))).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => guard.canActivate(context(method))).toThrow(
        'RUNTIME_ADMISSION_CLOSED',
      );
    }
  });

  it('does not alter mutation routing after managed admission succeeds', () => {
    const guard = new RuntimeWorkAdmissionGuard({
      current: () => ({ admitted: true }),
    } as never, { current: () => readySnapshot } as never);
    expect(guard.canActivate(context('POST'))).toBe(true);
  });

  it('rejects mutations after dynamic readiness closes even when static admission was valid at boot', () => {
    const guard = new RuntimeWorkAdmissionGuard(
      { current: () => ({ admitted: true }) } as never,
      { current: () => ({ status: 'not_ready' }) } as never,
    );

    expect(() => guard.canActivate(context('POST'))).toThrow(
      'RUNTIME_ADMISSION_CLOSED',
    );
  });

  it('is registered as a global guard rather than relying on each controller to opt in', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'app.module.ts'), 'utf8');
    expect(source).toContain('useClass: RuntimeWorkAdmissionGuard');
  });
});
