import type { AuthorizationScope } from './scopes';
import type { DiscoveryV3TaskClaim } from './discovery-v3-admission-contract';

/** Resolved from the external platform's token on every authenticated request. */
export interface RequestContext {
  userId: string;
  workspaceId: string;
  roles: string[];
  scopes?: readonly AuthorizationScope[];
  discoveryV3Task?: DiscoveryV3TaskClaim;
}
