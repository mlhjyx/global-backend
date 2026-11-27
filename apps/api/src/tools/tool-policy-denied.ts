export class ToolPolicyDenied extends Error {
  constructor(
    public readonly toolId: string,
    public readonly reason: string,
  ) {
    super(`tool ${toolId} denied: ${reason}`);
    this.name = "ToolPolicyDenied";
  }
}
