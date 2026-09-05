import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { RuntimeWorkAdmissionGuard } from './runtime-work-admission.guard';
import { RuntimeAdmissionService } from './runtime-admission';
import { RuntimeReadinessService } from '../health/runtime-readiness.service';
import { PlatformExecutionTechnicalQuoteController } from '../platform-authority/platform-execution-technical-quote.controller';
import { READ_ONLY_CONTROL_PLANE_METADATA } from './read-only-control-plane.decorator';

const readySnapshot = Object.freeze({ status: 'ready' as const });

class OrdinaryController {
  mutate(): void {}
}

function context(
  method: string,
  input: Readonly<{
    handler?: (...args: never[]) => unknown;
    controller?: object;
    request?: Readonly<Record<string, unknown>>;
  }> = {},
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => input.handler ?? OrdinaryController.prototype.mutate,
    getClass: () => input.controller ?? OrdinaryController,
    switchToHttp: () => ({
      getRequest: () => ({ method, ...(input.request ?? {}) }),
    }),
  } as unknown as ExecutionContext;
}

describe('RuntimeWorkAdmissionGuard', () => {
  it('keeps concrete Nest injection metadata for the dynamic readiness snapshot', () => {
    expect(
      Reflect.getMetadata('design:paramtypes', RuntimeWorkAdmissionGuard),
    ).toEqual([RuntimeAdmissionService, RuntimeReadinessService, Reflector]);
  });

  it('keeps diagnostics readable but rejects every HTTP mutation while managed admission is closed', () => {
    const guard = new RuntimeWorkAdmissionGuard(
      {
        current: () => ({ admitted: false }),
      } as never,
      { current: () => readySnapshot } as never,
      new Reflector(),
    );

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
    const guard = new RuntimeWorkAdmissionGuard(
      {
        current: () => ({ admitted: true }),
      } as never,
      {
        current: () => ({
          ...readySnapshot,
          capabilities: {
            execution_budget_jwks: { status: 'failed' },
            workspace_budget_authority: { status: 'failed' },
            platform_budget_authority: { status: 'failed' },
          },
        }),
      } as never,
      new Reflector(),
    );
    expect(guard.canActivate(context('POST'))).toBe(true);
  });

  it('rejects mutations after dynamic readiness closes even when static admission was valid at boot', () => {
    const guard = new RuntimeWorkAdmissionGuard(
      { current: () => ({ admitted: true }) } as never,
      { current: () => ({ status: 'not_ready' }) } as never,
      new Reflector(),
    );

    expect(() => guard.canActivate(context('POST'))).toThrow(
      'RUNTIME_ADMISSION_CLOSED',
    );
  });

  it('admits only code-owned read-only control-plane metadata while ordinary work stays closed', () => {
    const reflector = new Reflector();
    const guard = new RuntimeWorkAdmissionGuard(
      { current: () => ({ admitted: false }) } as never,
      { current: () => ({ status: 'not_ready' }) } as never,
      reflector,
    );
    const quoteHandler = PlatformExecutionTechnicalQuoteController.prototype.read;

    expect(
      reflector.get<boolean>(READ_ONLY_CONTROL_PLANE_METADATA, quoteHandler),
    ).toBe(true);
    expect(
      guard.canActivate(
        context('POST', {
          handler: quoteHandler,
          controller: PlatformExecutionTechnicalQuoteController,
        }),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        context('POST', {
          request: {
            readOnlyControlPlane: true,
            headers: { 'x-read-only-control-plane': 'true' },
          },
        }),
      ),
    ).toThrow('RUNTIME_ADMISSION_CLOSED');
    expect(() => guard.canActivate(context('POST'))).toThrow(
      'RUNTIME_ADMISSION_CLOSED',
    );
  });

  it('is registered as a global guard rather than relying on each controller to opt in', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'app.module.ts'),
      'utf8',
    );
    expect(source).toContain('useClass: RuntimeWorkAdmissionGuard');
  });
});
