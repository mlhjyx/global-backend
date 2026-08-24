import type { TypedProjectionSchema } from './durable-result-strategy';

export const TYPED_PROJECTION_ENVELOPE_VERSION =
  'generic-operation-projection/v2' as const;

export interface TypedProjectionDefinition<Raw, Projected> {
  readonly schema: TypedProjectionSchema;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  project(raw: Raw): Projected;
  restore(projected: Projected): Raw;
}

export interface TypedProjectionEnvelope {
  readonly schemaVersion: typeof TYPED_PROJECTION_ENVELOPE_VERSION;
  readonly schema: TypedProjectionSchema;
  readonly digest: string;
  readonly data: unknown;
}

/** The smallest SQL surface required to verify PostgreSQL's JSONB text size. */
export interface PostgresJsonbByteExecutor {
  $queryRaw<T>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
}
