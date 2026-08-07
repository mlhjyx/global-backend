/** Resolved from the external platform's token on every authenticated request. */
export interface RequestContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly roles: readonly string[];
}
