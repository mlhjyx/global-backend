import 'reflect-metadata';
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

describe('controller authorization guard topology', () => {
  it.each(PROTECTED_CONTROLLERS)(
    '%s runs authentication before scope enforcement',
    (controller) => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
      expect(guards).toEqual([AuthGuard, ScopesGuard]);
    },
  );
});
