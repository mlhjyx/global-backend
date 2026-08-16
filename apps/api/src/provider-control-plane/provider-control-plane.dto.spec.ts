import { describe, expect, it } from 'vitest';
import { PROVIDER_CONTROL_PLANE_RESPONSE_SCHEMA } from './provider-control-plane.dto';

type SchemaNode = Record<string, unknown>;

function findConstPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findConstPaths(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];

  const node = value as SchemaNode;
  return [
    ...('const' in node ? [path] : []),
    ...Object.entries(node).flatMap(([key, child]) => findConstPaths(child, `${path}.${key}`)),
  ];
}

describe('PROVIDER_CONTROL_PLANE_RESPONSE_SCHEMA', () => {
  it('uses OAS3-compatible single-value enums for invariant response fields', () => {
    const schema = PROVIDER_CONTROL_PLANE_RESPONSE_SCHEMA as SchemaNode;
    const provider = (((schema.properties as SchemaNode).providers as SchemaNode).items as SchemaNode);
    const properties = provider.properties as SchemaNode;
    const route = (properties.route as SchemaNode).properties as SchemaNode;
    const live = (properties.live as SchemaNode).properties as SchemaNode;
    const evidenceRail = (properties.evidenceRail as SchemaNode).properties as SchemaNode;

    expect(findConstPaths(schema)).toEqual([]);
    expect(route.runtimeHealth).toEqual({ enum: ['NOT_EVALUATED'] });
    expect(live.reasonCode).toEqual({ enum: ['CONNECTION_PROBE_NOT_IMPLEMENTED'] });
    expect(evidenceRail.evidence).toEqual({ enum: ['UNAVAILABLE'] });
    expect(evidenceRail.lead).toEqual({ enum: ['UNAVAILABLE'] });
    expect(evidenceRail.outbox).toEqual({ enum: ['UNAVAILABLE'] });
    expect(evidenceRail.replay).toEqual({ enum: ['UNAVAILABLE'] });
  });
});
