import { ActivityCancellationType, CancellationScope, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import type { DiscoveryV3WorkerActivities } from './discovery-v3.worker-activities';

const activities = proxyActivities<DiscoveryV3WorkerActivities>({
  startToCloseTimeout: '195 minutes',
  heartbeatTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 2 },
});

const terminal = proxyActivities<Pick<DiscoveryV3WorkerActivities, 'cancelDiscoveryV3' | 'failDiscoveryV3'>>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

export async function discoveryExecutionV3Workflow(command: DiscoveryV3Dispatch): Promise<void> {
  try {
    await activities.dispatchDiscoveryV3(command);
  } catch (error) {
    await CancellationScope.nonCancellable(() => isCancellation(error)
      ? terminal.cancelDiscoveryV3(command)
      : terminal.failDiscoveryV3(command));
    throw error;
  }
}
