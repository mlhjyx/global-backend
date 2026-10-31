import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  type ExecutionContext,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { RuntimeWorkAdmissionGuard } from './runtime-work-admission.guard';
import { RuntimeAdmissionService } from './runtime-admission';
import { RuntimeReadinessService } from '../health/runtime-readiness.service';
import { PlatformExecutionTechnicalQuoteController } from '../platform-authority/platform-execution-technical-quote.controller';
import { PlatformTargetLookupController } from '../platform-authority/platform-target-lookup.controller';
import { READ_ONLY_CONTROL_PLANE_METADATA } from './read-only-control-plane.decorator';

const readySnapshot = Object.freeze({ status: 'ready' as const });
const PLATFORM_WORKER_NOT_READY = Object.freeze({
  status: 'failed' as const,
  code: 'PLATFORM_WORKER_NOT_READY',
});
// The hard component names the readiness service reports (its initial
// snapshot carries every one of them).
const HARD_COMPONENTS = Object.keys(
  new RuntimeReadinessService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ).current().components,
);

function notReadySnapshot(overrides: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    status: 'not_ready' as const,
    components: Object.freeze({
      ...Object.fromEntries(
        HARD_COMPONENTS.map((name) => [name, { status: 'ok' }]),
      ),
      ...overrides,
    }),
  });
}

function guardWith(
  admitted: boolean,
  snapshot: Readonly<Record<string, unknown>>,
): RuntimeWorkAdmissionGuard {
  return new RuntimeWorkAdmissionGuard(
    { current: () => ({ admitted }) } as never,
    { current: () => snapshot } as never,
    new Reflector(),
  );
}

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

function productionTypescript(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypescript(path);
    return entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('RuntimeWorkAdmissionGuard', () => {
  it('admits code-owned recovery writes independently of aggregate readiness but never release admission', () => {
    const handler = () => undefined;
    Reflect.defineMetadata('runtime:recovery-control-plane', 'platform-authority-revocation', handler);
    const make = (admitted: boolean) => new RuntimeWorkAdmissionGuard(
      { current: () => ({ admitted }) } as never,
      { current: () => ({ status: 'not_ready' }) } as never,
      new Reflector(),
    );
    expect(make(true).canActivate(context('POST', { handler }))).toBe(true);
    expect(() => make(false).canActivate(context('POST', { handler }))).toThrow('RUNTIME_ADMISSION_CLOSED');
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(() => make(true).canActivate(context(method, { handler }))).toThrow('RUNTIME_ADMISSION_CLOSED');
    }
    expect(() => make(true).canActivate(context('POST', {
      request: { headers: { 'x-recovery-control-plane': 'platform-authority-revocation' } },
    }))).toThrow('RUNTIME_ADMISSION_CLOSED');
    Reflect.defineMetadata('runtime:recovery-control-plane', true, handler);
    expect(() => make(true).canActivate(context('POST', { handler }))).toThrow('RUNTIME_ADMISSION_CLOSED');
  });

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

  it('admits customer writes while the separate platform worker is only absent or not yet READY', () => {
    const guard = guardWith(
      true,
      notReadySnapshot({ platform_worker: PLATFORM_WORKER_NOT_READY }),
    );

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(guard.canActivate(context(method))).toBe(true);
    }
  });

  it('keeps the stable 503 for a platform worker integrity failure or a missing customer dependency', () => {
    for (const overrides of [
      {
        platform_worker: {
          status: 'failed',
          code: 'PLATFORM_WORKER_MIXED_RELEASE_IDENTITY',
        },
      },
      {
        platform_worker: {
          status: 'failed',
          code: 'WORKER_TEMPORAL_IDENTITY_INVALID',
        },
      },
      {
        platform_worker: {
          status: 'failed',
          code: 'RUNTIME_PROCESS_LEASE_UNAVAILABLE',
        },
      },
      {
        platform_worker: {
          status: 'not_proven',
          code: 'RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE',
        },
      },
      { worker: { status: 'failed', code: 'MATCHING_WORKER_NOT_READY' } },
      {
        worker: { status: 'failed', code: 'MATCHING_WORKER_NOT_READY' },
        platform_worker: PLATFORM_WORKER_NOT_READY,
      },
    ]) {
      const guard = guardWith(true, notReadySnapshot(overrides));
      let error: unknown;
      try {
        guard.canActivate(context('POST'));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        message: 'RUNTIME_ADMISSION_CLOSED',
        error: {
          code: 'RUNTIME_ADMISSION_CLOSED',
          message: 'managed runtime is not ready to accept new work',
        },
      });
    }
  });

  it('keeps static release admission in front of the platform worker tolerance', () => {
    const guard = guardWith(
      false,
      notReadySnapshot({ platform_worker: PLATFORM_WORKER_NOT_READY }),
    );

    expect(guard.canActivate(context('GET'))).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => guard.canActivate(context(method))).toThrow(
        'RUNTIME_ADMISSION_CLOSED',
      );
    }
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

  it('admits read-only metadata only on the registered zero-write control-plane handlers', () => {
    const sourceRoot = resolve(import.meta.dirname, '..');
    const uses = productionTypescript(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes('@ReadOnlyControlPlane()'))
      .map((path) => relative(sourceRoot, path));
    expect(uses).toEqual([
      'platform-authority/platform-execution-technical-quote.controller.ts',
      'platform-authority/platform-target-lookup.controller.ts',
    ]);
    expect(Reflect.getMetadata(READ_ONLY_CONTROL_PLANE_METADATA, PlatformTargetLookupController.prototype.read)).toBe(true);
  });
});
