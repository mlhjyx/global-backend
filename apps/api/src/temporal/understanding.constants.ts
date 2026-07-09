// Shared identifiers — no @temporalio imports, so this is safe to import from
// both the workflow sandbox and normal Node code (the relay starts by name).
// 单 worker 单队列跑获客主线的所有 workflow；量大后可按域拆队列。
export const UNDERSTANDING_TASK_QUEUE = 'understanding';
export const UNDERSTANDING_WORKFLOW = 'understandingWorkflow';
export const DISCOVERY_WORKFLOW = 'discoveryWorkflow';
export const QUALIFY_WORKFLOW = 'qualifyWorkflow';
export const ACQUISITION_SWEEP_WORKFLOW = 'acquisitionSweepWorkflow';
export const ACQ_SWEEP_SCHEDULE_ID = 'acq-sweep';
export const INTENT_SWEEP_WORKFLOW = 'intentSweepWorkflow';
export const INTENT_SWEEP_SCHEDULE_ID = 'intent-sweep';
export const BACKLOG_SWEEP_WORKFLOW = 'backlogSweepWorkflow';
export const BACKLOG_SWEEP_SCHEDULE_ID = 'backlog-sweep';
export const EXTERNAL_INTENT_SWEEP_WORKFLOW = 'externalIntentSweepWorkflow';
export const EXTERNAL_INTENT_SWEEP_SCHEDULE_ID = 'external-intent-sweep';
