// Shared identifiers — no @temporalio imports, so this is safe to import from
// both the workflow sandbox and normal Node code (the relay starts by name).
// 单 worker 单队列跑获客主线的所有 workflow；量大后可按域拆队列。
export const UNDERSTANDING_TASK_QUEUE = 'understanding';
export const UNDERSTANDING_WORKFLOW = 'understandingWorkflow';
export const DISCOVERY_WORKFLOW = 'discoveryWorkflow';
