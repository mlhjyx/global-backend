import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_POSTGRES_ACK,
  admitDisposablePostgresVerification,
} from "./lead-quality-label.postgres-verifier";

const IMAGE = `pgvector/pgvector:pg16@sha256:${"a".repeat(64)}`;

describe("disposable quality-label PostgreSQL verifier admission", () => {
  it("is explicitly NOT_RUN by default and performs no external connection", () => {
    expect(admitDisposablePostgresVerification([], {})).toEqual({
      status: "NOT_RUN",
      reason: expect.stringContaining("--execute-disposable"),
      externalConnections: 0,
    });
  });

  it("requires an exact acknowledgement and digest-pinned dedicated image", () => {
    expect(() =>
      admitDisposablePostgresVerification(["--execute-disposable"], {
        GLOBAL_DISPOSABLE_PG_IMAGE: IMAGE,
      }),
    ).toThrow(/acknowledgement/i);
    expect(() =>
      admitDisposablePostgresVerification(["--execute-disposable"], {
        GLOBAL_DISPOSABLE_PG_VERIFY_ACK: DISPOSABLE_POSTGRES_ACK,
        GLOBAL_DISPOSABLE_PG_IMAGE: "pgvector/pgvector:pg16",
      }),
    ).toThrow(/sha256/i);
    expect(
      admitDisposablePostgresVerification(["--execute-disposable"], {
        GLOBAL_DISPOSABLE_PG_VERIFY_ACK: DISPOSABLE_POSTGRES_ACK,
        GLOBAL_DISPOSABLE_PG_IMAGE: IMAGE,
        DATABASE_URL: "postgresql://must-be-ignored.invalid/existing",
      }),
    ).toEqual({ status: "READY_FOR_DISPOSABLE_EXECUTION", image: IMAGE });
  });

  it("accepts no caller-supplied connection or target arguments", () => {
    for (const args of [
      ["--execute-disposable", "--database-url", "postgresql://existing"],
      ["--host", "127.0.0.1"],
      ["--execute"],
    ]) {
      expect(() =>
        admitDisposablePostgresVerification(args, {
          GLOBAL_DISPOSABLE_PG_VERIFY_ACK: DISPOSABLE_POSTGRES_ACK,
          GLOBAL_DISPOSABLE_PG_IMAGE: IMAGE,
        }),
      ).toThrow(/only --execute-disposable/i);
    }
  });
});
