import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from '../auth/acquisition-scope-inventory';
import { REQUIRED_AUTH_SCOPES } from '../auth/auth-scopes';
import { DiscoveryController } from '../discovery/discovery.controller';

const GOVERNANCE_METHODS = [
  'addSuppression',
  'listSuppressions',
  'removeSuppression',
  'requestSuppressionRelease',
] as const;

describe('suppression governance authorization', () => {
  it.each(GOVERNANCE_METHODS)(
    'binds %s to the exact compliance:manage scope',
    (methodName) => {
      const method = DiscoveryController.prototype[methodName];

      expect(Reflect.getMetadata(REQUIRED_AUTH_SCOPES, method)).toEqual([
        'compliance:manage',
      ]);
      expect(
        ACQUISITION_CONTROLLER_SCOPE_INVENTORY.DiscoveryController.operations[
          methodName
        ],
      ).toEqual(['compliance:manage']);
    },
  );
});
