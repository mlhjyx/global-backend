export const DISPOSABLE_POSTGRES_ACK =
  "CREATE_AND_DESTROY_EPHEMERAL_QUALITY_LABEL_POSTGRES";

export type DisposablePostgresAdmission =
  | {
      status: "NOT_RUN";
      reason: string;
      externalConnections: 0;
    }
  | {
      status: "READY_FOR_DISPOSABLE_EXECUTION";
      image: string;
    };

const PINNED_PGVECTOR_IMAGE =
  /^pgvector\/pgvector:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

/**
 * Pure, zero-I/O admission. It accepts no host, port, URL, database, or
 * container name arguments, so execution cannot be redirected to an existing
 * database. The runner creates every connection detail itself after admission.
 */
export function admitDisposablePostgresVerification(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): DisposablePostgresAdmission {
  if (args.length === 0) {
    return {
      status: "NOT_RUN",
      reason:
        "disposable PostgreSQL verification requires --execute-disposable and an explicit acknowledgement",
      externalConnections: 0,
    };
  }
  if (args.length !== 1 || args[0] !== "--execute-disposable") {
    throw new Error("only --execute-disposable is accepted");
  }
  if (env.GLOBAL_DISPOSABLE_PG_VERIFY_ACK !== DISPOSABLE_POSTGRES_ACK) {
    throw new Error(
      "disposable PostgreSQL acknowledgement is missing or inexact",
    );
  }
  const image = env.GLOBAL_DISPOSABLE_PG_IMAGE;
  if (!image || !PINNED_PGVECTOR_IMAGE.test(image)) {
    throw new Error(
      "GLOBAL_DISPOSABLE_PG_IMAGE must be an exact pgvector/pgvector tag plus sha256 digest",
    );
  }
  return { status: "READY_FOR_DISPOSABLE_EXECUTION", image };
}
