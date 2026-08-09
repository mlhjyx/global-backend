import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ClaimController } from '../claim/claim.controller';
import { CompanyController } from '../company/company.controller';
import { DeletionController } from '../compliance/deletion.controller';
import { DiscoveryController } from '../discovery/discovery.controller';
import { EventsController } from '../events/events.controller';
import { IcpController } from '../icp/icp.controller';
import { LeadController } from '../lead/lead.controller';
import { AssetsController } from '../site-builder/assets.controller';
import { BuildsController } from '../site-builder/builds.controller';
import { IntakeController } from '../site-builder/intake.controller';
import { KbController } from '../site-builder/kb.controller';
import { SitesController } from '../site-builder/sites.controller';
import { WhoamiController } from '../whoami/whoami.controller';
import { AuthGuard } from './auth.guard';
import { ScopesGuard } from './scopes.guard';

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
  WhoamiController,
] as const;

const PUBLIC_CONTROLLER_FILES = new Set([
  'health/health.controller.ts',
  'site-builder/site-preview.controller.ts',
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
  it.each(PROTECTED_CONTROLLERS)(
    '%s runs authentication before scope enforcement',
    (controller) => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
      expect(guards).toEqual([AuthGuard, ScopesGuard]);
    },
  );

  it('fails closed when a new non-public controller omits the authz topology', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const offenders: string[] = [];
    const discoveredPublic = new Set<string>();

    for (const absolute of controllerFiles(sourceRoot)) {
      const path = relative(sourceRoot, absolute);
      if (PUBLIC_CONTROLLER_FILES.has(path)) {
        discoveredPublic.add(path);
        continue;
      }
      const source = readFileSync(absolute, 'utf8');
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
    expect(offenders).toEqual([]);
  });
});
