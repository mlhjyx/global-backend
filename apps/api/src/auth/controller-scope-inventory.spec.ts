import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { ClaimController } from '../claim/claim.controller';
import { CompanyController } from '../company/company.controller';
import { DeletionController } from '../compliance/deletion.controller';
import { DiscoveryController } from '../discovery/discovery.controller';
import { EventsController } from '../events/events.controller';
import { IcpController } from '../icp/icp.controller';
import { LeadController } from '../lead/lead.controller';
import {
  ACQUISITION_CONTROLLER_SCOPE_INVENTORY,
  NON_ACQUISITION_CONTROLLER_EXEMPTIONS,
} from './acquisition-scope-inventory';
import { REQUIRED_AUTH_SCOPES } from './auth-scopes';
import { AuthGuard } from './auth.guard';

const CONTROLLERS = {
  ClaimController,
  CompanyController,
  DeletionController,
  DiscoveryController,
  EventsController,
  IcpController,
  LeadController,
} as const;

const REGISTERED_PRODUCTION_CONTROLLERS = Object.freeze([
  'AssetsController',
  'BuildsController',
  'ClaimController',
  'CompanyController',
  'DeletionController',
  'DiscoveryController',
  'EventsController',
  'HealthController',
  'IcpController',
  'IntakeController',
  'KbController',
  'LeadController',
  'SitePreviewController',
  'SitesController',
  'WhoamiController',
]);

function routeMethods(controller: abstract new (...args: never[]) => unknown): string[] {
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .filter((name) => Reflect.hasMetadata(PATH_METADATA, controller.prototype[name]))
    .filter((name) => Reflect.hasMetadata(METHOD_METADATA, controller.prototype[name]))
    .sort();
}

function controllerFiles(): string[] {
  const sourceRoot = resolve(__dirname, '..');
  return readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.controller.ts'))
    .map((path) => path.replaceAll('\\', '/'))
    .sort();
}

describe('acquisition/compliance controller operation -> scope inventory', () => {
  it('covers every operation with exact decorator metadata and no stale entries', () => {
    for (const [controllerName, controller] of Object.entries(CONTROLLERS)) {
      const inventory = ACQUISITION_CONTROLLER_SCOPE_INVENTORY[controllerName];
      expect(inventory, `${controllerName} is missing from the inventory`).toBeDefined();
      expect(
        Reflect.getMetadata(GUARDS_METADATA, controller),
        `${controllerName} must establish signed context with AuthGuard`,
      ).toContain(AuthGuard);
      expect(Object.keys(inventory.operations).sort()).toEqual(routeMethods(controller));

      for (const [operation, expectedScopes] of Object.entries(inventory.operations)) {
        const handler = controller.prototype[operation as keyof typeof controller.prototype];
        expect(
          Reflect.getMetadata(REQUIRED_AUTH_SCOPES, handler),
          `${controllerName}.${operation} is missing @RequireScopes`,
        ).toEqual(expectedScopes);
      }
    }
  });

  it('forces every non-Site-Builder controller file to be inventoried or explicitly exempted', () => {
    const inventoried = Object.values(ACQUISITION_CONTROLLER_SCOPE_INVENTORY).map(({ file }) => file);
    expect(controllerFiles()).toEqual([...inventoried, ...NON_ACQUISITION_CONTROLLER_EXEMPTIONS].sort());
  });

  it('matches the actual Nest production module graph bidirectionally', async () => {
    const originalEnvironment = process.env;
    process.env = {
      ...process.env,
      NODE_ENV: 'test',
      DEPLOYMENT_STAGE: 'development',
      API_BIND_HOST: '127.0.0.1',
      AUTH_ALLOW_DEV_TOKENS: 'true',
      AUTH_ROLE_SCOPE_MAP: JSON.stringify({ 'inventory.reader': ['acquisition:read'] }),
    };
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      const modules = app.get(ModulesContainer);
      const registered = [...modules.values()]
        .flatMap((module) => [...module.controllers.values()])
        .map((wrapper) => wrapper.metatype?.name)
        .filter((name): name is string => Boolean(name))
        .sort();

      expect(registered).toEqual([...REGISTERED_PRODUCTION_CONTROLLERS].sort());
    } finally {
      await app.close();
      process.env = originalEnvironment;
    }
  });

  it('requires personal-data and compliance authority for sensitive acquisition operations', () => {
    expect(ACQUISITION_CONTROLLER_SCOPE_INVENTORY.DiscoveryController.operations.verify).toEqual([
      'acquisition:write',
      'personal-data:read',
      'compliance:manage',
    ]);
    expect(ACQUISITION_CONTROLLER_SCOPE_INVENTORY.DiscoveryController.operations.guessEmails).toEqual([
      'acquisition:write',
      'personal-data:read',
      'compliance:manage',
    ]);
    expect(ACQUISITION_CONTROLLER_SCOPE_INVENTORY.LeadController.operations.accept).toEqual([
      'acquisition:review',
      'personal-data:read',
    ]);
    expect(ACQUISITION_CONTROLLER_SCOPE_INVENTORY.EventsController.operations.list).toEqual([
      'acquisition:read',
      'personal-data:read',
    ]);
  });

  it('keeps quality-label write and identity-review scopes unbound until their separate endpoints exist', () => {
    const used = new Set(
      Object.values(ACQUISITION_CONTROLLER_SCOPE_INVENTORY).flatMap(({ operations }) =>
        Object.values(operations).flat(),
      ),
    );
    expect(used.has('acquisition:label:write')).toBe(false);
    expect(used.has('acquisition:identity:review')).toBe(false);
  });
});
