import { proxyActivities } from '@temporalio/workflow';
import type { DataExportActivities } from './data-export.activities';
import type {
  DataExportWorkflowInput,
  DataExportWorkflowResult,
} from '../data-exports/data-exports.types';

const acts = proxyActivities<DataExportActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

function errorCodeFrom(error: unknown): string {
  if (error && typeof error === 'object') {
    const type = (error as { type?: unknown }).type;
    if (typeof type === 'string' && type.trim().length > 0) {
      return type.trim().slice(0, 120);
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0 && name !== 'Error') {
      return name.trim().slice(0, 120);
    }
  }
  return 'DATA_EXPORT_FAILED';
}

export async function dataExportWorkflow(
  input: DataExportWorkflowInput,
): Promise<DataExportWorkflowResult> {
  try {
    return await acts.runDataExport(input);
  } catch (error) {
    await acts
      .failDataExport({
        workspaceId: input.workspaceId,
        exportId: input.exportId,
        errorCode: errorCodeFrom(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
