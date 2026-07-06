/** Resolved from the external platform's token on every authenticated request. */
export interface RequestContext {
  userId: string;
  workspaceId: string;
  roles: string[];
}
