/**
 * Cross-branch authorization contract for the reference quality-label
 * operator. Runtime decorators and the machine-checked controller inventory
 * must match this declaration. Authentication alone is never represented as
 * scope enforcement.
 */
export const LEAD_QUALITY_LABEL_OPERATOR_AUTH_CONTRACT = Object.freeze({
  runtimeBinding: "INTEGRATED_SCOPE_GUARD" as const,
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
