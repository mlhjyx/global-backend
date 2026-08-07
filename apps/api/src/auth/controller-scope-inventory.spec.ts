import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
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

const CONTROLLERS = {
  ClaimController,
  CompanyController,
  DeletionController,
  DiscoveryController,
  EventsController,
  IcpController,
  LeadController,
} as const;

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
    const inventoried = Object.values(ACQUISITION_CONTROLLER_SCOPE_INVENTORY).map(
      ({ file }) => file,
    );
    expect(controllerFiles()).toEqual(
      [...inventoried, ...NON_ACQUISITION_CONTROLLER_EXEMPTIONS].sort(),
    );
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
