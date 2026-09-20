import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ClaimController } from '../claim/claim.controller';
import { CompanyController } from '../company/company.controller';
import { DeletionController } from '../compliance/deletion.controller';
import { DiscoveryController } from '../discovery/discovery.controller';
import { EventsController } from '../events/events.controller';
import { IcpController } from '../icp/icp.controller';
import { LeadController } from '../lead/lead.controller';
import { PlatformExecutionTechnicalQuoteController } from '../platform-authority/platform-execution-technical-quote.controller';
import { PlatformTechnicalQuoteServiceAuthenticationGuard } from '../platform-authority/platform-technical-quote-service-auth';
import { PlatformTargetLookupController } from '../platform-authority/platform-target-lookup.controller';
import { PlatformTargetLookupGuard } from '../platform-authority/platform-target-lookup.guard';
import { PlatformRevocationHttpController } from '../platform-authority/platform-revocation-http.controller';
import { PlatformRevocationHttpGuard } from '../platform-authority/platform-revocation-http.guard';
import { AssetsController } from '../site-builder/assets.controller';
import { BuildsController } from '../site-builder/builds.controller';
import { IntakeController } from '../site-builder/intake.controller';
import { KbController } from '../site-builder/kb.controller';
import { SitesController } from '../site-builder/sites.controller';
import { SiteBuildTechnicalBudgetQuoteController } from '../site-builder/site-build-technical-budget-quote.controller';
import { WhoamiController } from '../whoami/whoami.controller';
import { AuthGuard } from './auth.guard';
import { ScopesGuard } from './scopes.guard';
import { RuntimeClockController } from '../runtime/runtime-clock.controller';
import { READ_ONLY_CONTROL_PLANE_METADATA } from '../runtime/read-only-control-plane.decorator';
import { RECOVERY_CONTROL_PLANE_METADATA } from '../runtime/recovery-control-plane.decorator';

const PROTECTED_CONTROLLERS = [
  ClaimController,
  CompanyController,
  DeletionController,
  DiscoveryController,
  EventsController,
  IcpController,
  LeadController,
  AssetsController,
  BuildsController,
  IntakeController,
  KbController,
  SitesController,
  SiteBuildTechnicalBudgetQuoteController,
  WhoamiController,
] as const;

const PUBLIC_CONTROLLER_FILES = new Set([
  'health/health.controller.ts',
  'runtime/runtime-clock.controller.ts',
  'site-builder/site-preview.controller.ts',
  'platform-authority/platform-fence-ack-jwks.controller.ts',
]);

const SERVICE_PROTECTED_CONTROLLERS = [
  PlatformExecutionTechnicalQuoteController,
] as const;

const SERVICE_PROTECTED_CONTROLLER_FILES = new Set([
  'platform-authority/platform-execution-technical-quote.controller.ts',
  'platform-authority/platform-target-lookup.controller.ts',
  'platform-authority/platform-revocation-http.controller.ts',
]);

function controllerFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) found.push(...controllerFiles(absolute));
    if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      found.push(absolute);
    }
  }
  return found;
}

describe('controller authorization guard topology', () => {
  it('limits the public clock controller to one GET diagnostic without mutation exemptions', () => {
    expect(Reflect.getMetadata(PATH_METADATA, RuntimeClockController)).toBe('health');
    expect(Object.getOwnPropertyNames(RuntimeClockController.prototype).filter(name => name !== 'constructor')).toEqual(['read']);
    const handler = RuntimeClockController.prototype.read;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('clock');
    for (const target of [RuntimeClockController, handler]) {
      expect(Reflect.getMetadata(READ_ONLY_CONTROL_PLANE_METADATA, target)).toBeUndefined();
      expect(Reflect.getMetadata(RECOVERY_CONTROL_PLANE_METADATA, target)).toBeUndefined();
    }
  });
  it('requires the dedicated signed-command guard for the recovery mutation', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformRevocationHttpController)).toEqual([PlatformRevocationHttpGuard]);
  });
  it('requires the dedicated guarded lookup pipeline for its read-only handler', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformTargetLookupController)).toEqual([PlatformTargetLookupGuard]);
  });
  it.each(PROTECTED_CONTROLLERS)(
    '%s runs authentication before scope enforcement',
    (controller) => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
      expect(guards).toEqual([AuthGuard, ScopesGuard]);
    },
  );

  it.each(SERVICE_PROTECTED_CONTROLLERS)(
    '%s uses only the dedicated service authentication guard',
    (controller) => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
      expect(guards).toEqual([
        PlatformTechnicalQuoteServiceAuthenticationGuard,
      ]);
    },
  );

  it('fails closed when a new non-public controller omits the authz topology', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const offenders: string[] = [];
    const discoveredPublic = new Set<string>();
    const discoveredServiceProtected = new Set<string>();

    for (const absolute of controllerFiles(sourceRoot)) {
      const path = relative(sourceRoot, absolute);
      if (PUBLIC_CONTROLLER_FILES.has(path)) {
        discoveredPublic.add(path);
        continue;
      }
      const source = readFileSync(absolute, 'utf8');
      if (SERVICE_PROTECTED_CONTROLLER_FILES.has(path)) {
        discoveredServiceProtected.add(path);
        const requiredTokens = path === 'platform-authority/platform-revocation-http.controller.ts' ? [
          '@UseGuards(PlatformRevocationHttpGuard)', '@PlatformRevocationRecovery()', '@ApiConsumes("application/jose")', 'receivePlatformAuthorityRevocation_v1',
        ] : path === 'platform-authority/platform-target-lookup.controller.ts' ? [
          '@ApiBearerAuth(PLATFORM_AUTHORITY_TARGET_READER_SECURITY_SCHEME)',
          '@UseGuards(PlatformTargetLookupGuard)',
          '@ReadOnlyControlPlane()',
          'PLATFORM_AUTHORITY_TARGET_READER_SCOPE',
        ] : [
          '@ApiBearerAuth(PLATFORM_TECHNICAL_QUOTE_OPENAPI_SECURITY_SCHEME)',
          '@UseGuards(PlatformTechnicalQuoteServiceAuthenticationGuard)',
          '@ReadOnlyControlPlane()',
          '@ApiExtension("x-required-service-scope", "platform-technical-quote.read")',
        ];
        for (const required of requiredTokens) {
          if (!source.includes(required)) offenders.push(`${path}: ${required}`);
        }
        for (const forbidden of [
          '@ApiBearerAuth()',
          '@UseGuards(AuthGuard, ScopesGuard)',
          '@RequireScopes(',
        ]) {
          if (source.includes(forbidden)) offenders.push(`${path}: forbidden ${forbidden}`);
        }
        continue;
      }
      for (const required of [
        '@ApiBearerAuth()',
        '@UseGuards(AuthGuard, ScopesGuard)',
        '@RequireScopes(',
      ]) {
        if (!source.includes(required)) offenders.push(`${path}: ${required}`);
      }
    }

    expect([...discoveredPublic].sort()).toEqual(
      [...PUBLIC_CONTROLLER_FILES].sort(),
    );
    expect([...discoveredServiceProtected].sort()).toEqual(
      [...SERVICE_PROTECTED_CONTROLLER_FILES].sort(),
    );
    expect(offenders).toEqual([]);
  });
});
