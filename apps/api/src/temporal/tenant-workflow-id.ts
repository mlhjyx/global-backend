/**
 * Tenant-scoped Temporal WorkflowId contract (`ws:<workspaceId>:<type>:<id>`),
 * with backward-compatible parsing & lookup for historical unprefixed IDs.
 *
 * Pure string utilities (zero @temporalio imports) so both Node services and
 * workflow bundles can share the exact same format.
 */

const SAFE_TENANT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PREFIXED_WORKFLOW_ID_RE =
  /^ws:([a-z0-9][a-z0-9._-]{0,127}):([a-z0-9][a-z0-9._-]{0,63}):([^\s\p{Cc}]{1,128})$/iu;

const LEGACY_TYPE_PREFIXES = [
  'personal-artifact-cleanup',
  'asset-object-cleanup',
  'workspace-purge',
  'seller-document',
  'site-refurbish',
  'campaign-plan',
  'understanding',
  'data-export',
  'discovery',
  'site-demo',
  'deletion',
  'qualify',
  'rejudge',
  'site-kb',
] as const;

export interface ParsedTenantWorkflowId {
  readonly workspaceId: string | null;
  readonly type: string;
  readonly id: string;
  readonly legacy: boolean;
}

export function formatTenantWorkflowId(
  workspaceId: string,
  type: string,
  id: string,
): string {
  const ws = workspaceId.trim().toLowerCase();
  const normalizedType = type.trim().toLowerCase();
  const normalizedId = id.trim();
  if (!SAFE_TENANT_ID_RE.test(ws)) {
    throw new TypeError(`TEMPORAL_WORKFLOW_ID_INVALID_WORKSPACE:${workspaceId}`);
  }
  if (!SAFE_SEGMENT_RE.test(normalizedType)) {
    throw new TypeError(`TEMPORAL_WORKFLOW_ID_INVALID_TYPE:${type}`);
  }
  if (
    !normalizedId ||
    normalizedId.length > 128 ||
    /[\s\p{Cc}]/u.test(normalizedId)
  ) {
    throw new TypeError('TEMPORAL_WORKFLOW_ID_INVALID_ENTITY_ID');
  }
  return `ws:${ws}:${normalizedType}:${normalizedId}`;
}

export function formatLegacyWorkflowId(type: string, id: string): string {
  return `${type.trim().toLowerCase()}-${id.trim()}`;
}

/**
 * Parses either a tenant-prefixed workflowId (`ws:<workspaceId>:<type>:<id>`)
 * or a historical unprefixed workflowId (`<type>-<id>`).
 */
export function parseTenantWorkflowId(workflowId: string): ParsedTenantWorkflowId | null {
  const trimmed = workflowId.trim();
  if (!trimmed) return null;
  const prefixed = trimmed.match(PREFIXED_WORKFLOW_ID_RE);
  if (prefixed) {
    return {
      workspaceId: prefixed[1]!.toLowerCase(),
      type: prefixed[2]!.toLowerCase(),
      id: prefixed[3]!,
      legacy: false,
    };
  }
  for (const prefix of LEGACY_TYPE_PREFIXES) {
    if (trimmed.startsWith(`${prefix}-`) && trimmed.length > prefix.length + 1) {
      return {
        workspaceId: null,
        type: prefix,
        id: trimmed.slice(prefix.length + 1),
        legacy: true,
      };
    }
  }
  return null;
}

/**
 * Returns candidate workflowIds in lookup preference order: new tenant-prefixed
 * ID first, followed by historical unprefixed legacy ID for read compatibility.
 */
export function candidateWorkflowIdsForLookup(
  workspaceId: string,
  type: string,
  id: string,
): readonly [string, string] {
  return [
    formatTenantWorkflowId(workspaceId, type, id),
    formatLegacyWorkflowId(type, id),
  ] as const;
}

export function isTenantOrLegacyWorkflowId(
  workflowId: string,
  workspaceId: string,
  type: string,
  id: string,
): boolean {
  const [prefixed, legacy] = candidateWorkflowIdsForLookup(workspaceId, type, id);
  return workflowId === prefixed || workflowId === legacy;
}

/**
 * Expands a list of workflowIds (which may contain legacy unprefixed DB snapshot
 * entries or tenant-prefixed entries) so workspace purge cancels both formats,
 * while never including the purge workflow itself.
 */
export function expandPurgeWorkflowIds(
  workspaceId: string,
  rawWorkflowIds: readonly string[],
): string[] {
  const normalizedWs = workspaceId.trim().toLowerCase();
  const selfLegacy = formatLegacyWorkflowId('workspace-purge', normalizedWs);
  const selfPrefixed = formatTenantWorkflowId(normalizedWs, 'workspace-purge', normalizedWs);
  const out = new Set<string>();
  for (const raw of rawWorkflowIds) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === selfLegacy || trimmed === selfPrefixed) continue;
    const parsed = parseTenantWorkflowId(trimmed);
    if (parsed) {
      // Fail-closed: never emit or cancel a workflow belonging to a different workspace.
      if (parsed.workspaceId && parsed.workspaceId !== normalizedWs) continue;
      const prefixed = formatTenantWorkflowId(normalizedWs, parsed.type, parsed.id);
      const legacy = formatLegacyWorkflowId(parsed.type, parsed.id);
      if (prefixed !== selfPrefixed) out.add(prefixed);
      if (legacy !== selfLegacy) out.add(legacy);
    } else if (!trimmed.toLowerCase().startsWith('ws:')) {
      out.add(trimmed);
    }
  }
  return [...out];
}

export function isTemporalNotFoundError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'WorkflowNotFoundError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /not found|NotFound|does not exist/i.test(message);
}

/**
 * Cancels a customer workflow trying the tenant-prefixed workflowId first and
 * falling back to the historical unprefixed ID when not found.
 */
export async function cancelTenantOrLegacyWorkflow(
  workflowClient: { getHandle(workflowId: string): { cancel(): Promise<unknown> } },
  workspaceId: string,
  type: string,
  id: string,
): Promise<void> {
  const [prefixed, legacy] = candidateWorkflowIdsForLookup(workspaceId, type, id);
  try {
    await workflowClient.getHandle(prefixed).cancel();
  } catch (error) {
    if (!isTemporalNotFoundError(error)) throw error;
    try {
      await workflowClient.getHandle(legacy).cancel();
    } catch (legacyError) {
      if (!isTemporalNotFoundError(legacyError)) throw legacyError;
    }
  }
}

/**
 * Extracts workspaceId from a tenant-prefixed workflowId (returns null for
 * legacy unprefixed IDs or platform workflows).
 */
export function workspaceIdFromWorkflowId(workflowId: string): string | null {
  return parseTenantWorkflowId(workflowId)?.workspaceId ?? null;
}
