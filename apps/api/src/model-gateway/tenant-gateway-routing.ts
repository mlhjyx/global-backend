/**
 * Tenant attribution & optional per-tenant sub-key routing for `global-new-api`.
 *
 * - Always attaches `X-Workspace-Id` when a valid workspaceId is present in AiContext.
 * - Supports optional `MODEL_GATEWAY_TENANT_KEYS_JSON` (`{"<workspace-uuid>": "<sub-key>"}`)
 *   so high-value or isolated tenants can use dedicated `new-api` sub-keys while other
 *   tenants transparently fall back to the default gateway token.
 * - Never interpolates raw keys into error messages.
 */

const SAFE_WORKSPACE_HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const MODEL_GATEWAY_TENANT_KEYS_ENV = 'MODEL_GATEWAY_TENANT_KEYS_JSON' as const;

export function parseTenantGatewayKeyMap(
  rawJson: string | undefined,
): ReadonlyMap<string, string> {
  const trimmed = rawJson?.trim();
  if (!trimmed) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('MODEL_GATEWAY_TENANT_KEYS_JSON_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MODEL_GATEWAY_TENANT_KEYS_JSON_INVALID');
  }
  const map = new Map<string, string>();
  for (const [workspaceId, token] of Object.entries(parsed as Record<string, unknown>)) {
    const ws = workspaceId.trim();
    if (!SAFE_WORKSPACE_HEADER_RE.test(ws)) {
      throw new Error('MODEL_GATEWAY_TENANT_KEY_WORKSPACE_INVALID');
    }
    if (
      typeof token !== 'string' ||
      token.trim().length === 0 ||
      /[\r\n\p{Cc}]/u.test(token)
    ) {
      throw new Error('MODEL_GATEWAY_TENANT_KEY_TOKEN_INVALID');
    }
    map.set(ws, token.trim());
  }
  return map;
}

export function resolveTenantGatewayApiKey(
  defaultApiKey: string,
  tenantKeys: ReadonlyMap<string, string> | undefined,
  workspaceId: string | undefined,
): string {
  const ws = workspaceId?.trim();
  if (!ws || !tenantKeys) return defaultApiKey;
  return tenantKeys.get(ws) ?? defaultApiKey;
}

export function buildTenantGatewayHeaders(input: {
  readonly defaultApiKey: string;
  readonly tenantKeys?: ReadonlyMap<string, string>;
  readonly workspaceId?: string;
  readonly authHeader?: 'bearer' | 'x-api-key';
  readonly extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const ws = input.workspaceId?.trim();
  const apiKey = resolveTenantGatewayApiKey(
    input.defaultApiKey,
    input.tenantKeys,
    ws,
  );
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(input.authHeader === 'x-api-key'
      ? { 'x-api-key': apiKey }
      : { Authorization: `Bearer ${apiKey}` }),
    ...(input.extra ?? {}),
  };
  if (ws && SAFE_WORKSPACE_HEADER_RE.test(ws)) {
    headers['X-Workspace-Id'] = ws;
  }
  return headers;
}
