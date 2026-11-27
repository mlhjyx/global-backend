import { describe, expect, it } from 'vitest';
import { discoveryV3Attempt, discoveryV3RequestSha256 } from './discovery-v3-admission-contract';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const planId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const task = {
  taskId: '44444444-4444-4444-8444-444444444444',
  taskRunId: '55555555-5555-4555-8555-555555555555',
};

describe('discovery v3 cross-repo admission identity', () => {
  it('matches the canonical first-attempt vector shared by engine and SaaS', () => {
    const attemptId = discoveryV3Attempt(workspaceId, planId);
    expect(attemptId).toBe('42ad8757-c18a-5d3e-84db-331ee09317ac');
    expect(discoveryV3RequestSha256({ workspaceId, planId, actorId, attemptId, task }))
      .toBe('d91021e03ebc254a86dd2e1f65a860b656bf32bf731582f86be9e942939a1202');
  });

  it('keeps the implicit slot distinct from a caller-supplied retry', () => {
    const initial = discoveryV3Attempt(workspaceId, planId);
    expect(() => discoveryV3Attempt(workspaceId, planId, initial.toUpperCase())).toThrow('DISCOVERY_RESERVED_ATTEMPT');
    expect(discoveryV3Attempt(workspaceId, planId, actorId)).toBe(actorId);
    expect(discoveryV3Attempt(planId, workspaceId)).not.toBe(initial);
  });

  it('binds the plan, actor, option, task and effective attempt to the request', () => {
    const attemptId = discoveryV3Attempt(workspaceId, planId);
    const request = { workspaceId, planId, actorId, attemptId, task };
    const digest = discoveryV3RequestSha256(request);
    expect(discoveryV3RequestSha256({ ...request, actorId: planId })).not.toBe(digest);
    expect(discoveryV3RequestSha256({ ...request, planId: actorId })).not.toBe(digest);
    expect(discoveryV3RequestSha256({ ...request, attemptId: actorId })).not.toBe(digest);
    expect(discoveryV3RequestSha256({ ...request, task: undefined })).not.toBe(digest);
    expect(discoveryV3RequestSha256({ ...request, manufacturerNetworkRevision: 'manufacturer-network/v2' })).not.toBe(digest);
  });
});
