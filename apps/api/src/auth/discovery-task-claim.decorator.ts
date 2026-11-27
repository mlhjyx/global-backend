import { SetMetadata } from '@nestjs/common';

export const DISCOVERY_TASK_CLAIM_ROUTE = Symbol('DISCOVERY_TASK_CLAIM_ROUTE');
export const AllowDiscoveryTaskClaim = () => SetMetadata(DISCOVERY_TASK_CLAIM_ROUTE, true);
