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
// 专利发明人缓存刷新（scale-safe #89，第 5 个周期 Schedule）：一次共享大扫落 postgres → 逐公司零 BQ 字节读缓存
export const PATENTS_CACHE_REFRESH_WORKFLOW = 'patentsCacheRefreshWorkflow';
export const PATENTS_CACHE_REFRESH_SCHEDULE_ID = 'patents-cache-refresh';
// 收口⑥ PR-B：删除编排（on-demand，非 Schedule；DeletionService 按 deletion_request 触发）
export const DELETION_WORKFLOW = 'deletionWorkflow';
