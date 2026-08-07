/**
 * Cross-branch authorization contract for the reference quality-label
 * operator. Runtime decorators are owned by the authorization branch and must
 * match this declaration before integration. Until then, the relevant
 * endpoints are guarded by an explicit fail-closed availability stop; a plain
 * AuthGuard is never represented as scope enforcement.
 */
export const LEAD_QUALITY_LABEL_OPERATOR_AUTH_CONTRACT = Object.freeze({
  runtimeBinding: "FAIL_CLOSED_PENDING_AUTHORIZATION_INTEGRATION" as const,
  operations: Object.freeze({
    pullLeadQualified: Object.freeze({
      method: "GET" as const,
      path: "/api/v1/events",
      scopes: Object.freeze(["acquisition:read", "personal-data:read"]),
    }),
    appendLabel: Object.freeze({
      method: "POST" as const,
      path: "/api/v1/lead-quality-labels",
      scopes: Object.freeze(["acquisition:label:write"]),
    }),
    acknowledgeEvent: Object.freeze({
      method: "POST" as const,
      path: "/api/v1/events/ack",
      scopes: Object.freeze(["acquisition:event:ack"]),
    }),
  }),
});
