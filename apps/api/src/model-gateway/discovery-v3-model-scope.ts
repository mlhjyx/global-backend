import { currentDiscoveryV3OperationScope } from '../durable-results/discovery-v3-operation-scope';
import type { AiContext } from './types';

export function hasNativeDiscoveryModelScope(context: AiContext): boolean {
  return currentDiscoveryV3OperationScope(context) !== undefined;
}
